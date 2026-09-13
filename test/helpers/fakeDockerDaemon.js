const http = require('node:http');
const Docker = require('dockerode');

const LEGACY_FIELDS_REMOVED_IN = 1.52;
const NOISE_INTERVAL_MS = 20;
const MAX_SLICE_BYTES = 9000;
const NOISE_ID = 'b'.repeat(64);
const NOISE_EXEC_ID = 'e'.repeat(64);

/**
 * @typedef {Object} FakeContainer
 * @property {string} Id - 64-hex container id.
 * @property {string[]} Names - Docker names, each with a leading `/`.
 * @property {Record<string, string>} [Labels]
 */

/**
 * @typedef {'ok' | 'fail' | 'hang'} ContainersMode
 */

/**
 * @typedef {'ok' | 'refuse'} EventsMode
 */

/**
 * @typedef {Object} FakeDockerDaemonOptions
 * @property {number} [apiVersion=1.54] - API version served on unversioned paths.
 * @property {number} [seed=1] - Seed for the PRNG that slices the event byte stream.
 */

/**
 * @typedef {Object} FakeDockerDaemonStats
 * @property {number} eventsConnections - Total `/events` requests received, refused ones included.
 * @property {number} listRequests - Total `/containers/json` requests received, failed and hanging ones included.
 * @property {number} eventsSent - Total events written, counted once per receiving `/events` response.
 */

/**
 * @typedef {Object} FakeDockerDaemon
 * @property {number} port
 * @property {import('dockerode')} docker - dockerode client pointed at the fake daemon over TCP.
 * @property {(list: FakeContainer[]) => void} setContainers - Replaces the running-container list.
 * @property {(action: string, name: string, id?: string, extraAttrs?: Record<string, string>) => number} emit - Writes one container event to every open `/events` response; returns how many received it.
 * @property {(on: boolean) => void} noise - Toggles `exec_*` healthcheck events every 20 ms.
 * @property {() => void} sever - Destroys the sockets of every open `/events` request.
 * @property {() => void} endCleanly - Ends every open `/events` response.
 * @property {() => void} endMidObject - Writes half an event, then ends every open `/events` response.
 * @property {(mode: ContainersMode) => void} setContainersMode - `fail` answers 500; `hang` never answers until `stop()`.
 * @property {(mode: EventsMode) => void} setEventsMode - `refuse` answers `/events` with 500.
 * @property {() => Promise<void>} stop - Closes the server and destroys every socket.
 * @property {() => Promise<void>} restart - Listens again on the same port.
 * @property {() => number} openEventStreams - Number of `/events` responses currently open.
 * @property {FakeDockerDaemonStats} stats - Live counters.
 */

/**
 * @param {number} seed
 * @returns {() => number} Uniform values in [0, 1).
 */
function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function eventAttributes(name, extraAttrs) {
  const attributes = { name, image: `ghcr.io/example/${name}:1.0` };
  for (let i = 0; i < 40; i++) {
    attributes[`com.example.label.${i}`] = 'x'.repeat(60 + (i % 7) * 11);
  }
  return { ...attributes, ...extraAttrs };
}

function buildEvent(action, name, id, extraAttrs = {}) {
  const nowMs = Date.now();
  return {
    Type: 'container',
    Action: action,
    Actor: { ID: id, Attributes: eventAttributes(name, extraAttrs) },
    scope: 'local',
    time: Math.floor(nowMs / 1000),
    timeNano: nowMs * 1e6
  };
}

function shapeEvent(event, apiVersion) {
  if (apiVersion >= LEGACY_FIELDS_REMOVED_IN) return event;
  return { status: event.Action, id: event.Actor.ID, from: event.Actor.Attributes.image, ...event };
}

