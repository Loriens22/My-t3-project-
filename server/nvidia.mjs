import fs from "node:fs";
import { execFileSync } from "node:child_process";

export function nvidiaConfiguration(root, nativeCatalog = []) {
  const bundled = JSON.parse(fs.readFileSync(new URL("./nvidia-models.json", import.meta.url), "utf8"));
  const hasKey = Boolean(process.env.NVIDIA_API_KEY?.trim());
  const enabled = hasKey && nativeCatalog.some((model) => model.providerID === "nvidia");
  if (hasKey && !enabled) console.warn("NVIDIA catalog unavailable; retaining the key and keeping NVIDIA disabled for this startup.");
  let models = bundled;
  if (enabled) {
    try {
      const live = JSON.parse(execFileSync("curl", ["--fail", "--silent", "--show-error", "--max-time", "15", "https://integrate.api.nvidia.com/v1/models"], {
        encoding: "utf8", maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
      }));
      const available = new Set(live.data.map((model) => model.id));
      const candidates = nativeCatalog.filter((model) => model.providerID === "nvidia" &&
        available.has(model.id) && model.capabilities?.tools && model.limit?.output > 0 &&
        model.status !== "deprecated");
      if (candidates.length === 0) throw new Error("Empty NVIDIA coding catalog");
      models = Object.fromEntries(candidates.map((model) => [model.id,
        { name: model.name, limit: model.limit, tool_call: true },
      ]));
    } catch {
      console.warn("NVIDIA catalog refresh unavailable; using the verified coding model catalog.");
    }
  }
  return {
    enabled,
    provider: {
      name: "NVIDIA NIM", npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "https://integrate.api.nvidia.com/v1", apiKey: "{env:NVIDIA_API_KEY}" },
      whitelist: Object.keys(models), models,
    },
  };
}
