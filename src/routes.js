import { pool } from './db.js'; // Import the pool directly
import process from 'process';

// Map to hold per-crawl context data (keyed by crawlId)
const crawlContexts = new Map();

// Cleanup old crawl contexts after timeout (prevent memory leaks)
const CONTEXT_TIMEOUT_MS = 3600000; // 1 hour
const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [crawlId, ctx] of crawlContexts.entries()) {
        if (now - ctx.startTime > CONTEXT_TIMEOUT_MS) {
            console.warn(`Cleaning up stale crawl context: ${crawlId}`);
            crawlContexts.delete(crawlId);
        }
    }
}, 300000); // Check every 5 minutes

// Prevent the interval from keeping the process alive
cleanupInterval.unref();

// Function to insert a batch of rows within a transaction
const insertBatch = async (batch) => {
    let client = null;
    try {
        client = await pool.connect(); // Acquire a client from the pool
        await client.query('BEGIN'); // Start a transaction

        // Filter out records without any contact info
        const contactRecords = batch.filter(record =>
            (record[2] && record[2].length > 0) || // emails
            (record[3] && record[3].length > 0) || // twitter_links
            (record[4] && record[4].length > 0) || // instagram_links
            (record[5] && record[5].length > 0)    // linkedin_links
        );

        if (contactRecords.length === 0) {
            console.log('Skipping empty contact batch');
            await client.query('COMMIT'); // Commit empty transaction to release lock
            return;
        }

        const insertQuery = `
            INSERT INTO ${process.env.SCRAPE_TABLE_NAME} (
                site_homepage, loaded_url,
                emails, twitter_links, instagram_links, linkedin_links
            )
            VALUES ${contactRecords.map((_, i) => `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6})`).join(', ')}
            ON CONFLICT (site_homepage) DO UPDATE SET
                loaded_url = EXCLUDED.loaded_url,
                emails = EXCLUDED.emails,
                twitter_links = EXCLUDED.twitter_links,
                instagram_links = EXCLUDED.instagram_links,
                linkedin_links = EXCLUDED.linkedin_links;
        `;
        // Flatten the contactRecords array into a single array of values for the query
        const values = contactRecords.flat();

        await client.query(insertQuery, values); // Execute the batch insert
        await client.query('COMMIT'); // Commit the transaction

        console.log(`Processed ${batch.length} rows (inserted or updated)`);
    } catch (error) {
        // Only attempt rollback if client exists and connection is active
        if (client) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('Error during rollback:', rollbackError);
            }
        }
        console.error('Error inserting/updating batch:', error);
        throw error;
    } finally {
        // Always release the client back to the pool if it was acquired
        if (client) {
            try {
                client.release();
            } catch (releaseError) {
                console.error('Error releasing client:', releaseError);
            }
        }
    }
};

