/*jshint node: true, expr: false, boss: true */

var util = require('util'),
    express = require('express'),
    request = require('request'),
    fs = require('fs'),
    async = require('async'),
    vows = require('vows'),
    assert = require('assert'),
    path = require('path'),
    _ = require('underscore');

function r (p) { return require(__dirname + '/../lib/' + p); }

var models = r('models'),
    models_sync = r('models-sync'),
    test_utils = r('test-utils');

function d (p) { return __dirname + '/' + p; }

var MOVIES_OPML = d('fixtures/movies.opml');
var BASE_PORT = 11000;

process.on('uncaughtException', function (e) {
    util.debug("ERROR " + e.stack);
});

var suite = vows.describe('Model tests');

suite.addBatch({
    '(FeedItem models)': {
        topic: initTopic,
        teardown: initTeardown,

        'a changing feed resource, polled and parsed several times': {
            topic: function () {
                var $this = this;

                var r = test_utils.trackedResources(this);
                var resources = r[0];
                var stats = r[1];

                var feed_items = new models.FeedItemCollection();
                feed_items.sync = $this.sync_proxy;

                this.msync.store = {};

                var results = [];
                var doPoll = function (resource, wf_next) {
                    resource.poll({
                        max_age: 0
                    }, function (err, resource) {
                        feed_items.parseResource(resource, function (err, result) {
                            results.push(result);
                            wf_next(null, resource);
                        });
                    });
                };

                async.waterfall([
                    function (wf_next) {
                        resources.create({
                            resource_url: $this.base_url + '200seq/feed-seq-$$.xml'
                        }, {
                            success: function (resource, resp, options) {
                                wf_next(null, resource);
                            }
                        });
                    },
                    doPoll, doPoll, doPoll, doPoll
                ], function (err, result) {
                    $this.callback(err, feed_items, results);
                });
            },
            'should yield expected parsed and new items':
                    function (err, feed_items, results) {
                // Ensure the parsed counts for the polls match feeds
                assert.deepEqual(
                    results.map(function (i) {
                        return i.parsed.length;
                    }),
                    [3, 4, 5, 3]
                );
                // Check new item counts against expectations.
                assert.deepEqual(
                    results.map(function (i) {
                        return i.new_items.length;
                    }),
                    [3, 1, 1, 0]
                );
            }
        }
    }
});

suite.addBatch({
    '(FeedItem models #2)': {
        topic: initTopic,
        teardown: initTeardown,

        'a set of fixture feed resources, all polled and parsed': {
            topic: function () {
                var $this = this;

                var r = test_utils.trackedResources(this);
                var resources = r[0];
                var stats = r[1];

                var feed_items = new models.FeedItemCollection();
                feed_items.sync = $this.sync_proxy;

                var attrs = [];
                for (var i=1; i<4; i++) {
                    attrs.push({
                        resource_url: this.base_url + 'fixtures/feed0' + i + '.xml'
                    });
                }
                
                var feed_stats = {};
                var created = [];
                async.each(attrs, function (item, fe_next) {
                    resources.create(item, {
                        success: function (model, resp, options) {
                            created.push(model);
                            fe_next();
                        }
                    });
                }, function (err) {
                    resources.pollAll({
                        concurrency: test_utils.MAX_CONCURRENCY
                    }, function (err) {
                        async.each(resources.models, function (resource, fe_next) {
                            var url = resource.get('resource_url');
                            feed_items.parseResource(resource, function (err, result) {
                                feed_stats[url] = result;
                                fe_next();
                            });
                        }, function (err) {
                            feed_items.fetch({
                                orderBy: '-published',
                                success: function (feed_items, resp, options) {
                                    $this.callback(err, resources, feed_items,
                                                   stats, feed_stats);
                                }
                            });
                        });
                    });
                });
            },

            'should result in the expected set of feed items':
                    function (err, resources, feed_items, stats, feed_stats) {
                var expected = [ 
                    // Need data
                ]; 
                var items = [];
                feed_items.each(function (item) {
                    var data = item.pick('resource_url', 'link', 'published');
                    data.published = ''+data.published;
                    items.push(data);
                });

                // assert.deepEqual(items, expected);
            }
        }
    }
});

