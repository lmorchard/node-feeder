// ## Backbone sync handlers for models
var util = require('util'),
    fs = require('fs'),
    mkdirp = require('mkdirp'),
    readdirp = require('readdirp'),
    path = require('path'),
    async = require('async'),
    _ = require('underscore'),
    nano = require('nano'),
    Backbone = require('backbone'),
    uuid = require('node-uuid');

var getUrl = function(object) {
    return _.result(object, 'url');
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
    _prepareModelForSave: function (model) {
        var now = (new Date()).getTime();
        if (!model.id) {
            var id_attr = model.idAttribute;
            if (!model.get(id_attr)) { 
                model.set(id_attr, (_.isFunction(model.hash)) ?
                    model.hash() : uuid.v1());
            }
            if (!model.get('created')) {
                model.set('created', now);
            }
        }
        model.set('modified', now);
    },
    sync: function (method, model, options) {
        var noop = function () {};
        options.success = options.success || noop;
        options.error = options.error || noop;

        // Auto-manage id, modified, and created
        if ('create' == method || 'update' == method) {
            this._prepareModelForSave(model);
            options.data = model.toJSON();
        }

        // Dispatch to a sync_* sub-method, if available
        var sub_method = 'sync_' + method;
        if (_.isFunction(this[sub_method])) {
            return this[sub_method](model, options);
        }

        // Dispatch to a model or collection specific sync_read
        if ('read' == method) {
            var sub_read_method;
            if (_.isObject(model.model)) {
                sub_read_method = sub_method + '_collection';
            } else {
                sub_read_method = sub_method + '_model';
            }
            if (_.isFunction(this[sub_read_method])) {
                return this[sub_read_method](model, options);
            }
        }

        return new Error("unimplemented");
    }
});

