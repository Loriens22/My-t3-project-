import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import { rotatingLog } from "./rotating-log.mjs";
import { inferenceQueue } from "./inference-queue.mjs";
import "./monitor.mjs";

const root = process.env.T3_PHONE_ROOT || "/data";
const password = fs.readFileSync(path.join(root, "opencode-server-password"), "utf8").trim();
const children = new Set();
const queue = await inferenceQueue(JSON.parse(fs.readFileSync(path.join(root, "inference-routes.json"), "utf8")), { storageRoot: root });
console.log("Private model queue ready: one inference stream at a time.");
let stopping = false;
const shutdown = (code) => {
  if (stopping) return;
  stopping = true;
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

const launch = (name, binary, args, environment = process.env) => {
  const log = rotatingLog(path.join(root, name + ".log"));
  const child = spawn(binary, args, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
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
  // Bun's GC can size itself for the host rather than this container. Give the
  // shared engine half the instance's RAM and collect more often while streaming.
  BUN_JSC_forceRAMSize: "536870912",
  BUN_OPTIONS: [process.env.BUN_OPTIONS, "--smol"].filter(Boolean).join(" "),
});
const headers = { Authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64") };
const healthy = () => new Promise((resolve) => {
  const request = http.get("http://127.0.0.1:4096/api/info", { headers, timeout: 1500 }, (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      body += chunk;
      if (body.length > 65536) request.destroy();
    });
    response.on("end", () => {
      try {
        const info = JSON.parse(body);
        resolve(response.statusCode === 200 && /^2\./.test(info.version));
      } catch { resolve(false); }
    });
    response.on("error", () => resolve(false));
  });
  request.on("error", () => resolve(false));
  request.on("timeout", () => request.destroy());
});
let ready = false;
for (let attempt = 0; attempt < 120 && !stopping; attempt++) {
  if (await healthy()) { ready = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!ready) {
  console.error("Private OpenCode server did not become ready.");
  shutdown(1);
} else if (!stopping) {
  console.log("Private shared OpenCode server ready; starting T3 Code.");
  launch("server", `/opt/t3/node_modules/@t3code/t3-linux-${process.arch}/t3`, ["serve", "--host", "0.0.0.0", "--port", process.env.PORT || "3773", "--base-dir", process.env.T3CODE_HOME]);
}