suite.addBatch({
    '(Resource models)': {
        topic: initTopic,
        teardown: initTeardown,

        'a resource': {
            topic: resourceTopic({
                resource_url: test_utils.TEST_PATH_1
            }),
            'should start with no data': assertResource({
                equals: { status_code: 0, body: '' },
                truthy: { last_validated: false },
                headers_empty: true,
                url_hit: false
            }),
            'that has been polled': {
                topic: function (err, r) {
                    r.poll({}, this.callback);
                },
                'should result in a GET to the resource URL': assertResource({
                    equals: { status_code: 200, body: test_utils.TEST_BODY_1 },
                    truthy: { last_validated: true },
                    headers_empty: false,
                    url_hit: true
                }),
                'and then polled again after a delay': {
                    topic: function (err, r, last_validated_1) {
                        var $this = this;
                        var last_validated = r.get('last_validated');
                        setTimeout(function () {
                            r.poll({}, function () {
                                $this.callback(null, r, last_validated);
                            });
                        }, 100);
                    },
                    'should result in a newer last_validated':
                        function (err, r, prev_lv) {
                            assert.ok(r.get('last_validated') > prev_lv);
                        }
                }
            }
        },
        'a disabled resource that has been polled': {
            topic: polledResourceTopic({
                resource_url: test_utils.TEST_PATH_1,
                disabled: true
            }),
            'should not result in a GET': assertResource({
                equals: { status_code: 0, body: '' },
                headers_empty: true,
                url_hit: false
            }),
            'should result in a poll:disabled event': function (err, r, evs) {
                assert.deepEqual(evs,
                    ['poll:start', 'poll:disabled', 'poll:end']);
            }
        },
        'a long-delayed resource with a timeout that has been polled': {
            topic: polledResourceTopic({
                resource_url: 'delayed',
                timeout: test_utils.SHORT_DELAY * 2
            }),
            'should result in an aborted GET and an error': assertResource({
                equals: { status_code: 408, body: '' },
                error: true,
                headers_empty: true,
                url_hit: null
            })
        },
        'a 200-then-500 resource': {
            topic: resourceTopic({ resource_url: '200then500' }),
            'that has been polled twice': {
                topic: function (err, r) {
                    var $this = this;
                    r.poll({}, function (err, r) {
                        assert.equal(r.get('status_code'), 200);
                        assert.equal(r.get('body'), test_utils.TEST_BODY_200);
                        r.poll({}, $this.callback);
                    });
                },
                'should result in 500 status, yet body content from previous 200 OK': assertResource({
                    equals: { status_code: 500, body: test_utils.TEST_BODY_200 },
                    error: false,
                    headers_empty: null,
                    url_hit: null
                })
            }
        },
        
        'a resource that supports If-None-Match and yields ETag when polled':
            testConditionalGET('supports-if-none-match'),
        
        'a resource that supports If-Modified-Since and yields Last-Modified when polled':
            testConditionalGET('supports-if-modified-since'),

        'a resource with a long max_age': {
            topic: polledResourceTopic({
                resource_url: '200?id=pollMeThrice',
                max_age: test_utils.SHORT_DELAY * 5
            }),
            'polled multiple times': {
                topic: function (err, r, evs) {
                    var $this = this;
                    r.poll({}, function (err, r) {
                        r.poll({}, function (err, r) {
                            $this.callback(err, r, evs);
                        });
                    });
                },
                'should result in only 1 GET': function (err, r, evs) {
                    assert.equal(this.httpd.stats.urls['/200?id=pollMeThrice'], 1);
                },
                'should result in poll:fresh events for polls after the first poll:status_200':
                        function (err, r, evs) {
                    assert.deepEqual(evs.splice(0,9), [
                        'poll:start', 'poll:status_200', 'poll:end',
                        'poll:start', 'poll:fresh', 'poll:end',
                        'poll:start', 'poll:fresh', 'poll:end' 
                    ]);
                },
                'and then polled twice after max_age': {
                    topic: function (err, r, evs) {
                        var $this = this;
                        setTimeout(function () {
                            r.poll({}, function (err, r) {
                                r.poll({}, function (err, r) {
                                    $this.callback(err, r, evs);
                                });
                            });
                        }, test_utils.SHORT_DELAY * 10);
                    },
                    'should result in only 2 GETs': function (err, r, evs) {
                        assert.equal(this.httpd.stats.urls['/200?id=pollMeThrice'], 2);
                    },
                    'should result in a poll:status_200, then a poll:fresh':
                            function (err, r, evs) {
                        assert.deepEqual(evs.splice(0,6), [
                            'poll:start', 'poll:status_200', 'poll:end',
                            'poll:start', 'poll:fresh', 'poll:end'
                        ]);
                    },
                    'and polled one more time with a short max_age option': {
                        topic: function (err, r, evs) {
                            var $this = this;
                            r.poll({max_age: 0}, function (err, r) {
                                $this.callback(err, r, evs);
                            });
                        },
                        'should result in a poll:status_200': function (err, r, evs) {
                            assert.deepEqual(evs.splice(0,3), [
                                'poll:start', 'poll:status_200', 'poll:end'
                            ]);
                        }
                    }
                }
            }
        },
        'a collection of 200 OK resources': {
            topic: test_utils.trackedResourcesTopic('200?id=loadOfResources', true),
            'that all get polled': {
                topic: function (err, resources, stats, expected_urls) {
                    var $this = this;
                    resources.pollAll({
                        concurrency: test_utils.MAX_CONCURRENCY
                    }, function (err) {
                        $this.callback(err, resources, stats, expected_urls);
                    });
                },
                'should result in poll:allStart and poll:allEnd events from the collection':
                        function (err, resources, stats, expected_urls) {
                    assert.deepEqual(stats.events._collection,
                        ['poll:allStart', 'poll:allEnd']);
                },
                'should not result in a GET for the disabled resource':
                        function (err, resources, stats, expected_urls) {
                    var path = '/200?id=loadOfResources-disabled';
                    assert.notEqual(this.httpd.stats.urls[path], 1);
                },
                'should result in GETs for expected URLs': 
                        function (err, resources, stats, expected_urls) {
                    for (var i = 0, url; url = expected_urls[i]; i++) {
                        var path = url.replace(this.base_url, '/');
                        assert.equal(this.httpd.stats.urls[path], 1);
                    }
                },
                'should result in a poll:disabled event for the disabled resource':
                        function (err, resources, stats, expected_urls) {
                    var url = this.base_url + '200?id=loadOfResources-disabled';
                    var expected_events = [
                        'poll:enqueue', 'poll:start', 'poll:disabled', 'poll:end'
                    ];
                    assert.deepEqual(stats.events[url], expected_events);
                },
                '"poll:*" events should narrate the poll for enabled resources': 
                        function (err, resources, stats, expected_urls) {
                    var expected_events = [
                        'poll:enqueue', 'poll:start', 'poll:status_200', 'poll:end'
                    ];
                    for (var i = 0, url; url = expected_urls[i]; i++) {
                        assert.deepEqual(stats.events[url], expected_events);
                    }
                },
                'in-progress poll count should never exceed specified concurrency maximum':
                        function (err, resources, stats, expected_urls) {
                    assert.ok(stats.max_concurrency <= test_utils.MAX_CONCURRENCY);
                }
            }
        },
        'a collection of 200 OK resources (again)': {
            topic: test_utils.trackedResourcesTopic('200?id=aborter'),
            'that all get polled, but the process is aborted': {
                topic: function (err, resources, stats, expected_urls) {
                    var $this = this;

                    var left_to_start = 4;
                    var ended_ct = 0;
                    var poll_handle = null;

                    // Allow some polls to start, then attempt an abort
                    resources.on('poll:start', function (r) {
                        if (--left_to_start <= 0) {
                            process.nextTick(function () {
                                poll_handle.abort();
                            });
                        }
                    });
                    
                    // Count how many actually ended
                    resources.on('poll:end', function (r) { ended_ct++; });

                    // Finally start up the polling, with a concurrency that
                    // gives us a chance to abort.
                    poll_handle = resources.pollAll({
                        concurrency: left_to_start
                    }, function (err) {
                        $this.callback(err, ended_ct, resources, stats, expected_urls);
                    });
                    
                },
                'should result in not all of the resources having been polled':
                        function (err, ended_ct, resources, stats, expected_urls) {
                    
                    assert.equal(ended_ct, 4);

                    assert.deepEqual(stats.events._collection,
                        ['poll:allStart', 'poll:abort', 'poll:allEnd']);

                    var url_prefix = this.base_url + '200?id=aborter';
                    
                    for (var i=0; i<4; i++) {
                        assert.deepEqual(stats.events[url_prefix + i],
                                         ['poll:enqueue', 'poll:start',
                                          'poll:status_200', 'poll:end']);
                    }
                    
                    for (var j=4; j<9; j++) {
                        assert.deepEqual(stats.events[url_prefix + i],
                                         ['poll:enqueue']); 
                    }

                }
            }
        }
    }
});

