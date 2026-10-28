import { createHash } from "node:crypto";

const endpoints = Object.freeze({
  opencode: "https://opencode.ai/inference/openai/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  moonshotai: "https://api.moonshot.ai/v1",
  "kimi-code-plan-global": "https://api.kimi.ai/coding/v1",
});

export function configureInferenceRoutes(config, nativeCatalog) {
  const routes = {};
  for (const model of nativeCatalog) {
    const entry = config.providers?.[model.providerID]?.models?.[model.id];
    if (!entry || entry.disabled) continue;
    const fallback = endpoints[model.providerID];
    if (!fallback) throw new Error("Unrecognized inference provider in the model catalog");
    let base;
    try { base = new URL(model.baseURL || fallback); }
    catch { throw new Error("Unrecognized inference endpoint in the model catalog"); }
    const expected = new URL(fallback);
    if (base.protocol !== "https:" || base.host !== expected.host || base.username || base.password || base.search || base.hash ||
        (["moonshotai", "kimi-code-plan-global"].includes(model.providerID) &&
          base.pathname.replace(/\/$/, "") !== expected.pathname)) {
      // Never include an unexpected URL in diagnostics; it might contain a key.
      throw new Error("Unrecognized inference endpoint in the model catalog");
    }
    const id = createHash("sha256").update(base.href).digest("hex").slice(0, 16);
    routes[id] = base.href;
    entry.settings = { ...entry.settings, baseURL: `http://127.0.0.1:4098/${id}` };
  }
  return routes;
}
