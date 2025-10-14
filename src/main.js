import 'dotenv/config';
import express from 'express';
import { PlaywrightCrawler, Configuration, RequestQueue } from 'crawlee';
import { requestHandler, getMetrics, clearMetrics, flushBatch } from './routes.js';
import { randomUUID } from 'crypto';

// Initialize the Express app
const app = express();
const port = parseInt(process.env.PORT) || 3001;

// Track active crawls to prevent resource exhaustion
const activeCrawls = new Set();
const MAX_CONCURRENT_CRAWLS = parseInt(process.env.MAX_CONCURRENT_CRAWLS) || 3;

// CORS middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
});

// Handle OPTIONS requests
app.options('*', (req, res) => res.sendStatus(200));

// Configure memory settings
process.env.CRAWLEE_MEMORY_MBYTES = process.env.CRAWLEE_MEMORY_MBYTES || '2048';

// Use memory storage
Configuration.getGlobalConfig().set('storageClientOptions', {
    persistStorage: false,
});

// Crawl endpoint
app.get('/start-crawl', async (req, res) => {
    const urlToCrawl = req.query.url;
    const maxResults = req.query.maxResults ? parseInt(req.query.maxResults) : null;

    if (!urlToCrawl) {
        return res.status(400).send('Please provide a URL to crawl using the "url" query parameter.');
    }

    if (maxResults !== null && (isNaN(maxResults) || maxResults <= 0)) {
        return res.status(400).send('maxResults must be a positive integer if provided.');
    }

    // Check concurrent crawl limit
    if (activeCrawls.size >= MAX_CONCURRENT_CRAWLS) {
        return res.status(429).json({
            success: false,
            message: `Maximum concurrent crawls (${MAX_CONCURRENT_CRAWLS}) reached. Please try again later.`,
        });
    }

    // Generate unique crawl ID
    const crawlId = randomUUID();
    activeCrawls.add(crawlId);

    console.log(`Starting crawl ${crawlId} for URL: ${urlToCrawl}`);
    clearMetrics(crawlId);

    let maxResultsReached = false;
    let currentWebsite = null;
    let websiteMaxResults = maxResults;
    let requestQueue = null;
    let crawler = null;
    let isShuttingDown = false; // Prevent race conditions during cleanup

    // Set timeout for the entire crawl operation
    const crawlTimeout = setTimeout(() => {
        console.error(`Crawl ${crawlId} timeout - forcing cleanup`);
        isShuttingDown = true;
        activeCrawls.delete(crawlId);
        clearMetrics(crawlId);
    }, parseInt(process.env.CRAWL_TIMEOUT_MS) || 600000); // Default 10 minutes

    try {
        // Initialize request queue at crawl start
        requestQueue = await RequestQueue.open();
        console.log('Request queue initialized');

        // Create a new crawler instance for each website
        crawler = new PlaywrightCrawler({
            requestQueue, // Use the initialized queue
            launchContext: {
                launchOptions: {
                    headless: true,
                    args: [
                        '--disk-cache-dir=/tmp',
                        '--disk-cache-size=0',
                        '--disable-dev-shm-usage',
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-gpu',
                        '--disable-web-security',
                        '--disable-features=IsolateOrigins,site-per-process',
                        '--no-first-run',
                        '--no-zygote',
                        '--single-process',
                        '--disable-extensions'
                    ],
                },
            },
            browserPoolOptions: {
                retireBrowserAfterPageCount: 10, // Close browser after 10 pages to prevent memory leaks
            },
            maxConcurrency: parseInt(process.env.maxConcurrency) || 3,
            maxRequestRetries: 0,
            navigationTimeoutSecs: 10,
            maxCrawlDepth: parseInt(process.env.MAX_CRAWL_DEPTH) || 2, // Default depth: 2 levels deep
            requestHandler: async (context) => {
                const website = new URL(context.request.loadedUrl).origin;

                // Reset max results tracking when website changes
                if (website !== currentWebsite) {
                    currentWebsite = website;
                    maxResultsReached = false;
                    websiteMaxResults = maxResults;
                    console.log(`Counters reset for new website: ${website}`);
                    console.log(`websiteMaxResults set to: ${websiteMaxResults}`);
                }

                if (maxResultsReached) {
                    context.request.noRetry = true;
                    return;
                }

                context.request.noRetry = true;
                context.maxResults = websiteMaxResults;
                context.crawlId = crawlId; // Pass crawlId to request handler

                try {
                    await requestHandler(context);

                    const metrics = getMetrics(crawlId);
                    if (websiteMaxResults && metrics.totalArticles >= websiteMaxResults) {
                        maxResultsReached = true;
                        isShuttingDown = true;

                        // Gracefully stop the crawler by preventing new requests
                        console.log('Max results reached, initiating graceful shutdown');

                        // Abort the crawler to stop processing new requests
                        await crawler.autoscaledPool?.abort();
                        throw new Error('MAX_RESULTS_REACHED');
                    }
                } catch (error) {
                    if (error.message === 'MAX_RESULTS_REACHED') {
                        throw error;
                    }
                    console.error('Error in requestHandler:', error);
                    // Don't rethrow other errors to allow crawler to continue
                }
            },
        });

        crawler.events.on('abort', async () => {
            await flushBatch(crawlId);
        });

        console.log('Starting the crawler...');
        await crawler.run([urlToCrawl]);
        console.log('Crawler finished successfully.');
        await flushBatch(crawlId);
        const metrics = getMetrics(crawlId);

        clearTimeout(crawlTimeout);
        activeCrawls.delete(crawlId);
        clearMetrics(crawlId);

        res.json({
            success: true,
            message: 'Crawl completed successfully.',
            metrics,
        });
    } catch (error) {
        console.error('Crawler failed:', error);

        if (error.code !== 'CRAWLER_ABORTED') {
            await flushBatch(crawlId);
        }

        clearTimeout(crawlTimeout);
        activeCrawls.delete(crawlId);
        const metrics = getMetrics(crawlId);
        clearMetrics(crawlId);

        if (error.message === 'MAX_RESULTS_REACHED') {
            res.json({
                success: true,
                message: `Crawl completed after reaching max results (${maxResults}).`,
                metrics,
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Crawler failed. Check the server logs for details.',
                error: error.message,
            });
        }
    } finally {
        isShuttingDown = true;

        // Clean up crawler resources first - this will wait for pending operations
        try {
            if (crawler) {
                // Close all browser pages and contexts first
                if (crawler.browserPool) {
                    try {
                        // Close all browser instances in the pool
                        await crawler.browserPool.destroy();
                        console.log('Browser pool destroyed');
                    } catch (poolError) {
                        console.error('Error destroying browser pool:', poolError);
                    }
                }

                // Wait for crawler to fully teardown including all pending request updates
                await crawler.teardown();
                console.log('Crawler resources cleaned up');
            }
        } catch (cleanupError) {
            // Only log non-teardown errors
            if (cleanupError.message && !cleanupError.message.includes('Cannot read properties of undefined')) {
                console.error('Error during crawler cleanup:', cleanupError);
            }
        }

        // Force garbage collection if available (V8 only)
        if (global.gc) {
            global.gc();
            console.log('Forced garbage collection');
        }

        // Don't manually drop the queue - let the memory storage handle cleanup
        // This avoids race conditions with pending request operations
        console.log('Request queue cleanup deferred to memory storage');

        // Ensure cleanup happens
        clearTimeout(crawlTimeout);
        activeCrawls.delete(crawlId);
        clearMetrics(crawlId);
    }
});

// Start server
app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${port}`);
});