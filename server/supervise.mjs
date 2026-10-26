import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { rotatingLog } from "./rotating-log.mjs";
import { inferenceQueue } from "./inference-queue.mjs";
import { storageMaintenance } from "./storage-maintenance.mjs";
import { settledArchive } from "./settled-archive.mjs";
import { probeJson, runtimeHealth } from "./runtime-health.mjs";
import { browserBudget } from "./browser-resources.mjs";
import "./monitor.mjs";

const root = process.env.T3_PHONE_ROOT || "/data";
const password = fs.readFileSync(path.join(root, "opencode-server-password"), "utf8").trim();
const children = new Set();
const browsers = browserBudget();
const archives = settledArchive(root);
const maintenance = storageMaintenance(root, { archives });
const queue = await inferenceQueue(JSON.parse(fs.readFileSync(path.join(root, "inference-routes.json"), "utf8")), { storageRoot: root, maintenance });
console.log("Private model queue ready: one inference stream at a time.");
let stopping = false;
let watchdog;
const shutdown = (code) => {
  if (stopping) return;
  stopping = true;
  watchdog?.close();
  browsers.close();
  maintenance.close();
  archives.close();
  queue.close();
  for (const child of children) child.kill("SIGTERM");
  const timer = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(code);
  }, 5000);
  timer.unref();
  const check = setInterval(() => {
    if (children.size === 0) process.exit(code);
  }, 50);
};
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => shutdown(0));

const launch = (name, binary, args, environment = process.env, ipc = false) => {
  const log = rotatingLog(path.join(root, name + ".log"));
  const child = spawn(binary, args, { env: environment, stdio: ["ignore", "pipe", "pipe", ...(ipc ? ["ipc"] : [])] });
  child.stdout.on("data", (chunk) => log.write(chunk));
  child.stderr.on("data", (chunk) => log.write(chunk));
  child.on("close", () => log.close());
  children.add(child);
  child.on("error", (error) => {
    console.error(`${name} could not start: ${error.code || "unknown error"}`);
    children.delete(child);
    shutdown(1);
  });
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`${name} exited: code=${code}, signal=${signal}`);
      shutdown(1);
    }
  });
  return child;
};

launch("opencode-server", "/opt/t3/node_modules/.bin/opencode", ["serve", "--hostname=127.0.0.1", "--port=4096"], {
  ...process.env, OPENCODE_PASSWORD: password,
  // Leave room for T3, the supervisor, tools and hot executable pages in 1 GB.
  // forceRAMSize is a GC sizing hint; gcMaxHeapSize is the separate heap ceiling.
  BUN_JSC_forceRAMSize: "268435456",
  BUN_JSC_gcMaxHeapSize: "335544320",
  BUN_OPTIONS: [process.env.BUN_OPTIONS, "--smol"].filter(Boolean).join(" "),
});
const headers = { Authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64") };
const healthy = () => probeJson("http://127.0.0.1:4096/api/info", {
  headers, accept: (info) => /^2\./.test(info.version),
});
let ready = false;
for (const deadline = Date.now() + 60000; Date.now() < deadline && !stopping;) {
  if (await healthy()) { ready = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!ready) {
  console.error("Private OpenCode server did not become ready.");
  shutdown(1);
} else if (!stopping) {
  console.log("Private shared OpenCode server ready; starting T3 Code.");
  const server = launch("server", `/opt/t3/node_modules/@t3code/t3-linux-${process.arch}/t3`, ["serve", "--host", "0.0.0.0", "--port", process.env.PORT || "3773", "--base-dir", process.env.T3CODE_HOME], {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=224 --max-semi-space-size=4 --require=/app/server/runtime-memory.cjs"].filter(Boolean).join(" "),
  }, true);
  let heartbeat = null;
  server.on("message", (sample) => {
    if (sample?.type === "t3.runtime.health") heartbeat = { at: Date.now(), sample };
  });
  const t3Healthy = () => probeJson(`http://127.0.0.1:${process.env.PORT || "3773"}/.well-known/t3/environment`, {
    accept: (info) => info.orchestrationProtocolVersion === 2,
  });
  let t3Ready = false;
  for (const deadline = Date.now() + 60000; Date.now() < deadline && !stopping;) {
    if (await t3Healthy()) { t3Ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!t3Ready) shutdown(1);
  else if (!stopping) {
    console.log("T3 protocol ready; continuous health and memory monitoring enabled.");
    watchdog = runtimeHealth({
      probes: [healthy, t3Healthy], heartbeat: () => heartbeat,
      relieve: (state) => browsers.relieve(state),
      collect: () => { if (server.connected) server.send({ type: "t3.runtime.collect" }, () => {}); },
      recover: () => shutdown(1),
    });
  }
}
