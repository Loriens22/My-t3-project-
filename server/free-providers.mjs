import https from "node:https";

// These models are listed in Groq's recurring Free Plan, checked 2026-11-05.
// Eligibility is account-plan dependent: keep native prices and key bindings.
const groqFreePlanModels = new Set([
  "qwen/qwen3.8-27b", "openai/gpt-oss-20b", "openai/gpt-oss-120b",
]);
const providers = Object.freeze([
  { id: "groq", key: "GROQ_API_KEY", name: "Groq" },
  { id: "openrouter", key: "OPENROUTER_API_KEY", name: "OpenRouter" },
]);
const modelId = id => typeof id === "string" && id.length <= 200 &&
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*(?::[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/.test(id);
const hasKey = (environment, name) => typeof environment[name] === "string" && Boolean(environment[name].trim());

export function recurringFreeDiscoveryProviders(environment = process.env) {
  return providers.filter(provider => hasKey(environment, provider.key)).map(provider => provider.id);
}

function requestPublicOpenRouterModels() {
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({ proxyEnv: process.env });
    let settled = false;
    let deadline;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      agent.destroy();
      resolve(value);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      agent.destroy();
      reject(new Error("OpenRouter public model catalog unavailable"));
    };
    // https.get does not follow redirects. This public catalog needs no key.
    const request = https.get("https://openrouter.ai/api/v1/models", {
      agent, headers: { accept: "application/json" },
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        finish({ status: response.statusCode });
        return;
      }
      let bytes = 0;
      const chunks = [];
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) {
          request.destroy(new Error("Public model catalog exceeds size limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (settled) return;
        try { finish({ status: 200, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch { fail(); }
      });
      response.on("error", fail);
    });
    deadline = setTimeout(() => request.destroy(new Error("Public catalog deadline")), 10000);
    request.on("error", fail);
  });
}

function zeroPrice(value) {
  if (typeof value === "number") return Number.isFinite(value) && value === 0;
  // Compare the coefficient, not Number(value): a nonzero quoted price such
  // as "1e-9999" underflows to 0 in JavaScript and must remain ineligible.
  return typeof value === "string" && /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:e[+-]?\d+)?$/i.test(value.trim());
}

function freeToolModel(model) {
  const price = model?.pricing;
  return modelId(model?.id) && model.id.endsWith(":free") &&
    Array.isArray(model.supported_parameters) && model.supported_parameters.includes("tools") &&
    price !== null && typeof price === "object" && !Array.isArray(price) &&
    Object.hasOwn(price, "prompt") && Object.hasOwn(price, "completion") &&
    Object.values(price).every(zeroPrice);
}

export async function openRouterFreeCatalog(environment = process.env, fetchModels = requestPublicOpenRouterModels) {
  if (!hasKey(environment, "OPENROUTER_API_KEY")) return { reason: "missing_key", modelIds: [] };
  try {
    const result = await fetchModels();
    if (result?.status !== 200 || !Array.isArray(result.body?.data)) {
      return { reason: "catalog_unavailable", modelIds: [] };
    }
    const modelIds = [...new Set(result.body.data.filter(freeToolModel).map(model => model.id))].sort();
    return { reason: modelIds.length ? "ready" : "catalog_unavailable", modelIds };
  } catch {
    return { reason: "catalog_unavailable", modelIds: [] };
  }
}

export function configureRecurringFreeProviders(config, nativeCatalog, environment = process.env, openRouterCatalog) {
  const managed = new Set(providers.map(provider => provider.id));
  const enabled = new Set((config.enabled_providers || ["opencode"]).filter(id => !managed.has(id)));
  const publicFreeIds = new Set(openRouterCatalog?.reason === "ready" && Array.isArray(openRouterCatalog.modelIds) ?
    openRouterCatalog.modelIds.filter(id => modelId(id) && id.endsWith(":free")) : []);
  config.providers ??= {};
  const status = [];
  for (const provider of providers) {
    const keyPresent = hasKey(environment, provider.key);
    const candidates = nativeCatalog.filter(model => model.providerID === provider.id && modelId(model.id));
    const available = candidates.filter(model => model.enabled !== false && model.status !== "deprecated" &&
      model.capabilities?.tools === true && typeof model.limit?.output === "number" &&
      Number.isFinite(model.limit.output) && model.limit.output > 0 &&
      (provider.id === "groq" ? groqFreePlanModels.has(model.id) : publicFreeIds.has(model.id)));
    const ready = keyPresent && available.length > 0;
    const allowed = new Set(ready ? available.map(model => model.id) : []);
    const providerConfig = config.providers[provider.id] ??= {};
    const previous = providerConfig.models || {};
    // An omitted native model defaults to enabled. Disable every other model,
    // including paid twins and models that have disappeared from the free API.
    providerConfig.models = Object.fromEntries(
      [...new Set([...Object.keys(previous), ...candidates.map(model => model.id)])]
        .map(id => [id, { ...previous[id], disabled: !allowed.has(id) }]),
    );
    if (ready) enabled.add(provider.id);
    status.push({ provider: provider.id, name: provider.name, enabled: ready,
      modelCount: allowed.size, keyVariable: provider.key,
      reason: !keyPresent ? "missing_key" : ready ? "ready" : "catalog_unavailable" });
  }
  config.enabled_providers = [...enabled];
  return status;
}
