import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { FakeCloudflare, FakeCloudflareListingQuirks, FakeCloudflareOptions, FakeCloudflareRecord, FakeCloudflareRequest } from '../../types/test';

const API_PREFIX = '/client/v4';
const DEFAULT_PER_PAGE = 100;

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function ok(result: unknown, resultInfo?: Record<string, number>) {
  return { success: true, errors: [], messages: [], result, ...(resultInfo ? { result_info: resultInfo } : {}) };
}

function failure(status: number) {
  return { success: false, errors: [{ code: 10000, message: `synthetic failure ${status}` }], messages: [], result: null };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
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
async function startFakeCloudflare({ zoneName = 'example.com', zoneId = 'zone-1', records = [] }: FakeCloudflareOptions = {}): Promise<FakeCloudflare> {
  let nextId = 1;
  const withId = (record: FakeCloudflareRecord) => ({ ...record, id: record.id ?? `cf-${nextId++}` });
  let list = records.map(withId);
  let failedPage: number | null = null;
  let failedPageStatus = 500;
  let writeFailure: number | null = null;
  let quirks: FakeCloudflareListingQuirks = {};
  const requests: FakeCloudflareRequest[] = [];
  const sockets = new Set<Socket>();
  const recordsPath = `${API_PREFIX}/zones/${zoneId}/dns_records`;

  function listRecords(query: Record<string, string>): [number, unknown] {
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

  function createRecord(body: any): [number, unknown] {
    if (writeFailure !== null) return [writeFailure, failure(writeFailure)];
    const record = withId({ ...body, id: undefined, zone_id: zoneId, zone_name: zoneName });
    list.push(record);
    return [200, ok(record)];
  }

  function updateRecord(id: string, body: any): [number, unknown] {
    if (writeFailure !== null) return [writeFailure, failure(writeFailure)];
    const index = list.findIndex((record) => record.id === id);
    if (index === -1) return [404, failure(404)];
    list[index] = { ...list[index], ...body, id };
    return [200, ok(list[index])];
  }

  function route(method: string, path: string, query: Record<string, string>, body: any): [number, unknown] {
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
    const url = new URL(req.url!, 'http://127.0.0.1');
    const query = Object.fromEntries(url.searchParams);
    const isWrite = req.method === 'POST' || req.method === 'PUT';
    const body = isWrite ? await readBody(req) : undefined;
    const [status, payload] = isWrite && body === undefined
      ? [400, failure(400)]
      : route(req.method!, url.pathname, query, body);
    requests.push({ method: req.method!, path: url.pathname, query, status, ...(isWrite ? { body } : {}) });
    sendJson(res, status, payload);
  });
  // Longer than the client agent's 5 s idle timeout, so the client always closes idle sockets first.
  server.keepAliveTimeout = 30000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
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
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await closed;
    }
  };
}

export { startFakeCloudflare };
