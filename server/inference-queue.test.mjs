import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { inferenceQueue } from './inference-queue.mjs';

const NVIDIA = 'aaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbb';
const routes = {
  [NVIDIA]: 'https://integrate.api.nvidia.com/v1',
  [OTHER]: 'https://other-provider.example/v1',
};
const storageRoot = [os.tmpdir(), '/dev/shm'].find((directory) => {
  try {
    const disk = fs.statfsSync(directory);
    return disk.bavail * disk.bsize > 160 * 1024 * 1024;
  } catch { return false; }
});
assert.ok(storageRoot, 'Tests require an ordinary filesystem with sufficient storage reserve');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, handler, timeoutMs = 70) {
  const backend = http.createServer((request, response) => {
    request.on('error', () => {});
    response.on('error', () => {});
    handler(request, response);
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const backendPort = backend.address().port;
  let queue;
  let closed = false;
  const closeQueue = async () => {
    if (closed || !queue) return;
    closed = true;
    const close = once(queue.server, 'close');
    queue.close();
    await close;
  };
  t.after(async () => {
    await closeQueue();
    const close = once(backend, 'close');
    backend.closeAllConnections();
    backend.close();
    await close;
  });
  queue = await inferenceQueue(routes, {
    port: 0, storageRoot, nvidiaResponseTimeoutMs: timeoutMs,
    // Real HTTP on both sides; substitute only the external TLS transport.
    upstreamRequest(target, options, callback) {
      return http.request({
        hostname: '127.0.0.1', port: backendPort,
        path: target.pathname + target.search,
        method: options.method, headers: options.headers, agent: false,
      }, callback);
    },
  });
  const origin = `http://127.0.0.1:${queue.server.address().port}`;
  const request = (route, path, body = '{}') => new Promise((resolve, reject) => {
    const call = http.request(`${origin}/${route}${path}`, { method: 'POST' }, (response) => {
      let content = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { content += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: content }));
      response.on('error', reject);
    });
    call.on('error', reject);
    call.end(body);
  });
  const health = async () => {
    const response = await fetch(`${origin}/health`);
    assert.equal(response.status, 200);
    return response.json();
  };
  return { origin, request, health, closeQueue };
}

async function until(check, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(5);
  }
  assert.fail('Expected HTTP-visible state did not arrive');
}

test('silent NVIDIA response expires once and frees the slot for another provider', { timeout: 5000 }, async (t) => {
  const accepted = deferred();
  const f = await fixture(t, (request, response) => {
    request.resume();
    if (request.url.endsWith('/silent')) accepted.resolve();
    else response.end('other provider answered');
  });
  const stalled = f.request(NVIDIA, '/silent');
  await accepted.promise;
  const next = f.request(OTHER, '/working');
  const [failure, working] = await Promise.all([stalled, next]);
  assert.equal(failure.status, 504);
  assert.equal(failure.headers['x-should-retry'], 'false');
  assert.equal(JSON.parse(failure.body).error.code, 'NVIDIA_RESPONSE_TIMEOUT');
  assert.match(JSON.parse(failure.body).error.message, /Choose another model or try again later/);
  assert.equal(working.status, 200);
  assert.equal(working.body, 'other provider answered');
  const health = await f.health();
  assert.equal(health.active, 0);
  assert.equal(health.waiting, 0);
  assert.equal(health.started, 2);
  assert.equal(health.failed, 1);
  assert.equal(health.completed, 1);
  assert.equal(health.nvidiaResponseTimeouts, 1);
});

test('fast NVIDIA succeeds without a synthetic retry override', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, (request, response) => {
    assert.equal(request.headers.host, 'integrate.api.nvidia.com');
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json', 'x-vendor-probe': 'preserved' });
    response.end('{"reply":"CONNECTED"}');
  });
  const result = await f.request(NVIDIA, '/chat/completions');
  assert.equal(result.status, 200);
  assert.equal(result.body, '{"reply":"CONNECTED"}');
  assert.equal(result.headers['x-vendor-probe'], 'preserved');
  assert.equal(result.headers['x-should-retry'], undefined);
  assert.equal((await f.health()).nvidiaResponseTimeouts, 0);
});

test('NVIDIA genuine 429 keeps status, retry-after, retry policy and complete body', { timeout: 5000 }, async (t) => {
  const body = '{"error":{"code":"provider.quota","message":"Upstream allowance exhausted"}}';
  const f = await fixture(t, (request, response) => {
    request.resume();
    response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '17', 'x-should-retry': 'true' });
    response.end(body);
  });
  const result = await f.request(NVIDIA, '/limited');
  assert.equal(result.status, 429);
  assert.equal(result.headers['retry-after'], '17');
  assert.equal(result.headers['x-should-retry'], 'true');
  assert.equal(result.body, body);
  assert.equal((await f.health()).nvidiaResponseTimeouts, 0);
});

