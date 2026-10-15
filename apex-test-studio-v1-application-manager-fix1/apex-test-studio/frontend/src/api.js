async function j(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}
const get = (u) => fetch(u).then(j);
const send = (method, u, body) =>
  fetch(u, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(j);

export const getConfig = () => get("/api/config");
export const getSettings = () => get("/api/settings");
export const saveSettings = (s) => send("PUT", "/api/settings", s);

const scope = (appId) => (appId ? `?application_id=${appId}` : "");

export const listApps = () => get("/api/applications");
export const saveApp = (id, body) => (id ? send("PUT", `/api/applications/${id}`, body) : send("POST", "/api/applications", body));
export const deleteApp = (id) => send("DELETE", `/api/applications/${id}`);
export const testConnection = (base_url) => send("POST", "/api/applications/test", { base_url });

export const uploadExcel = (file, appId) =>
  fetch(`/api/upload?filename=${encodeURIComponent(file.name)}&application_id=${appId}`, { method: "POST", body: file }).then(j);
export const listUploads = (appId) => get(`/api/uploads${scope(appId)}`);
export const getUpload = (id) => get(`/api/uploads/${id}`);

export const listCustom = (appId) => get(`/api/custom${scope(appId)}`);
export const saveCustom = (id, body) => (id ? send("PUT", `/api/custom/${id}`, body) : send("POST", "/api/custom", body));
export const deleteCustom = (id) => send("DELETE", `/api/custom/${id}`);

export const startRun = (payload) => send("POST", "/api/runs", payload);
export const getRun = (id) => get(`/api/runs/${id}`);
export const listRuns = (appId) => get(`/api/runs${scope(appId)}`);
export const deleteRun = (id) => send("DELETE", `/api/runs/${id}`);
export const getAnalytics = (appId) => get(`/api/analytics${scope(appId)}`);
