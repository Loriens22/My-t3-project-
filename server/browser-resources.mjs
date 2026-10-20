import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const browserNames = new Set(['headless_shell', 'chrome-headless-shell', 'chrome', 'chromium', 'chromium-browser']);

export function browserProcesses() {
  const uptime = Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
  const result = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const base = '/proc/' + entry;
      const exe = fs.readlinkSync(base + '/exe');
      if (!browserNames.has(path.basename(exe))) continue;
      const stat = fs.readFileSync(base + '/stat', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      const status = fs.readFileSync(base + '/status', 'utf8');
      const startTicks = Number(fields[19]);
      result.push({ pid: Number(entry), ppid: Number(fields[1]), startTicks,
        ageMs: (uptime - startTicks / 100) * 1000,
        rssBytes: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] || 0) * 1024 });
    } catch {} // A process can exit between /proc reads.
  }
  return result;
}

export function browserBudget({ read = browserProcesses, kill = (pid, signal) => process.kill(pid, signal),
  prioritize = (pid) => {
    try { if (os.getPriority(pid) < 10) os.setPriority(pid, 10); } catch {}
    // If a sudden spike reaches the kernel before our next check, prefer a
    // failed browser tool to losing the chat services and every running agent.
    try {
      const file = '/proc/' + pid + '/oom_score_adj';
      if (Number(fs.readFileSync(file, 'utf8')) < 800) fs.writeFileSync(file, '800');
    } catch {}
  },
  minAgeMs = 10000, minRssBytes = 64 * 1048576, killDelayMs = 5000 } = {}) {
  let lastRelief = 0;
  const timers = new Set();
  const relieve = ({ sample, unresponsive = false }) => {
    let processes;
    try { processes = read(); } catch { return false; }
    for (const process of processes) { try { prioritize(process.pid); } catch {} }
    const pressure = sample && Number.isFinite(sample.limitBytes) && sample.limitBytes > 0 &&
      sample.workingBytes > sample.limitBytes * 0.86 &&
      (sample.stalledPercent >= 3 || sample.workingBytes > sample.limitBytes * 0.90);
    if ((!pressure && !unresponsive) || Date.now() - lastRelief < 15000) return false;
    const byPid = new Map(processes.map((p) => [p.pid, p]));
    const groups = processes.filter((p) => !byPid.has(p.ppid)).map((root) => {
      const members = processes.filter((p) => {
        let cursor = p;
        const seen = new Set();
        while (cursor && !seen.has(cursor.pid)) {
          if (cursor.pid === root.pid) return true;
          seen.add(cursor.pid);
          cursor = byPid.get(cursor.ppid);
        }
        return false;
      });
      return { root, members, bytes: members.reduce((total, p) => total + p.rssBytes, 0) };
    }).filter((g) => g.root.ageMs >= minAgeMs && g.bytes >= minRssBytes).sort((a, b) => b.bytes - a.bytes);
    const group = groups[0];
    if (!group) return false;
    try { kill(group.root.pid, 'SIGTERM'); } catch { return false; }
    lastRelief = Date.now();
    console.warn('Automatic browser cleanup:', JSON.stringify({ processes: group.members.length, rssBytes: group.bytes,
      ageSeconds: Math.round(group.root.ageMs / 1000), reason: unresponsive ? 'runtime_unresponsive' : 'memory_pressure' }));
    const timer = setTimeout(() => {
      timers.delete(timer);
      // Recheck start identity before touching a PID that the kernel may reuse.
      let current;
      try { current = new Map(read().map((p) => [p.pid, p])); } catch { return; }
      for (const member of group.members) {
        if (current.get(member.pid)?.startTicks === member.startTicks) {
          try { kill(member.pid, 'SIGKILL'); } catch {}
        }
      }
    }, killDelayMs);
    timer.unref();
    timers.add(timer);
    return true;
  };
  return { relieve, close() { for (const timer of timers) clearTimeout(timer); timers.clear(); } };
}
