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

process.on('uncaughtException', function (e) {
    util.error('ERRRRR ' + (e.stack));
});

function r (p) { return require(__dirname + '/../lib/' + p); }

var models = r('models'),
    models_sync = r('models-sync'),
    test_utils = r('test-utils');

function d (p) { return __dirname + '/' + p; }

var CASES = {
    hash: new models_sync.HashSync(),
    file: new models_sync.FileSync({
        name: 'tmp/db-test-file-sync'
    }),
    dirty: new models_sync.DirtySync({
        name: 'tmp/db-test-dirty-sync'
    })/*,
    couch: new models_sync.CouchSync({
        url: 'http://tester:tester@localhost:5984',
        name: 'db-test-couch-sync'
    })
    */
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

_.each(CASES, function (case_msync, case_name) {
    var batch = {};
    batch[case_name + ' sync'] = {
        topic: function () {
            var $this = this;
            this.msync = case_msync;
            this.msync.open(function (err, sync_proxy) {
                $this.sync_proxy = sync_proxy;
                $this.callback(err);
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
                        error: function (err) {
                            $this.callback(err, null);
                        }
                    });
                },
                'should result in an error': function (err, coll, model) {
                    assert(!!err, 'There should be an error');
                }
            }
        },
        'with sample model objects': {
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
                topic: function (err, coll) {
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
                topic: function (err, coll) {
                    var $this = this;
                    var models = [];

                    var coll = new MonsterCollection();
                    coll.sync = this.sync_proxy;
                    coll.fetch({
                        success: function (items, resp, options) {
                            items.each(function (item) {
                                models.push(item);
                            });
                            async.each(models, function (model, fe_next) {
                                model.destroy({
                                    success: function () { fe_next(); }
                                });
                            }, function (err) {
                                $this.callback(err, models);
                            });
                        }
                    });
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
                    'should result in an empty collection':
                            function (err, items) {
                        assert.equal(items.length, 0);
                    }
                }
            }
        }
    };
    suite.addBatch(batch);
});

if (process.argv[1] === __filename) {
    suite.run({error: false});
} else {
    suite.export(module, {error: false});
}
