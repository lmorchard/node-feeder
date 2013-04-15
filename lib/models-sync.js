// ## Backbone sync handlers for models
var util = require('util'),
    async = require('async'),
    _ = require('underscore'),
    Backbone = require('backbone'),
    uuid = require('node-uuid');

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
        options.data = ('model' in model) ? null : model.toJSON();

        if ('create' == method) {
            if (!model.id) { 
                model.id = model.attributes.id = uuid.v1();
                // options.data.id = model.id = model.attributes.id = model.hash();
            }
            if (!options.data.created) {
                options.data.created = model.attributes.created = now;
            }
        }
        if ('create' == method || 'update' == method) {
            options.data.modified = model.attributes.modified = now;
        }

        if (options.data) {
            options.data.id = model.id;
        }

        if ('function' == typeof (this['sync_'+method])) {
            // Allow dispatch to methods on the object, if found.
            return this['sync_'+method](model, options);
        } else {
            return error("unimplemented");
        }
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
    sync_create: function (model, options) {
        this.store[model.url()] = options.data;
        return options.success(model, options.data);
    },
    sync_update: function (model, options) {
        this.store[model.url()] = options.data;
        return options.success(model, options.data);
    },
    sync_delete: function (model, options) {
        delete this.store[model.url()];
        return options.success(model, options.data);
    },
    sync_read: function (model, options) {
        if ('model' in model) {
            return options.success(_(this.store).values());
        } else {
            return options.success(this.store[model.url()]);
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
        return BaseSync.prototype.open.call(this, next);
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
    sync_create: function (model, options) {
        this.db.set(model.url(), options.data, function () {
            return options.success(model, options.data);
        });
    },
    sync_update: function (model, options) {
        this.db.set(model.url(), options.data, function () {
            return options.success(model, options.data);
        });
    },
    sync_delete: function (model, options) {
        this.db.rm(model.url(), function () {
            return options.success(model, options.data);
        });
    },
    sync_read: function (model, options) {
        if ('model' in model) {
            var items = [],
                base_url = model.url(),
                uniq = {};
            this.db.forEach(function (key, val) {
                if (key.indexOf(base_url) === 0) {
                    uniq[key] = val;
                }
            });
            return options.success(_.values(uniq));
        } else {
            var data = this.db.get(model.id);
            return options.success(data);
        }
    }
});

module.exports = {
    LocmemSync: LocmemSync,
    DirtySync: DirtySync
};
