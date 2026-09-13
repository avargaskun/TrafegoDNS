/**
 * Traefik Monitor Service
 * Responsible for monitoring Traefik routers and updating DNS records
 */
const axios = require('axios');
const logger = require('../utils/logger');
const EventTypes = require('../events/EventTypes');
const { extractHostnamesFromRule } = require('../utils/traefik');
const { getLabelValue } = require('../utils/dns');
const { SingleFlight } = require('../utils/singleFlight');
const { resolveHostnameLabels } = require('../utils/routerAttribution');

const ROUTERS_PER_PAGE = 100;
const MAX_ROUTER_PAGES = 100;
const LABELS_NOT_LOADED = 'Skipping DNS pass: Docker container labels have not been loaded yet';

class TraefikMonitor {
  constructor(config, eventBus) {
    this.config = config;
    this.eventBus = eventBus;
    
    // Initialize HTTP client
    this.client = axios.create({
      baseURL: config.traefikApiUrl,
      timeout: config.apiTimeout  // Use the configurable timeout
    });
    
    // Add basic auth if configured
    if (config.traefikApiUsername && config.traefikApiPassword) {
      this.client.defaults.auth = {
        username: config.traefikApiUsername,
        password: config.traefikApiPassword
      };
    }
    
    // Track previous poll statistics to reduce logging noise
    this.previousStats = {
      hostnameCount: 0
    };
    
    // Poll timer reference
    this.pollTimer = null;
    
    this.pollRunner = new SingleFlight((trigger) => this.runPoll(trigger));
    this.lastContainers = [];
    this.labelsGateWarned = false;
    this.warnedAmbiguousRouters = new Set();
    this.warnedOwnerConflicts = new Set();
    
    // Reference to DockerMonitor (will be set from app.js)
    this.dockerMonitor = null;
    
    // Subscribe to Docker label updates
    this.setupEventSubscriptions();
  }
  
