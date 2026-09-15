import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { FakeTraefik, FakeTraefikOptions } from '../../types/test';

const DEFAULT_PAGE = 1;
const DEFAULT_PER_PAGE = 100;

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function intParam(params: URLSearchParams, name: string, fallback: number): number {
  const raw = params.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : NaN;
}

/**
 * In-process fake of the Traefik API, paginating `/api/http/routers` like Traefik v3.7 `pkg/api/criterion.go`.
 * @param {FakeTraefikOptions} [options={}]
 * @returns {Promise<FakeTraefik>}
 */
async function startFakeTraefik({ routers = [] }: FakeTraefikOptions = {}): Promise<FakeTraefik> {
  let list = [...routers];
  const stats = { routerRequests: 0 };
  const sockets = new Set<Socket>();

  function handleRouters(res: http.ServerResponse, params: URLSearchParams) {
    stats.routerRequests++;
    const page = intParam(params, 'page', DEFAULT_PAGE);
    const perPage = intParam(params, 'per_page', DEFAULT_PER_PAGE);
    const start = (page - 1) * perPage;
    if (Number.isNaN(page) || Number.isNaN(perPage) || (start !== 0 && start >= list.length)) {
      sendJson(res, 400, { message: `invalid request: page: ${params.get('page')}, per_page: ${params.get('per_page')}` });
      return;
    }
    const nextPage = page * perPage < list.length ? page + 1 : 1;
    sendJson(res, 200, list.slice(start, start + perPage), { 'X-Next-Page': String(nextPage) });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/api/overview') {
      sendJson(res, 200, {});
    } else if (req.method === 'GET' && url.pathname === '/api/http/routers') {
      handleRouters(res, url.searchParams);
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

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });

  return {
    port,
    url: `http://127.0.0.1:${port}/api`,
    stats,
    setRouters(next) {
      list = [...next];
    },
    async stop() {
      if (!server.listening) return;
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await closed;
    }
  };
}

export { startFakeTraefik };
