import 'dotenv/config';
import express from 'express';
import { PlaywrightCrawler, Configuration } from 'crawlee';
import { requestHandler, getMetrics, clearMetrics } from './routes.js';

// Set memory limit from environment
process.env.CRAWLEE_MEMORY_MBYTES = process.env.CRAWLEE_MEMORY_MBYTES || '2048';

// Configure storage to use memory
Configuration.getGlobalConfig().set('storageClientOptions', {
    persistStorage: false, // This will use memory storage
});

// Initialize the Express app
const app = express();
const port = process.env.PORT || 3001;

// Define the /start-crawl endpoint
app.get('/start-crawl', async (req, res) => {
    const urlToCrawl = req.query.url;
    const maxResults = req.query.maxResults ? parseInt(req.query.maxResults) : null;

    if (!urlToCrawl) {
        return res.status(400).send('Please provide a URL to crawl using the "url" query parameter.');
    }

    if (maxResults !== null && (isNaN(maxResults) || maxResults <= 0)) {
        return res.status(400).send('maxResults must be a positive integer if provided.');
    }

    console.log(`Starting crawl for URL: ${urlToCrawl}`);

    // Clear previous metrics
    clearMetrics();

    // Initialize the crawler
    const crawler = new PlaywrightCrawler({
        launchContext: {
            launchOptions: {
                headless: true,
                args: [
                    '--disk-cache-dir=/tmp',  // Use the RAM-mounted /tmp
                    '--disk-cache-size=0',    // Disable disk cache (optional)
                    '--disable-dev-shm-usage',
                    '--no-sandbox',
                ],
            },
        },
        maxConcurrency: parseInt(process.env.maxConcurrency) || 3,
        requestHandler: async (context) => {
            // Pass maxResults to the request handler
            context.maxResults = maxResults;
            return requestHandler(context);
        },
    });

    try {
        console.log('Starting the crawler...');
        await crawler.run([urlToCrawl]);
        console.log('Crawler finished successfully.');

        // Get the metrics
        const metrics = getMetrics();

        // Send the metrics as JSON response
        res.json({
            success: true,
            message: 'Crawl completed successfully.',
            metrics,
        });
    } catch (error) {
        console.error('Crawler failed:', error);
        res.status(500).json({
            success: false,
            message: 'Crawler failed. Check the server logs for details.',
            error: error.message,
        });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
