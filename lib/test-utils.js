/*jshint node: true, expr: false, boss: true, evil: true */

var util = require('util'),
    express = require('express'),
    request = require('request'),
    fs = require('fs'),
    async = require('async'),
    vows = require('vows'),
    assert = require('assert'),
    path = require('path'),
    _ = require('underscore');

function d (p) { return __dirname + '/../test/' + p; }
function r (p) { return require(__dirname + '/' + p); }

var models = r('models'),
    models_sync = r('models-sync');

var SHORT_DELAY = 25;
var MED_DELAY = 100;
var LONG_DELAY = 5000;

var TEST_PATH_1 = 'fixtures/movies.opml';
var TEST_BODY_1 = fs.readFileSync(d(TEST_PATH_1));
var TEST_BODY_200 = 'THIS IS 200 CONTENT';
var TEST_BODY_500 = '500 ERROR CONTENT NO ONE SHOULD SEE';

var MAX_CONCURRENCY = 3;

['TEST_PATH_1', 'TEST_BODY_1', 'TEST_BODY_200', 'TEST_BODY_500',
    'SHORT_DELAY', 'MED_DELAY', 'LONG_DELAY', 'MAX_CONCURRENCY'
].forEach(function (name) {
    module.exports[name] = eval(name);
});

// Creates an HTTP server for fixtures and contrived responses
module.exports.createTestServer = function createTestServer (port) {
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

        // 200seq - repeated requests cycle through a sequence of fixtures
        var seqs = {};
        app.get('/200seq/:fn', function (req, res) {
            var fn = req.params.fn;
            if (!_.has(seqs, fn)) { seqs[fn] = 0; }
            seqs[fn]++;
            function _fn () {
                return d('fixtures/' + fn.replace(/\$\$/, seqs[fn]));
            }
            var out_fn = _fn();
            if (!fs.existsSync(_fn())) {
                seqs[fn] = 1;
                out_fn = _fn();
            }
            var data = fs.readFileSync(out_fn);
            res.send(data);
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

    var server = app.listen(port || BASE_PORT);

    return {
        app: app,
        server: server, 
        stats: stats,
        base_url: 'http://localhost:' + port + '/'
    };
};

var trackedResources = module.exports.trackedResources = function ($this) {
    var resources = new models.ResourceCollection();
    resources.sync = $this.sync_proxy;

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

    return [resources, stats];
};

module.exports.trackedResourcesTopic = function trackedResourcesTopic(url_prefix, with_disabled) {
    return function () {
        var $this = this;

        var r = trackedResources(this);
        var resources = r[0];
        var stats = r[1];

        var expected_urls = [];
        var attrs = [];
        for (var i = 0; i < MAX_CONCURRENCY * 3; i++) {
            var url = $this.base_url + url_prefix + i;
            expected_urls.push(url);
            attrs.push({
                title: 'Resource ' + i,
                resource_url: url
            });
        }

        if (with_disabled) {
            attrs.push({
                title: 'Resource disabled',
                resource_url: $this.base_url + url_prefix + '-disabled',
                disabled: true
            });
        }

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
    };
};
