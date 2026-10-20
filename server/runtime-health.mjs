import fs from 'node:fs';
import http from 'node:http';

export function memorySample() {
  try {
    const read = (name) => fs.readFileSync('/sys/fs/cgroup/' + name, 'utf8');
    const currentBytes = Number(read('memory.current'));
    const limitBytes = Number(read('memory.max'));
    const values = Object.fromEntries(read('memory.stat').trim().split('\n').map((l) => l.split(' ')));
    let pressure = '';
    // Some test/container kernels do not expose PSI; retain the other readings.
    try { pressure = read('memory.pressure'); } catch {}
    const full = pressure.split('\n').find((l) => l.startsWith('full '));
    return { currentBytes, limitBytes,
      workingBytes: currentBytes - Number(values.inactive_file || 0),
      stalledPercent: Number(/avg10=([\d.]+)/.exec(full || '')?.[1] || 0) };
  } catch { return null; }
}

// A wall-clock deadline also catches servers that accept a socket then stall.
export function probeJson(url, { headers = {}, timeoutMs = 3000, accept = () => true } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let request;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => { finish(false); request?.destroy(); }, timeoutMs);
    request = http.get(url, { headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 65536) { finish(false); request.destroy(); }
      });
      response.on('end', () => {
        try { finish(response.statusCode === 200 && accept(JSON.parse(body))); }
        catch { finish(false); }
      });
      response.on('error', () => finish(false));
    });
    request.on('error', () => finish(false));
  });
}

export function runtimeHealth({ probes, recover, collect, heartbeat, relieve, memory = memorySample,
  intervalMs = 5000, failuresRequired = 3, heartbeatTimeoutMs = 25000 }) {
  let closed = false;
  let checking = false;
  let failures = 0;
  let pressureSamples = 0;
  let recovered = false;
  let lastReport = 0;
  const check = async () => {
    if (closed || checking || recovered) return;
    checking = true;
    try {
      const results = await Promise.all(probes.map((probe) => Promise.resolve().then(probe).catch(() => false)));
      if (closed) return;
      const beat = heartbeat?.();
      const stale = beat && Date.now() - beat.at > heartbeatTimeoutMs;
      failures = results.every(Boolean) && !stale ? 0 : failures + 1;
      const sample = memory();
      // A browser tool can exhaust RAM while the two core services are healthy.
      // Release that tool first and let its calling agent receive the tool error.
      if (relieve?.({ sample, unresponsive: failures >= 2 })) {
        failures = 0;
        pressureSamples = 0;
        return;
      }
      const constrained = sample && Number.isFinite(sample.limitBytes) && sample.limitBytes > 0;
      // Ignore reclaimable file cache. Recover only from sustained working-set
      // pressure accompanied by actual time lost to kernel memory reclaim.
      const pressured = constrained && sample.workingBytes > sample.limitBytes * 0.86 && sample.stalledPercent >= 10;
      pressureSamples = pressured ? pressureSamples + 1 : 0;
      if (constrained && sample.currentBytes > sample.limitBytes * 0.82) collect?.();
      if (Date.now() - lastReport > 60000) {
        lastReport = Date.now();
        console.log('Runtime health:', JSON.stringify({ ...sample, native: beat?.sample, failures }));
      }
      if (failures >= failuresRequired || pressureSamples >= 6) {
        recovered = true;
        const reason = failures >= failuresRequired ? 'runtime_unresponsive' : 'sustained_memory_pressure';
        console.error('Automatic runtime recovery:', JSON.stringify({ reason, failures, pressureSamples, ...sample }));
        recover(reason);
      }
    } finally { checking = false; }
  };
  const timer = setInterval(() => { void check(); }, intervalMs);
  timer.unref();
  return { check, close() { closed = true; clearInterval(timer); } };
}
