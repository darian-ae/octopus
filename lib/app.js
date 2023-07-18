/**
 * Octopus module
 * @module lib/app
 */


/**
 * Required modules
 */
require('dotenv').config()
const got = require('got');
const { EOL } = require('os');
const async = require('async');
const { URL } = require('url');
const justify = require('justify');
const prettyMs = require('pretty-ms');
const prependHttp = require('prepend-http');
const cheerioLoad = require('cheerio')['load'];
const differenceBy = require('lodash.differenceby');
const windowWidth = require('term-size')()['columns'];

/**
 * App defaults
 */
let config;
let baseUrl;
let baseHost;
let crawledLinks = [];
let inboundLinks = [];
let brokenLinks = [];

/**
 * CLI colors
 */
const COLOR_GRAY = '\x1b[90m';
const COLOR_GREEN = '\x1b[32m';
const FORMAT_END = '\x1b[0m';

/**
 * App timing
 */
const NS_PER_SEC = 1e9;
const MS_PER_NS = 1e-6;
const executionTime = process.hrtime();

/**
 * Blacklisted protocols
 */
const ignoreProtocols = [
    '[href^="javascript:"]',
    '[href^="mailto:"]',
    '[href^="telnet:"]',
    '[href^="file:"]',
    '[href^="news:"]',
    '[href^="tel:"]',
    '[href^="ftp:"]',
    '[href^="#"]'
];

/**
 * Output line length
 */
const maxLength = windowWidth - 20;

/**
 * Console streaming
 */
require('draftlog').into(console);
console.stream = console.draft(EOL);


/**
 * Magic function for the brokenLinks object
 */
const brokenLinksObserver = new Proxy(brokenLinks, {
    set: function(target, key, value) {

        // Extract variables
        const {requestUrl, referenceUrl, statusMessage, statusCode} = value;

        // Push to object
        target.push(requestUrl);

        // Terminal output
        // this will log out all errors. Sometimes there are false positives such as 302 and 999 errors for valid links
        // these false positivies get filtered out below before we send the notification to Discord
        console.log(
            '%s%s%s%s%s: %s%s%s: %s (%d)%s',
            justify('⚠️', null, 5),
            requestUrl.substr(0, maxLength),
            EOL,

            COLOR_GRAY,
            justify(null, 'APPEARS ON', 14),
            referenceUrl.substr(0, maxLength),
            EOL,

            justify(null,'STATUS MSG', 14),
            statusMessage,
            statusCode,
            FORMAT_END
        );

        // post notification to discord if not a 302, 403, or 999 error
        // twitter gives 302 errors even with valid link
        // linkedin gives 999 errors even with valid link
        // defi llama gives 403 erros even with valid link
        if (statusCode != 302 && statusCode != 403 && statusCode != 999) {
            const headers = {
                'Content-Type': 'application/json',
              };
            console.log("posting to discord...")
            got.post(process.env.DISCORD_WEBHOOK, {
                body: JSON.stringify({
                    "content": 
                    `💔 Found broken [URL](${requestUrl}) with status code ${statusCode}. URL appears on page: ${referenceUrl}`
                }),
                headers
            })
        }
    }
} );


/**
 * Executes the URL request
 * @param {String} requestUrl - URL of the requested link
 * @param {String} referenceUrl - URL of the reference page
 * @param {Function} requestCallback - Callback function
 * @returns {Function} Callback function
 */
