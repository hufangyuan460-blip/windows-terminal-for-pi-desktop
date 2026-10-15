'use strict';

/**
 * loopback.js — the plugin's own 127.0.0.1 event service.
 *
 * Why it exists: PI-Desktop 0.17.0 gives a plugin panel a request/response
 * bridge (`pluginBridge.invoke` -> `onPanelInvoke`) and host-owned broadcast
 * events, but no plugin-driven push channel. Terminal output is a stream, so the
 * output path is a Server-Sent Events feed served from this process, with
 * sequence-numbered resume. The bridge keeps polling as a fallback, so a panel
 * whose EventSource is blocked still works.
 *
 * Security posture:
 *   * bound to 127.0.0.1 only, on an ephemeral port;
 *   * every request needs the per-start token (32 random bytes, base64url),
 *     compared in constant time; a request without it gets 403 and no data;
 *   * the token is handed to the panel only through the plugin bridge, never
 *     through a log line, file or URL that gets written down;
 *   * CORS headers exist so the file:// panel can read the response — they are
 *     not authentication, and the token check runs first regardless;
 *   * no endpoint executes anything: input and resize travel over the bridge to
 *     the plugin, which owns the pseudoconsole.
 */

const http = require('node:http');
const crypto = require('node:crypto');

const MAX_URL_LENGTH = 2048;
const MAX_SSE_CLIENTS = 8;
const HEARTBEAT_MS = 15000;
const PROTOCOL_VERSION = 1;

class LoopbackService {
  /**
   * @param {object} options
   * @param {(message: string) => void} [options.log] diagnostics sink (no secrets)
   * @param {object} options.source terminal state provider
   */
  constructor(options) {
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.source = options.source;
    this.server = null;
    this.port = 0;
    this.token = '';
    this.clients = new Set();
    this.heartbeat = null;
    this.startedAt = 0;
    this.requestCount = 0;
    this.rejectedCount = 0;
    this.dropCount = 0;
  }

  get info() {
    return { port: this.port, token: this.token, protocol: PROTOCOL_VERSION };
  }

  get clientCount() {
    return this.clients.size;
  }

