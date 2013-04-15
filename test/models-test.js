var util = require('util'),
    express = require('express'),
    request = require('request'),
    fs = require('fs'),
    vows = require('vows'),
    assert = require('assert'),
    path = require('path'),
    _ = require('underscore');

function r (p) { return require(__dirname + '/../lib/' + p); }

var models = r('models');
var models_sync = r('models-sync');

function d (p) { return __dirname + '/' + p; }

var TEST_DB = d('test.db');
var MOVIES_OPML = d('fixtures/movies.opml');
var TEST_PORT = '9001';
var BASE_URL = 'http://localhost:' + TEST_PORT + '/';

process.on('uncaughtException', function (err, data) {
    util.error("EXCEPTION " + util.inspect(arguments));
    util.error(err.stack);
});

// Creates an HTTP server for fixtures
function createTestServer (port) {
    var app = express();
    var stats = { urls: {}, hits: [] };
    app.configure(function () {
        app.use(express.logger({
            format: ':method :url :status :res[content-length]' +
                    ' - :response-time ms'
        }));
        app.use(function (req, res, mw_next) {
            var url = req.originalUrl;
            if (url in stats.urls) {
                stats.urls[url]++;
            } else {
                stats.urls[url] = 1;
            }
            stats.hits.push(req.originalUrl);
            setTimeout(mw_next, 10);
        });
        app.use('/200s', function (req, res) {
            res.send(200, '200 from ' + req.originalUrl);
        });
        app.use('/301s', function (req, res) {
            res.send(301, '301 from ' + req.originalUrl);
        });
        app.use('/302s', function (req, res) {
            res.send(302, '302 from ' + req.originalUrl);
        });
        app.use('/404s', function (req, res) {
            res.send(404, '404 from ' + req.originalUrl);
        });
        app.use('/410s', function (req, res) {
            res.send(410, '410 from ' + req.originalUrl);
        });
        app.use('/500s', function (req, res) {
            res.send(500, '500 from ' + req.originalUrl);
        });
        app.use(express['static'](d('fixtures')));
    });
    var server = app.listen(port || TEST_PORT);
    return {
        app: app,
        server: server, 
        stats: stats
    };
}

var suite = vows.describe('Basic tests');

var TEST_PATH_1 = 'movies.opml';
var TEST_BODY_1 = fs.readFileSync(d('fixtures/'+TEST_PATH_1));

function assertResource(expected) {
    return function (r) {
        ['status_code', 'body'].forEach(function (name) {
            if (name in expected) {
                assert.equal(expected[name], r.get(name));
            }
        });

        var path = r.get('resource_url').replace(BASE_URL, '/');
        var result_hit = path in this.httpd.stats.urls;
        assert.equal(!!expected.url_hit, result_hit);

        var headers = r.get('headers');
        var headers_ct = _.keys(headers).length;
        assert.equal(!!expected.headers_empty, (headers_ct == 0));
    };
}

suite.addBatch({
    'a clean DB and an HTTP server': {
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
        'and a single resource': {
            topic: function () {
                return new models.Resource({
                    resource_url: BASE_URL + TEST_PATH_1
                });
            },
            'should start with no data': assertResource({
                status_code: 0, body: '',
                headers_empty: true, url_hit: false
            }),
            'that has been polled': {
                topic: function (r) {
                    r.poll(this.callback);
                },
                'should result in a GET to the resource URL': assertResource({
                    status_code: 200, body: TEST_BODY_1,
                    headers_empty: false, url_hit: true
                })
            }
        },
        'and a load of resources': {
            topic: function () {
                var $this = this;

                var feeds = [];
                var resources = new models.ResourceCollection();
                var OpmlParser = require('opmlparser');

                fs.createReadStream(MOVIES_OPML)
                    .pipe(new OpmlParser())
                    .on('feed', function (feed) {
                        var r = resources.create({
                            title: feed.title,
                            resource_url: feed.xmlUrl || feed.xmlurl
                        });
                        feeds.push(r);
                    })
                    .on('end', function () {
                        $this.callback(null, resources, feeds);
                    });
            },
            /*
            "PPLAYU": function (resources, feeds) {
                assert.ok(true);
            }
            */
        },
    }
});

// run or export the suite.
if (process.argv[1] === __filename) suite.run();
else suite.export(module);
