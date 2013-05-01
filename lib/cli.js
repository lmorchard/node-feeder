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
    var to_save = [];
    var OpmlParser = require('opmlparser');
    fs.createReadStream(filename)
        .pipe(new OpmlParser())
        .on('feed', function (feed) {
            to_save.push({
                title: feed.title,
                resource_url: feed.xmlUrl || feed.xmlurl
            });
        })
        .on('end', function () {
            logger.info("Parsed " + to_save.length + " items");
            var resources = new models.ResourceCollection();
            resources.add(to_save);
            resources.sync('batch', resources, {
                success: function (successes, errors) {
                    logger.info("Import complete - " +
                        successes.length + " newly imported, " +
                        errors.length + " already exist.");
                }
            });
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
                    function (err, meta) {
                        logger.info("Parsed " + meta.new_items.length +
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