  async start() {
    if (this.server) return this.info;
    this.token = crypto.randomBytes(32).toString('base64url');
    const server = http.createServer((request, response) => {
      try {
        this.#handle(request, response);
      } catch (error) {
        this.log('loopback request failed: ' + (error && error.message ? error.message : error));
        this.#respond(response, 500, { error: 'internal' });
      }
    });
    server.on('clientError', (_error, socket) => {
      try {
        socket.destroy();
      } catch {
        // ignored
      }
    });
    this.server = server;
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
    });
    const address = server.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
    this.startedAt = Date.now();
    this.heartbeat = setInterval(() => this.#heartbeat(), HEARTBEAT_MS);
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
    this.log('loopback service listening on 127.0.0.1:' + String(this.port));
    return this.info;
  }

  async stop() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    for (const client of [...this.clients]) {
      this.#closeClient(client);
    }
    const server = this.server;
    this.server = null;
    this.port = 0;
    this.token = '';
    if (!server) return;
    await new Promise((resolve) => {
      server.close(() => resolve());
      // A keep-alive socket would hold close() open; SSE sockets are already gone.
      setTimeout(resolve, 500);
    });
  }

  /** Pushes one payload to every SSE client watching `tabId` (or all of them). */
  broadcast(tabId, payload) {
    if (this.clients.size === 0) return;
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of [...this.clients]) {
      if (client.tabId && tabId && client.tabId !== tabId) continue;
      try {
        client.response.write(frame);
      } catch (error) {
        this.dropCount += 1;
        this.log('sse write failed: ' + (error && error.message ? error.message : error));
        this.#closeClient(client);
      }
    }
  }

  stats() {
    return {
      port: this.port,
      clients: this.clients.size,
      requests: this.requestCount,
      rejected: this.rejectedCount,
      dropped: this.dropCount,
      startedAt: this.startedAt,
      protocol: PROTOCOL_VERSION,
    };
  }

  #handle(request, response) {
    this.requestCount += 1;
    if (!request.url || request.url.length === 0 || request.url.length > MAX_URL_LENGTH) {
      this.#reject(response, 'bad-url');
      return;
    }

    const url = new URL(request.url, 'http://127.0.0.1');
    const method = request.method || 'GET';

    if (method === 'OPTIONS') {
      this.#respond(response, 204, null, {
        'Access-Control-Allow-Headers': 'content-type, x-pi-token',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      });
      return;
    }

    if (!this.#authorized(url, request)) {
      this.#reject(response, 'bad-token');
      return;
    }

    if (method !== 'GET') {
      this.#reject(response, 'bad-method', 405);
      return;
    }

    if (url.pathname === '/v1/state') {
      this.#respond(response, 200, {
        ok: true,
        protocol: PROTOCOL_VERSION,
        tabs: this.source ? this.source.listTabs() : [],
        server: { clients: this.clients.size, uptimeMs: Date.now() - this.startedAt },
      });
      return;
    }

    if (url.pathname === '/v1/events') {
      this.#serveEvents(url, request, response);
      return;
    }

    this.#reject(response, 'not-found', 404);
  }

  #serveEvents(url, request, response) {
    if (this.clients.size >= MAX_SSE_CLIENTS) {
      this.#reject(response, 'too-many-clients', 429);
      return;
    }

    const tabId = (url.searchParams.get('tab') || '').slice(0, 64);
    const sinceParam = Number(url.searchParams.get('since'));
    const since = Number.isFinite(sinceParam) && sinceParam > 0 ? Math.floor(sinceParam) : 0;

    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...this.#corsHeaders(),
    });
    response.write(`retry: 1000\n\n`);

    const client = { response, tabId: tabId || null, since, openedAt: Date.now() };
    this.clients.add(client);

    // Backlog first, then live frames: a reconnecting panel resumes exactly
    // where it stopped instead of repainting from scratch.
    if (this.source && tabId) {
      try {
        const backlog = this.source.readSince(tabId, since, { maxBytes: 512 * 1024, maxChunks: 2048 });
        if (backlog && backlog.truncated) {
          response.write(`data: ${JSON.stringify({ kind: 'notice', tabId, code: 'OUTPUT_DROPPED', droppedBytes: backlog.droppedBytes })}\n\n`);
        }
        for (const chunk of (backlog && backlog.chunks) || []) {
          const payload = {
            kind: 'output',
            tabId,
            seq: chunk.seq,
            data: chunk.buffer.toString('base64'),
          };
          response.write(`data: ${JSON.stringify(payload)}\n\n`);
          client.since = chunk.seq;
        }
      } catch (error) {
        this.log('sse backlog failed: ' + (error && error.message ? error.message : error));
      }
    }

    const close = () => this.#closeClient(client);
    request.on('close', close);
    request.on('error', close);
    response.on('error', close);
    this.log('sse client attached (' + String(this.clients.size) + ' total)');
  }

  #heartbeat() {
    for (const client of [...this.clients]) {
      try {
        client.response.write(': ping\n\n');
      } catch {
        this.#closeClient(client);
      }
    }
  }

  /**
   * Detaches an SSE client. The socket is only ended when it is still alive:
   * calling `end()` (or `destroy()`) on a socket the peer already aborted makes
   * Node on Windows assert inside libuv
   * (`!(handle->flags & UV_HANDLE_CLOSING)`), which would take the whole plugin
   * process down just because a panel window closed.
   */
  #closeClient(client) {
    if (!this.clients.delete(client)) return;
    const response = client.response;
    if (response.destroyed || response.writableEnded || response.writable === false) return;
    try {
      response.end();
    } catch {
      // The peer is gone; nothing left to end.
    }
  }
  #authorized(url, request) {
    const provided = url.searchParams.get('token')
      || (typeof request.headers['x-pi-token'] === 'string' ? request.headers['x-pi-token'] : '');
    if (!provided || !this.token) return false;
    const expected = Buffer.from(this.token, 'utf8');
    const actual = Buffer.from(provided, 'utf8');
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  }

  #reject(response, reason, status = 403) {
    this.rejectedCount += 1;
    this.log('loopback request rejected: ' + reason);
    this.#respond(response, status, { ok: false, error: reason });
  }

  #corsHeaders() {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Private-Network': 'true',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
  }

  #respond(response, status, payload, extraHeaders = {}) {
    const headers = { ...this.#corsHeaders(), ...extraHeaders };
    if (payload === null || payload === undefined) {
      response.writeHead(status, headers);
      response.end();
      return;
    }
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    headers['Content-Type'] = 'application/json; charset=utf-8';
    headers['Content-Length'] = String(body.length);
    response.writeHead(status, headers);
    response.end(body);
  }
}

module.exports = { LoopbackService, PROTOCOL_VERSION };
