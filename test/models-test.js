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
    models_sync = r('models-sync');

function d (p) { return __dirname + '/' + p; }

var MOVIES_OPML = d('fixtures/movies.opml');
var TEST_PORT = '9001';
var BASE_URL = 'http://localhost:' + TEST_PORT + '/';

var SHORT_DELAY = 25;
var MED_DELAY = 100;
var LONG_DELAY = 5000;

var MAX_CONCURRENCY = 3;

var TEST_PATH_1 = 'fixtures/movies.opml';
var TEST_BODY_1 = fs.readFileSync(d(TEST_PATH_1));
var TEST_BODY_200 = 'THIS IS 200 CONTENT';
var TEST_BODY_500 = '500 ERROR CONTENT NO ONE SHOULD SEE';

var suite = vows.describe('Model tests');

suite.addBatch({
    '...': {
        topic: function () {
            var $this = this;
            this.httpd = createTestServer();
            this.msync = new models_sync.LocmemSync()
                .open(function (err, sync_handler) {
                    var Backbone = require('backbone');
                    Backbone.sync = sync_handler;
                    $this.callback();
                });
        },
        teardown: function () {
            this.msync.close();
            this.httpd.server.close();
        },
        'a resource': {
            topic: function () {
                this.callback(null, new models.Resource({
                    resource_url: BASE_URL + TEST_PATH_1,
                    max_age: 0
                }));
            },
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
                    equals: { status_code: 200, body: TEST_BODY_1 },
                    truthy: { last_validated: true },
                    headers_empty: false,
                    url_hit: true
                })
            },
            'that has been polled (again)': {
                topic: function (err, r) {
                    r.poll({}, this.callback);
                },
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
            topic: trackedResourcePoll({
                resource_url: BASE_URL + TEST_PATH_1,
                disabled: true,
                max_age: 0
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
            topic: function () {
                var r = new models.Resource({
                    resource_url: BASE_URL + 'delayed',
                    max_age: 0,
                    timeout: SHORT_DELAY * 2
                });
                r.poll({}, this.callback);
            },
            'should result in an aborted GET and an error': assertResource({
                equals: { status_code: 408, body: '' },
                error: true,
                headers_empty: true,
                url_hit: null
            })
        },
        'a 200-then-500 resource that has been polled twice': {
            topic: function () {
                var $this = this;
                var r = new models.Resource({
                    resource_url: BASE_URL + '200then500',
                    max_age: 0
                });
                r.poll({}, function (err, r) {
                    assert.equal(r.get('status_code'), 200);
                    assert.equal(r.get('body'), TEST_BODY_200);
                    r.poll({}, $this.callback);
                });
            },
            'should result in 500 status, yet body content from previous 200 OK': assertResource({
                equals: { status_code: 500, body: TEST_BODY_200 },
                error: false,
                headers_empty: null,
                url_hit: null
            })
        },
        
        'a resource that supports If-None-Match and yields ETag when polled':
            testConditionalGET('supports-if-none-match'),
        
        'a resource that supports If-Modified-Since and yields Last-Modified when polled':
            testConditionalGET('supports-if-modified-since'),

        'a resource with a long max_age': {
            topic: trackedResourcePoll({
                resource_url: BASE_URL + '200?id=pollMeThrice',
                max_age: SHORT_DELAY * 5
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
                        }, SHORT_DELAY * 10);
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
            topic: function () {
                var $this = this;

                var resources = new models.ResourceCollection();
                var stats = trackResources(resources);

                var expected_urls = [];
                var attrs = [];
                for (var i = 0; i < MAX_CONCURRENCY * 3; i++) {
                    var url = BASE_URL + '200?id=loadOfResources-' + i;
                    expected_urls.push(url);
                    attrs.push({
                        title: 'Resource ' + i,
                        resource_url: url
                    });
                }

                attrs.push({
                    title: 'Resource disabled',
                    resource_url: BASE_URL + '200?id=loadOfResources-disabled',
                    disabled: true
                });

                var created = [];
                async.each(attrs, function (item, fe_next) {
                    resources.create(item, {
                        success: function (model, resp, options) {
                            created.push(model);
                            fe_next();
                        }
                    });
                }, function (err) {
                    $this.callback(err, resources, stats, expected_urls);
                });
            },
            'that all get polled': {
                topic: function (err, resources, stats, expected_urls) {
                    var $this = this;
                    resources.pollAll({
                        concurrency: MAX_CONCURRENCY
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
                        var path = url.replace(BASE_URL, '/');
                        assert.equal(this.httpd.stats.urls[path], 1);
                    }
                },
                'should result in a poll:disabled event for the disabled resource':
                        function (err, resources, stats, expected_urls) {
                    var url = BASE_URL + '200?id=loadOfResources-disabled';
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
                    assert.ok(stats.max_concurrency <= MAX_CONCURRENCY);
                }
            }
        }
    }
});

// Creates an HTTP server for fixtures and contrived responses
function createTestServer (port) {
    var app = express();
    var stats = { urls: {}, hits: [] };
    app.configure(function () {
        
        if (false) app.use(express.logger({
            format: ':method :url :status :res[content-length]' +
                    ' - :response-time ms'
        }));

        app.use(function (req, res, mw_next) {
            // Record some stats about this request.
            var url = req.originalUrl;
            if (url in stats.urls) {
                stats.urls[url]++;
            } else {
                stats.urls[url] = 1;
            }
            stats.hits.push(req.originalUrl);
            // Requests get an artificial delay, to shake out async problems.
            setTimeout(mw_next, SHORT_DELAY / 2);
        });

        // fixtures - serve up model fixtures
        app.use('/fixtures', express.static(d('fixtures')));
        
        // delayed - intentionally delayed response
        app.use('/delayed', function (req, res) {
            setTimeout(function () {
                res.send(200, 'Delayed response');
            }, LONG_DELAY);
        });

        // 200 - always responds with 200 OK
        app.use('/200', function (req, res) {
            res.send(200, '200 from ' + req.originalUrl);
        });

        // 200then500 - alternate between 200 OK and 500 Server Error
        var ct_200then500 = 0;
        app.use('/200then500', function (req, res) {
            if (ct_200then500++ % 2) {
                res.send(500, TEST_BODY_500);
            } else {
                res.send(200, TEST_BODY_200);
            }
        });

        // supports-if-none-match
        var ETAG = '"I LIKE PIE"';
        app.use('/supports-if-none-match', function (req, res) {
            res.set('ETag', ETAG);
            if (req.get('If-None-Match') == ETAG) {
                res.send(304, '');
            } else {
                res.send(200, TEST_BODY_200);
            }
        });

        // supports-if-modified-since
        var LAST_MODIFIED = 'Tue, 16 Apr 2013 12:45:26 GMT';
        app.use('/supports-if-modified-since', function (req, res) {
            res.set('Last-Modified', LAST_MODIFIED);
            // HACK: This should really parse the date and actually check
            // modified since.
            if (req.get('If-Modified-Since') == LAST_MODIFIED) {
                res.send(304, '');
            } else {
                res.send(200, TEST_BODY_200);
            }
        });

    });

    var server = app.listen(port || TEST_PORT);

    return {
        app: app,
        server: server, 
        stats: stats,
        BASE_URL: 'http://localhost:' + port + '/'
    };
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
            var path = r.get('resource_url').replace(BASE_URL, '/');
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

// Create and track events for a single resource poll
function trackedResourcePoll (attrs) {
    return function () {
        var $this = this;
        var args = Array.prototype.splice.call(arguments,0);
        
        var r = new models.Resource(attrs);
        var evs = [];
        r.on('all', function (ev, model) {
            if (model == r && /^poll:/.test(ev)) {
                evs.push(ev);
            }
        });

        // Cumbersome, but ensure (err, r, evs) are the first three callback
        // parameters, yet include the rest that may have come in.
        var err = args.shift();
        args.unshift(evs);
        args.unshift(r);
        args.unshift(err);

        r.poll({}, function (err, r) {
            $this.callback.apply($this, args);
        });
    };
}

// Build a test for conditional get
function testConditionalGET (path) {
    return {
        topic: trackedResourcePoll({
            resource_url: BASE_URL + path,
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
                assert.equal(r.get('body'), TEST_BODY_200);
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

// Track events produced by a collection of resources.
function trackResources (resources) {
    var stats = {
        events: {
            '_collection': []
        },
        urls: [],
        max_concurrency: 0
    };

    var curr_concurrency = 0;
    
    resources.on('all', function (ev, model) {
        var url = model.get('resource_url');
        if ('add' == ev) {
            stats.urls.push(url);
            stats.events[url] = [];
        }
        if (/^poll:/.test(ev)) {
            // HACK: No URL is a special case - events from the collection itself.
            if (!url) { url = '_collection'; }

            stats.events[url].push(ev);
            
            if ('poll:start' == ev) { curr_concurrency++; }
            if ('poll:end' == ev)   { curr_concurrency--; }
            if (curr_concurrency > stats.max_concurrency) {
                stats.max_concurrency = curr_concurrency;
            }
        }
    });

    return stats;
}

if (process.argv[1] === __filename) {
    suite.run({error: false});
} else {
    suite.export(module, {error: false});
}
