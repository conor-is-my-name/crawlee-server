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
    tmpfs: [`/tmp:size=${tmpfsSize},mode=1777`],
    build: '.',
    env_file: '.env',
    environment: {
      PORT: port
    },
    ports: [`${port}:${port}`],
    cpu_shares: 1024,
    deploy: {
      replicas: 1,
      resources: {
        limits: {
          cpus: cpuLimit,
          memory: memoryLimit
        }
      }
    },
    networks: ['shark']
  };
}

// Convert to YAML-like format manually (simpler than adding a YAML library)
let yamlContent = 'services:\n';

for (const [serviceName, serviceConfig] of Object.entries(config.services)) {
  yamlContent += `  ${serviceName}:\n`;
  yamlContent += `    tmpfs:\n`;
  yamlContent += `     - ${serviceConfig.tmpfs[0]}\n`;
  yamlContent += `    build: ${serviceConfig.build}\n`;
  yamlContent += `    env_file: ${serviceConfig.env_file}\n`;
  yamlContent += `    environment:\n`;
  yamlContent += `      PORT: ${serviceConfig.environment.PORT}\n`;
  yamlContent += `    ports:\n`;
  yamlContent += `      - "${serviceConfig.ports[0]}"\n`;
  yamlContent += `    cpu_shares: ${serviceConfig.cpu_shares}\n`;
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
console.log(`   CPU Limit: ${cpuLimit}, Memory: ${memoryLimit}, Tmpfs: ${tmpfsSize}`);
