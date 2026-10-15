#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/common.sh"
umask 077
mkdir -p "$T3_PHONE_ROOT/tools" "$T3CODE_HOME/userdata" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"

if ! node -e '
  const fs = require("node:fs");
  const root = process.argv[1];
  process.exit(
    JSON.parse(fs.readFileSync(root + "/node_modules/t3/package.json")).version === process.argv[2] &&
    JSON.parse(fs.readFileSync(root + "/node_modules/opencode-ai/package.json")).version === process.argv[3] ? 0 : 1
  );
' "$T3_PHONE_ROOT/tools" "$T3_PHONE_T3_VERSION" "$T3_PHONE_OPENCODE_VERSION" 2>/dev/null; then
  echo "Installing the tested T3 Code and OpenCode versions..."
  npm install --prefix "$T3_PHONE_ROOT/tools" --no-audit --no-fund \
    "t3@$T3_PHONE_T3_VERSION" "opencode-ai@$T3_PHONE_OPENCODE_VERSION"
fi

node - "$T3_PHONE_ROOT" <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const selection = { instanceId: "opencode", model: "opencode/deepseek-v4.1-flash-free" };
const writeNew = (file, value) => {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
};
writeNew(path.join(root, "opencode.json"), {
  $schema: "https://opencode.ai/config.json",
  model: selection.model,
  small_model: selection.model,
  enabled_providers: ["opencode"],
  provider: { opencode: { whitelist: ["deepseek-v4.1-flash-free"] } },
});
writeNew(path.join(root, "t3/userdata/settings.json"), {
  defaultModelSelection: selection,
  textGenerationModelSelection: selection,
  defaultRuntimeMode: "approval-required",
  addProjectBaseDirectory: path.join(root, "projects"),
  providerInstances: {
    opencode: {
      driver: "opencode", enabled: true,
      config: { binaryPath: path.join(root, "tools/node_modules/.bin/opencode") },
    },
    codex: { driver: "codex", enabled: false, config: {} },
    claudeAgent: { driver: "claudeAgent", enabled: false, config: {} },
  },
});
fs.mkdirSync(path.join(root, "projects"), { recursive: true });
JS

echo "T3 Code: $(t3 --version)"
echo "OpenCode: $(opencode --version)"
if ! opencode models opencode | rg -Fx "$T3_PHONE_MODEL" >/dev/null; then
  echo "The free model is not currently available. No paid model was selected."
  exit 1
fi
echo "Installed. Free DeepSeek is available. No OpenCode login or API key is needed."
