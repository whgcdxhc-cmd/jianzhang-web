import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceIndexUrl = new URL("../public/index.html", import.meta.url);
const builtIndexUrl = new URL("../dist/client/index.html", import.meta.url);

function assertJianzhangContent(html) {
  assert.match(html, /<title>简账/);
  assert.match(html, /id="authGate"/);
  assert.match(html, /id="authForm"/);
  assert.match(html, /id="authRegisterTab"/);
  assert.match(html, /只保存在你的云端账号中，不写入本机数据库/);
  assert.match(html, /placeholder="例如：这个月餐饮花了多少？"/);
  assert.match(html, /placeholder="例如：昨天晚上和朋友吃饭 68 元"/);
  assert.match(html, /id="importWechat"/);
  assert.match(html, /id="importAlipay"/);
  assert.match(html, /id="fontPreset"/);
  assert.match(html, /id="themePreset"/);
  assert.match(html, /id="ledgerCoverInput"/);
  assert.match(html, /id="budgetCard"/);
  assert.match(html, /id="searchPanel" class="search-panel hidden"/);
  assert.ok(html.indexOf('id="barChart"') < html.indexOf('id="pieChart"'));
  assert.doesNotMatch(html, /\u5218\u5174\u660a/);
}

test("source and built pages use anonymous example copy", async () => {
  const [sourceHtml, builtHtml] = await Promise.all([
    readFile(sourceIndexUrl, "utf8"),
    readFile(builtIndexUrl, "utf8"),
  ]);

  assertJianzhangContent(sourceHtml);
  assertJianzhangContent(builtHtml);
});

test("service worker advances the cloud cache and never caches account data", async () => {
  const [sourceWorker, builtWorker] = await Promise.all([
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../dist/client/sw.js", import.meta.url), "utf8"),
  ]);

  assert.match(sourceWorker, /jianzhang-0\.4\.0-independent-cloud/);
  assert.match(sourceWorker, /\.\/importers\.js/);
  assert.match(sourceWorker, /url\.pathname\.startsWith\("\/api\/cloud\/"\)/);
  assert.match(sourceWorker, /url\.pathname\.startsWith\("\/api\/auth\/"\)/);
  assert.equal(builtWorker, sourceWorker);
});

test("bill importers and cloud-synced font settings are wired into the app", async () => {
  const [app, importers, manifest] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/importers.js", import.meta.url), "utf8"),
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
  ]);
  assert.match(app, /parseWechatExcel,parseAlipayCsv/);
  assert.match(app, /state\.settings=\{/);
  assert.match(importers, /TextDecoder\("gb18030"\)/);
  assert.match(importers, /DecompressionStream\("deflate-raw"\)/);
  const parsedManifest = JSON.parse(manifest);
  assert.equal(parsedManifest.id, "/");
  assert.equal(parsedManifest.start_url, "/");
  assert.equal(parsedManifest.scope, "/");
});

test("storage writes authoritative state only through the cloud API", async () => {
  const storage = await readFile(new URL("../public/storage.js", import.meta.url), "utf8");
  assert.match(storage, /fetch\(url/);
  assert.match(storage, /"\/api\/cloud\/state"/);
  assert.match(storage, /indexedDB\.deleteDatabase\(LEGACY_DB_NAME\)/);
  assert.doesNotMatch(storage, /objectStore\(LEGACY_STORE\)\.put/);
});

test("worker serves the current Jianzhang page at the root", async () => {
  const builtHtml = await readFile(builtIndexUrl, "utf8");
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    {
      ASSETS: {
        fetch: async (request) => {
          const url = new URL(request.url);
          if (url.pathname !== "/index.html") {
            return new Response("Not found", { status: 404 });
          }
          return new Response(builtHtml, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        },
      },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assertJianzhangContent(await response.text());
});

test("cloud API rejects anonymous account reads", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("auth-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/api/cloud/account"),
    {},
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: "请先登录简账云端账号",
    code: "AUTH_REQUIRED",
  });
});

