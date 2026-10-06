import assert from "node:assert/strict";

const baseUrl = process.env.E2E_BASE_URL || "http://127.0.0.1:8787";
const email = `qa-${Date.now()}@example.test`;
const password = "Local-Test-Password-42";

async function request(path, { cookie, ...options } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      connection: "close",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.method && options.method !== "GET" ? { origin: baseUrl } : {}),
      ...(cookie ? { cookie } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

const register = await request("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({ email, password, displayName: "本机测试" }),
});
assert.equal(register.response.status, 201, JSON.stringify(register.payload));
console.error("e2e: registered");
const firstCookie = register.response.headers.get("set-cookie")?.split(";")[0];
assert.ok(firstCookie?.startsWith("jianzhang_session="));

const state = {
  ledgers: [{ id: "life", name: "生活账本", cover: "data:image/png;base64,aGk=" }],
  records: [
    {
      id: "qa-record",
      type: "expense",
      amount: 18.9,
      images: ["data:image/png;base64,aGk="],
    },
  ],
  dayBackgrounds: {},
};
const saved = await request("/api/cloud/state", {
  method: "PUT",
  cookie: firstCookie,
  body: JSON.stringify({ state, baseRevision: 0 }),
});
assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
assert.equal(saved.payload.revision, 1);
assert.match(saved.payload.state.records[0].images[0], /^\/api\/cloud\/file\?key=/);
console.error("e2e: saved state and image");

const logout = await request("/api/auth/logout", {
  method: "POST",
  cookie: firstCookie,
  body: "{}",
});
assert.equal(logout.response.status, 200, JSON.stringify(logout.payload));
console.error("e2e: logged out");

const anonymous = await request("/api/cloud/account");
assert.equal(anonymous.response.status, 401);
assert.equal(anonymous.payload.code, "AUTH_REQUIRED");
console.error("e2e: anonymous access rejected");

const login = await request("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({ email, password }),
});
assert.equal(login.response.status, 200, JSON.stringify(login.payload));
const secondCookie = login.response.headers.get("set-cookie")?.split(";")[0];
assert.ok(secondCookie?.startsWith("jianzhang_session="));
console.error("e2e: logged back in");

const restored = await request("/api/cloud/account", { cookie: secondCookie });
assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
assert.equal(restored.payload.revision, 1);
assert.equal(restored.payload.state.records[0].amount, 18.9);

console.log(
  JSON.stringify({
    registered: true,
    savedRevision: saved.payload.revision,
    imageExternalized: true,
    loggedOutUnauthorized: anonymous.response.status,
    loggedBackIn: true,
    persistedRevision: restored.payload.revision,
    persistedAmount: restored.payload.state.records[0].amount,
  }),
);
