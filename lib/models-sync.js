// ## Backbone sync handlers for models
var util = require('util'),
    async = require('async'),
    _ = require('underscore'),
    Backbone = require('backbone'),
    uuid = require('node-uuid');

var getUrl = function(object) {
    if (object.url instanceof Function) {
        return object.url();
    } else if (typeof object.url === 'string') {
        return object.url;
    }
};

// ### BaseSync: base class for all sync handlers
function BaseSync (options) {
    this.init(options);
}
_.extend(BaseSync.prototype, {
    init: function (options) {
        this.options = _.defaults(options || {}, this.defaults);
    },
    open: function (next) {
        var $this = this;
        if (next) {
            process.nextTick(function () {
                next(null, $this.getSync());
            }); 
        }
        return this;
    },
    close: function (next) {
        if (next) { process.nextTick(next); }
        return this;
    },
    getSync: function () { 
        return _.bind(this.sync, this); 
    },
    sync: function (method, model, options) {
        var now = (new Date()).getTime(),
            noop = function () {};

        options.success = options.success || noop;
        options.error = options.error || noop;

        if ('create' == method || 'update' == method) {
            options.data = model.toJSON();
            options.data.modified = model.attributes.modified = now;
        }

        if ('create' == method) {
            if (!model.id) { 
                if (_.isFunction(model.hash)) {
                    model.id = model.attributes.id = model.hash();
                } else {
                    model.id = model.attributes.id = uuid.v1();
                }
            }
            if (!options.data.created) {
                options.data.created = model.attributes.created = now;
            }
        }

        if (options.data) {
            options.data.id = model.id;
        }

        if (_.isFunction(this['sync_'+method])) {
            // Allow dispatch to methods on the object, if found.
            return this['sync_'+method](model, options);
        } else {
            return error("unimplemented");
        }
    },
    // By default, create is the same as update, but can be overridden.
    sync_create: function (model, options) {
        return this.sync_update(model, options);
    }
});

// TODO: FilesystemSync? key->filename / value->contents
// TODO: CouchdbSync?
// TODO: MySQLSync?
// TODO: RiakSync?

// ### LocmemSync: sync backbone to local memory
function LocmemSync (options) {
    this.init(options);
}
_.extend(LocmemSync.prototype, BaseSync.prototype, {
    open: function (next) {
        this.store = {};
        return BaseSync.prototype.open.call(this, next);
    },
    sync_update: function (model, options) {
        this.store[getUrl(model)] = options.data; 
        return options.success(options.data);
    },
    sync_delete: function (model, options) {
        delete this.store[getUrl(model)];
        return options.success({});
    },
    sync_read: function (model, options) {
        if ('model' in model) {
            return options.success(_(this.store).values());
        } else {
            return options.success(this.store[getUrl(model)]);
        }
    }
});

// In-memory cache of opened node-dirty databases
var _dirty_dbs = {};

// ### DirtySync: sync backbone to node-dirty
// Because [backbone-dirty][] has fallen quite a bit out of date.
// [backbone-dirty]: https://github.com/developmentseed/backbone-dirty
function DirtySync (options) {
    this.init(options);
}
_.extend(DirtySync.prototype, BaseSync.prototype, {
    open: function (next) {
        if (!next) { next = function (){}; }
        var $this = this,
            db_name = this.options.db_name;
        if (!(db_name in _dirty_dbs)) {
            _dirty_dbs[db_name] = require('dirty')(db_name);
        }
        this.db = _dirty_dbs[db_name];
        this.db.on('load', function () {
            next(null, $this.getSync());
        });
        return this;
    },
    close: function (next) {
        if (!next) { next = function (){}; }
        if (!this.db._queue.length) { 
            process.nextTick(next);
        } else {
            // HACK: This isn't really public API, but so what.
            this.db._flush();
            this.db.on('drain', next);
        }
        return this;
    },
    sync_update: function (model, options) {
        this.db.set(getUrl(model), options.data, function (err) {
            return (err) ? options.error(err) :
                           options.success(options.data);
        });
    },
    sync_delete: function (model, options) {
        this.db.rm(getUrl(model), function (err) {
            return (err) ? options.error(err) :
                           options.success({});
        });
    },
    sync_read: function (model, options) {
        if (model.id) {
            var data = this.db.get(model.id);
            return data ? options.success(data) :
                          error(new Error('Not found'));
        } else {
            var base_url = getUrl(model),
                items = [],
                seen = {};
            this.db.forEach(function (key, val) {
                if (val && key.indexOf(base_url) === 0 && !(key in seen)) {
                    seen[key] = true;
                    items.push(val);
                }
            });
            return options.success(items);
        }
    }
});

module.exports = {
    LocmemSync: LocmemSync,
    DirtySync: DirtySync
};
