import https from "node:https";

// OpenCode 2.2.5: packages/schema/src/config/provider.ts. These are native
// model definitions, not the removed V1 provider.models/whitelist format.
const providerID = "modelscope";
const baseURL = "https://api-inference.modelscope.cn/v1";
const packageName = "@opencode/ai/providers/openai-compatible";
const definitions = Object.freeze({
  "deepseek-ai/DeepSeek-V4.1-Flash-1017": { name: "DeepSeek V4.1 Flash 1017", deepseek: true },
  "deepseek-ai/DeepSeek-V4.1-Flash": { name: "DeepSeek V4.1 Flash", deepseek: true },
  "Qwen/Qwen3.8-27B": { name: "Qwen3.8 27B" },
  "Qwen/Qwen3.8-Flash-Next": { name: "Qwen3.8 Flash Next" },
});

function hasKey(environment) {
  return typeof environment.MODELSCOPE_API_KEY === "string" && Boolean(environment.MODELSCOPE_API_KEY.trim());
}

export function modelscopeDiscoveryProviders(environment = process.env) {
  return hasKey(environment) ? [providerID] : [];
}

function requestModelList() {
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({ proxyEnv: process.env });
    let completed = false;
    let deadline;
    const finish = (value, error) => {
      if (completed) return;
      completed = true;
      clearTimeout(deadline);
      agent.destroy();
      if (error) reject(new Error("ModelScope model catalog unavailable"));
      else resolve(value);
    };
    // The public metadata endpoint needs no credential. In particular, never
    // send the owner's key to a discovery redirect or save it in a catalog.
    const request = https.get(`${baseURL}/models`, {
      agent, headers: { accept: "application/json" },
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        finish({ status: response.statusCode });
        return;
      }
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        text += chunk;
        if (text.length > 1024 * 1024) request.destroy(new Error("Catalog too large"));
      });
      response.on("end", () => {
        try { finish({ status: 200, body: JSON.parse(text) }); }
        catch { finish(undefined, true); }
      });
      response.on("error", () => finish(undefined, true));
    });
    deadline = setTimeout(() => request.destroy(new Error("Catalog deadline")), 10000);
    request.on("error", () => finish(undefined, true));
  });
}

export async function modelScopeCatalog(environment = process.env, fetchModels = requestModelList) {
  if (!hasKey(environment)) return { reason: "missing_key", modelIds: [] };
  try {
    const result = await fetchModels();
    if (result.status !== 200 || !Array.isArray(result.body?.data)) {
      return { reason: "catalog_unavailable", modelIds: [] };
    }
    const modelIds = [...new Set(result.body.data
      .map(model => model?.id)
      .filter(id => typeof id === "string" && Object.hasOwn(definitions, id)))];
    return { reason: modelIds.length ? "ready" : "catalog_unavailable", modelIds };
  } catch {
    return { reason: "catalog_unavailable", modelIds: [] };
  }
}

// Seed a discovery document with nativeCatalog=[] before model.list. Its
// native output then validates these exact definitions and supplies metadata
// for the existing shared inference queue. Call again with that output when
// writing the final runtime config; missing/non-tool native entries are denied.
export function configureModelScope(config, nativeCatalog = [], environment = process.env, catalog) {
  const enabled = new Set((config.enabled_providers || ["opencode"]).filter(id => id !== providerID));
  const keyAvailable = hasKey(environment);
  const publicIds = new Set(catalog?.reason === "ready" && Array.isArray(catalog.modelIds)
    ? catalog.modelIds.filter(id => Object.hasOwn(definitions, id)) : []);
  const native = nativeCatalog.filter(model => model.providerID === providerID);
  const discovery = nativeCatalog.length === 0;
  const allowed = new Set(keyAvailable ? [...publicIds].filter(id => discovery || native.some(model =>
    model.id === id && model.enabled !== false && model.status !== "deprecated" &&
    model.capabilities?.tools && model.limit?.output > 0)) : []);
  config.providers ??= {};
  const provider = config.providers[providerID] ??= {};
  Object.assign(provider, { name: "ModelScope", env: ["MODELSCOPE_API_KEY"], package: packageName });
  provider.settings = { ...provider.settings, baseURL, provider: providerID };
  const previous = provider.models || {};
  provider.models = Object.fromEntries(
    [...new Set([...Object.keys(previous), ...native.map(model => model.id), ...Object.keys(definitions)])].map(id => {
      if (!allowed.has(id)) return [id, { ...previous[id], disabled: true }];
      const definition = definitions[id];
      const settings = { ...previous[id]?.settings };
      // A previous deployment's loopback route must never become the next
      // discovery endpoint. The queue overwrites this again after discovery.
      delete settings.baseURL;
      return [id, {
        ...previous[id],
        name: definition.name,
        type: "chat",
        modelID: id,
        package: packageName,
        capabilities: { tools: true, input: ["text", "image"], output: ["text"], temperature: true,
          reasoning: { supported: true } },
        compatibility: { reasoningField: "reasoning_content", maxTokensField: "max_tokens",
          ...(definition.deepseek ? { requireReasoning: true } : {}) },
        // Deliberate operator caps, below the models' published 1M context.
        // Hosted quota/context availability still needs an authenticated check.
        limit: { context: 131072, output: 32768 },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        settings,
        disabled: false,
      }];
    }),
  );
  if (allowed.size) enabled.add(providerID);
  config.enabled_providers = [...enabled];
  return { provider: providerID, name: "ModelScope", enabled: allowed.size > 0, modelCount: allowed.size,
    reason: !keyAvailable ? "missing_key" : allowed.size ? "ready" : "catalog_unavailable",
    keyVariable: "MODELSCOPE_API_KEY" };
}
