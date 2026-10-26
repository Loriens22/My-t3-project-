import { spawn } from "node:child_process";

// Network archives get their own single worker. The short disk-reserve worker
// must never kill a valid upload after its normal twenty-second local budget.
export function settledArchive(root) {
  let child = null;
  let closed = false;
  let last = null;
  let lastAt = 0;
  const run = () => {
    if (closed || child || Date.now() - lastAt < 30000) return;
    const current = spawn("python3", ["/app/server/settled_archive.py"], {
      env: { ...process.env, T3_PHONE_ROOT: root, PYTHONDONTWRITEBYTECODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = current;
    let output = "";
    current.stdout.on("data", chunk => { output = (output + chunk.toString()).slice(-16384); });
    current.stderr.resume();
    const timeout = setTimeout(() => {
      current.kill("SIGTERM");
      const force = setTimeout(() => current.kill("SIGKILL"), 5000);
      force.unref();
    }, 300000);
    timeout.unref();
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      child = null;
      lastAt = Date.now();
      try { last = code === 0 ? JSON.parse(output.trim()) : { deferred: "archive_worker_unavailable" }; }
      catch { last = { deferred: "archive_worker_unavailable" }; }
      if (last.archived || last.changed || last.dependenciesBytesReclaimed || last.lastError) {
        console.log("Settled conversation archive:", JSON.stringify(last));
      }
    };
    current.on("error", () => finish(1));
    current.on("close", finish);
  };
  const timer = setInterval(run, 60000);
  timer.unref();
  return {
    run,
    status: () => ({ running: Boolean(child), lastAt: lastAt ? new Date(lastAt).toISOString() : null, last }),
    close() { closed = true; clearInterval(timer); child?.kill("SIGTERM"); },
  };
}