  /**
   * Initialize the Traefik Monitor
   */
  async init() {
    try {
      logger.debug('Testing connection to Traefik API...');
      
      // Test connection
      const connected = await this.testConnection();
      
      if (!connected) {
        throw new Error('Failed to connect to Traefik API');
      }
      
      logger.success('Successfully connected to Traefik API');
      return true;
    } catch (error) {
      logger.error(`Failed to initialize Traefik Monitor: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Set up event subscriptions
   */
  setupEventSubscriptions() {
    // Subscribe to Docker label updates
    this.eventBus.subscribe(EventTypes.DOCKER_LABELS_UPDATED, (data) => {
      this.lastContainers = data.containers || [];
      logger.debug('Updated Docker container labels cache in TraefikMonitor');
      
      if (this.pollTimer && (data.trigger === 'event' || data.trigger === 'reconnect')) {
        return this.requestPoll(data.trigger);
      }
      return undefined;
    });
  }
  
  /**
   * Start the polling process
   */
  async startPolling() {
    // Perform initial poll
    await this.requestPoll('startup');
    
    // Set up interval for regular polling
    this.pollTimer = setInterval(() => this.requestPoll('interval'), this.config.pollInterval);
    
    logger.debug(`Traefik polling started with interval of ${this.config.pollInterval}ms`);
    return true;
  }
  
  /**
   * Stop the polling process
   */
  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      logger.debug('Traefik polling stopped');
    }
  }
  
  /**
   * Test the connection to the Traefik API
   */
  async testConnection() {
    try {
      // Try to access the overview endpoint
      await this.client.get('/overview');
      return true;
    } catch (error) {
      logger.error(`Failed to connect to Traefik API: ${error.message}`);
      return false;
    }
  }
  
  // A request made during a running poll is served by one trailing poll.
  requestPoll(trigger) {
    return this.pollRunner.run(trigger);
  }
  
  /**
   * Poll the Traefik API for routers
   */
  pollTraefikAPI(trigger = 'interval') {
    return this.requestPoll(trigger);
  }
  
  async runPoll(trigger) {
    try {
      // Publish poll started event
      this.eventBus.publish(EventTypes.TRAEFIK_POLL_STARTED);
      
      logger.debug(`Polling Traefik API for routers (trigger=${trigger})...`);
      
      // Get all routers from Traefik
      const routers = await this.getRouters();
      logger.debug(`Found ${routers.length} routers in Traefik`);
      
      if (this.dockerMonitor && this.config.watchDockerEvents) {
        await this.dockerMonitor.refreshLabels('poll');
        if (!this.dockerMonitor.hasLoadedLabels()) {
          if (this.labelsGateWarned) {
            logger.debug(LABELS_NOT_LOADED);
          } else {
            logger.warn(LABELS_NOT_LOADED);
            this.labelsGateWarned = true;
          }
          return;
        }
      }
      
      // Collect hostname data
      const { hostnames, hostnameRouters } = this.processRouters(routers);
      const { containerLabels, excludedHostnames, ambiguousRouters, ownerConflicts, owners } =
        resolveHostnameLabels(hostnameRouters, this.lastContainers, this.config);
      
      this.reportAttributionIssues(ambiguousRouters, ownerConflicts);
      this.logProxiedChanges(containerLabels, owners);
      
      const managedCandidates = hostnames.filter((hostname) => !excludedHostnames.has(hostname));
      
      // Only log hostname count if it changed from previous poll
      const hasChanged = this.previousStats.hostnameCount !== managedCandidates.length;
      
      if (hasChanged) {
        logger.info(`Processing ${managedCandidates.length} hostnames for DNS management`);
      } else {
        // Log at debug level instead of info when nothing has changed
        logger.debug(`Processing ${managedCandidates.length} hostnames for DNS management`);
      }
      
      // Update the previous count for next comparison
      this.previousStats.hostnameCount = managedCandidates.length;
      
      // Publish router update event
      this.eventBus.publish(EventTypes.TRAEFIK_ROUTERS_UPDATED, {
        hostnames: managedCandidates,
        containerLabels
      });
      
      // Publish poll completed event
      this.eventBus.publish(EventTypes.TRAEFIK_POLL_COMPLETED, {
        routerCount: routers.length,
        hostnameCount: managedCandidates.length
      });
    } catch (error) {
      logger.error(`Error polling Traefik API: ${error.message}`);
      
      this.eventBus.publish(EventTypes.ERROR_OCCURRED, {
        source: 'TraefikMonitor.pollTraefikAPI',
        error: error.message
      });
    }
  }
  
  /**
   * Get all HTTP routers from Traefik
   */
  async getRouters() {
    try {
      let page = 1;
      const routers = [];
      for (let i = 0; i < MAX_ROUTER_PAGES; i++) {
        const response = await this.client.get('/http/routers', { params: { page, per_page: ROUTERS_PER_PAGE } });
        routers.push(...(Array.isArray(response.data) ? response.data : Object.values(response.data || {})));
        const next = parseInt(response.headers?.['x-next-page'], 10);
        // Traefik v3.7 pkg/api/criterion.go:90-114: X-Next-Page wraps to 1 on the last page.
        if (!Number.isInteger(next) || next <= page) break;
        page = next;
      }
      return routers;
    } catch (error) {
      // Check for specific error types for better error messages
      if (error.code === 'ECONNREFUSED') {
        logger.error(`Connection refused to Traefik API at ${this.config.traefikApiUrl}. Is Traefik running?`);
        throw new Error(`Connection refused to Traefik API at ${this.config.traefikApiUrl}. Is Traefik running?`);
      }
      
      if (error.response && error.response.status === 401) {
        logger.error('Authentication failed for Traefik API. Check your username and password.');
        throw new Error('Authentication failed for Traefik API. Check your username and password.');
      }
      
      logger.error(`Failed to get Traefik routers: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Process routers to extract unique hostnames and the routers serving each hostname
   */
  processRouters(routers) {
    const hostnames = [];
    const hostnameRouters = new Map();
    const list = Array.isArray(routers) ? routers : Object.values(routers || {});
    
    for (const router of list) {
      const routerName = router.name;
      if (router.rule && router.rule.includes('Host')) {
        // Extract all hostnames from the rule
        const routerHostnames = extractHostnamesFromRule(router.rule);
        
        for (const hostname of routerHostnames) {
          if (!hostnameRouters.has(hostname)) {
            hostnameRouters.set(hostname, []);
            hostnames.push(hostname);
          }
          
          const refs = hostnameRouters.get(hostname);
          if (!refs.some((ref) => ref.name === routerName)) {
            refs.push({
              name: routerName,
              provider: router.provider,
              entryPoints: router.entryPoints,
              service: router.service
            });
          }
          
          logger.trace(`Processed router "${routerName}" for hostname "${hostname}" with service "${router.service}"`);
        }
      }
    }
    
    return { hostnames, hostnameRouters };
  }
  
  reportAttributionIssues(ambiguousRouters, ownerConflicts) {
    const ambiguousNow = new Set();
    for (const { routerName, ownerNames } of ambiguousRouters) {
      ambiguousNow.add(routerName);
      if (!this.warnedAmbiguousRouters.has(routerName)) {
        logger.warn(`Router ${routerName} is claimed by containers ${ownerNames.join(', ')} with different DNS labels; leaving its hostnames unmanaged`);
      }
    }
    this.warnedAmbiguousRouters = ambiguousNow;
    
    const conflictsNow = new Set();
    for (const { hostname, ownerNames, chosen } of ownerConflicts) {
      conflictsNow.add(hostname);
      if (!this.warnedOwnerConflicts.has(hostname)) {
        logger.warn(`Hostname ${hostname} is managed by containers ${ownerNames.join(', ')} with different DNS labels; using ${chosen}`);
      }
    }
    this.warnedOwnerConflicts = conflictsNow;
  }
  
  logProxiedChanges(containerLabels, owners) {
    const genericPrefix = this.config.genericLabelPrefix;
    const providerPrefix = this.config.dnsLabelPrefix;
    
    // For tracking changes in logging
    const firstPoll = !this.lastMergedLabels;
    const labelChanges = {};
    
    for (const [hostname, labels] of Object.entries(containerLabels)) {
      const containerName = owners[hostname];
      if (!containerName) {
        logger.debug(`No container match found for hostname ${hostname}`);
        continue;
      }
      logger.debug(`Found matching container ${containerName} for hostname ${hostname}`);
      
      // Check if this is first poll or if the proxied setting has changed
      const proxiedLabel = getLabelValue(labels, genericPrefix, providerPrefix, 'proxied', null);
      const previousLabels = this.lastMergedLabels?.[hostname];
      const previousProxied = previousLabels?.[`${providerPrefix}proxied`] || previousLabels?.[`${genericPrefix}proxied`];
      
      // Only log at INFO level if this is the first poll or the proxied value has changed
      if (firstPoll || previousProxied !== proxiedLabel) {
        if (proxiedLabel === 'false') {
          logger.info(`🔍 Found proxied=false for ${hostname} from container ${containerName}`);
          // Track the change for summary
          labelChanges[hostname] = 'unproxied';
        } else if (proxiedLabel === 'true' && previousProxied === 'false') {
          logger.info(`🔍 Found proxied=true for ${hostname} from container ${containerName}`);
          // Track the change for summary
          labelChanges[hostname] = 'proxied';
        }
      } else {
        // Use debug level for repeated information
        if (proxiedLabel === 'false') {
          logger.debug(`Found proxied=false for ${hostname} from container ${containerName}`);
        }
      }
    }
    
    // Log a summary of changes if any occurred
    const changeCount = Object.keys(labelChanges).length;
    if (changeCount > 0) {
      const changeList = Object.entries(labelChanges)
        .map(([hostname, change]) => `${hostname} (${change})`)
        .join(', ');
      logger.info(`DNS label changes detected for ${changeCount} hostnames: ${changeList}`);
    }
    
    // Store the current labels for next comparison
    this.lastMergedLabels = JSON.parse(JSON.stringify(containerLabels));
  }
  
  /**
   * Get all HTTP services from Traefik
   */
  async getServices() {
    try {
      const response = await this.client.get('/http/services');
      logger.debug(`Retrieved ${Object.keys(response.data).length} services from Traefik API`);
      return response.data;
    } catch (error) {
      logger.error(`Failed to get Traefik services: ${error.message}`);
      throw error;
    }
  }
}

module.exports = TraefikMonitor;
