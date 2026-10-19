import fs from "node:fs";

export function rotatingLog(file, maxBytes = 2 * 1024 * 1024, copies = 2) {
  let fd = null;
  let bytes = 0;
  let warned = false;
  return {
    write(chunk) {
      try {
        if (fd === null) {
          fd = fs.openSync(file, "a", 0o600);
          bytes = fs.fstatSync(fd).size;
        }
        if (bytes + chunk.length > maxBytes) {
          fs.closeSync(fd);
          fd = null;
          fs.rmSync(`${file}.${copies}`, { force: true });
          for (let n = copies - 1; n >= 1; n--) {
            if (fs.existsSync(`${file}.${n}`)) fs.renameSync(`${file}.${n}`, `${file}.${n + 1}`);
          }
          fs.renameSync(file, `${file}.1`);
          fd = fs.openSync(file, "a", 0o600);
          bytes = 0;
        }
        fs.writeSync(fd, chunk);
        bytes += chunk.length;
        warned = false;
      } catch (error) {
        if (fd !== null) { try { fs.closeSync(fd); } catch {} fd = null; }
        if (!warned) console.error(`Private diagnostic log unavailable: ${error.code || "unknown error"}`);
        warned = true;
      }
    },
    close() { if (fd !== null) { fs.closeSync(fd); fd = null; } },
  };
}