// Topic that initializes common stuff
// (there's probably a better way to do this)
function initTopic () {
    var $this = this;
    
    this.httpd = test_utils.createTestServer(++BASE_PORT);
    this.base_url = 'http://localhost:' + BASE_PORT + '/';

    var msync = this.msync = new models_sync.HashSync();
    msync.open(function (err, sync_proxy) {
        $this.sync_proxy = sync_proxy;
        $this.callback();
    });
}

// Teardown for the initializer topic
function initTeardown () {
    this.msync.close();
    this.httpd.server.close();
}

// Produce a callback that asserts expected facts against a resource topic.
function assertResource(expected) {
    return function (err, r) {
        ['status_code', 'body'].forEach(function (name) {
            if (expected.equals && name in expected.equals) {
                assert.equal(r.get(name), expected.equals[name]);
            }
            if (expected.not_equals && name in expected.not_equals) {
                assert.notEqual(r.get(name), expected.not_equals[name]);
            }
            if (expected.truthy && name in expected.truthy) {
                var val = !!expected.truthy[name];
                assert.ok(!!r.get(name), val);
            }
        });
        if (null !== expected.error) {
            assert.equal(!!err, !!expected.error);
        }
        if (null !== expected.url_hit) {
            var path = r.get('resource_url').replace(this.base_url, '/');
            var result_hit = path in this.httpd.stats.urls;
            assert.equal(result_hit, !!expected.url_hit);
        }
        if (null !== expected.headers_empty) {
            var headers = r.get('headers');
            var headers_ct = _.keys(headers).length;
            assert.equal((headers_ct === 0), !!expected.headers_empty);
        }
    };
}

