/**
 * Docker Monitor Service
 * Responsible for monitoring Docker container events
 */
const Docker = require('dockerode');
const { pipeline, Writable } = require('stream');
const { parser } = require('stream-json/Parser');
const { streamValues } = require('stream-json/streamers/StreamValues');
const logger = require('../utils/logger');
const EventTypes = require('../events/EventTypes');
const { getLabelValue, extractDnsLabels } = require('../utils/dns');
const { describeError, runGuarded } = require('../utils/errors');
const { SingleFlight } = require('../utils/singleFlight');

const DEFAULT_TIMINGS = Object.freeze({
  eventDebounceMs: 3000,
  eventDebounceMaxMs: 10000,
  reconnectInitialMs: 1000,
  reconnectMaxMs: 30000,
  stableConnectionMs: 30000,
  connectTimeoutMs: 10000,
  refreshTimeoutMs: 15000
});

const HANDLED_ACTIONS = new Set(['start', 'stop', 'die', 'destroy', 'health_status: healthy']);
const STOP_ACTIONS = new Set(['stop', 'die', 'destroy']);

function computeBackoffDelay(attempt, { reconnectInitialMs, reconnectMaxMs }, random = Math.random) {
  const base = Math.min(reconnectMaxMs, reconnectInitialMs * 2 ** attempt);
  return Math.round(base / 2 + random() * (base / 2));
}

class DockerMonitor {
  static DEFAULT_TIMINGS = DEFAULT_TIMINGS;

  static classifyEvent(event) {
    if (!event || event.Type !== 'container') return null;
    // `status` is the pre-1.52 field; API 1.52+ only sends `Action`.
    const action = typeof event.Action === 'string' ? event.Action : event.status;
    // Exact match: exec_* and other health states carry suffixes.
    if (!HANDLED_ACTIONS.has(action)) return null;
    return {
      action,
      id: event.Actor?.ID ?? event.id ?? null,
      name: event.Actor?.Attributes?.name ?? 'unknown'
    };
  }

  constructor(config, eventBus, options = {}) {
    this.config = config;
    this.eventBus = eventBus;
    this.docker = options.docker ?? new Docker({ socketPath: config.dockerSocket });
    this.timings = { ...DockerMonitor.DEFAULT_TIMINGS, ...options.timings };
    this.random = options.random ?? Math.random;
    
    // Global cache for container labels
    this.containerLabelsCache = {};
    
    // Container ID to name mapping
    this.containerIdToName = new Map();
    
    this.containers = [];
    this.labelsLoadedAt = null;
    this.refreshFailing = false;
    this.refreshRunner = new SingleFlight((trigger) => this.runRefresh(trigger));

    this.stopped = true;
    this.generation = 0;
    this.stream = null;
    this.abortController = null;
    this.reconnectTimer = null;
    this.debounceTimer = null;
    this.firstEventAt = 0;
    this.reconnectAttempt = 0;
    this.streamOutage = null;
    this.connectedAt = 0;
  }
  
  /**
   * Start watching Docker events; never rejects, retries in the background
   */
  async startWatching() {
    if (!this.stopped) return;
    this.stopped = false;
    this.streamOutage = null;
    this.reconnectAttempt = 0;
    logger.debug('Starting Docker event monitoring...');
    await this.connect('boot');
  }
  
