import http from "node:http";
import https from "node:https";
import fs from "node:fs";

// Serialize inference streams, including metadata and delegated-agent calls.
// Waiting at the HTTP boundary releases a slot before any tool starts, so a
// parent waiting for its child agent cannot hold the child's inference slot.
export async function inferenceQueue(routes, { port = 4098, storageRoot = "/data" } = {}) {
  const waiting = [];
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1, proxyEnv: process.env });
  let active = null;
  let stopping = false;
  const stats = { started: 0, completed: 0, cancelled: 0, failed: 0, maxActive: 0, maxWaiting: 0 };
  const pump = () => {
    if (stopping || active || !waiting.length) return;
    const task = waiting.shift();
    if (task.response.destroyed) { pump(); return; }
    try {
      const disk = fs.statfsSync(storageRoot);
      if (disk.bavail * disk.bsize < 24 * 1024 * 1024) {
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
    stats.started++;
    stats.maxActive = 1;
    const headers = { ...task.request.headers, host: task.target.host };
    for (const key of ["connection", "proxy-authorization", "proxy-connection", "keep-alive", "upgrade", "transfer-encoding", "te", "trailer"]) delete headers[key];
    const upstream = https.request(task.target, { method: task.request.method, headers, agent }, (reply) => {
      const responseHeaders = { ...reply.headers };
      for (const key of ["connection", "keep-alive", "transfer-encoding"]) delete responseHeaders[key];
      task.response.writeHead(reply.statusCode, responseHeaders);
      reply.pipe(task.response);
      reply.on("error", () => { task.response.destroy(); finish("failed"); });
      reply.on("end", () => finish("completed"));
    });
    task.upstream = upstream;
    const finish = (outcome) => {
      if (active !== task) return;
      active = null;
      stats[outcome]++;
      setImmediate(pump);
    };
    task.cancel = () => { upstream.destroy(); finish("cancelled"); };
    upstream.on("error", (error) => {
      if (!task.response.destroyed) {
        if (!task.response.headersSent) {
          task.response.writeHead(502, { "content-type": "application/json" });
          task.response.end(JSON.stringify({ error: { message: "Model connection failed. Retry this message.", code: error.code || "UPSTREAM_ERROR" } }));
        } else task.response.destroy();
      }
      finish("failed");
    });
    // Bound a hung upstream without limiting a long, actively streaming reply.
    upstream.setTimeout(180000, () => upstream.destroy(new Error("Model stream idle timeout")));
    task.request.pipe(upstream);
  };
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ active: active ? 1 : 0, waiting: waiting.length, ...stats }));
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
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return {
    server,
    close() {
      stopping = true;
      for (const task of waiting.splice(0)) task.response.destroy();
      if (active) { active.cancel(); active?.response.destroy(); }
      agent.destroy();
      server.closeAllConnections();
      server.close();
    },
  };
}
