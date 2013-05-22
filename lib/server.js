/*jshint node: true, expr: false, boss: true */
var util = require('util'),
    _ = require('underscore'),
    async = require('async'),
    url = require('url'),
    express = require('express'),
    socket_io = require('socket.io'),
    request = require('request'),
    async = require('async'),
    logger = require('winston'),
    ThumbExtractor = require('thumb-extractor'),
    FeedParser = require('feedparser'),
    Backbone = require('backbone'),
    cons = require('consolidate'),
    dust = require('dustjs-linkedin');

var models = require('./models'),
    models_sync = require('./models-sync');

function d (path) { return __dirname + '/../' + path; }

function Server () {
    this.init.apply(this, arguments);
}
_.extend(Server.prototype, {

    init: function (options) {
        var $this = this;

        this.options = _.defaults(options, {
            verbose: false,
            logger: null
        });

        this.poll_handle = null;
        
        this.resources = new models.ResourceCollection();

        this.resources.on('all', function (ev, r) {
            // util.debug('EV ' + ev + ' ' + r);
        });

        this.resources.on('poll:status_200', function (resource) {
            var feed_items = new models.FeedItemCollection();
            feed_items.parseResource(resource, 
                function (err, result) {
                    $this.resources.trigger('poll:parsed', resource, {
                        errors_ct: result.errors_ct,
                        new_items_ct: result.new_items.length,
                        parsed_ct: result.parsed.length
                    });
                }
            );
        });

        var app = this.app = express();

        app.configure(function () {
            app.engine('html', cons.dust);
            app.set('view engine', 'html');
            app.set('views', d('views'));

            app.use(_.bind($this._log, $this));

            app.use(express.bodyParser());
            app.use(express.methodOverride());
            app.use(app.router);
            app.use('/socket.io',
                express.static(d('node_modules/socket.io-client/dist')));
            app.use('/', express.static(d('static')));
        });

        app.get('/', this.renderView('index', {title: 'home'}));
        app.get('/poll', this.renderView('poll', {title: 'poll'}));
        app.get('/feeds', _.bind(this.viewFeeds, this));

        app.get('/thumb', function (request, response) {
            var parts = url.parse(request.url, true);
            var qs = parts.query;
            if (!qs.url) {
                response.writeHead(404, {});
                response.end();
            }
            try {
                ThumbExtractor.fetch(qs.url, function (err, thumb_url, kind) {
                    if (thumb_url) {
                        response.writeHead(301, {
                            'Location': thumb_url,
                            'X-Thumb-Kind': kind
                        });
                        response.end();
                    } else {
                        response.writeHead(404, {});
                        response.end();
                    }
                });
            } catch (e) {
                response.writeHead(500, {});
                response.end("ERROR: " + util.inspect(e));
            }
        });

    },
    
    listen: function () {
        var $this = this;

        logger.info("Server listening on port " + this.options.port);

        var server = this.server = this.app.listen(this.options.port);
        var io = this.io = socket_io.listen(server);
        io.set("log level", 0);
        io.sockets
            .on("connection", _.bind(this.pollSocketConnect, this));
        
        // Fire off a scheduled periodic poll
        /*
        setInterval(function () {
            logger.info("Starting periodic poll...");
            $this.startPoll(null, {
                max_age: 3600,
                concurrency: 8
            });
        }, 1000 * 60 * 30);
        */

        return this;
    },

    close: function () {
        if (this.server) {
            this.server.close();
        }
        return this;
    },

    pollSocketConnect: function (socket) {
        var $this = this;
        $this.resources.on('all', function (ev, r, detail) {
            if (/^poll:/.test(ev)) {
                var url = (r === $this.resources) ?
                    null : r.get('resource_url');
                socket.emit(ev, _.extend({
                    url: url,
                    status_code: r.get('status_code')
                }, detail || {}));
            }
        });
        _.functions(this).forEach(function (name) {
            var m = /^socketOn_(.*)/.exec(name);
            if (m) {
                socket.on(m[1], function (msg) {
                    return $this[m[0]](socket, msg);
                });
            }
        });
    },

    renderView: function (view, data) {
        return function (req, res) {
            res.render(view, data);
        };
    },

    startPoll: function (socket, msg) {
        var $this = this;
        if (socket && this.poll_handle) {
            return socket.emit('poll:inProgress');
        }
        $this.resources.fetch({
            success: function (collection, resp, options) {
                $this.poll_handle = $this.resources.pollAll(
                    msg || {},
                    function (err) {
                        $this.poll_handle = null;
                    }
                );
            }
        });
    },

    socketOn_echo: function (socket, msg) {
        socket.emit('echo', msg);
    },

    socketOn_startPoll: function (socket, msg) {
        this.startPoll(socket, msg);
    },

    socketOn_abortPoll: function (socket, msg) {
        var $this = this;
        if (!$this.poll_handle) {
            return socket.emit('poll:notInProgress');
        }
        $this.poll_handle.abort();
    },

    viewFeeds: function (req, res) {
        var resources = new models.ResourceCollection();
        var feed_items = new models.FeedItemCollection();

        var feeds = {};
        var r_map = {};

        feed_items.fetch({
            orderBy: '-published',
            limit: 1000,
            success: function (items, resp, options) {

                // Collect unique resource URLs from the set of items fetched.
                items.each(function (item) {
                    var r_url = item.get('resource_url');
                    r_map[r_url] = null; 
                });

                // Fetch the resources in parallel, then continue on with
                // building the view.
                async.each(_.keys(r_map), function (r_url, fe_next) {
                    var resource = new models.Resource({resource_url: r_url});
                    resource.collection = resources;
                    resource.fetch({
                        view: 'meta',
                        success: function (resource, resp, options) {
                            r_map[r_url] = resource.toJSON();
                            fe_next();
                        },
                        error: function (err) {
                            fe_next();
                        }
                    });
                }, function (err) {
                
                    // Collate items by their respective feeds.
                    items.each(function (item) {
                        var out = item.toJSON();
                        var r_url = out.resource_url;

                        out.resource = r_map[r_url];
                        
                        var parsed = url.parse(r_url);
                        out.resource_host = parsed.host;

                        if (!(r_url in feeds)) {
                            feeds[r_url] = [];
                        }
                        feeds[r_url].push(out);

                        return out;
                    });

                    // Sort each collated feed by newest.
                    var feed_newest = {};
                    _.each(feeds, function (items, r_url) {
                        items.sort(function (b, a) {
                            var ad = a.published;
                            var bd = b.published;
                            return (ad<bd) ? -1 : ( (ad>bd) ? 1 : 0 );
                        });
                        feed_newest[r_url] = items[0].published;
                    });

                    // Sort the collection of collated feed by newest item
                    var feed_sort = _.pairs(feed_newest);
                    feed_sort.sort(function (b, a) {
                        var ad = a[1];
                        var bd = b[1];
                        return (ad<bd) ? -1 : ( (ad>bd) ? 1 : 0 );
                    });

                    // Finally, build the view output of feeds and items in
                    // reverse-chronological order.
                    var feeds_out = feed_sort.map(function (i) {
                        var r_url = i[0];
                        return {
                            resource_url: r_url,
                            feed: r_map[r_url],
                            feed_updated: i[1],
                            items: feeds[r_url]
                        };
                    });

                    res.render('feeds', {
                        title: 'Feeds',
                        feeds: feeds_out
                    });

                });
            }
        });
    },

    _log: function (req, res, next) {
        var t_start = new Date();
        var end = res.end;
        res.end = function () {
            res.end = end;
            end.apply(res, arguments);
            logger.debug(util.format(
                req.method, req.originalUrl, res.statusCode,
                (new Date() - t_start) + 'ms',
                (res._headers['content-length'] || '---')
            ));
        };
        next();
    }
});

module.exports = Server;
