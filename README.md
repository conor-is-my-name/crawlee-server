# Web Scraping API Service

A Node.js service for crawling and scraping web pages using Playwright.
It is configured to send the results to a postgres database.  Configure in .env file

Docker compose file includes commented out configuration options to scale to multiple containers.  Add more ports to the range if you plan to go above 4 instances.  I've tested it on an 8 core 16gb Root VPS with a AMD EPYC™ 9634, max performance on that setup is around 5-6 containers.

You can adjust the memory used by the scraper and max concurrency in the .env file.  There is less chance of rate limiting if you keep concurrency in the 3-5 range, but I've done over 100, when limits aren't set, on some websites when not limited.  

Uses ramdisk to help with IO performance. 

## API Endpoints

### Start a Crawl
`GET /start-crawl`

Starts a web crawling job for the specified URL.

**Query Parameters:**
- `url` (required) - The URL to start crawling from
- `maxResults` (optional) - Maximum number of pages to scrape (default: no limit)

**Example Request:**
```bash
curl "http://localhost:3001/start-crawl?url=https://example.com&maxResults=10"
```
make sure to update your servers IP & Port
you can use variables for the website and max results

**Success Response:**
```json
{
  "success": true,
  "message": "Crawl completed successfully.",
  "metrics": {
    "totalPagesScraped": 10,
    "totalFailures": 0,
    "averageSpeed": 2.5
  }
}
```

**Error Responses:**
- Missing URL parameter:
  ```json
  {
    "success": false,
    "message": "Please provide a URL to crawl using the \"url\" query parameter."
  }
  ```

- Crawler failure:
  ```json
  {
    "success": false,
    "message": "Crawler failed. Check the server logs for details.",
    "error": "Error message here"
  }
  ```

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables in `.env`:
```
PORT=3001
```

3. Start the server:
```bash
node src/main.js
```

## Running with Docker

1. Build the image:
```bash
docker-compose build
```

2. Start the container:
```bash
docker-compose up
```

## Configuration

The service is configured with:
- 3GB memory limit
- In-memory storage (no persistence)
- 3 concurrent requests
- Headless browser mode