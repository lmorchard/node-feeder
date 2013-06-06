/*jshint node: true, expr: false, boss: true */

var util = require('util'),
    crypto = require('crypto'),
    express = require('express'),
    request = require('request'),
    fs = require('fs'),
    async = require('async'),
    vows = require('vows'),
    assert = require('assert'),
    path = require('path'),
    _ = require('underscore'),
    Backbone = require('backbone');

/*
process.on('uncaughtException', function (e) {
    util.error('ERRRRR ' + (e.stack));
});
*/

function r (p) { return require(__dirname + '/../lib/' + p); }

var models = r('models'),
    models_sync = r('models-sync'),
    test_utils = r('test-utils');

function d (p) { return __dirname + '/' + p; }

var CASES = {
    /*
    hash: new models_sync.HashSync(),
    file: new models_sync.FileSync({
        name: 'tmp/db-test-file-sync'
    }),
    dirty: new models_sync.DirtySync({
        name: 'tmp/db-test-dirty-sync'
    }),
    couch: new models_sync.CouchSync({
        url: 'http://tester:tester@localhost:5984',
        name: 'db-test-couch-sync'
    })
    */
    mongo: new models_sync.MongoSync({
        url: 'mongodb://127.0.0.1:27017/db-test-mongo-sync'
    })
};

BaseModel = Backbone.Model.extend({
    sync: function() {
        var sync_fn = (this.collection) ?
            this.collection.sync : Backbone.sync;
        return sync_fn.apply(this, arguments);
    }
});

BaseCollection = Backbone.Collection.extend({
});

Monster = BaseModel.extend({
    defaults: {
        name: null, eyes: 2, arms: 2, 
        legs: 2, wings: 0, tails: null
    },
    hash: function () {
        return this.get('name');
    }
});

MonsterCollection = BaseCollection.extend({
    url: '/monsters/',
    model: Monster
});

var SAMPLE_ATTRS = ['name', 'eyes', 'arms', 'legs', 'wings', 'tail', 'meta'];
var SAMPLE_DATA = _.object(_.map([
    ['dragon', 2, 0, 4, 2,  true, {'home': 'dragonia'}],
    ['octo',   2, 8, 0, 0, false, {'home': 'under the sea'}],
    ['tails',  2, 2, 2, 0,  true, {'home': 'lol wut'}],
    ['behold', 1, 0, 0, 0, false, {'home': 'dungeons'}]
], function (i) {
    var o = _.object(_.zip(SAMPLE_ATTRS, i));
    return ['/monsters/' + o.name, o];
}));

var suite = vows.describe('Model sync tests');

function collection ($this) {
    var coll = new MonsterCollection();
    coll.sync = $this.sync_proxy;
    return coll;
}

