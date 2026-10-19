// Explicit, temporary maintenance mode. Never runs beside T3 or OpenCode.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";

const root = process.env.T3_PHONE_ROOT || "/data";
const token = process.env.T3_RECOVERY_TOKEN;
if (!token || token.length < 48) throw new Error("Maintenance credential missing");
const authorized = (request) => {
  const a = Buffer.from(request.headers.authorization || "");
  const b = Buffer.from("Bearer " + token);
  return a.length === b.length && timingSafeEqual(a, b);
};
const files = () => {
  const result = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) result.push({ path: path.relative(root, file), bytes: fs.statSync(file).size });
    }
  };
  visit(root);
  return result.sort((a, b) => b.bytes - a.bytes);
};
const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/.well-known/t3/environment") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ maintenance: true }));
    return;
  }
  if (!authorized(request)) { response.writeHead(401); response.end(); return; }
  try {
    if (request.method === "GET" && request.url === "/recovery/status") {
      const disk = fs.statfsSync(root);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ freeBytes: disk.bavail * disk.bsize, files: files() }));
    } else if (request.method === "GET" && request.url === "/recovery/archive") {
      response.setHeader("content-type", "application/gzip");
      const tar = spawn("tar", ["-czf", "-", "-C", root, "."], { stdio: ["ignore", "pipe", "ignore"] });
      tar.stdout.pipe(response);
      response.on("close", () => tar.kill("SIGTERM"));
      tar.on("error", () => response.destroy());
      tar.on("exit", (code) => { if (code && !response.writableEnded) response.destroy(); });
    } else if (request.method === "POST" && request.url === "/recovery/prune-archived-diagnostics") {
      let body = "";
      for await (const chunk of request) { body += chunk; if (body.length > 131072) throw new Error("Request too large"); }
      const selected = JSON.parse(body).files;
      const checked = [];
      for (const entry of selected) {
        const file = path.resolve(root, entry.path);
        const relative = path.relative(root, file);
        if (relative.startsWith("..") || path.isAbsolute(relative) ||
            !/^(backups\/|(?:server|opencode-server)\.log(?:\.\d+)?$|t3\/userdata\/logs\/server\.trace\.ndjson(?:\..*)?$)/.test(relative) ||
            !fs.lstatSync(file).isFile()) throw new Error("File outside diagnostic archive scope");
        const hash = createHash("sha256");
        for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
        if (hash.digest("hex") !== entry.sha256) throw new Error("Archived file checksum changed");
        checked.push(file);
      }
      for (const file of checked) fs.unlinkSync(file);
      response.end(JSON.stringify({ removed: checked.length }));
    } else { response.writeHead(404); response.end(); }
  } catch (error) {
    if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: error.code || "Maintenance request rejected" }));
  }
});
server.requestTimeout = 0;
server.listen(Number(process.env.PORT || 3773), "0.0.0.0", () => console.log("Private storage recovery mode ready."));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
