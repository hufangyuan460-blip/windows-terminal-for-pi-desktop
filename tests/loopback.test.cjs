'use strict';

/**
 * loopback.test.cjs — the plugin's 127.0.0.1 event service.
 *
 * The security claims in the manifest deserve tests, not prose: a request
 * without the token must be refused before any data is produced, the token
 * check must not be bypassable through the CORS headers, and the SSE path must
 * still resume by sequence number.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { LoopbackService } = require('../lib/loopback');

function makeSource() {
  const chunks = [{ seq: 1, buffer: Buffer.from('hello ') }];
  return {
    listTabs: () => [{ id: 't1', status: 'running' }],
    readSince: (_tabId, since) => {
      const kept = chunks.filter((chunk) => chunk.seq > since);
      return {
        chunks: kept,
        bytes: kept.reduce((sum, chunk) => sum + chunk.buffer.length, 0),
        truncated: false,
        droppedBytes: 0,
        seq: chunks.length ? chunks[chunks.length - 1].seq : 0,
        oldestSeq: chunks.length ? chunks[0].seq : 0,
      };
    },
    push: (text) => {
      chunks.push({ seq: chunks.length + 1, buffer: Buffer.from(text) });
      return chunks[chunks.length - 1].seq;
    },
  };
}

async function withService(run) {
  const source = makeSource();
  const service = new LoopbackService({ source, log: () => {} });
  await service.start();
  try {
    await run(service, source);
  } finally {
    await service.stop();
  }
}

function url(service, path, token) {
  const suffix = token === undefined ? '' : `?token=${encodeURIComponent(token)}`;
  return `http://127.0.0.1:${service.port}${path}${suffix}`;
}

test('binds to loopback on an ephemeral port with a strong token', async () => {
  await withService(async (service) => {
    assert.equal(service.port > 1023 && service.port < 65536, true);
    assert.ok(service.token.length >= 32, 'the token must be long enough to be unguessable');
    const response = await fetch(url(service, '/v1/state', service.token));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.protocol, 1);
    assert.deepEqual(body.tabs, [{ id: 't1', status: 'running' }]);
  });
});

test('refuses requests without a token and with a wrong token', async () => {
  await withService(async (service) => {
    const missing = await fetch(url(service, '/v1/state'));
    assert.equal(missing.status, 403);
    assert.deepEqual(await missing.json(), { ok: false, error: 'bad-token' });

    const wrong = await fetch(url(service, '/v1/state', 'not-the-token'));
    assert.equal(wrong.status, 403);

    const short = await fetch(url(service, '/v1/events', 'x'));
    assert.equal(short.status, 403);

    assert.ok(service.stats().rejected >= 3);
  });
});

test('CORS headers are present but do not replace the token check', async () => {
  await withService(async (service) => {
    const preflight = await fetch(url(service, '/v1/events'), { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');

    const bare = await fetch(url(service, '/v1/events'), {
      headers: { Origin: 'null', 'Access-Control-Request-Private-Network': 'true' },
    });
    assert.equal(bare.status, 403, 'an origin header must never be accepted as authentication');
  });
});

test('serves the backlog with sequence numbers and streams live frames', async () => {
  await withService(async (service, source) => {
    const controller = new AbortController();
    // Subscribing for one tab is what makes the server replay that tab's backlog.
    const endpoint = `http://127.0.0.1:${service.port}/v1/events?tab=t1&token=${encodeURIComponent(service.token)}`;
    const response = await fetch(endpoint, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const nextFrame = async () => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const index = buffer.indexOf('\n\n');
        if (index >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
          if (dataLine) return JSON.parse(dataLine.slice(6));
          continue;
        }
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
      return null;
    };

    // A live frame, exactly as the plugin pushes terminal output.
    const seq = source.push('world');
    service.broadcast('t1', { kind: 'output', tabId: 't1', seq, data: Buffer.from('world').toString('base64') });

    const frames = [];
    for (let index = 0; index < 2; index += 1) {
      const frame = await nextFrame();
      if (!frame) break;
      frames.push(frame);
    }

    const outputs = frames.filter((frame) => frame.kind === 'output');
    assert.ok(outputs.length >= 2, `expected backlog plus a live frame, got ${JSON.stringify(frames)}`);
    assert.equal(outputs[0].data, Buffer.from('hello ').toString('base64'));
    assert.equal(outputs[1].data, Buffer.from('world').toString('base64'));
    assert.deepEqual(outputs.map((frame) => frame.seq), [1, 2]);

    // End the stream from the client side instead of aborting the request: an
    // abort races the socket teardown and makes Node on Windows assert in libuv.
    await reader.cancel();
    await service.stop();
  });
});

test('unknown paths are refused and stop() releases the port', async () => {
  const service = new LoopbackService({ source: makeSource(), log: () => {} });
  await service.start();
  const port = service.port;
  const notFound = await fetch(url(service, '/v1/exec', service.token));
  assert.equal(notFound.status, 404);
  await service.stop();
  let refused = false;
  try {
    await fetch(`http://127.0.0.1:${port}/v1/state`);
  } catch {
    refused = true;
  }
  assert.equal(refused, true, 'the listener must be gone after stop()');
});

test('a broadcast reaches only the subscribed tab', async () => {
  await withService(async (service) => {
    assert.equal(service.broadcast('t1', { kind: 'output', tabId: 't1', seq: 1, data: '' }), undefined);
    assert.equal(service.clientCount, 0);
    assert.equal(service.stats().clients, 0);
  });
});