_.each(CASES, function (case_msync, case_name) {
    var batch = {};
    batch[case_name + ' sync'] = {
        topic: function () {
            var $this = this;

            this.msync = case_msync;
            this.msync.open(function (err, sync_proxy) {
                $this.sync_proxy = sync_proxy;

                // Wipe any objects in storage (eg. for Couch)
                var coll = collection($this);
                coll.fetch({
                    error: function () { $this.callback(); },
                    success: function (items, resp, options) {
                        var to_delete = _.clone(items.models);
                        async.each(to_delete, function (item, fe_next) {
                            item.destroy({
                                success: function () { fe_next(); },
                                error: function () { fe_next(); }
                            });
                        }, function (err) { $this.callback(); });
                    }
                });
            });
        },
        teardown: function () {
            this.msync.close();
        },
        'with a single object created': {
            topic: function () {
                var $this = this;
                var coll = new MonsterCollection();
                coll.sync = this.sync_proxy;
                coll.create({
                    "name": "foobar",
                    "arms": 5,
                    "meta": {"test": "data"}
                }, {
                    success: function (model, resp, options) {
                        $this.callback(null, model);
                    },
                    error: function (err) {
                        $this.callback(err, null);
                    }
                });
            },
            teardown: function () {
                // Ensure the object doesn't exist
                var coll = new MonsterCollection();
                coll.sync = this.sync_proxy;
                var obj = new Monster({'name':'foobar'});
                obj.collection = coll;
                obj.fetch({
                    success: function () { obj.destroy(); }
                });
            },
            'and a second attempt to create the same object': {
                topic: function (err) {
                    var $this = this;
                    // Same name, no ID - should be a conflict.
                    var coll = new MonsterCollection();
                    coll.sync = this.sync_proxy;
                    coll.create({
                        "name": "foobar",
                        "arms": 10,
                        "meta": {"test": "changed"}
                    }, {
                        success: function (model, resp, options) {
                            $this.callback(null, model);
                        },
                        error: function (model, err, options) {
                            $this.callback(err, null);
                        }
                    });
                },
                'should result in an error': function (err, coll, model) {
                    assert(!!err, 'There should be an error');
                }
            }
        },
        'with objects created individually': {
            topic: function () {
                var $this = this;
                var coll = new MonsterCollection();
                coll.sync = this.sync_proxy;
                async.each(_.values(SAMPLE_DATA), function (item, fe_next) {
                    coll.create(item, {
                        success: function (model, resp, options) {
                            fe_next();
                        }
                    });
                }, function (err) {
                    $this.callback(err, coll);
                });
            },
            'and each object selected individually': {
                topic: function (err, coll) {
                    var $this = this;
                    var items = [];
                    async.each(_.values(SAMPLE_DATA), function (item, fe_next) {
                        var m = new Monster({name: item.name});
                        m.collection = coll;
                        m.fetch({
                            success: function (model, resp, options) {
                                items.push(model);
                                fe_next();
                            }
                        });
                    }, function (err) {
                        $this.callback(err, items);
                    });
                },
                'should result in fetched items that match the sample data':
                        function (err, items) {
                    items.forEach(function (o) {
                        var expected = SAMPLE_DATA[o.url()];
                        _.each(expected, function (val, key) {
                            assert.deepEqual(o.get(key), val);
                        });
                    });
                }
            },
            'and the full collection fetched': { 
                topic: function (err) {
                    var $this = this;
                    var coll = new MonsterCollection();
                    coll.sync = this.sync_proxy;
                    coll.fetch({
                        success: function (items, resp, options) {
                            $this.callback(null, items);
                        }
                    });
                },
                'should result in fetched items that match the sample data':
                        function (err, items) {
                    items.each(function (o) {
                        var expected = SAMPLE_DATA[o.url()];
                        _.each(expected, function (val, key) {
                            assert.deepEqual(o.get(key), val);
                        });
                    });
                }
            },
            'and every item deleted': {
                topic: function (err) {
                    var $this = this;
                    var deleted_ids = [];

                    var coll = new MonsterCollection();
                    coll.sync = this.sync_proxy;
                    coll.fetch({
                        success: function (items, resp, options) {
                            models = _.clone(items.models);
                            async.each(models, function (model, fe_next) {
                                deleted_ids.push(model.id);
                                model.destroy({
                                    success: function () { fe_next(); },
                                    error: function () { fe_next(); }
                                });
                            }, function (err) {
                                $this.callback(err, deleted_ids);
                            });
                        }
                    });
                },
                'and the full collection fetched': { 
                    topic: function (err, deleted_ids) {
                        var $this = this;
                        var coll = new MonsterCollection();
                        coll.sync = this.sync_proxy;
                        coll.fetch({
                            success: function (items, resp, options) {
                                $this.callback(null, deleted_ids, items);
                            }
                        });
                    },
                    'should result in none of the deleted items present':
                            function (err, deleted_ids, items) {
                        var found_ids = items.map(function (item) {
                            return item.id;
                        });
                        deleted_ids.forEach(function (item) {
                            assert.equal(found_ids.indexOf(item.id), -1);
                        });
                    }
                }
            }
        },
        'with a batch of objects created': {
            topic: function () {
                var $this = this;
                
                var batch_data = _.object(_.map(SAMPLE_DATA,
                        function (item, key) {
                    var batch_item = _.clone(item);
                    batch_item.name = 'batch-' + item.name;
                    return ['/monsters/' + batch_item.name, batch_item];
                }));

                var coll = new MonsterCollection();
                coll.sync = this.sync_proxy;
                coll.add(_.values(batch_data));
                coll.sync('batch', coll, {
                    success: function (successes, errors) {
                        $this.callback(null, batch_data, successes, errors);
                    }
                });
            },
            teardown: function (err, batch_data, successes, errors) {
                if (successes) successes.forEach(function (model) {
                    model.destroy({wait: true});
                });
            },
            'should result in success for all batch items':
                    function (err, batch_data, successes, errors) {
                assert.equal(successes.length,
                             _.keys(batch_data).length);
                successes.forEach(function (item) {
                    var url = _.result(item, 'url');
                    var expected = batch_data[url];
                    _.each(expected, function (val, key) {
                        assert.deepEqual(item.get(key), val);
                    });
                });
            },
            'and a second batch attempt with some new and some existing': {
                topic: function (err, batch_data, successes, errors) {
                    var $this = this;

                    var new_batch = _.extend(_.clone(batch_data), {
                        '/monsters/new-1': { name: 'new-1', eyes: 4 },
                        '/monsters/new-2': { name: 'new-2', eyes: 5 }
                    });

                    var coll = new MonsterCollection();
                    coll.sync = this.sync_proxy;
                    coll.add(_.values(new_batch));
                    coll.sync('batch', coll, {
                        success: function (successes, errors) {
                            $this.callback(null, new_batch, successes, errors);
                        }
                    });
                },
                'should result in errors for the existing items': 
                        function (err, new_batch, successes, errors) {
                    assert.equal(successes.length, 2);
                    assert.equal(errors.length, 4);
                }
            },
            'and the full collection fetched': { 
                topic: function (err, batch_data) {
                    var $this = this;
                    var coll = new MonsterCollection();
                    coll.sync = this.sync_proxy;
                    coll.fetch({
                        success: function (items, resp, options) {
                            $this.callback(null, batch_data, items);
                        }
                    });
                },
                'should result in fetched items that match the sample data':
                        function (err, batch_data, items) {
                    var result_items = items.filter(function (item) {
                        return item.url().indexOf('batch-') !== -1;
                    });
                    assert.equal(result_items.length,
                                 _.keys(batch_data).length);
                    result_items.forEach(function (item) {
                        var url = _.result(item, 'url');
                        var expected = batch_data[url];
                        _.each(expected, function (val, key) {
                            assert.deepEqual(item.get(key), val);
                        });
                    });
                }
            }
        }
        /*,
        */
    };
    suite.addBatch(batch);
});

if (process.argv[1] === __filename) {
    suite.run({error: false});
} else {
    suite.export(module, {error: false});
}