// Create a Resource with convenient testing defaults
function resource ($this, attrs) {
    attrs = _.defaults(attrs, {
        max_age: 0
    });
    attrs.resource_url = $this.base_url + attrs.resource_url;
    var r = new models.Resource(attrs);
    r.sync = $this.sync_proxy;
    return r;
}

// Create a topic that produces a Resource
function resourceTopic (attrs) {
    return function () {
        this.callback(null, resource(this, attrs));
    };
}

// Create a topic that tracks events for a single resource poll
function polledResourceTopic (attrs, poll_options) {
    return function () {
        var $this = this;
        var r = resource(this, attrs);
        var evs = [];
        r.on('all', function (ev, model) {
            if (model == r && /^poll:/.test(ev)) {
                evs.push(ev);
            }
        });
        r.poll(poll_options, function (err, r) {
            $this.callback(err, r, evs);
        });
    };
}

// Build a test for conditional get
function testConditionalGET (path) {
    return {
        topic: polledResourceTopic({
            resource_url: path,
            max_age: 0
        }),
        'and then polled again': {
            topic: function (err, r, evs) {
                var $this = this;
                r.poll({}, function (err, r) {
                    $this.callback(err, r, evs);
                });
            },
            'should result in expected content': function (err, r, evs) {
                assert.equal(r.get('body'), test_utils.TEST_BODY_200);
            },
            'should result in 200, then 304 status': function (err, r, evs) {
                assert.equal(r.get('status_code'), 304);
                assert.deepEqual(evs, [
                    'poll:start', 'poll:status_200', 'poll:end',
                    'poll:start', 'poll:status_304', 'poll:end'
                ]);
            }
        }
    };
}

if (process.argv[1] === __filename) {
    suite.run({error: false});
} else {
    suite.export(module, {error: false});
}
