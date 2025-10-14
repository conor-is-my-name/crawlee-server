import pg from 'pg';
import { readFileSync } from 'fs';
import fetch from 'node-fetch';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const { Pool } = pg;

// Read .env file
const envContent = readFileSync('.env', 'utf-8');
const envVars = {};
envContent.split('\n').forEach(line => {
  const [key, ...valueParts] = line.split('=');
  if (key && !key.startsWith('#')) {
    envVars[key.trim()] = valueParts.join('=').trim();
  }
});

// Database configuration
const pool = new Pool({
  user: envVars.POSTGRES_USER,
  host: envVars.POSTGRES_HOST,
  database: envVars.POSTGRES_DB,
  password: envVars.POSTGRES_PASSWORD,
  port: parseInt(envVars.POSTGRES_PORT),
});

const INPUT_TABLE_NAME = envVars.INPUT_TABLE_NAME || 'gmaps_pm_results';
const NUM_SCRAPERS = parseInt(envVars.NUM_SCRAPERS) || 16;
const START_PORT = parseInt(envVars.START_PORT) || 11000;
const MAX_RESULTS = parseInt(envVars.MAX_RESULTS) || 50;

// Memory management configuration
const MEMORY_THRESHOLD_MB = 2048; // Restart container if memory exceeds 2GB
const CHECK_INTERVAL_MS = 60000; // Check memory every minute
const MIN_JOBS_BEFORE_RESTART = 10; // Restart after at least 10 jobs
const FORCE_RESTART_AFTER_HOURS = 1; // Force restart after 1 hour regardless

// Get container uptime in milliseconds
async function getContainerUptime(containerName) {
  try {
    const { stdout } = await execAsync(
      `docker inspect ${containerName} --format='{{.State.StartedAt}}'`
    );
    const startTime = new Date(stdout.trim()).getTime();
    return Date.now() - startTime;
  } catch (error) {
    console.error(`Error getting uptime for ${containerName}:`, error.message);
    return 0;
  }
}

// Worker pool - tracks which containers are busy
const workers = Array.from({ length: NUM_SCRAPERS }, (_, i) => ({
  id: i + 1,
  port: START_PORT + i,
  containerName: `crawlee-server-scraper${i + 1}-1`,
  busy: false,
  currentJobId: null,
  jobsProcessed: 0,
  lastRestart: Date.now(),
  memoryUsage: 0,
}));

// Get container memory usage
async function getContainerMemory(containerName) {
  try {
    const { stdout } = await execAsync(
      `docker stats ${containerName} --no-stream --format "{{.MemUsage}}" | cut -d'/' -f1 | sed 's/[^0-9.]//g'`
    );
    const memoryMB = parseFloat(stdout.trim());

    // Handle GiB vs MiB
    if (stdout.includes('GiB')) {
      return memoryMB * 1024;
    }
    return memoryMB;
  } catch (error) {
    console.error(`Error getting memory for ${containerName}:`, error.message);
    return 0;
  }
}

// Restart a specific container
async function restartContainer(worker) {
  if (worker.busy) {
    console.log(`[Worker ${worker.id}] ⏳ Waiting for current job to complete before restart...`);
    return false;
  }

  try {
    console.log(`[Worker ${worker.id}] 🔄 Restarting container ${worker.containerName} (Memory: ${worker.memoryUsage.toFixed(0)}MB, Jobs: ${worker.jobsProcessed})`);

    await execAsync(`docker restart ${worker.containerName}`);

    // Wait for container to be ready
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Reset worker stats
    worker.jobsProcessed = 0;
    worker.lastRestart = Date.now();
    worker.memoryUsage = 0;

    console.log(`[Worker ${worker.id}] ✅ Container restarted successfully`);
    return true;
  } catch (error) {
    console.error(`[Worker ${worker.id}] ❌ Failed to restart container:`, error.message);
    return false;
  }
}

// Monitor and manage container health
async function monitorContainers() {
  while (true) {
    for (const worker of workers) {
      try {
        // Get current memory usage
        worker.memoryUsage = await getContainerMemory(worker.containerName);

        const hoursSinceRestart = (Date.now() - worker.lastRestart) / (1000 * 60 * 60);

        // Determine if restart is needed
        const needsRestart =
          (worker.memoryUsage > MEMORY_THRESHOLD_MB && worker.jobsProcessed >= MIN_JOBS_BEFORE_RESTART) ||
          (hoursSinceRestart >= FORCE_RESTART_AFTER_HOURS);

        if (needsRestart && !worker.busy) {
          await restartContainer(worker);
        }
      } catch (error) {
        console.error(`Error monitoring worker ${worker.id}:`, error.message);
      }
    }

    // Log current status
    const busyWorkers = workers.filter(w => w.busy).length;
    const avgMemory = workers.reduce((sum, w) => sum + w.memoryUsage, 0) / workers.length;
    console.log(`📊 Status: ${busyWorkers}/${NUM_SCRAPERS} busy, Avg Memory: ${avgMemory.toFixed(0)}MB`);

    await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL_MS));
  }
}

