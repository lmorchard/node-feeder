/*jshint node: true, expr: false, boss: true */

var util = require('util'),
    crypto = require('crypto'),
    uuid = require('node-uuid');
    _ = require('underscore'),
    async = require('async'),
    url = require('url'),
    http = require('http'),
    https = require('https'),
    request = require('request'),
    async = require('async'),
    url = require('url'),
    Backbone = require('backbone');

var DEFAULT_CONCURRENCY = 64;
var DEFAULT_TIMEOUT = 1000 * 5; // 5 seconds
var DEFAULT_MAX_AGE = 1000 * 60 * 60; // 1 hour

function now () { return (new Date()).getTime(); }

var Resource = module.exports.Resource = Backbone.Model.extend({

    defaults: {
        "id": null,
        "resource_url": "",
        "disabled": false,

        "timeout": DEFAULT_TIMEOUT,
        "max_age": DEFAULT_MAX_AGE,

        "title": "",
        "description": "",
        "encoding": "utf-8",

        "last_validated": 0,
        "last_error": null,

        "status_code": 0,
        "headers": {},
        "body": "",
    
        "history": []
    },

    urlRoot: '/resources/',

    initialize: function (options) {
        if (!options.id) {
            // var id = uuid.v1();
            var r_url = options.resource_url || this.get('resource_url');
            var id = crypto.createHash('md5').update(r_url).digest('hex');
            this.set('id', id);
        }
    },

    validate: function (attrs, options) {
        if (!attrs.resource_url) {
            return "resource_url is required";
        }
    },

    poll: function (options, next) {
        var $this = this;
        var t_now = now();

        options = _.defaults(options, {
            // max_age - not used when not present.
        });

        $this.trigger('poll:start', $this);

        // Common exit point
        var _next = _.once(function (err, r) {
            $this.trigger('poll:end', $this);
            next(err, $this);
        });

        // Bail out if this resource is disabled.
        if (this.get('disabled')) {
            process.nextTick(function () {
                $this.trigger('poll:disabled', $this);
                _next();
            }); 
            return this;
        }

        // Skip poll if stored content is newer than max_age.
        var age = t_now - this.get('last_validated');
        var max_age = ('max_age' in options) ?
            options.max_age : this.get('max_age');
        if (age < max_age) {
            process.nextTick(function () {
                $this.trigger('poll:fresh', $this);
                _next();
            });
            return this;
        }
        
        // Request options
        var opts = {
            method: 'GET',
            url: this.get('resource_url'),
            timeout: this.get('timeout'),
            encoding: this.get('encoding'),
            jar: false,
            headers: {}
            // TODO: Track 3xx redirects, update resource URL on 301
            // followRedirect: false
        };

        if (options.agent_pool) {
            // poolAll() sets up an agent pool with a maxSockets to support
            // desired concurrency
            opts.pool = options.agent_pool;
        }

        // Conditional GET support...
        var prev_headers = this.get('headers');
        if (prev_headers.etag) {
            opts.headers['If-None-Match'] = prev_headers.etag;
        }
        if (prev_headers['last-modified']) {
            opts.headers['If-Modified-Since'] = prev_headers['last-modified'];
        }

        var req = request(opts, function (err, resp, body) {
            if (err) {
                if ('ETIMEDOUT' == err.code || 'ESOCKETTIMEDOUT' == err.code) {
                    $this.set({status_code: 408, last_error: err.code});
                } else {
                    $this.set({status_code: 499, last_error: '' + err});
                }
            } else {
                $this.set({
                    status_code: resp.statusCode,
                    headers: resp.headers
                });
                if (200 == resp.statusCode) {
                    $this.set('body', body);
                }
            }
            $this.save({last_validated: t_now}, {
                success: function (model, resp, options) {
                    var status_ev = 'poll:status_' + $this.get('status_code');
                    $this.trigger(status_ev, $this);
                    _next(err);
                }
            });
        });
        return this;
    }

});

var ResourceCollection = module.exports.ResourceCollection = Backbone.Collection.extend({

    url: '/resources/',
    
    model: Resource,

    pollAll: function (options, next) {
        var $this = this;

        options = _.defaults(options, {
            concurrency: DEFAULT_CONCURRENCY
        });

        $this.trigger('poll:allStart', $this);
        if (!this.length) {
            $this.trigger('poll:allEnd', $this);
            return next();
        }

        var poll_options = _.extend(_.clone(options), {
            agent_pool: {maxSockets: options.concurrency}
        });

        var queue = async.queue(function (item, q_next) {
            item.poll(poll_options, q_next);
        }, options.concurrency);

        queue.drain = function (err) {
            $this.trigger('poll:allEnd', $this);
            next(err);
        };

        this.each(function (r) {
            $this.trigger('poll:enqueue', r);
            queue.push(r);
        });
    }

});
