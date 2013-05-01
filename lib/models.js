/*jshint node: true, expr: false, boss: true */

var util = require('util'),
    crypto = require('crypto'),
    uuid = require('node-uuid');
    _ = require('underscore'),
    logger = require('winston'),
    async = require('async'),
    url = require('url'),
    request = require('request'),
    async = require('async'),
    url = require('url'),
    FeedParser = require('feedparser'),
    Backbone = require('backbone');

var DEFAULT_CONCURRENCY = 64;
var DEFAULT_TIMEOUT = 1000 * 5; // 5 seconds
var DEFAULT_MAX_AGE = 1000 * 60 * 60; // 1 hour

var SAVE_QUEUE_CONCURRENCY = 15;

function now () { return (new Date()).getTime(); }

BaseModel = Backbone.Model.extend({
    sync: function() {
        var sync_fn = (this.collection) ?
            this.collection.sync : Backbone.sync;
        return sync_fn.apply(this, arguments);
    }
});

BaseCollection = Backbone.Collection.extend({
});

Resource = BaseModel.extend({

    urlRoot: '/resources/',
    
    defaults: {
        "resource_url": "",
        "disabled": false,

        "timeout": DEFAULT_TIMEOUT,
        "max_age": DEFAULT_MAX_AGE,

        "encoding": "utf-8",
        "title": "",
        "meta": {},

        "status_code": 0,
        "headers": {},
        "body": "",
    
        "last_validated": 0,
        "last_error": null,

        "history": [],

        "modified": null,
        "created": null
    },

    hash: function () {
        var r_url = this.get('resource_url');
        return crypto.createHash('md5').update(r_url).digest('hex');
    },

    validate: function (attrs, options) {
        if (!attrs.resource_url) {
            return "resource_url is required";
        }
    },

    poll: function (options, next) {
        var $this = this;
        var t_now = now();

        options = _.defaults(options || {}, {
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
                    var status = $this.get('status_code');
                    var status_ev = 'poll:status_' + status;
                    $this.trigger(status_ev, $this);
                    _next(err);
                }
            });
        });
        return this;
    }

});

ResourceCollection = BaseCollection.extend({

    url: '/resources/',
    
    model: Resource,

    pollAll: function (options, next) {
        var $this = this;

        if (this.is_polling) { return; }
        this.is_polling = true;

        options = _.defaults(options, {
            concurrency: DEFAULT_CONCURRENCY
        });

        var _next = function (err) {
            $this.is_polling = false;
            next(err);
        };

        var handle = {};

        var should_abort = false;
        handle.abort = _.once(function () {
            should_abort = true;
            $this.trigger('poll:abort', $this);
        });

        $this.trigger('poll:allStart', $this);
        if (!this.length) {
            $this.trigger('poll:allEnd', $this);
            return _next();
        }

        var poll_options = _.extend(_.clone(options), {
            agent_pool: {maxSockets: options.concurrency}
        });

        var queue = async.queue(function (item, q_next) {
            // Bail on the rest of the queue, if we're aborting.
            if (should_abort) { return q_next(); }
            // Otherwise carry on with the next resource poll.
            item.poll(poll_options, q_next);
        }, options.concurrency);

        queue.drain = function (err) {
            $this.trigger('poll:allEnd', $this);
            handle.abort = function () {};
            _next(err);
        };

        this.each(function (r) {
            $this.trigger('poll:enqueue', r);
            queue.push(r);
        });

        return handle;
    }

});

FeedItem = BaseModel.extend({
    urlRoot: '/feed-items/',
    
    defaults: {
        "resource_url": null,

        "title": '',
        "description": '',
        "summary": '',
        "author": '',
        "comments": '',
        "image": '',
        "published": '',
        "enclosures": '',
        "guid": '',
        "link": '',
        "parsed": '',

        "modified": '',
         
        "created": ''
    },

    hash: function () {
        var hash = crypto.createHash('md5');
        var guid = this.get('guid');
        if (guid) {
            hash.update(guid);
        } else {
            hash.update(this.get('link'));
            hash.update(this.get('title'));
        }
        return hash.digest('hex');
    }
});

FeedItemCollection = BaseCollection.extend({
    url: '/feed-items/',
    model: FeedItem,

    parseResource: function (resource, next) {
        var $this = this;

        var errors_ct = 0;
        var parsed = [];
        var new_items = [];

        var _next = function (err) {
            next(err, {
                parsed: parsed,
                new_items: new_items,
                errors_ct: errors_ct
            });
        };

        var body = resource.get('body');
        if (!body) { return _next(); }

        FeedParser.parseString(body, {addmeta: false})
            .on('meta', function (meta) {
                resource.save({meta: meta});
            })
            .on('article', function (item) {
                parsed.push({
                    resource_url: resource.get('resource_url'),
                    title: item.title,
                    description: item.description,
                    summary: item.summary,
                    author: item.author,
                    comments: item.comments,
                    image: item.image,
                    published: item.date,
                    enclosures: item.enclosures,
                    link: item.link,
                    guid: item.guid,
                    parsed: item
                });
            })
            .on('error', function (e) {
                errors_ct++;
            })
            .on('end', function () {
                $this.add(parsed);
                $this.sync('batch', $this, {
                    success: function (successes, errors) {
                        new_items = successes;
                        _next();
                    }
                });
            });
    }
});

Subscription = BaseModel.extend({
    urlRoot: '/subscriptions/',
    defaults: {
        "resource_id": null,
        "owner_id": null
    }
});

SubscriptionCollection = BaseCollection.extend({
    url: '/subscriptions/',
    model: Subscription
});

['Resource', 'ResourceCollection',
    'Subscription','SubscriptionCollection',
    'FeedItem', 'FeedItemCollection'
].forEach(function (name) {
    module.exports[name] = global[name];
});
