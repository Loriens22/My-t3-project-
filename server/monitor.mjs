import fs from "node:fs";
import path from "node:path";
const root = process.env.T3_PHONE_ROOT || "/data";
const logFile = path.join(root, "server.log");
let offset = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
let previousEvents = "";
const tick = () => {
  try {
    const events = fs.readFileSync("/sys/fs/cgroup/memory.events", "utf8");
    if (events !== previousEvents) {
      previousEvents = events;
      const current = fs.readFileSync("/sys/fs/cgroup/memory.current", "utf8").trim();
      console.log("Memory diagnostic:", JSON.stringify({ currentBytes: Number(current), events: events.trim().replaceAll("\n", "; ") }));
    }
  } catch {}
  try {
    const size = fs.statSync(logFile).size;
    if (size < offset) offset = 0;
    if (size > offset) {
      const buffer = Buffer.alloc(Math.min(size - offset, 65536));
      const fd = fs.openSync(logFile, "r");
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      fs.closeSync(fd);
      offset += buffer.length;
      for (const line of buffer.toString().split("\n")) {
        if (/WARN|ERROR|unexpected|out of memory|terminated/i.test(line) && !/token|credential|authorization|pairing/i.test(line)) console.log("T3 diagnostic:", line);
      }
    }
  } catch {}
};
setInterval(tick, 1000);
tick();
