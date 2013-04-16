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

var DEFAULT_CONCURRENCY = 32;

function now () { return (new Date()).getTime(); }

var Resource = module.exports.Resource = Backbone.Model.extend({

    defaults: {
        "id": null,
        "resource_url": "",
        "disabled": false,

        "timeout": 1000 * 5, // 5 seconds
        "max_age": 1000 * 60 * 60, // 1 hour

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
        if (age < this.get('max_age')) {
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

        var prev_headers = this.get('headers');

        // Conditional GET support...
        if (prev_headers['etag']) {
            opts.headers['If-None-Match'] = prev_headers['etag'];
        }
        if (prev_headers['last-modified']) {
            opts.headers['If-Modified-Since'] = prev_headers['last-modified'];
        }

        var req = request(opts, function (err, resp, body) {
            
            if (err) {
                if ('ETIMEDOUT' == err.code || 'ESOCKETTIMEDOUT' == err.code) {
                    $this.set({
                        // TODO: This is a bogus status. Pick something better?
                        // http://en.wikipedia.org/wiki/List_of_HTTP_status_codes#408
                        status_code: 408,
                        last_error: err.code
                    });
                } else {
                    $this.set({
                        // TODO: This is a bogus status. Pick something better?
                        // http://en.wikipedia.org/wiki/List_of_HTTP_status_codes#499
                        status_code: 499,
                        last_error: '' + err
                    });
                }
            } else {
                if (200 == resp.statusCode) {
                    $this.set('body', body);
                }
                $this.set({
                    status_code: resp.statusCode,
                    headers: resp.headers
                });
            }

            $this.trigger('poll:status_' + $this.get('status_code'), $this);

            $this.save({
                last_validated: t_now
            }, {
                success: function (model, resp, options) {
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

        $this.trigger('poll:allStart', $this);

        options = _.defaults(options, {
            concurrency: DEFAULT_CONCURRENCY
        });

        var queue = async.queue(function (item, q_next) {
            item.poll(options, q_next);
        }, options.concurrency);

        queue.drain = function (err) {
            $this.trigger('poll:allEnd', $this);
            next(err);
        }

        this.each(function (r) {
            $this.trigger('poll:enqueue', r);
            queue.push(r);
        });
    }

});