export const requestHandler = async ({ request, page, log, pushData, enqueueLinks, maxResults, crawlId }) => {
    // Get or create context for this crawl
    if (!crawlContexts.has(crawlId)) {
        crawlContexts.set(crawlId, {
            totalPagesScraped: 0,
            totalFailures: 0,
            startTime: Date.now(),
            site_homepage: null,
            websiteData: {
                site_homepage: null,
                emails: new Set(),
                twitter_links: new Set(),
                instagram_links: new Set(),
                linkedin_links: new Set()
            }
        });
    }

    const ctx = crawlContexts.get(crawlId);

    // Get current website
    const currentWebsite = new URL(request.loadedUrl).origin;

    // Reset metrics if website has changed
    if (ctx.site_homepage !== currentWebsite) {
        ctx.site_homepage = currentWebsite;
        ctx.websiteData.site_homepage = ctx.site_homepage;
        ctx.totalPagesScraped = 0;
        log.info(`New website detected: ${ctx.site_homepage}`);
        console.log(`New website detected: ${ctx.site_homepage}`);
    }

    // Check if we've reached max results for this website
    if (maxResults !== null && ctx.totalPagesScraped >= maxResults) {
        log.info(`Reached max results (${maxResults}) for ${ctx.site_homepage}, aborting crawl`);
        throw new Error('MAX_RESULTS_REACHED');
    }

    log.info(`Processing: ${request.url}`);
    console.log(`Processing URL: ${request.url}`);

    try {
        await page.waitForLoadState('networkidle', { timeout: 15000 }); // Added 15 second timeout

        const title = await page.title();
        log.info(`Title: ${title}`);
        console.log(`Page Title: ${title}`);

        // Scroll the page to trigger dynamic content
        await page.evaluate(() => {
            window.scrollBy(0, window.innerHeight);
        });

        // Check if page might have contact info
        const contactSelectors = [
            'a[href^="mailto:"]',
            'a[href*="twitter.com"]',
            'a[href*="instagram.com"]',
            'a[href*="linkedin.com"]'
        ];
        
        const hasContactInfo = await page.$$eval(contactSelectors.join(','),
            elements => elements.length > 0
        );

        // Extract body text and emails
        const bodyText = await page.evaluate(() => {
            const clone = (document.querySelector('article') || document.body).cloneNode(true);
            // Remove unwanted elements
            clone.querySelectorAll('img, figure, script, style, .ad, .caption').forEach(el => el.remove());

            const emailSet = new Set();

            // 1. Extract emails from mailto links (most reliable)
            document.querySelectorAll('a[href^="mailto:"]').forEach(link => {
                const email = link.href.replace('mailto:', '').split('?')[0].toLowerCase().trim();
                if (email) emailSet.add(email);
            });

            // 2. Extract emails from text content with improved regex
            const emailRegex = /\b[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+\b/gi;
            const textEmails = Array.from(document.body.textContent.matchAll(emailRegex))
                .map(m => m[0].toLowerCase().trim());
            textEmails.forEach(email => emailSet.add(email));

            // 3. Extract emails from HTML attributes (data-email, etc.)
            document.querySelectorAll('[data-email], [data-mail]').forEach(el => {
                const email = (el.getAttribute('data-email') || el.getAttribute('data-mail'))?.toLowerCase().trim();
                if (email && email.includes('@')) emailSet.add(email);
            });

            // 4. Handle obfuscated emails in text (e.g., "name [at] domain [dot] com")
            const obfuscatedRegex = /\b([A-Za-z0-9._%+-]+)\s*[\[\(]?\s*at\s*[\]\)]?\s*([A-Za-z0-9-]+)\s*[\[\(]?\s*dot\s*[\]\)]?\s*([A-Za-z]+)\b/gi;
            const obfuscatedMatches = Array.from(document.body.textContent.matchAll(obfuscatedRegex));
            obfuscatedMatches.forEach(match => {
                const email = `${match[1]}@${match[2]}.${match[3]}`.toLowerCase().trim();
                emailSet.add(email);
            });

            // Filter out invalid and spam emails
            const commonSpamDomains = [
                'example.com', 'example.org', 'test.com', 'test.org',
                'domain.com', 'email.com', 'yoursite.com', 'yourdomain.com',
                'sentry.io', 'wixpress.com', 'schema.org'
            ];

            const validEmails = Array.from(emailSet).filter(email => {
                // Basic validation
                const parts = email.split('@');
                if (parts.length !== 2) return false;

                const [localPart, domain] = parts;

                // Filter invalid patterns
                if (!localPart || !domain) return false;
                if (email.includes('..')) return false;
                if (email.startsWith('.') || email.endsWith('.')) return false;
                if (email.length > 254) return false;
                if (localPart.length > 64) return false;

                // Filter phone number patterns in local part
                // Matches patterns like: 555-1234, 555.1234, (555)1234, 5551234 (all digits with separators)
                const phonePatterns = [
                    /^\d{3}[-.\s]?\d{3}[-.\s]?\d{4}$/,  // 555-867-5309, 555.867.5309
                    /^\d{10}$/,                          // 5558675309
                    /^\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}$/, // (555)867-5309
                    /^\d{3}[-.\s]?\d{4}$/,               // 555-1234
                    /^\d{7,}$/,                          // 7+ digits in a row
                ];
                if (phonePatterns.some(pattern => pattern.test(localPart))) return false;

                // Filter if local part is mostly digits (likely phone number)
                const digitCount = (localPart.match(/\d/g) || []).length;
                const letterCount = (localPart.match(/[a-z]/gi) || []).length;
                if (digitCount > 0 && letterCount === 0 && digitCount >= 7) return false;

                // Filter if local part starts with 7+ consecutive digits (phone number pattern)
                // This catches: 5558675309manassas, 4155551234property, etc.
                if (/^\d{7,}/.test(localPart)) return false;

                // Filter if digits significantly outnumber letters (ratio > 3:1)
                // This catches things like: 123456a, 9876543xyz
                if (letterCount > 0 && digitCount / letterCount > 3) return false;

                // Filter spam domains
                if (commonSpamDomains.includes(domain)) return false;

                // Must have valid TLD (at least 2 chars)
                const tld = domain.split('.').pop();
                if (!tld || tld.length < 2) return false;

                // Domain must contain at least one letter (not all numbers)
                if (!/[a-z]/i.test(domain)) return false;

                // Local part should contain at least one letter (helps filter phone numbers)
                if (!/[a-z]/i.test(localPart)) return false;

                // Filter image/asset file extensions that might be false positives
                if (email.match(/\.(jpg|jpeg|png|gif|svg|webp|css|js)$/i)) return false;

                return true;
            });

            // Get clean text
            return {
                text: clone.textContent
                    .replace(/\s+/g, ' ')
                    .replace(/\b(Figure|Image)\s*\d*:?/gi, '')
                    .trim(),
                emails: validEmails
            };
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

        // Extract social media profiles
        const socialLinks = await page.evaluate(() => {
            const socialSet = new Set();

            // Twitter/X patterns
            const twitterSelectors = 'a[href*="twitter.com"], a[href*="x.com"]';
            document.querySelectorAll(twitterSelectors).forEach(el => {
                const url = el.href.toLowerCase();
                // Filter out generic links like /share, /intent, etc.
                if (url.match(/(?:twitter\.com|x\.com)\/(?!share|intent|i\/|home|explore|search)[a-zA-Z0-9_]+/)) {
                    socialSet.add(el.href);
                }
            });

            // Instagram patterns
            const instaSelectors = 'a[href*="instagram.com"]';
            document.querySelectorAll(instaSelectors).forEach(el => {
                const url = el.href.toLowerCase();
                // Filter out generic/action links
                if (url.match(/instagram\.com\/(?!p\/|reel\/|tv\/|explore)[a-zA-Z0-9._]+/)) {
                    socialSet.add(el.href);
                }
            });

            // LinkedIn patterns (company pages and personal profiles)
            const linkedinSelectors = 'a[href*="linkedin.com"]';
            document.querySelectorAll(linkedinSelectors).forEach(el => {
                const url = el.href.toLowerCase();
                // Match both /in/ (profiles) and /company/ (company pages)
                if (url.match(/linkedin\.com\/(in|company)\//)) {
                    socialSet.add(el.href);
                }
            });

            return Array.from(socialSet);
        });

        // Extract comments
        const comments = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.comment-text, .comment-content')).map(el => el.textContent.trim());
        });

        // Only add data if contact info was found on this page
        if (hasContactInfo) {
            bodyText.emails.forEach(email => ctx.websiteData.emails.add(email));

            // Add Twitter/X links
            socialLinks.filter(l => {
                const url = l.toLowerCase();
                return url.includes('twitter.com') || url.includes('x.com');
            }).forEach(link => ctx.websiteData.twitter_links.add(link));

            // Add Instagram links
            socialLinks.filter(l => l.toLowerCase().includes('instagram.com'))
                .forEach(link => ctx.websiteData.instagram_links.add(link));

            // Add LinkedIn links (both profiles and company pages)
            socialLinks.filter(l => l.toLowerCase().includes('linkedin.com'))
                .forEach(link => ctx.websiteData.linkedin_links.add(link));
        }

        ctx.totalPagesScraped++;
        log.info(`Processed page ${ctx.totalPagesScraped} for ${ctx.site_homepage}`);

    } catch (error) {
        log.error(`Error processing ${request.url}:`, error);
        console.error(`Error processing ${request.url}:`, error);

        // Increment the number of failures
        ctx.totalFailures++;

        // Ensure page is closed on error to prevent memory leaks
        try {
            if (page && !page.isClosed()) {
                await page.close();
            }
        } catch (closeError) {
            console.error('Error closing page:', closeError);
        }
    }

    // Enqueue links - but skip if we're at or near max results to avoid race conditions
    const shouldEnqueueLinks = !maxResults || ctx.totalPagesScraped < maxResults - 1;

    if (shouldEnqueueLinks) {
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
            // Don't log errors if it's related to queue being dropped (during shutdown)
            if (!error.message?.includes('does not exist')) {
                console.error(`Error enqueueing links from ${request.url}:`, error);
            }
        }
    } else {
        console.log(`Skipping link enqueuing - approaching max results (${ctx.totalPagesScraped}/${maxResults})`);
    }
};

