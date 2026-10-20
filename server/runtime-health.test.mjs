import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { probeJson, runtimeHealth } from './runtime-health.mjs';

test('probe rejects a socket that keeps sending without completing JSON', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200);
    const timer = setInterval(() => response.write(' '), 5);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const start = Date.now();
    assert.equal(await probeJson(`http://127.0.0.1:${server.address().port}/`, { timeoutMs: 50 }), false);
    assert.ok(Date.now() - start < 500);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test('a transient timeout clears; repeated failures recover exactly once', async () => {
  let healthy = false;
  const reasons = [];
  const watcher = runtimeHealth({ intervalMs: 60000, probes: [async () => healthy], memory: () => null, recover: (r) => reasons.push(r) });
  await watcher.check();
  healthy = true;
  await watcher.check();
  healthy = false;
  await watcher.check(); await watcher.check();
  assert.deepEqual(reasons, []);
  await watcher.check(); await watcher.check();
  assert.deepEqual(reasons, ['runtime_unresponsive']);
  watcher.close();
});

test('a stalled native heartbeat is unhealthy even if basic HTTP still responds', async () => {
  const reasons = [];
  const watcher = runtimeHealth({ intervalMs: 60000, probes: [async () => true], memory: () => null,
    heartbeat: () => ({ at: Date.now() - 30000 }), recover: (r) => reasons.push(r) });
  for (let n = 0; n < 3; n++) await watcher.check();
  assert.deepEqual(reasons, ['runtime_unresponsive']);
  watcher.close();
});

test('reclaimable cache does not restart; sustained working-set stalls do', async () => {
  const reasons = [];
  let sample = { currentBytes: 990, limitBytes: 1000, workingBytes: 650, stalledPercent: 20 };
  const watcher = runtimeHealth({ intervalMs: 60000, probes: [async () => true], memory: () => sample, recover: (r) => reasons.push(r) });
  for (let n = 0; n < 8; n++) await watcher.check();
  assert.deepEqual(reasons, []);
  sample = { ...sample, workingBytes: 900 };
  for (let n = 0; n < 5; n++) await watcher.check();
  assert.deepEqual(reasons, []);
  await watcher.check();
  assert.deepEqual(reasons, ['sustained_memory_pressure']);
  watcher.close();
});

test('releasing an overloaded tool gives the runtime a chance to recover', async () => {
  const reasons = [];
  let healthy = false;
  let relieved = 0;
  const watcher = runtimeHealth({ intervalMs: 60000, probes: [async () => healthy], memory: () => null,
    relieve: ({ unresponsive }) => {
      if (!unresponsive) return false;
      relieved++; healthy = true; return true;
    }, recover: (r) => reasons.push(r) });
  await watcher.check(); await watcher.check();
  for (let n = 0; n < 4; n++) await watcher.check();
  assert.equal(relieved, 1);
  assert.deepEqual(reasons, []);
  watcher.close();
});