test('received headers permit an active NVIDIA stream beyond the initial deadline', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, (request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    response.write('data: first\n\n');
    setTimeout(() => response.end('data: last\n\n'), 100);
  }, 30);
  const result = await f.request(NVIDIA, '/stream');
  assert.equal(result.status, 200);
  assert.equal(result.body, 'data: first\n\ndata: last\n\n');
  const health = await f.health();
  assert.equal(health.completed, 1);
  assert.equal(health.nvidiaResponseTimeouts, 0);
});

test('a non-NVIDIA backend may wait longer than the NVIDIA header deadline', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, (request, response) => {
    request.resume();
    setTimeout(() => response.end('normal provider response'), 100);
  }, 25);
  const result = await f.request(OTHER, '/slow');
  assert.equal(result.status, 200);
  assert.equal(result.body, 'normal provider response');
  assert.equal(result.headers['x-should-retry'], undefined);
  assert.equal((await f.health()).nvidiaResponseTimeouts, 0);
});

test('only synthetic NVIDIA transport errors disable automatic retries', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, (request) => {
    request.resume();
    request.socket.destroy();
  });
  const nvidia = await f.request(NVIDIA, '/reset');
  const other = await f.request(OTHER, '/reset');
  assert.equal(nvidia.status, 502);
  assert.equal(nvidia.headers['x-should-retry'], 'false');
  assert.equal(JSON.parse(nvidia.body).error.code, 'ECONNRESET');
  assert.equal(other.status, 502);
  assert.equal(other.headers['x-should-retry'], undefined);
  assert.equal(JSON.parse(other.body).error.code, 'ECONNRESET');
  const health = await f.health();
  assert.equal(health.failed, 2);
  assert.equal(health.nvidiaResponseTimeouts, 0);
});

test('client cancellation releases NVIDIA and leaves no later phantom timeout', { timeout: 5000 }, async (t) => {
  const accepted = deferred();
  const f = await fixture(t, (request) => {
    request.resume();
    accepted.resolve();
  }, 100);
  const call = http.request(`${f.origin}/${NVIDIA}/cancel`, { method: 'POST' });
  call.on('error', () => {});
  call.end('{}');
  await accepted.promise;
  call.destroy();
  await until(async () => (await f.health()).cancelled === 1);
  await delay(130);
  const health = await f.health();
  assert.equal(health.active, 0);
  assert.equal(health.failed, 0);
  assert.equal(health.cancelled, 1);
  assert.equal(health.nvidiaResponseTimeouts, 0);
});

test('the NVIDIA deadline is measured from admission rather than waiting in the queue', { timeout: 5000 }, async (t) => {
  const accepted = deferred();
  const f = await fixture(t, (request, response) => {
    request.resume();
    if (request.url.endsWith('/first')) {
      accepted.resolve();
      setTimeout(() => response.end('first'), 100);
    } else response.end('second');
  }, 35);
  const first = f.request(OTHER, '/first');
  await accepted.promise;
  const second = f.request(NVIDIA, '/second');
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((r) => [r.status, r.body]), [[200, 'first'], [200, 'second']]);
  assert.equal((await f.health()).nvidiaResponseTimeouts, 0);
});

test('a continuously uploading NVIDIA request cannot reset the header deadline', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, (request) => { request.resume(); }, 90);
  let uploads = 0;
  const start = Date.now();
  const result = await new Promise((resolve, reject) => {
    let interval;
    const call = http.request(`${f.origin}/${NVIDIA}/upload`, { method: 'POST' }, (response) => {
      let content = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { content += chunk; });
      response.on('end', () => {
        clearInterval(interval);
        call.end('}');
        resolve({ status: response.statusCode, body: content });
      });
      response.on('error', reject);
    });
    call.on('error', (error) => { clearInterval(interval); reject(error); });
    call.write('{');
    interval = setInterval(() => { uploads++; call.write(' '); }, 12);
  });
  assert.equal(result.status, 504);
  assert.equal(JSON.parse(result.body).error.code, 'NVIDIA_RESPONSE_TIMEOUT');
  assert.ok(uploads >= 2, 'The connection was active while awaiting response headers');
  assert.ok(Date.now() - start < 1000, 'Active upload must not stretch the header deadline indefinitely');
  assert.equal((await f.health()).nvidiaResponseTimeouts, 1);
});

test('shutdown cancels the active NVIDIA connection without leaking its deadline', { timeout: 5000 }, async (t) => {
  const accepted = deferred();
  const backendClosed = deferred();
  const f = await fixture(t, (request) => {
    request.resume();
    request.socket.on('close', backendClosed.resolve);
    accepted.resolve();
  }, 80);
  const result = f.request(NVIDIA, '/shutdown').then(() => 'response', () => 'closed');
  await accepted.promise;
  await f.closeQueue();
  await backendClosed.promise;
  assert.equal(await result, 'closed');
  await delay(110);
});
