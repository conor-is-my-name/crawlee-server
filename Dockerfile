# Use an official Node.js runtime as a parent image
FROM node:18

# Set the working directory in the container
WORKDIR /usr/src/app

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

# Install Playwright browsers (if using Playwright)
RUN npx playwright install --with-deps

# Copy the rest of the application code
COPY . .

# Command to run the application
CMD ["node", "src/main.js"]