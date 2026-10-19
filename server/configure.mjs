import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { nvidiaConfiguration } from "./nvidia.mjs";

const root = process.env.T3_PHONE_ROOT || "/data";
const selection = { instanceId: "opencode", model: "opencode/deepseek-v4.1-flash-free" };
for (const dir of ["t3/userdata", "data", "config", "projects/my-project"]) {
  fs.mkdirSync(path.join(root, dir), { recursive: true, mode: 0o700 });
}
fs.mkdirSync(process.env.XDG_CACHE_HOME || "/tmp/t3-cache", { recursive: true, mode: 0o700 });
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
let catalogModels = [];
const catalogFile = path.join(root, "model-catalog-public.json");
try { catalogModels = JSON.parse(fs.readFileSync(catalogFile, "utf8")); } catch {}
const discoveryFile = path.join(root, "catalog-discovery.json");
fs.writeFileSync(discoveryFile, JSON.stringify({ enabled_providers: [
  "opencode", ...(process.env.NVIDIA_API_KEY?.trim() ? ["nvidia"] : []),
] }), { mode: 0o600 });
try {
  const output = execFileSync(process.env.OPENCODE_BINARY || "/opt/t3/node_modules/.bin/opencode", ["api", "--standalone", "model.list"], {
    env: { ...process.env, OPENCODE_CONFIG: discoveryFile },
    encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"], cwd: "/tmp",
  });
  const entries = JSON.parse(output).data;
  // Keep only public model metadata. OpenCode's raw response also contains
  // provider credentials, which must never be logged or saved to the catalog.
  catalogModels = entries.map(({ id, providerID, name, capabilities, limit, status, cost, enabled }) =>
    ({ id, providerID, name, capabilities, limit, status, cost, enabled }));
  const zeroPrices = (cost) => cost.input === 0 && cost.output === 0 &&
    Object.values(cost.cache || {}).every((price) => price === 0);
  const discovered = entries.filter((model) => model.providerID === "opencode" &&
    model.enabled !== false && model.status !== "deprecated" &&
    Array.isArray(model.cost) && model.cost.length > 0 &&
    model.cost.every(zeroPrices),
  ).map((model) => model.id);
  if (!discovered.includes("deepseek-v4.1-flash-free")) throw new Error("Incomplete free model catalog");
  freeModels = [...new Set(discovered)].sort();
  fs.writeFileSync(catalogFile, JSON.stringify(catalogModels) + "\n", { mode: 0o600 });
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
const nvidia = nvidiaConfiguration(root, catalogModels);
config.enabled_providers = [...new Set([
  ...(config.enabled_providers || ["opencode"]).filter((id) => id !== "nvidia"),
  ...(nvidia.enabled ? ["nvidia"] : []),
])];
config.provider ??= {};
config.provider.nvidia = nvidia.provider;
// OpenCode 2 removed the V1 whitelist field. Native model switches enforce
// the same curated list, including excluding embedding and safety-only APIs.
config.providers ??= {};
config.providers.opencode ??= {};
config.providers.opencode.models = Object.fromEntries(
  catalogModels.filter((model) => model.providerID === "opencode")
    .map((model) => [model.id, { disabled: !freeModels.includes(model.id) }]),
);
config.providers.nvidia ??= {};
config.providers.nvidia.models = Object.fromEntries(
  [...new Set([
    ...catalogModels.filter((model) => model.providerID === "nvidia").map((model) => model.id),
    ...Object.keys(nvidia.provider.models),
  ])].map((id) => [id, { disabled: !nvidia.provider.whitelist.includes(id) }]),
);
config.permission = "allow";
const previous = config.provider?.opencode?.whitelist;
if (JSON.stringify(previous) !== JSON.stringify(freeModels)) {
  fs.copyFileSync(configFile, configFile + ".before-free-catalog-update");
  config.provider ??= {};
  config.provider.opencode ??= {};
  config.provider.opencode.whitelist = freeModels;
}
fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
console.log(`OpenCode catalog: ${freeModels.length} models with zero input/output/cache prices.`);
console.log(`NVIDIA NIM: ${nvidia.enabled ? "enabled" : "waiting for NVIDIA_API_KEY"}; ${nvidia.provider.whitelist.length} compatible coding models configured.`);
writeNew("t3/userdata/settings.json", {
  defaultModelSelection: { ...selection, options: [{ id: "variant", value: "high" }] },
  textGenerationModelSelection: { ...selection, options: [{ id: "agent", value: "title" }] },
  defaultRuntimeMode: "full-access",
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
const fullAccessMigration = path.join(root, "full-access-default-v1");
if (!fs.existsSync(fullAccessMigration)) settings.defaultRuntimeMode = "full-access";
if (settings.defaultModelSelection?.model === selection.model &&
    !settings.defaultModelSelection.options?.some((option) => option.id === "variant")) {
  settings.defaultModelSelection.options = [
    ...(settings.defaultModelSelection.options || []), { id: "variant", value: "high" },
  ];
}
// OpenCode's own title agent supports tool-free metadata requests on the free
// endpoint; a build agent with every tool denied is rejected by that endpoint.
if (settings.textGenerationModelSelection?.instanceId === "opencode" &&
    !settings.textGenerationModelSelection.options?.some((option) => option.id === "agent")) {
  settings.textGenerationModelSelection.options = [
    ...(settings.textGenerationModelSelection.options || []), { id: "agent", value: "title" },
  ];
}
settings.providerInstances ??= {};
settings.providerInstances.opencode ??= { driver: "opencode", enabled: true, config: {} };
settings.providerInstances.opencode.config ??= {};
Object.assign(settings.providerInstances.opencode.config, {
  serverUrl: "http://127.0.0.1:4096",
  serverPassword: fs.readFileSync(passwordFile, "utf8").trim(),
});
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
if (!fs.existsSync(fullAccessMigration)) fs.writeFileSync(fullAccessMigration, "enabled by owner request\n", { mode: 0o600, flag: "wx" });
