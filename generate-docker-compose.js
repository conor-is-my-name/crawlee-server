import { writeFileSync, readFileSync } from 'fs';

// Read .env file manually
const envContent = readFileSync('.env', 'utf-8');
const envVars = {};
envContent.split('\n').forEach(line => {
  const [key, ...valueParts] = line.split('=');
  if (key && !key.startsWith('#')) {
    envVars[key.trim()] = valueParts.join('=').trim();
  }
});

const numContainers = parseInt(envVars.NUM_SCRAPERS) || 12;
const startPort = parseInt(envVars.START_PORT) || 3001;
const cpuLimit = envVars.CPU_LIMIT || '1';
const memoryLimit = envVars.MEMORY_LIMIT || '3G';
const tmpfsSize = envVars.TMPFS_SIZE || '1G';
const cpuShares = parseInt(envVars.CPU_SHARES) || 1024;

const config = {
  services: {},
  networks: {
    shark: {
      external: true
    }
  }
};

// Generate scraper services
for (let i = 1; i <= numContainers; i++) {
  const port = startPort + i - 1;
  const serviceName = `scraper${i}`;

  config.services[serviceName] = {
    tmpfs: [
      `/tmp:size=${tmpfsSize},mode=1777`,
      `/usr/src/app/storage:size=500M,mode=1777`,  // Crawlee storage
      `/var/cache:size=100M,mode=1777`,            // System cache
      `/root/.cache:size=500M,mode=1777`,          // User cache (Playwright browsers)
      `/home/pptruser/.cache:size=500M,mode=1777`  // Playwright user cache
    ],
    build: '.',
    env_file: '.env',
    environment: {
      PORT: port,
      CRAWLEE_STORAGE_DIR: '/usr/src/app/storage',  // Force Crawlee to use tmpfs storage
      TMPDIR: '/tmp'                               // Ensure temp files go to tmpfs
    },
    ports: [`${port}:${port}`],
    cpu_shares: cpuShares,
    deploy: {
      replicas: 1,
      resources: {
        limits: {
          cpus: cpuLimit,
          memory: memoryLimit
        }
      }
    },
    cpuset: `${(i - 1) % 16}`,  // Pin to physical cores 0-15 only
    networks: ['shark'],
    read_only: true,  // Make root filesystem read-only
    security_opt: ['no-new-privileges']  // Additional security
  };
}

// Convert to YAML-like format manually (simpler than adding a YAML library)
let yamlContent = 'services:\n';

for (const [serviceName, serviceConfig] of Object.entries(config.services)) {
  yamlContent += `  ${serviceName}:\n`;
  yamlContent += `    tmpfs:\n`;
  serviceConfig.tmpfs.forEach(tmpfs => {
    yamlContent += `      - ${tmpfs}\n`;
  });
  yamlContent += `    build: ${serviceConfig.build}\n`;
  yamlContent += `    env_file: ${serviceConfig.env_file}\n`;
  yamlContent += `    environment:\n`;
  yamlContent += `      PORT: ${serviceConfig.environment.PORT}\n`;
  yamlContent += `      CRAWLEE_STORAGE_DIR: ${serviceConfig.environment.CRAWLEE_STORAGE_DIR}\n`;
  yamlContent += `      TMPDIR: ${serviceConfig.environment.TMPDIR}\n`;
  yamlContent += `    ports:\n`;
  yamlContent += `      - "${serviceConfig.ports[0]}"\n`;
  yamlContent += `    cpu_shares: ${serviceConfig.cpu_shares}\n`;
  yamlContent += `    cpuset: "${serviceConfig.cpuset}"\n`;
  yamlContent += `    read_only: ${serviceConfig.read_only}\n`;
  yamlContent += `    security_opt:\n`;
  serviceConfig.security_opt.forEach(opt => {
    yamlContent += `      - ${opt}\n`;
  });
  yamlContent += `    deploy:\n`;
  yamlContent += `      replicas: ${serviceConfig.deploy.replicas}\n`;
  yamlContent += `      resources:\n`;
  yamlContent += `        limits:\n`;
  yamlContent += `          cpus: '${serviceConfig.deploy.resources.limits.cpus}'\n`;
  yamlContent += `          memory: ${serviceConfig.deploy.resources.limits.memory}\n`;
  yamlContent += `    networks:\n`;
  yamlContent += `      - shark\n`;
  yamlContent += `\n`;
}

yamlContent += 'networks:\n';
yamlContent += '  shark:\n';
yamlContent += '    external: true\n';

writeFileSync('docker-compose.yml', yamlContent);

console.log(`✅ Generated docker-compose.yml with ${numContainers} scrapers`);
console.log(`   Ports: ${startPort}-${startPort + numContainers - 1}`);
console.log(`   CPU Shares: ${cpuShares}, CPU Limit: ${cpuLimit}, Memory: ${memoryLimit}, Tmpfs: ${tmpfsSize}`);