function syntheticId(name) {
  return Buffer.from(name).toString('hex').padEnd(64, '0').slice(0, 64);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Starts an HTTP fake of the Docker Engine API on 127.0.0.1 with a random port.
 * @param {FakeDockerDaemonOptions} [options={}]
 * @returns {Promise<FakeDockerDaemon>}
 */
async function startFakeDockerDaemon({ apiVersion = 1.54, seed = 1 } = {}) {
  const random = mulberry32(seed);
  /** @type {FakeDockerDaemonStats} */
  const stats = { eventsConnections: 0, listRequests: 0, eventsSent: 0 };
  /** @type {FakeContainer[]} */
  let containers = [];
  /** @type {ContainersMode} */
  let containersMode = 'ok';
  /** @type {EventsMode} */
  let eventsMode = 'ok';
  let noiseOn = false;
  let noiseTimer = null;
  const sockets = new Set();
  const eventStreams = new Set();

  function writeSliced(stream, text) {
    if (stream.res.writableEnded || stream.res.destroyed) return false;
    let bytes = Buffer.from(text);
    while (bytes.length > 0) {
      const size = Math.min(bytes.length, 1 + Math.floor(random() * MAX_SLICE_BYTES));
      stream.res.write(bytes.subarray(0, size));
      bytes = bytes.subarray(size);
    }
    return true;
  }

  function broadcast(events) {
    let delivered = 0;
    for (const stream of eventStreams) {
      const text = events.map((event) => `${JSON.stringify(shapeEvent(event, stream.apiVersion))}\n`).join('');
      if (writeSliced(stream, text)) {
        delivered++;
        stats.eventsSent += events.length;
      }
    }
    return delivered;
  }

  function emitNoise() {
    const events = [];
    for (let i = 0; i < 3; i++) {
      events.push(buildEvent('exec_create: wget -q http://127.0.0.1/health', 'noise', NOISE_ID));
      events.push(buildEvent('exec_start: wget -q http://127.0.0.1/health', 'noise', NOISE_ID));
      events.push(buildEvent('exec_die', 'noise', NOISE_ID, { exitCode: '0', execID: NOISE_EXEC_ID }));
    }
    broadcast(events);
  }

  function startNoiseTimer() {
    if (!noiseTimer) noiseTimer = setInterval(emitNoise, NOISE_INTERVAL_MS);
  }

  function stopNoiseTimer() {
    clearInterval(noiseTimer);
    noiseTimer = null;
  }

  function handleEvents(req, res, version) {
    stats.eventsConnections++;
    if (eventsMode === 'refuse') {
      sendJson(res, 500, { message: 'synthetic events refusal' });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // docker-modem resolves getEvents only once the response headers arrive.
    res.flushHeaders();
    const stream = { req, res, apiVersion: version };
    eventStreams.add(stream);
    res.on('close', () => eventStreams.delete(stream));
  }

  function handleList(res) {
    stats.listRequests++;
    if (containersMode === 'fail') {
      sendJson(res, 500, { message: 'synthetic list failure' });
    } else if (containersMode === 'ok') {
      sendJson(res, 200, containers);
    }
  }

  const server = http.createServer((req, res) => {
    const versioned = /^\/v(\d+\.\d+)(\/.*)$/.exec(req.url);
    const version = versioned ? parseFloat(versioned[1]) : apiVersion;
    const path = (versioned ? versioned[2] : req.url).split('?')[0];
    if (path === '/containers/json') {
      handleList(res);
    } else if (path === '/events') {
      handleEvents(req, res, version);
    } else if (path === '/_ping') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    } else if (path === '/info' || path === '/version') {
      sendJson(res, 200, { ApiVersion: String(version) });
    } else {
      sendJson(res, 404, { message: 'page not found' });
    }
  });
  // Longer than the client agent's 5 s idle timeout, so the client always closes idle sockets first.
  server.keepAliveTimeout = 30000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  function listen(port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve(server.address().port);
      });
    });
  }

  const port = await listen(0);
  const docker = new Docker({ host: '127.0.0.1', port, protocol: 'http' });

  return {
    port,
    docker,
    stats,
    setContainers(list) {
      containers = [...list];
    },
    emit(action, name, id, extraAttrs) {
      const containerId = id ?? containers.find((c) => c.Names?.[0] === `/${name}`)?.Id ?? syntheticId(name);
      return broadcast([buildEvent(action, name, containerId, extraAttrs)]);
    },
    noise(on) {
      noiseOn = on;
      if (on && server.listening) startNoiseTimer();
      if (!on) stopNoiseTimer();
    },
    sever() {
      for (const stream of eventStreams) stream.req.socket.destroy();
      eventStreams.clear();
    },
    endCleanly() {
      for (const stream of eventStreams) stream.res.end();
      eventStreams.clear();
    },
    endMidObject() {
      for (const stream of eventStreams) {
        stream.res.write('{"Type":"container","Act');
        stream.res.end();
      }
      eventStreams.clear();
    },
    setContainersMode(mode) {
      containersMode = mode;
    },
    setEventsMode(mode) {
      eventsMode = mode;
    },
    async stop() {
      stopNoiseTimer();
      if (!server.listening) return;
      const closed = new Promise((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      eventStreams.clear();
      await closed;
    },
    async restart() {
      if (server.listening) return;
      await listen(port);
      if (noiseOn) startNoiseTimer();
    },
    openEventStreams() {
      return eventStreams.size;
    }
  };
}

module.exports = { startFakeDockerDaemon };
