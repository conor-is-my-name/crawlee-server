import { pool } from './db.js'; // Import the pool directly
import process from 'process';

let totalPagesScraped = 0;
let totalFailures = 0;
let startTime = null;
let sitehomepage = null; // Variable to store the base URL

// Batch configuration
const BATCH_SIZE = 100; // Number of rows to insert in a single batch
let batch = []; // Array to hold rows for the current batch

// Function to insert a batch of rows within a transaction
const insertBatch = async (batch) => {
    const client = await pool.connect(); // Acquire a client from the pool
    try {
        await client.query('BEGIN'); // Start a transaction

        const insertQuery = `
            INSERT INTO ${process.env.SCRAPE_TABLE_NAME} (
                sitehomepage, article_url, title, bodyText, datePublished, 
                articlecategories, tags, keywords, author, featuredImage, comments
            )
            VALUES ${batch.map((_, i) => `($${i * 11 + 1}, $${i * 11 + 2}, $${i * 11 + 3}, $${i * 11 + 4}, $${i * 11 + 5}, $${i * 11 + 6}, $${i * 11 + 7}, $${i * 11 + 8}, $${i * 11 + 9}, $${i * 11 + 10}, $${i * 11 + 11})`).join(', ')}
            ON CONFLICT (article_url) DO UPDATE SET
                sitehomepage = EXCLUDED.sitehomepage,
                title = EXCLUDED.title,
                bodyText = EXCLUDED.bodyText,
                datePublished = EXCLUDED.datePublished,
                articlecategories = EXCLUDED.articlecategories,
                tags = EXCLUDED.tags,
                keywords = EXCLUDED.keywords,
                author = EXCLUDED.author,
                featuredImage = EXCLUDED.featuredImage,
                comments = EXCLUDED.comments;
        `;
        const values = batch.flat(); // Flatten the batch array into a single array of values

        await client.query(insertQuery, values); // Execute the batch insert
        await client.query('COMMIT'); // Commit the transaction

        console.log(`Processed ${batch.length} rows (inserted or updated)`);
    } catch (error) {
        await client.query('ROLLBACK'); // Rollback the transaction on error
        console.error('Error inserting/updating batch:', error);
        throw error;
    } finally {
        client.release(); // Release the client back to the pool
    }
};

