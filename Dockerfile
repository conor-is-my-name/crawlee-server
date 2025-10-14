# Use an official Node.js runtime as a parent image
FROM node:18

# Install dumb-init for proper signal handling and zombie reaping
RUN apt-get update && apt-get install -y dumb-init && rm -rf /var/lib/apt/lists/*

# Set the working directory in the container
WORKDIR /usr/src/app

# Create necessary directories for tmpfs mounts
RUN mkdir -p /usr/src/app/storage /tmp /var/cache /root/.cache /home/pptruser/.cache && \
    chmod 777 /usr/src/app/storage /tmp /var/cache /root/.cache /home/pptruser/.cache

# Install system dependencies required for Playwright, PostgreSQL, and other libraries
RUN apt-get update && \
    apt-get install -y \
    wget \
    curl \
    git \
    libgtk2.0-0 \
    libgtk-3-0 \
    libgbm-dev \
    libnotify-dev \
    libgconf-2-4 \
    libnss3 \
    libxss1 \
    libasound2 \
    libxtst6 \
    xauth \
    xvfb \
    # Install PostgreSQL client library (libpq)
    libpq-dev \
    # Clean up to reduce image size
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Copy package.json and package-lock.json
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Set Playwright browsers path to a location in the image (not tmpfs)
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/lib/playwright

# Install Playwright browsers in the image
RUN npx playwright install --with-deps chromium

# Copy the rest of the application code
COPY . .

# Set environment variables for RAM-only operation
ENV CRAWLEE_STORAGE_DIR=/usr/src/app/storage \
    TMPDIR=/tmp \
    NODE_OPTIONS="--max-old-space-size=3072" \
    CRAWLEE_MEMORY_MBYTES=2048

# Use dumb-init as the entrypoint to handle signals and reap zombie processes
ENTRYPOINT ["dumb-init", "--"]

# Command to run the application with garbage collection flags
CMD ["node", "--expose-gc", "--max-old-space-size=3072", "src/main.js"]