import { createPlaywrightRouter, sleep } from 'crawlee';
import fs from 'fs';
import path from 'path';
import https from 'https';

export const router = createPlaywrightRouter();

// Default handler to enqueue links based on URL structure
router.addDefaultHandler(async ({ request, enqueueLinks, log }) => {
    const url = request.loadedUrl;

    if (url.includes('/Items/')) {
        log.info('Enqueueing category page URLs');
        await enqueueLinks({
            label: 'category',
        });
    } else if (url.includes('/p/')) {
        log.info('Enqueueing product page URLs');
        await enqueueLinks({
            label: 'detail',
        });
    } else {
        log.info(`Unknown page type, enqueueing with 'detail' label: ${url}`);
        await enqueueLinks({
            label: 'detail', // Default label for unknown pages
        });
    }
});

// Handler for processing category pages
router.addHandler('category', async ({ request, page, log, pushData, enqueueLinks }) => {
    const title = await page.title();
    log.info(`Processing Category: ${title}`, { url: request.loadedUrl });

    await page.waitForLoadState('networkidle');

    // Extract category description
    const categoryDescription = await page.evaluate(() => {
        const element = document.querySelector('.category-description');
        return element ? element.textContent.trim() : null;
    });

    // Enqueue links to product pages
    await enqueueLinks({
        selector: 'a', // Enqueue all links
        label: 'detail', // Override the default label
    });

    // Enqueue the next page, if it exists
    const nextPageUrl = await page.evaluate(() => {
        const nextPageLink = document.querySelector('.next-page');
        return nextPageLink ? nextPageLink.href : null;
    });

    if (nextPageUrl) {
        log.info(`Enqueueing next page: ${nextPageUrl}`);
        await enqueueLinks({
            urls: [nextPageUrl],
            label: 'category',
        });
    }

    // Save the data
    await pushData({
        url: request.loadedUrl,
        title,
        categoryDescription,
    });
});

async function downloadImage(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
        }).on('error', (error) => {
            fs.unlink(dest, () => reject(error)); // Delete the file async. (But we don't check for errors)
        });
    });
}

// Handler for processing product detail pages
router.addHandler('detail', async ({ request, page, log, pushData, enqueueLinks }) => {
    const title = await page.title();
    log.info(`Processing Product Detail: ${title}`, { url: request.loadedUrl });

    await page.waitForLoadState('networkidle');

    // Scroll the page to mimic human behavior
    await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight);
    });

    // Extract item name
    const itemName = await page.evaluate(() => {
        const element = document.querySelector('h1.product_title');
        return element ? element.textContent.trim() : null;
    });

    // Extract item description
    const itemDescription = await page.evaluate(() => {
        const elements = document.querySelectorAll('div.woocommerce-Tabs-panel--description h3, div.woocommerce-Tabs-panel--description p');
        return Array.from(elements).map(el => el.innerText.trim()).join('\n');
    });

    // Extract highlights
    const short_description = await page.evaluate(() => {
        const listItems = document.querySelectorAll('div.woocommerce-product-details__short-description ul li');
        return Array.from(listItems).map(li => li.textContent.trim());
    });

    // Extract attributes
    const attributes = await page.evaluate(() => {
        const rows = document.querySelectorAll('div.woocommerce-Tabs-panel--additional_information table.woocommerce-product-attributes.shop_attributes tr');
        return Array.from(rows).map(row => {
            const label = row.querySelector('th')?.innerText.trim() || '';
            const value = row.querySelector('td')?.innerText.trim() || '';
            return { label, value };
        });
    });

    // Extract product image with itemprop="image", fallback to og:image
    let productImage = await page.evaluate(() => {
        let imgElement = document.querySelector('div.woocommerce-product-gallery__image img.wp-post-image');
        return imgElement ? imgElement.src : null;
    });

    // Extract breadcrumbs
    const breadcrumbs = await page.evaluate(() => {
        const breadcrumbElements = document.querySelectorAll('nav.woocommerce-breadcrumb a');
        return Array.from(breadcrumbElements).map(el => ({
            text: el.innerText.trim(),
            href: el.href
        }));
    });

    let imagePath = null;
    if (productImage && itemName) {
        const storagePath = path.join(process.cwd(), 'storage', 'images');
        if (!fs.existsSync(storagePath)) {
            fs.mkdirSync(storagePath, { recursive: true });
        }

        const fileExtension = path.extname(new URL(productImage).pathname) || '.jpg';
        const imageName = `${itemName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}${fileExtension}`;
        const imageFullPath = path.join(storagePath, imageName);

        try {
            await downloadImage(productImage, imageFullPath);
            imagePath = imageFullPath;
        } catch (error) {
            log.error(`Error downloading image: ${error}`);
        }
    }

    // Save the data
    await pushData({
        url: request.loadedUrl,
        productImage,
        title,
        itemName,
        itemDescription,
        short_description,
        attributes,
        imagePath,
        breadcrumbs,
    });

    // Append the product image URL to image_urls.txt
    if (productImage) {
        log.info('Product Image URL:', productImage);
    }

    // Add a random delay between 3 and 10 seconds
//    const delay = Math.floor(Math.random() * 3000) + 3000; // Random delay between 3-10 seconds
//    await sleep(delay);

    // Enqueue links found on this page to continue crawling
    await enqueueLinks({
        label: 'detail',
    });
});
