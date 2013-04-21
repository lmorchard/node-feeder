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
    },
    
    listen: function () {
        logger.info("Server listening on port " + this.options.port);
        var server = this.server = this.app.listen(this.options.port);
        var io = this.io = socket_io.listen(server);
        io.set("log level", 0);
        io.sockets
            .on("connection", _.bind(this.pollSocketConnect, this));
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
        $this.resources.on('all', function (ev, r, status) {
            if (/^poll:/.test(ev)) {
                var url = (r === $this.resources) ?
                    null : r.get('resource_url');
                socket.emit(ev, {
                    url: url,
                    status_code: r.get('status_code')
                });
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

    socketOn_echo: function (socket, msg) {
        socket.emit('echo', msg);
    },

    socketOn_startPoll: function (socket, msg) {
        var $this = this;
        $this.resources.fetch({
            success: function (collection, resp, options) {
                if ($this.poll_handle) {
                    return socket.emit('poll:inProgress');
                }
                $this.poll_handle = $this.resources.pollAll(
                    msg || {},
                    function (err) {
                        $this.poll_handle = null;
                    }
                );
            }
        });
    },

    socketOn_abortPoll: function (socket, msg) {
        var $this = this;
        if (!$this.poll_handle) {
            return socket.emit('poll:notInProgress');
        }
        $this.poll_handle.abort();
    },

    renderView: function (view, data) {
        return function (req, res) {
            res.render(view, data);
        };
    },

    viewFeeds: function (req, res) {
        var resources = new models.ResourceCollection();
        var _success = function (collection, resp, options) {
            var feeds = [];
            async.each(resources.models, function (r, e_next) {

                var body = r.get('body');
                if (!body) { return e_next(); }

                var url = r.get('resource_url');
                var items = [];
                var meta = null;

                var _next = _.once(function () {
                    feeds.push({
                        resource: r.pick('id', 'resource_url'),
                        meta: meta,
                        items: items.slice(0, 10)
                    });
                    e_next();
                });

                FeedParser.parseString(body)
                    .on('meta', function (meta_in) { meta = meta_in; })
                    .on('article', function (item) { items.push(item); })
                    .on('error', _next)
                    .on('end', _next);
                
            }, function (err) {
                res.render('feeds', {
                    title: 'FEEDS',
                    feeds: feeds
                });
            });
        };
        resources.fetch({success: _success});
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
