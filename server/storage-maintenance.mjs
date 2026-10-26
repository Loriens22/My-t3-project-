import fs from "node:fs";
import { spawn } from "node:child_process";

export function storageMaintenance(root, { archives } = {}) {
  let running = null;
  let child = null;
  let closed = false;
  let lastAt = 0;
  let last = null;
  const free = () => { const disk = fs.statfsSync(root); return disk.bavail * disk.bsize; };
  const ensureSpace = (force = false) => {
    if (free() < 128 * 1024 * 1024) archives?.run();
    if (running) return running;
    if (closed || (Date.now() - lastAt < 12000 && !force)) return Promise.resolve(last);
    running = new Promise((resolve) => {
      child = spawn("python3", ["/app/server/storage_maintenance.py", ...(force ? ["--force"] : [])], {
        env: { ...process.env, T3_PHONE_ROOT: root, PYTHONDONTWRITEBYTECODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output = (output + chunk.toString()).slice(-16384); });
      child.stderr.resume();
      const timeout = setTimeout(() => child?.kill("SIGTERM"), 20000);
      timeout.unref();
      let done = false;
      const finish = (code) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        lastAt = Date.now();
        try { last = code === 0 ? JSON.parse(output.trim()) : { deferred: "worker_unavailable", freeBytes: free() }; }
        catch { last = { deferred: "worker_unavailable" }; }
        if (last.reasoning?.changed || last.diagnosticBytesReclaimed || (last.reclaim?.pagesReclaimed || 0) > 0) {
          console.log("Automatic storage cleanup:", JSON.stringify(last));
        }
        child = null;
        running = null;
        resolve(last);
      };
      child.on("error", () => finish(1));
      child.on("close", finish);
    });
    return running;
  };
  const timer = setInterval(() => { void ensureSpace(); }, 15000);
  timer.unref();
  return {
    ensureSpace,
    status: () => ({ running: Boolean(running), lastAt: lastAt ? new Date(lastAt).toISOString() : null, last, archive: archives?.status() }),
    close() { closed = true; clearInterval(timer); child?.kill("SIGTERM"); },
  };
}