// Fetch next job from database
async function getNextJob() {
  const query = `
    SELECT id, website
    FROM ${INPUT_TABLE_NAME}
    WHERE website IS NOT NULL
      AND webscraped = false
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  `;

  const result = await pool.query(query);
  return result.rows[0] || null;
}

// Mark job as being processed
async function markJobInProgress(jobId) {
  await pool.query(
    `UPDATE ${INPUT_TABLE_NAME} SET webscraped = true WHERE id = $1`,
    [jobId]
  );
}

// Send crawl request to a scraper container
async function sendCrawlRequest(worker, url) {
  const scraperUrl = `http://localhost:${worker.port}/start-crawl?url=${encodeURIComponent(url)}&maxResults=${MAX_RESULTS}`;

  try {
    console.log(`[Worker ${worker.id}] Starting crawl for: ${url} (maxResults: ${MAX_RESULTS})`);
    const response = await fetch(scraperUrl);
    const result = await response.json();

    if (result.success) {
      console.log(`[Worker ${worker.id}] ✅ Completed: ${url}`);
      console.log(`[Worker ${worker.id}] Metrics:`, result.metrics);
    } else {
      console.log(`[Worker ${worker.id}] ❌ Failed: ${url} - ${result.message}`);
    }

    return result;
  } catch (error) {
    console.error(`[Worker ${worker.id}] Error crawling ${url}:`, error.message);
    return { success: false, error: error.message };
  }
}

// Process jobs continuously
async function processJobs() {
  console.log(`🚀 Orchestrator started with ${NUM_SCRAPERS} workers`);
  console.log(`📊 Querying table: ${INPUT_TABLE_NAME}`);
  console.log(`🔗 Workers on ports: ${START_PORT}-${START_PORT + NUM_SCRAPERS - 1}`);
  console.log(`🎯 Max results per crawl: ${MAX_RESULTS}`);
  console.log(`💾 Memory threshold: ${MEMORY_THRESHOLD_MB}MB`);
  console.log(`⏰ Force restart after: ${FORCE_RESTART_AFTER_HOURS} hour\n`);

  // Initialize worker lastRestart times based on actual container uptimes
  console.log('📊 Checking container uptimes...');
  for (const worker of workers) {
    const uptime = await getContainerUptime(worker.containerName);
    if (uptime > 0) {
      worker.lastRestart = Date.now() - uptime;
      const hoursUp = (uptime / (1000 * 60 * 60)).toFixed(1);
      console.log(`[Worker ${worker.id}] Container has been running for ${hoursUp} hours`);
    }
  }
  console.log('');

  // Start container monitoring in background
  monitorContainers().catch(error => {
    console.error('Monitor error:', error);
  });

  // Keep running until all jobs are done
  let activeWorkers = 0;
  let totalProcessed = 0;

  while (true) {
    // Find available workers (prioritize those with lower memory usage)
    const availableWorkers = workers
      .filter(w => !w.busy)
      .sort((a, b) => a.memoryUsage - b.memoryUsage);

    let availableWorker = availableWorkers[0];

    if (availableWorker) {
      // Update memory usage for this worker before checking
      availableWorker.memoryUsage = await getContainerMemory(availableWorker.containerName);

      // Check if this worker needs a restart BEFORE assigning new job
      const hoursSinceRestart = (Date.now() - availableWorker.lastRestart) / (1000 * 60 * 60);
      const needsRestart =
        (availableWorker.memoryUsage > MEMORY_THRESHOLD_MB && availableWorker.jobsProcessed >= MIN_JOBS_BEFORE_RESTART) ||
        (hoursSinceRestart >= FORCE_RESTART_AFTER_HOURS);

      if (needsRestart) {
        console.log(`[Worker ${availableWorker.id}] 🔄 Restarting before new job (Hours: ${hoursSinceRestart.toFixed(1)}, Memory: ${availableWorker.memoryUsage.toFixed(0)}MB, Jobs: ${availableWorker.jobsProcessed})`);
        const restartSuccess = await restartContainer(availableWorker);

        if (!restartSuccess) {
          // If restart failed, skip this worker for now
          console.log(`[Worker ${availableWorker.id}] ⚠️ Restart failed, skipping worker`);
          availableWorker = null;
        }
      }
    }

    if (availableWorker) {
      // Get next job
      const job = await getNextJob();

      if (job) {
        // Mark worker as busy
        availableWorker.busy = true;
        availableWorker.currentJobId = job.id;
        activeWorkers++;

        // Mark job as in progress in DB
        await markJobInProgress(job.id);

        // Process job asynchronously
        (async () => {
          await sendCrawlRequest(availableWorker, job.website);

          // Update worker stats
          availableWorker.busy = false;
          availableWorker.currentJobId = null;
          availableWorker.jobsProcessed++;
          activeWorkers--;
          totalProcessed++;

          console.log(`📈 Progress: ${totalProcessed} completed, ${activeWorkers} active\n`);
        })();
      } else if (activeWorkers === 0) {
        // No more jobs and no active workers - we're done
        console.log(`\n✅ All jobs completed! Total processed: ${totalProcessed}`);
        break;
      }
    }

    // Small delay to prevent tight loop
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  await pool.end();
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n⚠️  Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

// Start the orchestrator
processJobs().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});