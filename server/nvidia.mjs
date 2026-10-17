import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function nvidiaConfiguration(root) {
  const bundled = JSON.parse(fs.readFileSync(new URL("./nvidia-models.json", import.meta.url), "utf8"));
  const enabled = Boolean(process.env.NVIDIA_API_KEY?.trim());
  let models = bundled;
  if (enabled) {
    try {
      const catalog = JSON.parse(fs.readFileSync(path.join(root, "cache/opencode/models.json"), "utf8"));
      const live = JSON.parse(execFileSync("curl", ["--fail", "--silent", "--show-error", "--max-time", "15", "https://integrate.api.nvidia.com/v1/models"], {
        encoding: "utf8", maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
      }));
      const available = new Set(live.data.map((model) => model.id));
      const candidates = Object.entries(catalog.nvidia.models).filter(([id, model]) =>
        available.has(id) && model.tool_call && model.limit?.output > 0,
      );
      if (candidates.length === 0) throw new Error("Empty NVIDIA coding catalog");
      models = Object.fromEntries(candidates.map(([id, model]) => [id,
        Object.fromEntries(["name", "limit", "modalities", "reasoning", "attachment", "tool_call", "temperature"]
          .filter((key) => model[key] !== undefined).map((key) => [key, model[key]])),
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
