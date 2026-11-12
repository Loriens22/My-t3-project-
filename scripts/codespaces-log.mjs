import { rotatingLog } from "../server/rotating-log.mjs";

// Owner-private startup logs can contain pairing grants. Rotate while streaming,
// not just on a restart, and never echo them to a forwarded HTTP endpoint.
const log = rotatingLog("/workspaces/.t3-code/launcher.log", 2 * 1024 * 1024, 1);
process.stdin.on("data", chunk => log.write(chunk));
process.stdin.on("end", () => log.close());
process.stdin.on("error", () => { log.close(); process.exitCode = 1; });
