var util = require('util'),
    crypto = require('crypto'),
    uuid = require('node-uuid');
    _ = require('underscore'),
    url = require('url'),
    http = require('http'),
    https = require('https'),
    request = require('request'),
    Backbone = require('backbone');

var Resource = module.exports.Resource = Backbone.Model.extend({

    defaults: {
        "id": null,
        "resource_url": "",
        "disabled": false,

        "title": "",
        "description": "",

        "status_code": 0,
        "headers": {},
        "body": "",
    
        "last_validated": 0,
        "last_error": null,
        "status_history": []
    },

    initialize: function (options) {
        if (!options.id) {
            this.set('id', this._genID());
        }
    },

    validate: function (attrs, options) {
        if (!attrs.resource_url) {
            return "resource_url is required";
        }
    },

    urlRoot: '/resources/',

    _genID: function () {
        // return uuid.v1();
        return crypto.createHash('md5')
            .update(this.url())
            .digest('hex');
    },

    poll: function (next) {
        var $this = this;
        var now = (new Date()).getTime();

        // Do not poll if this resource is disabled.
        if (this.get('disabled')) { process.nextTick(next); }
        
        var url = this.get('resource_url');

        request(url, function (err, resp, body) {
            if (err) {
                return next(err, null);
            }
            
            $this.save({
                last_validated: now,
                status_code: resp.statusCode,
                headers: resp.headers,
                body: body
            }, {
                success: function (model, resp, options) {
                    return next(null, $this);
                }
            });
        });
    }

});

var ResourceCollection = module.exports.ResourceCollection = Backbone.Collection.extend({
    model: Resource,
    url: '/resources/'
});
