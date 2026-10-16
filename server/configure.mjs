import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const root = process.env.T3_PHONE_ROOT || "/data";
const selection = { instanceId: "opencode", model: "opencode/deepseek-v4.1-flash-free" };
for (const dir of ["t3/userdata", "data", "config", "cache", "projects/my-project"]) {
  fs.mkdirSync(path.join(root, dir), { recursive: true, mode: 0o700 });
}
const writeNew = (name, value) => {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  }
};
// Discover before T3 starts: a second OpenCode process must not compete with
// an active conversation for this server's 1 GB of memory.
const bundledFreeModels = JSON.parse(fs.readFileSync(new URL("./free-models.json", import.meta.url), "utf8"));
let freeModels = bundledFreeModels;
const discoveryFile = path.join(root, "catalog-discovery.json");
fs.writeFileSync(discoveryFile, JSON.stringify({ enabled_providers: ["opencode"] }), { mode: 0o600 });
try {
  const output = execFileSync(process.env.OPENCODE_BINARY || "/opt/t3/node_modules/.bin/opencode", ["models", "opencode", "--verbose"], {
    env: { ...process.env, OPENCODE_CONFIG: discoveryFile },
    encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const entries = output.split(/\n(?=opencode\/)/).map((entry) => {
    const start = entry.indexOf("{");
    return start >= 0 ? JSON.parse(entry.slice(start)) : null;
  }).filter(Boolean);
  const allZero = (value) => typeof value === "number" ? value === 0
    : value !== null && typeof value === "object" && Object.values(value).every(allZero);
  const discovered = entries.filter((model) => model.cost?.input === 0 && model.cost?.output === 0 && allZero(model.cost)).map((model) => model.id);
  if (!discovered.includes("deepseek-v4.1-flash-free")) throw new Error("Incomplete free model catalog");
  freeModels = [...new Set(discovered)].sort();
} catch {
  console.warn("Free model discovery unavailable; keeping the verified free catalog.");
} finally {
  fs.rmSync(discoveryFile, { force: true });
}
writeNew("opencode.json", {
  $schema: "https://opencode.ai/config.json",
  model: selection.model,
  small_model: selection.model,
  enabled_providers: ["opencode"],
  provider: { opencode: { whitelist: freeModels } },
});
const configFile = path.join(root, "opencode.json");
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
const previous = config.provider?.opencode?.whitelist;
if (JSON.stringify(previous) !== JSON.stringify(freeModels)) {
  fs.copyFileSync(configFile, configFile + ".before-free-catalog-update");
  config.provider ??= {};
  config.provider.opencode ??= {};
  config.provider.opencode.whitelist = freeModels;
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}
console.log(`OpenCode catalog: ${freeModels.length} models with zero input/output/cache prices.`);
writeNew("t3/userdata/settings.json", {
  defaultModelSelection: selection,
  textGenerationModelSelection: selection,
  defaultRuntimeMode: "approval-required",
  addProjectBaseDirectory: path.join(root, "projects"),
  providerInstances: {
    opencode: { driver: "opencode", enabled: true, config: { binaryPath: "/opt/t3/node_modules/.bin/opencode" } },
    codex: { driver: "codex", enabled: false, config: {} },
    claudeAgent: { driver: "claudeAgent", enabled: false, config: {} },
  },
});
// All T3 activities share one private OpenCode server. Starting an independent
// helper and one process per thread exceeds the 1 GB trial limit.
const passwordFile = path.join(root, "opencode-server-password");
if (!fs.existsSync(passwordFile)) fs.writeFileSync(passwordFile, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
const settingsFile = path.join(root, "t3/userdata/settings.json");
const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
settings.providerInstances ??= {};
settings.providerInstances.opencode ??= { driver: "opencode", enabled: true, config: {} };
settings.providerInstances.opencode.config ??= {};
Object.assign(settings.providerInstances.opencode.config, {
  serverUrl: "http://127.0.0.1:4096",
  serverPassword: fs.readFileSync(passwordFile, "utf8").trim(),
});
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
