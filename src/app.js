/**
 * Main application entry point for TráfegoDNS
 * Primary responsibility: Wire up the application components
 */
const { ConfigManager } = require('./config');
const { DNSManager, TraefikMonitor, DockerMonitor, StatusReporter, DirectDNSManager } = require('./services');
const { EventBus } = require('./events/EventBus');
const logger = require('./utils/logger');
const { describeError } = require('./utils/errors');
const { installProcessGuards } = require('./utils/processGuards');

installProcessGuards();

/**
 * Application startup
 */
async function start() {
  try {
    // Create event bus (central communication)
    const eventBus = new EventBus();
    
    // Initialize configuration
    const config = new ConfigManager();
    
    // Initialize services
    const statusReporter = new StatusReporter(config, eventBus);
    const dnsManager = new DNSManager(config, eventBus);
    const dockerMonitor = new DockerMonitor(config, eventBus);
    
    // Choose the appropriate monitor based on operation mode
    let monitor;
    
    if (config.operationMode.toLowerCase() === 'direct') {
      logger.info('🚀 Starting in DIRECT mode (without Traefik)');
      monitor = new DirectDNSManager(config, eventBus);
    } else {
      logger.info('🚀 Starting in TRAEFIK mode');
      monitor = new TraefikMonitor(config, eventBus);
    }
    
    // Connect monitors for container name resolution
    monitor.dockerMonitor = dockerMonitor;
    
    // Display startup configuration
    await statusReporter.displaySettings();
    
    // Start Docker monitoring first; it never rejects and keeps retrying in the background
    if (config.watchDockerEvents) {
      await dockerMonitor.startWatching();
    }
    
    // Initialize all services
    await dnsManager.init();
    await monitor.init();
    
    // Start main polling
    await monitor.startPolling();
    
    logger.complete('TráfegoDNS running successfully');
  } catch (error) {
    logger.error(`Failed to start TráfegoDNS: ${describeError(error)}`);
    process.exit(1);
  }
}

// Start the application
start();