export const requestHandler = async ({ request, page, log, pushData, enqueueLinks, maxResults }) => {
    if (!startTime) {
        startTime = Date.now(); // Record the start time of the crawl
    }

    // Set the base URL (sitehomepage) if it's not already set
    if (!sitehomepage) {
        sitehomepage = new URL(request.loadedUrl).origin; // Extract the base URL (e.g., https://example.com)
        log.info(`Base URL set to: ${sitehomepage}`);
        console.log(`Base URL set to: ${sitehomepage}`);
    }

    // Check if we've reached max results for this website
    if (maxResults !== null && totalPagesScraped >= maxResults) {
        log.info(`Reached max results (${maxResults}) for ${sitehomepage}, skipping ${request.url}`);
        return;
    }

    log.info(`Processing: ${request.url}`);
    console.log(`Processing URL: ${request.url}`);

    try {
        await page.waitForLoadState('networkidle', { timeout: 15000 }); // Added 15 second timeout

        const title = await page.title();
        log.info(`Title: ${title}`);
        console.log(`Page Title: ${title}`);

        // Scroll the page
        await page.evaluate(() => {
            window.scrollBy(0, window.innerHeight);
        });

        // Extract body text
        const bodyText = await page.evaluate(() => {
            const clone = (document.querySelector('article') || document.body).cloneNode(true);
            // Remove unwanted elements
            clone.querySelectorAll('img, figure, script, style, .ad, .caption').forEach(el => el.remove());
            // Get clean text
            return clone.textContent
                .replace(/\s+/g, ' ')
                .replace(/\b(Figure|Image)\s*\d*:?/gi, '')
                .trim();
        });

        // Extract and standardize date published to ISO UTC
        const datePublished = await page.evaluate(() => {
            // Helper function to convert date to ISO UTC
            const toISOUTC = (date) => {
                if (!date) return null;
                try {
                    const parsedDate = new Date(date);
                    if (isNaN(parsedDate.getTime())) return null;
                    return parsedDate.toISOString();
                } catch (e) {
                    return null;
                }
            };

            // Try different date sources in order of preference
            const timeElement = document.querySelector('time[datetime]');
            if (timeElement) return toISOUTC(timeElement.getAttribute('datetime'));

            const metaDate = document.querySelector('meta[property="article:published_time"]');
            if (metaDate) return toISOUTC(metaDate.getAttribute('content'));

            const spanDate = document.querySelector('span.published-date');
            if (spanDate) return toISOUTC(spanDate.textContent.trim());

            return null;
        });

        // Extract categories
        const articlecategories = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.categories a, .category a')).map(el => el.textContent.trim());
        });

        // Extract tags
        const tags = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.tags a, .tag a')).map(el => el.textContent.trim());
        });

        // Extract keywords
        const keywords = await page.evaluate(() => {
            const metaKeywords = document.querySelector('meta[name="keywords"]');
            return metaKeywords ? metaKeywords.content.split(',').map(k => k.trim()) : [];
        });

        // Extract author
        const author = await page.evaluate(() => {
            return document.querySelector('meta[name="author"]')?.content ||
                   document.querySelector('.author-name, .author a')?.textContent.trim();
        });

        // Extract featured image
        const featuredImage = await page.evaluate(() => {
            return document.querySelector('meta[property="og:image"]')?.content ||
                   document.querySelector('.featured-image img, .post-thumbnail img')?.src;
        });

        // Extract comments
        const comments = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.comment-text, .comment-content')).map(el => el.textContent.trim());
        });

        // Check if the article_url already exists in the batch
        const isDuplicate = batch.some(row => row[1] === request.loadedUrl); // row[1] is article_url
        if (isDuplicate) {
            log.info(`Skipping duplicate URL in batch: ${request.loadedUrl}`);
            console.log(`Skipping duplicate URL in batch: ${request.loadedUrl}`);
        } else {
            // Add data to the batch
            batch.push([
                sitehomepage, // sitehomepage (base URL of the website)
                request.loadedUrl, // article_url (URL of the article)
                title, // title (title of the article)
                bodyText, // bodyText (body text of the article)
                datePublished || null, // Convert empty/falsy values to NULL
                articlecategories, // articlecategories (categories of the article)
                tags, // tags (tags associated with the article)
                keywords, // keywords (keywords associated with the article)
                author, // author (author of the article)
                featuredImage, // featuredImage (URL of the featured image)
                JSON.stringify(comments), // comments (comments on the article)
            ]);

            // Insert batch if it reaches the batch size
            if (batch.length >= BATCH_SIZE) {
                await insertBatch(batch);
                batch = []; // Reset the batch
            }

            // Increment the number of pages scraped
            totalPagesScraped++;
        }

    } catch (error) {
        log.error(`Error processing ${request.url}:`, error);
        console.error(`Error processing ${request.url}:`, error);

        // Increment the number of failures
        totalFailures++;
    }

    // Enqueue links
    try {
        const links = await enqueueLinks({
            label: 'detail',
            transformRequestFunction(req) {
                // Define an array of file extensions to ignore
                const ignoredExtensions = ['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];

                // Check if the URL ends with any of the ignored extensions
                const shouldIgnore = ignoredExtensions.some(ext => req.url.toLowerCase().endsWith(ext));

                // If the URL should be ignored, return false
                if (shouldIgnore) return false;

                // Otherwise, return the request
                return req;
            },
        });
        console.log(`Enqueued ${links.length} links from ${request.url}`);
    } catch (error) {
        console.error(`Error enqueueing links from ${request.url}:`, error);
    }
};

// Function to flush the remaining batch (if any) when the crawl ends
export const flushBatch = async () => {
    if (batch.length > 0) {
        await insertBatch(batch);
        batch = []; // Reset the batch
    }
};

// Function to calculate average speed (pages per second)
const calculateAverageSpeed = () => {
    const endTime = Date.now();
    const totalTimeInSeconds = (endTime - startTime) / 1000;
    return totalPagesScraped / totalTimeInSeconds;
};

// Function to get metrics
export const getMetrics = () => {
    return {
        totalPagesScraped,
        totalFailures,
        averageSpeed: calculateAverageSpeed(),
    };
};

export const clearMetrics = () => {
    totalPagesScraped = 0;
    totalFailures = 0;
    startTime = null;
    sitehomepage = null; // Reset the base URL when clearing metrics
};
