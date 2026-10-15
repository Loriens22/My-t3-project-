import fs from "node:fs";
import path from "node:path";

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
writeNew("opencode.json", {
  $schema: "https://opencode.ai/config.json",
  model: selection.model,
  small_model: selection.model,
  enabled_providers: ["opencode"],
  provider: { opencode: { whitelist: ["deepseek-v4.1-flash-free"] } },
});
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
