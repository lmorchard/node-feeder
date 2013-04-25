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
        this._set(getUrl(model), options.data, function (err) {
            return (err) ? options.error(err) :
                           options.success(options.data);
        });
    },
    sync_delete: function (model, options) {
        this._del(getUrl(model), function (err) {
            return (err) ? options.error(err) :
                           options.success({});
        });
    },
    sync_read: function (model, options) {
        var base_url = getUrl(model);

        if (!_.isObject(model.model)) {
            var id = null;
            if (model.id) {
                id = model.id;
            } else if (_.isFunction(model.hash)) {
                id = model.hash();
            }
            if (!id) {
                return options.error(new Error('Not found'));
            }
            this._get(id, function (err, data) {
                return data ? options.success(data) :
                              options.error(new Error('Not found'));
            });
        }

        var seen_keys = {};
        
        var filter_fn = function (key, val) {
            return (val &&
                    key.indexOf(base_url) === 0 && 
                    !(key in seen_keys));
        };

        var cmp = function (key, a, b) {
            var ac = a[key];
            var bc = b[key];
            if (ac<bc) { return -1; }
            else if (ac>bc) { return 1; }
            return 0;
        };

        var sort_fn = function (a, b) {
            return cmp('created', a, b);
        };

        if ('orderBy' in options) {
            var key;
            if ('-' == options.orderBy[0]) {
                key = options.orderBy.substr(1);
                sort_fn = function (a, b) {
                    return cmp(key, b, a);
                };
            } else {
                key = options.orderBy;
                sort_fn = function (a, b) {
                    return cmp(key, a, b);
                };
            }
        }

        var items = [];
        this._each(function (key, val) {
            if (filter_fn(key, val)) {
                seen_keys[key] = true;
                items.push(val);
            }
        });

        items.sort(sort_fn);
        
        if (options.limit) {
            items = items.slice(0, options.limit);
        }

        return options.success(items);
    },
    _set: function (key, val, next) {
        this.store[key] = val; 
        return next();
    },
    _del: function (key, next) {
        delete this.store[getUrl(model)];
        next();
    },
    _get: function (key, next) {
        next(null, this.store[key]);
    },
    _each: function (iter) {
        _.each(this.store, function (val, key) {
            iter(key, val);
        });
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
_.extend(DirtySync.prototype, LocmemSync.prototype, {
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
    _set: function (key, val, next) {
        this.db.set(key, val, next);
    },
    _del: function (key, next) {
        this.db.rm(key, next);
    },
    _get: function (key, next) {
        next(null, this.db.get(key));
    },
    _each: function (iter) {
        this.db.forEach(iter);
    }
});

module.exports = {
    LocmemSync: LocmemSync,
    DirtySync: DirtySync
};