const request = async (requestUrl, referenceUrl, requestCallback) => {

    // Encode Url
    const encodedUrl = requestUrl.match(/%[0-9a-f]{2}/i) ? requestUrl : encodeURI(requestUrl);

    try {
        // Start request
        const response = await got( encodedUrl, {
            timeout: config.timeout,
            headers: {
                'user-agent': 'Octopus'
            }
        } );

        // Extract response data
        const { statusCode, statusMessage, headers, timings, body } = response;
        const contentType = headers['content-type'];

        // Parse url
        const parsedUrl = new URL(requestUrl);

        // Default
        let pageLinks = [];

        // Update stream
        if ( ! config.silent ) {
            console.stream(
                '%s%s %s(%d ms)%s',
                justify('🤖', null, 4),
                requestUrl.substr(0, maxLength),
                COLOR_GRAY,
                timings['phases'].total,
                FORMAT_END
            );
        }

        // Check for status code
        if ( ! [200, 204].includes(statusCode) ) {
            if ( ! brokenLinks.includes(requestUrl) ) {
                brokenLinksObserver[brokenLinks.length] = {
                    requestUrl,
                    referenceUrl,
                    statusCode,
                    statusMessage
                };
            }

        // Extract links only from internal HTML pages
        } else if ( parsedUrl.host === baseHost && contentType.startsWith('text/html') ) {
            const $ = cheerioLoad(body);

            $('a[href]').not( ignoreProtocols.join(',') ).each( (i, elem) => {
                if (elem.attribs.href) {
                    const hrefUrl = new URL(elem.attribs.href, baseUrl).href;

                    if ( ! pageLinks.includes(hrefUrl) ) {
                        pageLinks.push(hrefUrl);
                    }
                }
            });

            if ( config['include-images'] ) {
                $('img[src]').each((i, elem) => {
                    if (elem.attribs.src) {
                        const srcUrl = new URL(elem.attribs.src, baseUrl).href;

                        if (!pageLinks.includes(srcUrl)) {
                            pageLinks.push(srcUrl);
                        }
                    }
                });
            }
        }

        // Execute callback
        return requestCallback(requestUrl, pageLinks);

    } catch ( error ) {

        // Add to broken links on request error
        if ( ! brokenLinks.includes(requestUrl) ) {
            const statusCode = error.statusCode || '';
            const statusMessage = ( error.code || error.statusMessage ).toUpperCase();

            brokenLinksObserver[brokenLinks.length] = {
                requestUrl,
                referenceUrl,
                statusCode,
                statusMessage
            };
        }

        // Execute callback
        return requestCallback(requestUrl, []);

    }

};


/**
 * Starts the page crawling
 * @param {String} crawlUrl - URL of the crawled page
 * @param {String} [referenceUrl] - URL of the reference page
 * @returns {Promise} Promise object represents the crawling request
 */
const crawl = ( crawlUrl, referenceUrl = '' ) => {

    return request( crawlUrl, referenceUrl, (requestUrl, pageLinks) => {

        // Mark url as crawled
        crawledLinks.push( {
            'requestUrl': requestUrl
        } );

        // Async loop
        async.eachSeries( pageLinks, (pageLink, crawlCallback) => {

            // Parse url
            const parsedLink = new URL(pageLink);

            if (
                ( ! config['ignore-external'] || ( config['ignore-external'] && parsedLink.host === baseHost ) ) &&
                ( ! parsedLink.searchParams || ( parsedLink.searchParams && ! config['ignore-query'].filter(query => parsedLink.searchParams.get(query)).length ) ) &&
                ( ! inboundLinks.filter(item => item.requestUrl === pageLink).length )
            ) {
                inboundLinks.push( {
                    'referenceUrl': requestUrl,
                    'requestUrl': pageLink
                } );
            }

            crawlCallback();

        }, () => {

            // Evaluate links to crawl
            const nextUrls = differenceBy( inboundLinks, crawledLinks, 'requestUrl' );

            // Stream and check next link
            if ( Object.getOwnPropertyNames(nextUrls).length > 1 ) {
                return crawl( nextUrls[0].requestUrl, nextUrls[0].referenceUrl );

            // Nothing to check, log & exit
            } else {
                const diff = process.hrtime(executionTime);
                const ms = (diff[0] * NS_PER_SEC + diff[1]) * MS_PER_NS;

                console.log(
                    '%s%s%s%d %s %s%s',
                    EOL,
                    COLOR_GREEN,
                    justify('✅', null, 3),
                    inboundLinks.length,
                    'links checked in',
                    prettyMs( ms, { compact: true } ),
                    FORMAT_END
                );

                process.exit( 0 );
            }

        } );

    } );

};

// setup config and run crawler
config = {
    'timeout': 5000,
    'silent': false,
    'ignore-query': [],
    'ignore-external': false,
    'include-images': false,
    'slack-webhook': '',
};

baseUrl = process.env.BASE_URL
baseHost = new URL(baseUrl).host;
crawl(baseUrl)
