import http from "node:http";
import https from "node:https";
import fs from "node:fs";

// Serialize inference streams, including metadata and delegated-agent calls.
// Waiting at the HTTP boundary releases a slot before any tool starts, so a
// parent waiting for its child agent cannot hold the child's inference slot.
export async function inferenceQueue(routes, {
  port = 4098, storageRoot = "/data", maintenance,
  nvidiaResponseTimeoutMs = 60000, upstreamRequest = https.request,
} = {}) {
  if (!Number.isFinite(nvidiaResponseTimeoutMs) || nvidiaResponseTimeoutMs <= 0) {
    throw new TypeError("NVIDIA response timeout must be a positive finite number");
  }
  const waiting = [];
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1, proxyEnv: process.env });
  let active = null;
  let stopping = false;
  let admitting = false;
  const stats = { started: 0, completed: 0, cancelled: 0, failed: 0, maxActive: 0, maxWaiting: 0, responses: {}, nvidiaResponseTimeouts: 0 };
  const pump = async () => {
    if (stopping || active || admitting || !waiting.length) return;
    admitting = true;
    try {
      const disk = fs.statfsSync(storageRoot);
      if (maintenance && disk.bavail * disk.bsize < 128 * 1024 * 1024) await maintenance.ensureSpace();
    } catch {}
    admitting = false;
    if (stopping || active || !waiting.length) return;
    const task = waiting.shift();
    if (task.response.destroyed) { pump(); return; }
    try {
      const disk = fs.statfsSync(storageRoot);
      if (disk.bavail * disk.bsize < 64 * 1024 * 1024) {
        task.response.writeHead(507, { "content-type": "application/json" });
        task.response.end(JSON.stringify({ error: { message: "Server storage is nearly full. New model requests are paused to protect saved conversations." } }));
        stats.failed++;
        setImmediate(pump);
        return;
      }
    } catch {
      task.response.writeHead(503);
      task.response.end("Persistent storage unavailable");
      stats.failed++;
      setImmediate(pump);
      return;
    }
    active = task;
    task.startedAt = Date.now();
    stats.started++;
    stats.maxActive = 1;
    const nvidia = task.target.hostname === "integrate.api.nvidia.com";
    let responseTimer;
    let upstream;
    const clearResponseTimer = () => {
      clearTimeout(responseTimer);
      responseTimer = undefined;
    };
    const finish = (outcome) => {
      if (active !== task) return false;
      clearResponseTimer();
      active = null;
      stats[outcome]++;
      setImmediate(pump);
      return true;
    };
    const fail = (error, status = 502) => {
      if (!finish("failed")) return;
      if (!task.response.destroyed && !task.response.writableEnded) {
        if (!task.response.headersSent) {
          const headers = { "content-type": "application/json" };
          // This header is supported by OpenCode 2.2.5. A locally failed NVIDIA
          // request must release the single stream instead of retrying ten times.
          // Real upstream errors keep their own headers and retry policy.
          if (nvidia) headers["x-should-retry"] = "false";
          task.response.writeHead(status, headers);
          task.response.end(JSON.stringify({ error: {
            message: status === 504
              ? `NVIDIA model did not respond within ${Math.ceil(nvidiaResponseTimeoutMs / 1000)} seconds. Choose another model or try again later.`
              : "Model connection failed. Retry this message.",
            code: error.code || "UPSTREAM_ERROR",
          } }));
        } else task.response.destroy();
      }
    };
    task.cancel = () => {
      if (!finish("cancelled")) return;
      upstream?.destroy();
    };
    const headers = { ...task.request.headers, host: task.target.host };
    for (const key of ["connection", "proxy-authorization", "proxy-connection", "keep-alive", "upgrade", "transfer-encoding", "te", "trailer"]) delete headers[key];
    try {
      upstream = upstreamRequest(task.target, { method: task.request.method, headers, agent }, (reply) => {
        // A late response after timeout/cancellation cannot write a second reply.
        if (active !== task) { reply.destroy(); return; }
        clearResponseTimer();
        stats.responses[reply.statusCode] = (stats.responses[reply.statusCode] || 0) + 1;
        const responseHeaders = { ...reply.headers };
        for (const key of ["connection", "keep-alive", "transfer-encoding"]) delete responseHeaders[key];
        task.response.writeHead(reply.statusCode, responseHeaders);
        reply.pipe(task.response);
        reply.on("error", () => {
          if (finish("failed")) task.response.destroy();
        });
        reply.on("end", () => finish("completed"));
      });
      task.upstream = upstream;
      upstream.on("error", (error) => fail(error));
      // Keep the existing active-stream idle allowance. The separate NVIDIA
      // deadline below covers the wait before headers, including active uploads.
      upstream.setTimeout(180000, () => upstream.destroy(new Error("Model stream idle timeout")));
      if (nvidia) {
        const remaining = Math.max(0, task.startedAt + nvidiaResponseTimeoutMs - Date.now());
        responseTimer = setTimeout(() => {
          if (active !== task) return;
          stats.nvidiaResponseTimeouts++;
          const error = Object.assign(new Error("NVIDIA response deadline exceeded"), {
            code: "NVIDIA_RESPONSE_TIMEOUT",
          });
          fail(error, 504);
          upstream.destroy(error);
        }, remaining);
        responseTimer.unref();
      }
      task.request.pipe(upstream);
    } catch (error) {
      fail(error);
      upstream?.destroy();
    }
  };
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ active: active ? 1 : 0, activeSeconds: active ? Math.round((Date.now() - active.startedAt) / 1000) : 0, waiting: waiting.length, maintenance: maintenance?.status(), ...stats }));
      return;
    }
    if (request.method === "POST" && request.url === "/maintenance" && maintenance) {
      void maintenance.ensureSpace(true).then((result) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      }).catch(() => { response.writeHead(503); response.end(); });
      return;
    }
    const match = /^\/([a-f0-9]{16})(\/[^#]*)?$/.exec(request.url);
    if (!match || !routes[match[1]]) { response.writeHead(404); response.end(); return; }
    if (stopping || waiting.length >= 64) { response.writeHead(503); response.end("Model queue busy"); return; }
    const base = new URL(routes[match[1]]);
    const suffix = new URL(match[2] || "/", "http://localhost");
    base.pathname = base.pathname.replace(/\/$/, "") + suffix.pathname;
    base.search = suffix.search;
    const task = { request, response, target: base, cancel: null };
    const cancel = () => {
      const index = waiting.indexOf(task);
      if (index >= 0) { waiting.splice(index, 1); stats.cancelled++; }
      task.cancel?.();
    };
    request.on("aborted", cancel);
    response.on("close", () => { if (!response.writableEnded) cancel(); });
    request.pause();
    waiting.push(task);
    stats.maxWaiting = Math.max(stats.maxWaiting, waiting.length);
    pump();
  });
  server.requestTimeout = 0;
  server.timeout = 0;
  const storageGuard = setInterval(() => {
    if (!active) return;
    try {
      const disk = fs.statfsSync(storageRoot);
      if (disk.bavail * disk.bsize < 48 * 1024 * 1024) {
        active.upstream?.destroy(Object.assign(new Error("Conversation storage reserve reached"), { code: "STORAGE_RESERVE" }));
      }
    } catch {}
  }, 500);
  storageGuard.unref();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return {
    server,
    close() {
      stopping = true;
      clearInterval(storageGuard);
      for (const task of waiting.splice(0)) task.response.destroy();
      if (active) { const task = active; task.cancel(); task.response.destroy(); }
      agent.destroy();
      server.closeAllConnections();
      server.close();
    },
  };
}
