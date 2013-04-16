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

        var _next = _.once(function (err, r) {
            $this.trigger('poll:end', $this);
            next(err, r);
        });

        // Bail out if this resource is disabled.
        if (this.get('disabled')) {
            process.nextTick(function () {
                _next(null, $this);
            }); 
            return this;
        }

        $this.trigger('poll:start', $this);

        // Skip poll if stored content is newer than max_age.
        var age = t_now - this.get('last_validated');
        if (age < this.get('max_age')) {
            process.nextTick(function () {
                _next(null, $this);
            }); 
            return this;
        }
        
        var opts = {
            method: 'GET',
            url: this.get('resource_url'),
            timeout: this.get('timeout'),
            encoding: 'utf-8',
            jar: false,
            // followRedirect: false
        };

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
                    _next(err, $this);
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

        var queue = async.queue(function (item, q_next) {
            item.poll(options, q_next);
        }, options.concurrency);

        queue.drain = next;

        this.chain()
            .filter(function (r) {
                return !r.get('disabled');
            })
            .each(function (r) {
                queue.push(r);
            });
    }

});
