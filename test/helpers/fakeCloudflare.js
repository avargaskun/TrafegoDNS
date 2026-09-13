const http = require('node:http');

/**
 * @typedef {Object} FakeCloudflareRecord
 * @property {string} [id] - Assigned as `cf-<n>` when missing.
 * @property {string} type
 * @property {string} name
 * @property {string} content
 * @property {number} [ttl]
 * @property {boolean} [proxied]
 * @property {string} [comment]
 */

/**
 * @typedef {Object} FakeCloudflareOptions
 * @property {string} [zoneName='example.com'] - The only zone `GET /zones?name=` finds.
 * @property {string} [zoneId='zone-1']
 * @property {FakeCloudflareRecord[]} [records=[]] - Initial DNS records.
 */

/**
 * Distortions of the record listing's `result_info`, for testing a client's pagination edge cases.
 * @typedef {Object} FakeCloudflareListingQuirks
 * @property {number} [totalPages] - Reported as `result_info.total_pages` instead of the real page count.
 * @property {boolean} [omitResultInfo] - Leaves `result_info` out of listing responses.
 */

/**
 * A request as received; headers are deliberately never recorded.
 * @typedef {Object} FakeCloudflareRequest
 * @property {string} method
 * @property {string} path - Path without the query string, e.g. `/client/v4/zones/zone-1/dns_records`.
 * @property {Record<string, string>} query
 * @property {number} status - HTTP status the fake answered with.
 * @property {Object} [body] - Parsed JSON body of a POST or PUT.
 */

/**
 * @typedef {Object} FakeCloudflare
 * @property {number} port
 * @property {string} baseURL - API base URL, `http://127.0.0.1:<port>/client/v4`.
 * @property {(list: FakeCloudflareRecord[]) => void} setRecords - Replaces the DNS records.
 * @property {(page: number | null, status?: number) => void} failPage - Makes that page of the record listing answer `status` (default 500); `null` clears it.
 * @property {(status: number | null) => void} setWriteFailure - Makes every POST and PUT answer `status`; `null` clears it.
 * @property {(quirks: FakeCloudflareListingQuirks) => void} setListingQuirks - Replaces the listing quirks; `{}` restores accurate `result_info`.
 * @property {FakeCloudflareRequest[]} requests - Every request received (live array).
 * @property {() => Promise<void>} stop - Closes the server and destroys every socket.
 */

const API_PREFIX = '/client/v4';
const DEFAULT_PER_PAGE = 100;

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function ok(result, resultInfo) {
  return { success: true, errors: [], messages: [], result, ...(resultInfo ? { result_info: resultInfo } : {}) };
}

function failure(status) {
  return { success: false, errors: [{ code: 10000, message: `synthetic failure ${status}` }], messages: [], result: null };
}

function positiveInt(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(undefined);
      }
    });
  });
}

/**
 * In-process fake of the Cloudflare v4 API: zone lookup, paginated DNS record listing, record create and update.
 * @param {FakeCloudflareOptions} [options={}]
 * @returns {Promise<FakeCloudflare>}
 */
async function startFakeCloudflare({ zoneName = 'example.com', zoneId = 'zone-1', records = [] } = {}) {
  let nextId = 1;
  const withId = (record) => ({ ...record, id: record.id ?? `cf-${nextId++}` });
  let list = records.map(withId);
  let failedPage = null;
  let failedPageStatus = 500;
  let writeFailure = null;
  /** @type {FakeCloudflareListingQuirks} */
  let quirks = {};
  /** @type {FakeCloudflareRequest[]} */
  const requests = [];
  const sockets = new Set();
  const recordsPath = `${API_PREFIX}/zones/${zoneId}/dns_records`;

  function listRecords(query) {
    const page = positiveInt(query.page, 1);
    const perPage = positiveInt(query.per_page, DEFAULT_PER_PAGE);
    if (page === failedPage) return [failedPageStatus, failure(failedPageStatus)];
    const result = list.slice((page - 1) * perPage, page * perPage);
    if (quirks.omitResultInfo) return [200, ok(result)];
    return [200, ok(result, {
      page,
      per_page: perPage,
      count: result.length,
      total_count: list.length,
      total_pages: quirks.totalPages ?? Math.ceil(list.length / perPage)
    })];
  }

  function createRecord(body) {
    if (writeFailure !== null) return [writeFailure, failure(writeFailure)];
    const record = withId({ ...body, id: undefined, zone_id: zoneId, zone_name: zoneName });
    list.push(record);
    return [200, ok(record)];
  }

  function updateRecord(id, body) {
    if (writeFailure !== null) return [writeFailure, failure(writeFailure)];
    const index = list.findIndex((record) => record.id === id);
    if (index === -1) return [404, failure(404)];
    list[index] = { ...list[index], ...body, id };
    return [200, ok(list[index])];
  }

  function route(method, path, query, body) {
    if (method === 'GET' && path === `${API_PREFIX}/zones`) {
      const result = query.name === zoneName ? [{ id: zoneId, name: zoneName, status: 'active' }] : [];
      return [200, ok(result, { page: 1, per_page: 20, count: result.length, total_count: result.length, total_pages: 1 })];
    }
    if (method === 'GET' && path === recordsPath) return listRecords(query);
    if (method === 'POST' && path === recordsPath) return createRecord(body);
    if (method === 'PUT' && path.startsWith(`${recordsPath}/`)) return updateRecord(path.slice(recordsPath.length + 1), body);
    return [404, failure(404)];
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const query = Object.fromEntries(url.searchParams);
    const isWrite = req.method === 'POST' || req.method === 'PUT';
    const body = isWrite ? await readBody(req) : undefined;
    const [status, payload] = isWrite && body === undefined
      ? [400, failure(400)]
      : route(req.method, url.pathname, query, body);
    requests.push({ method: req.method, path: url.pathname, query, status, ...(isWrite ? { body } : {}) });
    sendJson(res, status, payload);
  });
  // Longer than the client agent's 5 s idle timeout, so the client always closes idle sockets first.
  server.keepAliveTimeout = 30000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });

  return {
    port,
    baseURL: `http://127.0.0.1:${port}${API_PREFIX}`,
    requests,
    setRecords(next) {
      list = next.map(withId);
    },
    failPage(page, status = 500) {
      failedPage = page;
      failedPageStatus = status;
    },
    setWriteFailure(status) {
      writeFailure = status;
    },
    setListingQuirks(next) {
      quirks = { ...next };
    },
    async stop() {
      if (!server.listening) return;
      const closed = new Promise((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await closed;
    }
  };
}

module.exports = { startFakeCloudflare };
