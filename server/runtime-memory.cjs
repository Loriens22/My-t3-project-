// Loaded only into the native Node server. Report numbers, never user content.
if (require('node:path').basename(process.execPath) === 't3') {
  const fs = require('node:fs');
  const v8 = require('node:v8');
  const vm = require('node:vm');
  v8.setFlagsFromString('--expose_gc');
  const collect = vm.runInNewContext('gc');
  let lastCollection = 0;
  let afterCollection = 0;
  let collections = 0;
  let collectionMs = 0;
  const sample = (requested = false) => {
    let used = process.memoryUsage();
    let pressure = false;
    try {
      const current = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
      const limit = Number(fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8'));
      pressure = Number.isFinite(limit) && current > limit * 0.82;
    } catch {}
    const grown = used.heapUsed > Math.max(96 * 1048576, afterCollection + 24 * 1048576);
    if ((requested || (pressure && grown)) && Date.now() - lastCollection > 15000) {
      const start = performance.now();
      collect();
      collectionMs = Math.round(performance.now() - start);
      used = process.memoryUsage();
      afterCollection = used.heapUsed;
      lastCollection = Date.now();
      collections++;
    }
    if (process.connected) process.send({
      type: 't3.runtime.health', rssBytes: used.rss, heapUsedBytes: used.heapUsed,
      heapLimitBytes: v8.getHeapStatistics().heap_size_limit,
      externalBytes: used.external, collections, collectionMs,
    }, () => {});
  };
  process.on('message', (message) => {
    if (message?.type === 't3.runtime.collect') sample(true);
  });
  process.channel?.unref();
  setInterval(sample, 5000).unref();
  sample();
}
