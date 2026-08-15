const LEGACY_DB_NAME = "jianzhang-db";
const LEGACY_DB_VERSION = 1;
const LEGACY_STORE = "app";

let cloudRevision = 0;
let cloudAccount = null;
let cloudUpdatedAt = null;

export class CloudStorageError extends Error {
  constructor(message, code = "CLOUD_ERROR", status = 0) {
    super(message);
    this.name = "CloudStorageError";
    this.code = code;
    this.status = status;
  }
}

export async function loadState() {
  const payload = await request("/api/cloud/account");
  cloudRevision = Number(payload.revision || 0);
  cloudAccount = payload.account || null;
  cloudUpdatedAt = payload.updatedAt || null;
  if (payload.state) return payload.state;

  const legacyState = await loadLegacyState().catch(() => null);
  if (!legacyState) {
    await removeLegacyDatabase().catch(() => {});
    return null;
  }

  const saved = await saveState(legacyState);
  await removeLegacyDatabase().catch(() => {});
  return saved;
}

export async function saveState(state) {
  const payload = await request("/api/cloud/state", {
    method: "PUT",
    body: JSON.stringify({ state, baseRevision: cloudRevision }),
  });
  cloudRevision = Number(payload.revision || cloudRevision + 1);
  cloudUpdatedAt = payload.updatedAt || new Date().toISOString();
  return payload.state || state;
}

export async function exportCloudState() {
  return request("/api/cloud/export");
}

export async function importCloudState(payload) {
  const result = await request("/api/cloud/import", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  cloudRevision = Number(result.revision || 1);
  cloudUpdatedAt = result.updatedAt || new Date().toISOString();
  await removeLegacyDatabase().catch(() => {});
  return result.state;
}

export function getCloudStatus() {
  return {
    account: cloudAccount,
    revision: cloudRevision,
    updatedAt: cloudUpdatedAt,
    storage: "cloud",
  };
}

async function request(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
  } catch {
    throw new CloudStorageError(
      "无法连接云端，请检查网络后重试",
      "NETWORK_ERROR",
      0,
    );
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new CloudStorageError(
      payload?.error || "云端请求失败",
      payload?.code || "CLOUD_ERROR",
      response.status,
    );
  }
  return payload;
}

function openLegacyDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in globalThis)) return resolve(null);
    const request = indexedDB.open(LEGACY_DB_NAME, LEGACY_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(LEGACY_STORE)) {
        database.createObjectStore(LEGACY_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadLegacyState() {
  const database = await openLegacyDatabase();
  if (!database) return null;
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(LEGACY_STORE, "readonly");
      const request = transaction.objectStore(LEGACY_STORE).get("state");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

function removeLegacyDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in globalThis)) return resolve();
    const request = indexedDB.deleteDatabase(LEGACY_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}
