/*jshint node: true, expr: false, boss: true */

var util = require('util'),
    fs = require('fs'),
    async = require('async'),
    FeedParser = require('feedparser'),
    nconf = require('nconf'),
    logger = require('winston'),
    Backbone = require('backbone'),
    prog = require('commander');

var models = require('./models'),
    models_sync = require('./models-sync');

var DEFAULT_CONFIG = {
    verbose: false,
    name: 'feeder.db'
};

var msync;

function main (argv) {
    prog.version('0.2.0')
        .option('-v, --verbose', 'Verbose output', false)
        .option('-c, --config', 'Configuration file', 'feeder-config.json');

    prog.command('runserver [port]')
        .description('Run HTTP app server')
        .action(init(runServer));

    prog.command('import-opml [filename]')
        .description('Import from OPML')
        .action(init(importOpml));

    prog.command('compact')
        .action(init(compact));

    prog.command('list')
        .action(init(list));

    prog.command('poll')
        .action(init(poll));

    prog.command('feeds')
        .action(init(feeds));

    prog.parse(argv);
}

function init (fn) {
    return function () {
        var $this = this;
        var $arguments = arguments;

        // Set up configuration
        nconf.env();
        nconf.overrides(_.pick(prog, 'verbose'));
        if (fs.existsSync(prog.config)) {
            nconf.file(prog.config);
        }
        nconf.defaults(DEFAULT_CONFIG);

        // Set up logging
        logger.remove(logger.transports.Console);
        if (nconf.get('verbose')) {
            logger.padLevels = true;
            logger.add(logger.transports.Console, {
                level: 'silly', colorize: true
            });
        }

        // see: https://github.com/flatiron/logger/issues/89
        logger.setLevels({silly: 0, verbose: 1, debug: 2,
                           info: 3, warn: 4, error: 5});

        // Set up Dirty data storage
        /*
        msync = new models_sync.DirtySync({
            name: nconf.get('name')
        });
        msync = new models_sync.FileSync({
            name: 'feeder-db'
        });
        */
        msync = new models_sync.CouchSync({
            url: 'http://tester:tester@localhost:5984',
            name: 'feeder'
        });
        msync.open(function (err, sync_handler) {
            Backbone.sync = sync_handler;
            return fn.apply($this, $arguments);
        });
    };
}

function compact () {
    fs.unlinkSync('compacted.db');
    var new_db = require('dirty')('compacted.db');
    var ct = 0;
    msync.db.forEach(function (key, val) {
        if ((ct++ % 100) === 0) {
            logger.debug("RECORDS PROCESSED " + ct);
        }
        new_db.set(key, val);
    });
}

function runServer (port) {
    var cls = require('./server');
    var server = new cls({
        port: port || 9070,
        logger: logger,
        verbose: nconf.get('verbose')
    }).listen();
}

function importOpml (filename) {
    var feeds = [];
    var resources = new models.ResourceCollection();
    var OpmlParser = require('opmlparser');

    var save_q = async.queue(function (attrs, q_next) {
        resources.create(attrs, {
            success: function (model, resp, options) {
                logger.debug("Imported " + model.get('resource_url'));
                q_next();
            }
        });
    }, 10);

    save_q.drain = function () {
        logger.info("Import complete");
    };

    var feed_ct = 0;
    fs.createReadStream(filename)
        .pipe(new OpmlParser())
        .on('feed', function (feed) {
            save_q.push({
                title: feed.title,
                resource_url: feed.xmlUrl || feed.xmlurl
            });
            feed_ct++;
        })
        .on('end', function () {
            logger.info("Parsed " + feed_ct + " items");
        });
}

function list () {
    var resources = new models.ResourceCollection();
    resources.fetch({
        success: function (collection, resp, options) {
            logger.debug("FETCHED " + collection.length);
            resources.each(function (r) {
                logger.debug("URL " + r.get('resource_url'));
            });
        }
    });
}

function feeds () {
    var resources = new models.ResourceCollection();
    var counts = {};

    resources.fetch({
        success: function (collection, resp, options) {
            resources.each(function (r) {

                var items = [];
                var url = r.get('resource_url');
                
                var body = r.get('body');
                if (!body) { return; }

                counts[url] = (url in counts) ? (counts[url] + 1) : 1;
                FeedParser.parseString(body, {addmeta: false})
                    .on('article', function (item) {
                        items.push(item);
                    })
                    .on('error', function (e) {
                        logger.debug("URL " + url + " " + counts[url]);
                        //logger.debug("URL " + r.id + ": " + url);
                        logger.error("FEED ERROR " + e);
                    })
                    .on('end', function () {
                        logger.debug("URL " + url);
                        _.each(items, function (item, idx) {
                            // logger.debug("\t* " + item.title);
                            logger.debug(util.inspect(item));
                        });
                    });
            });
        }
    });
}

function poll () {
    var resources = new models.ResourceCollection();
    var feed_items = new models.FeedItemCollection();

    resources.fetch({
        success: function (collection, resp, options) {
            util.debug("MODELS " + collection.models.length);

            resources.on('all', function (ev, model) {
                if (/^poll:/.test(ev)) {
                    logger.debug(ev + ' ' + model.get('resource_url'));
                }
            });

            resources.on('poll:end', function (resource) {
                feed_items.parseResource(resource, 
                    function (err, parsed_ct) {
                        logger.info("Parsed " + parsed_ct +
                                    " from " + resource.get('resource_url'));
                    });
            });

            resources.pollAll({}, function (e) {
                logger.debug('POLL DONE');
            });

        }
    });
}

module.exports.main = main;