  /**
   * Stop watching Docker events
   */
  stopWatching() {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.debounceTimer);
    // A stale debounceTimer would make scheduleEventRefresh() return early after a restart.
    this.reconnectTimer = null;
    this.debounceTimer = null;
    this.abortController?.abort();
    this.abortController = null;
    this.stream?.destroy();
    this.stream = null;
    logger.debug('Docker event monitoring stopped');
  }

  async connect(trigger) {
    const gen = ++this.generation;
    const abortController = new AbortController();
    this.abortController = abortController;
    const connectTimer = setTimeout(() => abortController.abort(), this.timings.connectTimeoutMs);
    let source;
    try {
      source = await this.getEvents({ filters: { type: ['container'] }, abortSignal: abortController.signal });
    } catch (error) {
      clearTimeout(connectTimer);
      if (gen === this.generation) this.handleStreamClosed(gen, error, { connected: false, trigger });
      return;
    }
    clearTimeout(connectTimer);
    if (gen !== this.generation || this.stopped) {
      source.destroy();
      return;
    }

    this.stream = source;
    this.connectedAt = Date.now();
    const sink = new Writable({
      objectMode: true,
      write: (chunk, _encoding, callback) => {
        runGuarded('Docker event handler', () => this.handleEvent(chunk.value));
        callback();
      }
    });
    pipeline(source, parser({ jsonStreaming: true }), streamValues(), sink,
      (error) => this.handleStreamClosed(gen, error, { connected: true, trigger }));

    // Subscribe first, then re-list, so nothing that happens after the subscription is missed.
    const result = await this.refreshLabels(trigger);
    if (gen !== this.generation || this.stream !== source) return;
    if (this.streamOutage) {
      logger.info(`Docker event stream reconnected after ${this.streamOutage.attempts} attempt(s); re-listed ${result.containerCount ?? 'unknown'} running containers (trigger=${trigger})`);
      this.streamOutage = null;
    } else if (trigger === 'boot') {
      logger.success('Docker event monitoring started successfully');
    }
  }

  handleStreamClosed(gen, error, { connected, trigger }) {
    if (gen !== this.generation || this.stopped) return;
    this.stream = null;
    if (connected && Date.now() - this.connectedAt >= this.timings.stableConnectionMs) {
      this.reconnectAttempt = 0;
    }
    const reason = error ? describeError(error) : 'stream ended';
    if (!this.streamOutage) {
      this.streamOutage = { since: Date.now(), reason, attempts: 0 };
      logger.warn(trigger === 'boot' && !connected
        ? `Docker is unreachable (${reason}); continuing and retrying in the background`
        : `Docker event stream ${error ? `error: ${reason}` : 'ended'}; reconnecting`);
    }
    const delay = computeBackoffDelay(this.reconnectAttempt++, this.timings, this.random);
    this.streamOutage.attempts++;
    logger.debug(`Docker event stream reconnect attempt ${this.reconnectAttempt} in ${delay} ms (${reason})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      runGuarded('Docker reconnect', () => this.connect('reconnect'));
    }, delay);
  }

  handleEvent(value) {
    const event = DockerMonitor.classifyEvent(value);
    if (!event) return;
    logger.info(`Docker event ${event.action} ${event.name}`);
    const payload = { containerId: event.id, containerName: event.name, status: event.action };
    if (event.action === 'start') {
      this.eventBus.publish(EventTypes.DOCKER_CONTAINER_STARTED, payload);
    } else if (STOP_ACTIONS.has(event.action)) {
      this.eventBus.publish(EventTypes.DOCKER_CONTAINER_STOPPED, payload);
    }
    this.scheduleEventRefresh();
  }

  scheduleEventRefresh() {
    if (this.stopped) return;
    const now = Date.now();
    if (!this.debounceTimer) {
      this.firstEventAt = now;
    } else if (now - this.firstEventAt >= this.timings.eventDebounceMaxMs) {
      return;
    }
    clearTimeout(this.debounceTimer);
    const delay = Math.min(this.timings.eventDebounceMs, this.timings.eventDebounceMaxMs - (now - this.firstEventAt));
    this.debounceTimer = setTimeout(() => runGuarded('Docker event refresh', async () => {
      this.debounceTimer = null;
      await this.refreshLabels('event');
    }), delay);
  }
  
  // Never rejects: resolves to { ok: true, containerCount, changed } or { ok: false, error }.
  refreshLabels(trigger) {
    return this.refreshRunner.run(trigger);
  }

  async runRefresh(trigger) {
    try {
      const list = await this.listContainers({
        all: false,
        abortSignal: AbortSignal.timeout(this.timings.refreshTimeoutMs)
      });
      if (this.refreshFailing) {
        this.refreshFailing = false;
        logger.info(`Docker label refresh recovered (trigger=${trigger})`);
      }
      const changed = this.applyContainerList(list, trigger);
      return { ok: true, containerCount: list.length, changed };
    } catch (error) {
      const message = `Could not refresh Docker labels (trigger=${trigger}): ${describeError(error)}; keeping last good cache (${this.containers.length} containers)`;
      if (this.refreshFailing) {
        logger.debug(message);
      } else {
        logger.warn(message);
      }
      this.refreshFailing = true;
      return { ok: false, error };
    }
  }
      
  applyContainerList(containers, trigger) {
    const newCache = {};
    const genericPrefix = this.config.genericLabelPrefix;
    const providerPrefix = this.config.dnsLabelPrefix;
      
    // New ID to name mapping
    const containerIdToName = new Map();
      
    // For tracking changes - track IDs, names, and their relationships
    const previousIds = new Set();        // Track previous container IDs
    const previousNames = new Set();      // Track previous container names
    const currentIds = new Set();         // Track current container IDs
    const currentNames = new Set();       // Track current container names
    const dnsLabelChanges = {};           // Track which containers had changes

    // Build maps of previous container relationships
    for (const key of Object.keys(this.containerLabelsCache)) {
      // If key looks like a container ID (long hex string)
      if (key.length > 12 && /^[0-9a-f]+$/.test(key)) {
        previousIds.add(key);
      } else {
        // Otherwise assume it's a container name
        previousNames.add(key);
      }
    }
      
    // Process current containers
    containers.forEach(container => {
      const id = container.Id;
      const labels = container.Labels || {};
      currentIds.add(id);
      newCache[id] = labels;
        
      // Also index by container name for easier lookup
      if (container.Names && container.Names.length > 0) {
        const name = container.Names[0].replace(/^\//, '');
        currentNames.add(name);
        newCache[name] = labels;
          
        containerIdToName.set(id, name);
          
        const dnsLabels = extractDnsLabels(labels, genericPrefix, providerPrefix);
          
        // Compare with previous labels to detect changes
        const hasPreviousLabels = this.containerLabelsCache[name];
        let dnsLabelsChanged = false;
          
        if (hasPreviousLabels) {
          const prevLabels = this.containerLabelsCache[name];
            
          // Check if any DNS labels changed
          for (const [key, value] of Object.entries(dnsLabels)) {
            if (prevLabels[key] !== value) {
              dnsLabelsChanged = true;
              dnsLabelChanges[name] = true;
              break;
            }
          }
            
          // Check if any DNS labels were removed
          for (const key of Object.keys(prevLabels)) {
            if ((key.startsWith(genericPrefix) || key.startsWith(providerPrefix)) &&
                dnsLabels[key] === undefined) {
              dnsLabelsChanged = true;
              dnsLabelChanges[name] = true;
              break;
            }
          }
        } else {
          // New container with DNS labels
          if (Object.keys(dnsLabels).length > 0) {
            dnsLabelsChanged = true;
            dnsLabelChanges[name] = true;
          }
        }
          
        // Only log at INFO level if there are changes or new containers
        if (dnsLabelsChanged && Object.keys(dnsLabels).length > 0) {
          logger.info(`Container ${name} has DNS labels: ${JSON.stringify(dnsLabels)}`);
            
          // Check for important label settings - use getLabelValue for consistent precedence
          const proxiedLabel = getLabelValue(labels, genericPrefix, providerPrefix, 'proxied', null);
          if (proxiedLabel === 'false') {
            logger.info(`⚠️ Container ${name} has proxied=false label - will disable Cloudflare proxy`);
          }
            
          const skipLabel = getLabelValue(labels, genericPrefix, providerPrefix, 'skip', null);
          if (skipLabel === 'true') {
            logger.info(`⚠️ Container ${name} has skip=true label - will skip DNS management`);
          }
            
          const manageLabel = getLabelValue(labels, genericPrefix, providerPrefix, 'manage', null);
          if (manageLabel === 'true') {
            logger.info(`⚠️ Container ${name} has manage=true label - will enable DNS management`);
          }
        } else if (Object.keys(dnsLabels).length > 0) {
          // No changes but still has DNS labels - log at debug level
          logger.debug(`Container ${name} has DNS labels: ${JSON.stringify(dnsLabels)} (unchanged)`);
        }
      }
    });
      
    // Check for removed containers with DNS labels
    const reportedRemovals = new Set();
    // First check removed IDs
    const removedIds = new Set([...previousIds].filter(id => !currentIds.has(id)));
      
    for (const id of removedIds) {
      const prevLabels = this.containerLabelsCache[id];
      const hasDnsLabels = prevLabels && Object.keys(prevLabels).some(key =>
        key.startsWith(genericPrefix) || key.startsWith(providerPrefix)
      );
        
      if (hasDnsLabels) {
        // Use the container name if we had it before
        const oldName = this.containerIdToName.get(id);
        const displayId = oldName || id;
          
        logger.info(`Container ${displayId} with DNS labels is no longer running`);
        reportedRemovals.add(displayId);
        // Only add to changes if we don't already have a matching name
        const name = [...previousNames].find(name =>
          this.containerLabelsCache[name] === prevLabels
        );
          
        if (!name || !dnsLabelChanges[name]) {
          dnsLabelChanges[id] = true;
        }
      }
    }
      
    // Then check removed names
    const removedNames = new Set([...previousNames].filter(name => !currentNames.has(name)));
      
    for (const name of removedNames) {
      const prevLabels = this.containerLabelsCache[name];
      const hasDnsLabels = prevLabels && Object.keys(prevLabels).some(key =>
        key.startsWith(genericPrefix) || key.startsWith(providerPrefix)
      );
        
      if (hasDnsLabels) {
        if (!reportedRemovals.has(name)) {
          logger.info(`Container ${name} with DNS labels is no longer running`);
        }
        dnsLabelChanges[name] = true;
      }
    }
      
    // Deduplicate changes - prefer names over IDs
    const uniqueChanges = new Set();
        
    for (const item of Object.keys(dnsLabelChanges)) {
      // If it looks like a container ID
      if (item.length > 12 && /^[0-9a-f]+$/.test(item)) {
        // Check if we have a name for this ID
        const name = containerIdToName.get(item) || this.containerIdToName.get(item);
        if (name && dnsLabelChanges[name]) {
          // Skip the ID since we have the name
          continue;
        }
        // If we have a name but no change for it, use the name instead of ID
        if (name) {
          uniqueChanges.add(name);
          continue;
        }
      }
      // Add this change (either a name or an ID without a matching name)
      uniqueChanges.add(item);
    }
      
    const changed = [...uniqueChanges];
    const summary = `Docker labels refreshed (trigger=${trigger}): ${containers.length} running containers; ` +
      (changed.length > 0 ? `DNS label changes: ${changed.join(', ')}` : 'no DNS label changes');
    if (trigger !== 'poll' || changed.length > 0) {
      logger.info(summary);
    } else {
      logger.debug(summary);
    }
      
    this.containerLabelsCache = newCache;
    this.containerIdToName = containerIdToName;
    this.containers = containers.map(c => ({
      id: c.Id,
      name: c.Names?.[0]?.replace(/^\//, '') ?? c.Id,
      labels: c.Labels ?? {}
    }));
    this.labelsLoadedAt = Date.now();
      
    this.eventBus.publish(EventTypes.DOCKER_LABELS_UPDATED, {
      containerLabelsCache: this.containerLabelsCache,
      containerIdToName: this.containerIdToName,
      containers: this.containers,
      hasChanges: changed.length > 0,
      trigger
    });
      
    return changed;
  }
  
  /**
   * Get Docker events stream
   */
  async getEvents(opts = { filters: { type: ['container'] } }) {
    return this.docker.getEvents(opts);
  }
  
  /**
   * List all running containers
   */
  async listContainers(opts = { all: false }) {
    return this.docker.listContainers(opts);
  }
  
  /**
   * Get container details by ID
   */
  async getContainer(id) {
    try {
      const container = this.docker.getContainer(id);
      const details = await container.inspect();
      return details;
    } catch (error) {
      logger.error(`Failed to get container ${id}: ${error.message}`);
      throw error;
    }
  }
  
  getContainers() {
    return this.containers;
  }

  hasLoadedLabels() {
    return this.labelsLoadedAt !== null;
  }

  /**
   * Get the current container labels cache
   */
  getContainerLabelsCache() {
    return this.containerLabelsCache;
  }
  
  /**
   * Get container name from ID if available
   */
  getContainerName(id) {
    return this.containerIdToName.get(id) || id;
  }
  
  /**
   * Test the connection to the Docker socket
   */
  async testConnection() {
    try {
      const info = await this.docker.info();
      return true;
    } catch (error) {
      logger.error(`Failed to connect to Docker: ${error.message}`);
      return false;
    }
  }
}

module.exports = DockerMonitor;
module.exports.DEFAULT_TIMINGS = DEFAULT_TIMINGS;
module.exports.HANDLED_ACTIONS = HANDLED_ACTIONS;
module.exports.computeBackoffDelay = computeBackoffDelay;
module.exports.classifyEvent = DockerMonitor.classifyEvent;