// ### HashSync: sync backbone to local memory
function HashSync (options) {
    this.init(options);
}
_.extend(HashSync.prototype, BaseSync.prototype, {
    open: function (next) {
        this.store = {};
        return BaseSync.prototype.open.call(this, next);
    },
    sync_batch: function (coll, options) {
        var $this = this;
        var successes = [];
        var errors = [];
        async.each(coll.models, function (model, fe_next) {
            model.save({}, {
                success: function (model, resp, options) {
                    successes.push(model);
                    fe_next();
                },
                error: function (err) {
                    errors.push(model);
                    fe_next();
                }
            });
        }, function (err) {
            options.success(successes, errors);
        });
    },
    sync_create: function (model, options) {
        var $this = this;
        this._exists(getUrl(model), function (err, exists) {
            if (exists) { return options.error('exists'); }
            return $this.sync_update(model, options);
        });
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
    sync_read_model: function (model, options) {
        var id = null;
        if (!model.id && _.isFunction(model.hash)) {
            model.id = model.hash();
        }
        if (!model.id) {
            return options.error(new Error('Not found'));
        }
        return this._get(getUrl(model), function (err, data) {
            if (data) {
                options.success(data);
            } else {
                options.error(new Error('Not found'));
            }
        });
    },
    sync_read_collection: function (coll, options) {
        var base_url = getUrl(coll);

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
        this._each(coll, function (key, val) {
            if (filter_fn(key, val)) {
                seen_keys[key] = true;
                items.push(val);
            }
        }, function () {
            items.sort(sort_fn);
            if (options.limit) {
                items = items.slice(0, options.limit);
            }
            options.success(items);
        });
    },
    _set: function (key, val, next) {
        this.store[key] = val; 
        return next();
    },
    _del: function (key, next) {
        delete this.store[key];
        next();
    },
    _exists: function (key, next) {
        next(null, (key in this.store));
    },
    _get: function (key, next) {
        next(null, this.store[key]);
    },
    _each: function (coll, iter, done) {
        _.each(this.store, function (val, key) {
            iter(key, val);
        });
        process.nextTick(done);
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
_.extend(DirtySync.prototype, HashSync.prototype, {
    open: function (next) {
        var $this = this,
            name = this.options.name;

        if (!next) { next = function (){}; }

        function _open (name, instantiate) {
            if (instantiate) {
                _dirty_dbs[name] = require('dirty')(name);
            }
            $this.db = _dirty_dbs[name];
            $this.db.on('load', function () {
                next(null, $this.getSync());
            });
        }

        if (name in _dirty_dbs) {
            return _open(name, false);
        } else {
            var dn = path.dirname(name);
            if (!fs.existsSync(dn)) {
                mkdirp(dn, function (err) {
                    return _open(name, true);
                });
            } else {
                return _open(name, true);
            }
        }
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
    _exists: function (key, next) {
        next(null, !!this.db.get(key));
    },
    _get: function (key, next) {
        next(null, this.db.get(key));
    },
    _each: function (coll, iter, done) {
        this.db.forEach(iter);
        process.nextTick(done);
    }
});

// ### FileSync: sync to files and directories
function FileSync (options) {
    this.init(options);
}
_.extend(FileSync.prototype, HashSync.prototype, {
    open: function (next) {
        var $this = this;
        var name = this.options.name;
        if (!next) { next = function (){}; }
        fs.exists(name, function (exists) {
            if (exists) {
                next(null, $this.getSync());
            } else {
                mkdirp(name, function (err) {
                    next(err, $this.getSync());
                });
            }
        });
        return this;
    },
    close: function (next) {
        if (next) { process.nextTick(next); }
        return this;
    },
    _path: function (key) {
        return path.join(this.options.name, key);
    },
    _set: function (key, val, next) {
        key = this.options.name + '/' + key;
        var d = path.dirname(key);
        var _store = function () {
            fs.writeFile(key, JSON.stringify(val), next);
        };
        fs.exists(d, function (exists) {
            if (exists) { _store(); }
            else { mkdirp(d, _store); }
        });
    },
    _del: function (key, next) {
        key = this.options.name + '/' + key;
        fs.unlink(key, next);
    },
    _exists: function (key, next) {
        fs.exists(this._path(key), function (exists) {
            next(null, exists);
        });
    },
    _get: function (key, next) {
        fs.readFile(this._path(key), function (err, data) {
            try {
                next(err, JSON.parse(data));
            } catch (e) {
                next(err, null);
            }
        });
    },
    _each: function (coll, iter, done) {
        var $this = this;
        var entries = [];
        var strm = readdirp({
            root: this.options.name
        }, function (entry) {
            entries.push(entry);
        }, function () {
            async.each(entries, function (entry, fe_next) {
                var key = '/' + entry.path;
                var fn = $this.options.name + '/' + key;
                fs.readFile(fn, function (err, data) {
                    var item = null;
                    try { item = JSON.parse(data); }
                    catch (e) { /* No-op */ }
                    if (item) { iter(key, item); }
                    fe_next();
                });
            }, done);
        });
    }
});

// ### CouchSync
function CouchSync (options) {
    this.init(options);
}
_.extend(CouchSync.prototype, HashSync.prototype, {
    open: function (next) {
        this.db = nano(this.options.url).use(this.options.name);
        next(null, this.getSync());
    },
    close: function (next) {
        var $this = this;
        if (next) { next(); }
    },
    sync_create: function (model, options) {
        var $this = this;
        return $this.sync_update(model, options);
    },
    sync_batch: function (coll, options) {
        var $this = this;
        
        var by_id = {};
        var successes = [], errors = [];

        var to_save = coll.map(function (model) {
            $this._prepareModelForSave(model);
            var data = model.toJSON();
            data._id = model.url();
            by_id[data._id] = model;
            return data;
        });

        this.db.bulk({docs: to_save}, {}, function (err, body) {
            _.each(body, function (result) {
                var model = by_id[result.id];
                if (result.error) {
                    errors.push([model, result]);
                } else {
                    model.set('_rev', result.rev);
                    successes.push(model);
                }
            });
            options.success(successes, errors);
        });
    },
    _set: function (key, val, next) {
        var $this = this;
        $this.db.insert(val, key, next);
    },
    _del: function (key, next) {
        var $this = this;
        this.db.get(key, {}, function (err, body) {
            if (err) { return next(err, null); }
            $this.db.destroy(key, body._rev, next);
        });
    },
    _get: function (key, next) {
        this.db.get(key, {}, next);
    },
    _each: function (coll, iter, done) {
        var $this = this;
        var base_url = getUrl(coll);
        this.db.list({}, function (err, body) {
            async.each(body.rows, function (row, fe_next) {
                var key = row.key;
                if (key.indexOf(base_url) === -1) {
                    fe_next();
                } else {
                    var rev = row.value.rev;
                    $this.db.get(key, {rev: rev}, function (err, doc) {
                        iter(key, doc);
                        fe_next();
                    });
                }
            }, done);
        });
    }
});

module.exports = {
    HashSync: HashSync,
    DirtySync: DirtySync,
    FileSync: FileSync,
    CouchSync: CouchSync
};