// Function to flush the website data when the crawl ends
export const flushBatch = async (crawlId) => {
    const ctx = crawlContexts.get(crawlId);
    if (!ctx) return;

    if (ctx.websiteData.site_homepage) {
        // Create a row from the aggregated data
        const row = [
            ctx.websiteData.site_homepage,
            ctx.websiteData.site_homepage, // We use the homepage as the loaded_url now
            Array.from(ctx.websiteData.emails),
            Array.from(ctx.websiteData.twitter_links),
            Array.from(ctx.websiteData.instagram_links),
            Array.from(ctx.websiteData.linkedin_links),
        ];

        // Use the existing insertBatch function, which expects an array of rows
        await insertBatch([row]);
    }

    // Clean up context
    crawlContexts.delete(crawlId);
};

// Function to calculate average speed (pages per second)
const calculateAverageSpeed = (ctx) => {
    const endTime = Date.now();
    const totalTimeInSeconds = (endTime - ctx.startTime) / 1000;
    // Avoid division by zero if no pages were scraped or time is zero
    return totalTimeInSeconds > 0 ? ctx.totalPagesScraped / totalTimeInSeconds : 0;
};

// Function to get metrics
export const getMetrics = (crawlId) => {
    const ctx = crawlContexts.get(crawlId);
    if (!ctx) {
        return {
            totalPagesScraped: 0,
            totalFailures: 0,
            averageSpeed: 0,
            totalArticles: 0
        };
    }
    return {
        totalPagesScraped: ctx.totalPagesScraped,
        totalFailures: ctx.totalFailures,
        averageSpeed: calculateAverageSpeed(ctx),
        totalArticles: ctx.totalPagesScraped
    };
};

export const clearMetrics = (crawlId) => {
    crawlContexts.delete(crawlId);
};