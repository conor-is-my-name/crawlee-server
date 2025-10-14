# RAM-Only Container Configuration

This document explains the RAM-only configuration for the Crawlee server containers, ensuring no data is written to persistent disk storage.

## Overview

The containers are configured to run entirely in RAM using tmpfs mounts. All temporary files, caches, and storage are directed to memory-backed filesystems that exist only while the container is running.

## Key Components

### 1. Tmpfs Mounts

Each container has the following tmpfs mounts configured:

- `/tmp` (1GB) - General temporary files
- `/usr/src/app/storage` (500MB) - Crawlee's data storage
- `/var/cache` (100MB) - System cache
- `/root/.cache` (500MB) - User cache including Playwright browsers
- `/home/pptruser/.cache` (500MB) - Playwright user-specific cache

Total RAM allocation per container for tmpfs: ~2.6GB

### 2. Read-Only Root Filesystem

The container's root filesystem is mounted as read-only (`read_only: true`), preventing any writes to the Docker image layers. Only the tmpfs mounts are writable.

### 3. Environment Variables

The following environment variables ensure applications use RAM-backed directories:

```yaml
CRAWLEE_STORAGE_DIR: /usr/src/app/storage  # Crawlee data in tmpfs
TMPDIR: /tmp                               # Temp files in tmpfs
PLAYWRIGHT_BROWSERS_PATH: /root/.cache/ms-playwright  # Browsers in tmpfs
```

### 4. Application Configuration

The main.js application is configured with:
- `persistStorage: false` - Prevents Crawlee from persisting data between runs
- Browser cache directories point to tmpfs mounts
- All Playwright browser operations use `--disk-cache-dir=/tmp` and `--disk-cache-size=0`

## Memory Considerations

Each container can use up to:
- 3GB total memory limit (set in Docker)
- ~2.6GB for tmpfs mounts
- ~400MB for application runtime

Ensure your system has sufficient RAM: (3GB + 2.6GB) × number of containers

For 12 containers: ~67GB total RAM requirement

## Building and Running

1. **Generate the docker-compose.yml:**
   ```bash
   node generate-docker-compose.js
   ```

2. **Build the containers:**
   ```bash
   docker-compose build
   ```

3. **Run the containers:**
   ```bash
   docker-compose up -d
   ```

## Configuration Options

Modify these environment variables in `.env` to adjust the configuration:

- `NUM_SCRAPERS` - Number of scraper containers (default: 12)
- `START_PORT` - Starting port number (default: 11000)
- `CPU_LIMIT` - CPU limit per container (default: '1')
- `MEMORY_LIMIT` - Memory limit per container (default: '3G')
- `TMPFS_SIZE` - Size of /tmp tmpfs mount (default: '1G')
- `CPU_SHARES` - CPU shares for scheduling (default: 512)

## Verification

To verify containers are running RAM-only:

1. **Check mounted filesystems:**
   ```bash
   docker exec scraper1 df -h
   ```
   You should see tmpfs mounts for all configured paths.

2. **Verify read-only root:**
   ```bash
   docker exec scraper1 touch /test.txt
   ```
   This should fail with a "Read-only file system" error.

3. **Monitor memory usage:**
   ```bash
   docker stats
   ```

## Benefits

1. **No Disk I/O**: Eliminates disk bottlenecks for improved performance
2. **Security**: No persistent data remains after container stops
3. **Clean State**: Each container start is completely fresh
4. **Reduced Wear**: No SSD/HDD write cycles

## Limitations

1. **No Persistence**: All data is lost when container stops
2. **Memory Requirements**: Requires significant RAM
3. **No Crash Recovery**: Cannot recover in-progress work after crashes

## Troubleshooting

If containers fail to start or crash:

1. **Check available memory:**
   ```bash
   free -h
   ```

2. **Reduce tmpfs sizes** in generate-docker-compose.js if needed

3. **Monitor container logs:**
   ```bash
   docker logs scraper1
   ```

4. **Adjust memory limits** in `.env` file based on your system capacity

## Security Notes

- Containers run with `no-new-privileges` security option
- Read-only root filesystem prevents unauthorized modifications
- All data exists only in volatile memory
- No sensitive data persists after container termination