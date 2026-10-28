import https from "node:https";

function requestModelList(key) {
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({ proxyEnv: process.env });
    const request = https.get("https://api.moonshot.ai/v1/models", {
      agent, headers: { authorization: `Bearer ${key}`, accept: "application/json" },
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
        if (text.length > 1024 * 1024) request.destroy(new Error("Model catalog too large"));
      });
      response.on("end", () => {
        try { finish({ status: 200, body: JSON.parse(text) }); }
        catch { fail(); }
      });
      response.on("error", fail);
    });
    const deadline = setTimeout(() => request.destroy(new Error("Catalog deadline")), 10000);
    const finish = value => { clearTimeout(deadline); agent.destroy(); resolve(value); };
    const fail = () => { clearTimeout(deadline); agent.destroy(); reject(new Error("Moonshot model catalog unavailable")); };
    request.on("error", fail);
  });
}

export async function moonshotAccountCatalog(environment = process.env, fetchModels = requestModelList) {
  const key = environment.MOONSHOT_API_KEY?.trim();
  if (!key) return { reason: "missing_key", modelIds: [] };
  try {
    const result = await fetchModels(key);
    if (result.status !== 200 || !Array.isArray(result.body?.data)) {
      return { reason: result.status === 401 || result.status === 403 ? "access_rejected" : "catalog_unavailable", modelIds: [] };
    }
    const modelIds = [...new Set(result.body.data.map(model => model.id).filter(id =>
      typeof id === "string" && /^[a-zA-Z0-9._/-]{1,200}$/.test(id)))];
    return { reason: modelIds.length ? "ready" : "catalog_unavailable", modelIds };
  } catch {
    return { reason: "catalog_unavailable", modelIds: [] };
  }
}
