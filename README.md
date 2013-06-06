# node-feeder

[![Build Status](https://secure.travis-ci.org/lmorchard/node-feeder.png)](http://travis-ci.org/lmorchard/node-feeder)

This is a suite of tools for dealing with web feeds of various sorts (ie. RSS,
Atom, Activity Streams, scraped resources). It might grow up to be a reader,
someday, but so far has ambitions more as a utility or backend service than a
consumer product.

## TODO

* General
    * Wire up persona logins
    * Invite by email system
    * Per-user subscriptions
    * [river.js output](http://riverjs.org/)
* UI
    * Thumb extractor
        * Cache results of thumb scraping in backbone models
            * Stop caching those results in memory (ouch)
        * Lazily queue up requests to find thumbs
        * Find a way to cheat on how much data this thing needs. Seems like a
          lot of HTTP requests, needing to visit each and every resource to
          scrape a thumb.
        * Is it possible to send an image with a Refresh header and
          periodically poll until later when the thumb service has found
          something?
* Poller
    * Use pagination in poller - do not load up all resources into memory
    * Record poll history per-resource
        * New items, HTTP status, response time
        * Maybe try to measure time between new item discovery and published time in resource?
    * Vary polling frequency based on history
        * AIMD? Increment delay for every error / 304, halve delay for every 200
    * Disable resources with a long enough history of errors
        * Take the hint sooner for 404 / 410
        * Be extra lenient for transient 500 / 503
* Events
    * Support webhooks to receive feed changes