test("independent account registration creates a secure session", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("register-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const db = new AuthMockD1();
  const registerResponse = await worker.fetch(
    new Request("https://jianzhang.example/api/auth/register", {
      method: "POST",
      headers: { origin: "https://jianzhang.example", "content-type": "application/json" },
      body: JSON.stringify({ email: "Owner@Example.com", password: "secure-pass-123", displayName: "小简" }),
    }),
    { DB: db },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(registerResponse.status, 201);
  const cookie = registerResponse.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^jianzhang_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);

  const sessionResponse = await worker.fetch(
    new Request("https://jianzhang.example/api/auth/session", {
      headers: { cookie: cookie.split(";")[0] },
    }),
    { DB: db },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.equal(session.authenticated, true);
  assert.equal(session.account.email, "owner@example.com");
  assert.equal(session.account.displayName, "小简");
});

test("authenticated cloud state round-trips through D1 and R2 compatibility", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("cloud-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const db = new MockD1();
  const files = new MockR2();
  const env = { DB: db, FILES: files };
  const authHeaders = {
    "oai-authenticated-user-id": "test-user",
    "oai-authenticated-user-email": "test@example.com",
  };
  const state = {
    ledgers: [{ id: "life", name: "生活账本", cover: "data:image/png;base64,aGk=" }],
    records: [{ id: "r1", images: ["data:image/png;base64,aGk="] }],
    dayBackgrounds: {},
  };

  const saveResponse = await worker.fetch(
    new Request("https://jianzhang-test.chatgpt.site/api/cloud/state", {
      method: "PUT",
      headers: {
        ...authHeaders,
        origin: "https://jianzhang-test.chatgpt.site",
        "content-type": "application/json",
      },
      body: JSON.stringify({ state, baseRevision: 0 }),
    }),
    env,
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(saveResponse.status, 200);
  const saved = await saveResponse.json();
  assert.equal(saved.revision, 1);
  assert.match(saved.state.records[0].images[0], /^\/api\/cloud\/file\?key=/);
  assert.match(saved.state.ledgers[0].cover, /^\/api\/cloud\/file\?key=/);
  assert.equal(files.objects.size, 1);

  const accountResponse = await worker.fetch(
    new Request("https://jianzhang-test.chatgpt.site/api/cloud/account", { headers: authHeaders }),
    env,
    { waitUntil() {}, passThroughOnException() {} },
  );
  const account = await accountResponse.json();
  assert.equal(account.revision, 1);
  assert.equal(account.account.email, "test@example.com");

  const exportResponse = await worker.fetch(
    new Request("https://jianzhang-test.chatgpt.site/api/cloud/export", { headers: authHeaders }),
    env,
    { waitUntil() {}, passThroughOnException() {} },
  );
  const backup = await exportResponse.json();
  assert.equal(backup.format, "jianzhang-cloud-backup");
  assert.equal(backup.state.records[0].images[0], "data:image/png;base64,aGk=");
  assert.equal(backup.state.ledgers[0].cover, "data:image/png;base64,aGk=");
});

test("cloud images use KV when R2 is not enabled", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("kv-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const db = new MockD1();
  const media = new MockKV();
  const env = { DB: db, MEDIA: media };
  const authHeaders = {
    "oai-authenticated-user-id": "kv-user",
    "oai-authenticated-user-email": "kv@example.com",
  };
  const saveResponse = await worker.fetch(
    new Request("https://jianzhang-test.chatgpt.site/api/cloud/state", {
      method: "PUT",
      headers: {
        ...authHeaders,
        origin: "https://jianzhang-test.chatgpt.site",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        state: {
          ledgers: [{ id: "life", name: "生活账本" }],
          records: [{ id: "kv-record", images: ["data:image/png;base64,aGk="] }],
          dayBackgrounds: {},
        },
        baseRevision: 0,
      }),
    }),
    env,
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(saveResponse.status, 200);
  const saved = await saveResponse.json();
  assert.match(saved.state.records[0].images[0], /^\/api\/cloud\/file\?key=/);
  assert.equal(media.objects.size, 1);

  const fileResponse = await worker.fetch(
    new Request(`https://jianzhang-test.chatgpt.site${saved.state.records[0].images[0]}`, {
      headers: authHeaders,
    }),
    env,
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(fileResponse.status, 200);
  assert.equal(fileResponse.headers.get("content-type"), "image/png");
  assert.equal(await fileResponse.text(), "hi");
});

class MockD1 {
  row = null;

  prepare(sql) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const database = this;
    return {
      values: [],
      bind(...values) {
        this.values = values;
        return this;
      },
      async first() {
        return database.row;
      },
      async run() {
        if (sql.startsWith("INSERT OR IGNORE")) {
          if (database.row) return { meta: { changes: 0 } };
          const [userId, email, stateJson, createdAt, updatedAt] = this.values;
          database.userId = userId;
          database.row = {
            email,
            state_json: stateJson,
            revision: 1,
            created_at: createdAt,
            updated_at: updatedAt,
          };
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("UPDATE cloud_states")) {
          const [email, stateJson, updatedAt, userId, revision] = this.values;
          if (!database.row || database.userId !== userId || database.row.revision !== revision) {
            return { meta: { changes: 0 } };
          }
          database.row = {
            ...database.row,
            email,
            state_json: stateJson,
            revision: revision + 1,
            updated_at: updatedAt,
          };
          return { meta: { changes: 1 } };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
  }
}

class MockR2 {
  objects = new Map();

  async head(key) {
    return this.objects.has(key) ? {} : null;
  }

  async put(key, value, options) {
    const bytes = new Uint8Array(value);
    this.objects.set(key, {
      bytes,
      contentType: options?.httpMetadata?.contentType || "application/octet-stream",
    });
  }

  async get(key) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      body: stored.bytes,
      httpMetadata: { contentType: stored.contentType },
      arrayBuffer: async () =>
        stored.bytes.buffer.slice(
          stored.bytes.byteOffset,
          stored.bytes.byteOffset + stored.bytes.byteLength,
        ),
    };
  }
}

class MockKV {
  objects = new Map();

  async put(key, value, options) {
    const bytes = new Uint8Array(value);
    this.objects.set(key, {
      bytes,
      metadata: options?.metadata || null,
    });
  }

  async getWithMetadata(key) {
    const stored = this.objects.get(key);
    if (!stored) return { value: null, metadata: null };
    return {
      value: stored.bytes.buffer.slice(
        stored.bytes.byteOffset,
        stored.bytes.byteOffset + stored.bytes.byteLength,
      ),
      metadata: stored.metadata,
    };
  }
}

class AuthMockD1 {
  usersByEmail = new Map();
  usersById = new Map();
  sessions = new Map();
  attempts = new Map();

  prepare(sql) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const database = this;
    return {
      values: [],
      bind(...values) {
        this.values = values;
        return this;
      },
      async first() {
        if (sql.startsWith("SELECT id, email, display_name")) {
          return database.usersByEmail.get(this.values[0]) || null;
        }
        if (sql.startsWith("SELECT users.id AS user_id")) {
          const session = database.sessions.get(this.values[0]);
          if (!session || session.expires_at <= this.values[1]) return null;
          const user = database.usersById.get(session.user_id);
          return user ? { user_id: user.id, email: user.email, display_name: user.display_name } : null;
        }
        if (sql.startsWith("SELECT attempts")) {
          return database.attempts.get(this.values[0]) || null;
        }
        throw new Error(`Unexpected first SQL: ${sql}`);
      },
      async run() {
        if (sql.startsWith("INSERT INTO users")) {
          const [id, email, displayName, passwordHash, passwordSalt, passwordIterations, createdAt, updatedAt] = this.values;
          if (database.usersByEmail.has(email)) throw new Error("UNIQUE constraint failed");
          const user = { id, email, display_name: displayName, password_hash: passwordHash, password_salt: passwordSalt, password_iterations: passwordIterations, created_at: createdAt, updated_at: updatedAt };
          database.usersByEmail.set(email, user);database.usersById.set(id, user);
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("INSERT INTO sessions")) {
          const [tokenHash, userId, createdAt, expiresAt] = this.values;
          database.sessions.set(tokenHash, { user_id: userId, created_at: createdAt, expires_at: expiresAt });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("DELETE FROM sessions WHERE user_id")) return { meta: { changes: 0 } };
        if (sql.startsWith("DELETE FROM sessions WHERE token_hash")) {
          return { meta: { changes: database.sessions.delete(this.values[0]) ? 1 : 0 } };
        }
        if (sql.startsWith("DELETE FROM auth_attempts")) {
          return { meta: { changes: database.attempts.delete(this.values[0]) ? 1 : 0 } };
        }
        if (sql.startsWith("INSERT INTO auth_attempts")) {
          database.attempts.set(this.values[0], { attempts: 1, window_started: this.values[1] });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("UPDATE auth_attempts")) {
          const row = database.attempts.get(this.values[0]);if (row) row.attempts += 1;
          return { meta: { changes: row ? 1 : 0 } };
        }
        throw new Error(`Unexpected run SQL: ${sql}`);
      },
    };
  }
}
