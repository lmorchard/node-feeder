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

        // Bail out if this resource is disabled.
        if (this.get('disabled')) {
            process.nextTick(function () {
                next(null, $this);
            }); 
            return this;
        }

        // Skip poll if stored content is newer than max_age.
        var age = t_now - this.get('last_validated');
        if (age < this.get('max_age')) {
            process.nextTick(function () {
                next(null, $this);
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

        var req = request(opts, _.once(function (err, resp, body) {
            
            if (err) {
                if ('ETIMEDOUT' == err.code || 'ESOCKETTIMEDOUT' == err.code) {
                    $this.set('status_code', 408);
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

            $this.save({
                last_validated: t_now
            }, {
                success: function (model, resp, options) {
                    return next(err, $this);
                }
            });

        }));

        return this;
    }

});

var ResourceCollection = module.exports.ResourceCollection = Backbone.Collection.extend({
    url: '/resources/',
    model: Resource,

    pollAll: function (options, next) {
        var $this = this;
        var to_poll = this.filter(function (r) {
            return !r.get('disabled');
        });
        async.each(to_poll, function (item, fe_next) {
            item.poll(options, fe_next);
        }, function (err) {
            next(err);
        });
    }
});
