/*jshint node: true, expr: false, boss: true */

var util = require('util'),
    io = require('socket.io-client'),
    fs = require('fs'),
    async = require('async'),
    vows = require('vows'),
    assert = require('assert'),
    path = require('path'),
    _ = require('underscore');

function r (p) { return require(__dirname + '/../lib/' + p); }

var Server = r('server'),
    models = r('models'),
    models_sync = r('models-sync'),
    test_utils = r('test-utils');

function d (p) { return __dirname + '/' + p; }

var BASE_PORT = 11000;

var SERVER_PORT = 12000;
var SERVER_URL = 'http://localhost:' + SERVER_PORT;

var SOCKET_OPTIONS = {
  transports: ['websocket'],
  'force new connection': true
};

process.on('uncaughtException', function (e) {
    util.error("ERR " + e.stack);
});

var suite = vows.describe('Server tests');

suite.addBatch({
    '(Server)': {
        topic: function () {
            var $this = this;
            
            this.httpd = test_utils.createTestServer(++BASE_PORT);
            this.base_url = 'http://localhost:' + BASE_PORT + '/';

            this.server = new Server({port: SERVER_PORT});
            this.server.listen();

            this.msync = new models_sync.HashSync();
            this.msync.open(function (err, sync_proxy) {
                $this.sync_proxy = sync_proxy;
                Backbone.sync = sync_proxy;
                $this.callback();
            });
        },

        teardown: function () {
            var $this = this;
            this.msync.close(function () {
                $this.server.close();
            });
        },

        'a socket connected to the server': {
            topic: function () {
                var $this = this;
                var socket = io.connect(SERVER_URL, SOCKET_OPTIONS);
                socket.on('connect', function () {
                    $this.callback(null, socket);
                });
            },
            'that sends an echo message': {
                topic: function (err, socket) {
                    var $this = this;
                    socket.on('echo', function (data) {
                        $this.callback(null, socket, data);
                    });
                    socket.emit("echo", "HIT ME BACK");
                },
                'should recieve an echo response': function (err, socket, response) {
                    assert.deepEqual(response, "HIT ME BACK");
                }
            }
        },

        'a collection of 200 OK resources (again)': {
            topic: test_utils.trackedResourcesTopic('200?id=socketIoPollAgain'),
            
            'and a socket connection': {
                topic: socketConnectionTopic(),

                'that sends a startPoll message': {
                    topic: trackedSocketPoll(),

                    'should result in all resources getting polled':
                            function (err, resources, stats, socket, socket_events) {
                        var $this = this;
                        resources.each(function (r) {
                            var url = r.get('resource_url');
                            var path = url.replace($this.base_url, '/');
                            assert.ok(path in $this.httpd.stats.urls);
                        });
                    },

                    'should receive expected progress messages':
                            function (err, resources, stats, socket, socket_events) {
                        assert.deepEqual(socket_events, [
                            // Polling starts
                            'allStart',
                            // Everything gets enqueued
                            'enqueue', 'enqueue', 'enqueue', 'enqueue', 'enqueue', 
                            'enqueue', 'enqueue', 'enqueue', 'enqueue', 
                            // The first polls start, up to concurrency limit
                            'start', 'start', 'start', 'start',
                            // Backlog of polls start as polls complete
                            'status_200', 'end', 'start',
                            'status_200', 'end', 'start',
                            'status_200', 'end', 'start',
                            'status_200', 'end', 'start',
                            'status_200', 'end', 'start',
                            // The last few polls finish up
                            'status_200', 'end', 'status_200', 'end',
                            'status_200', 'end', 'status_200', 'end', 
                            // And that's it
                            'allEnd'
                        ]);
                    },

                    'and that sends another startPoll and then abortPoll': {
                        topic: trackedSocketPoll(
                            function (resources, stats, socket, socket_events, _next) {
                                var ct = 0;
                                socket.on('poll:start', function (msg) {
                                    if (ct == 1) { socket.emit('startPoll'); }
                                    if (ct == 3) { socket.emit('abortPoll'); }
                                    ct++;
                                });
                            }),

                        'should result in progress messages describing an aborted poll':
                                function (err, resources, stats, socket, socket_events) {
                            assert.deepEqual(socket_events, [
                                // Polling starts
                                'allStart',
                                // Everything gets enqueued
                                'enqueue', 'enqueue', 'enqueue', 'enqueue', 'enqueue',
                                'enqueue', 'enqueue', 'enqueue', 'enqueue',
                                // Polls start...
                                'start', 'start', 'start',
                                // Then, a second 'startPoll' comes in, and is rejected
                                'inProgress',
                                // Next poll up to max concurrency
                                'start',
                                // Then we abort, and get confirmation
                                'abort',
                                // In-progress polls finish
                                'status_200', 'end', 'status_200', 'end',
                                'status_200', 'end', 'status_200', 'end',
                                // And we're done
                                'allEnd' 
                            ]);
                        }

                    }
                }
            }
        }
    }
});

function socketConnectionTopic () {
    return function (err, resources, stats) {
        var $this = this;
        var socket = io.connect(SERVER_URL, SOCKET_OPTIONS);
        socket.on('connect', function () {
            $this.callback(null, resources, stats, socket);
        });
    };
}

function trackedSocketPoll (after) {
    return function (err, resources, stats, socket) {
        var $this = this;

        var socket_events = [];
        var _next = _.once(function (err) {
            $this.callback(err, resources, stats,
                socket, socket_events);
        });

        var ev_names = [
            'allStart', 'allEnd',
            'inProgress', 'notInProgress',
            'enqueue', 'start', 'status_200', 'abort', 'end'
        ];
        ev_names.forEach(function (name) {
            var ev_name = 'poll:' + name;
            socket.on(ev_name, function (msg) {
                socket_events.push(name);
                if ('poll:allEnd' == ev_name) {
                    _next();
                }
            });
        });

        setTimeout(function () {
            _next('timeout', null);
        }, 200);

        socket.emit('startPoll', {
            concurrency: 4,
            max_age: 0
        });

        if (after) {
            after.call($this, resources, stats,
                       socket, socket_events, _next);
        }
    };
}

if (process.argv[1] === __filename) {
    suite.run({error: false});
} else {
    suite.export(module, {error: false});
}
