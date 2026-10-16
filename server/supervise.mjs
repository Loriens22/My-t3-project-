import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import "./monitor.mjs";

const root = process.env.T3_PHONE_ROOT || "/data";
const password = fs.readFileSync(path.join(root, "opencode-server-password"), "utf8").trim();
const children = new Set();
let stopping = false;
const shutdown = (code) => {
  if (stopping) return;
  stopping = true;
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
  const fd = fs.openSync(path.join(root, name + ".log"), "a", 0o600);
  const child = spawn(binary, args, { env: environment, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
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
  ...process.env, OPENCODE_SERVER_PASSWORD: password,
});
const headers = { Authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64") };
const healthy = () => new Promise((resolve) => {
  const request = http.get("http://127.0.0.1:4096/global/health", { headers, timeout: 1500 }, (response) => {
    response.resume();
    resolve(response.statusCode === 200);
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
