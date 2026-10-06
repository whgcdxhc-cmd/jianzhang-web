export interface AuthBindings {
  DB?: D1Database;
}

export type AuthUser = {
  userId: string;
  email: string;
  displayName: string;
};

type UserRow = {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
};

type SessionUserRow = {
  user_id: string;
  email: string;
  display_name: string;
};

type AttemptRow = {
  attempts: number;
  window_started: string;
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const SESSION_COOKIE = "jianzhang_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const PASSWORD_ITERATIONS = 210_000;
const MAX_AUTH_BODY_BYTES = 16 * 1024;
const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function handleAuthApi(
  request: Request,
  env: AuthBindings,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/auth/")) return null;

  try {
    if (request.method !== "GET" && !isSameOriginRequest(request)) {
      return json({ error: "请求来源无效", code: "INVALID_ORIGIN" }, 403);
    }

    if (url.pathname === "/api/auth/session" && request.method === "GET") {
      const user = await authenticatedUser(request, env);
      return json({ authenticated: Boolean(user), account: user ? publicUser(user) : null });
    }

    if (url.pathname === "/api/auth/register" && request.method === "POST") {
      const payload = await readAuthPayload(request);
      const email = normalizeEmail(payload.email);
      const password = validPassword(payload.password);
      const displayName = validDisplayName(payload.displayName, email);
      const rateKey = await rateLimitKey(request, email);
      await enforceRateLimit(env, rateKey);

      const existing = await findUserByEmail(env, email);
      if (existing) {
        await recordFailure(env, rateKey);
        throw new AuthError(409, "ACCOUNT_EXISTS", "该邮箱已经注册，请直接登录");
      }

      const userId = crypto.randomUUID();
      const salt = randomToken(16);
      const passwordHash = await derivePassword(password, salt, PASSWORD_ITERATIONS);
      const now = new Date().toISOString();
      const db = requireDatabase(env);
      try {
        await db
          .prepare(
            "INSERT INTO users (id, email, display_name, password_hash, password_salt, password_iterations, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(userId, email, displayName, passwordHash, salt, PASSWORD_ITERATIONS, now, now)
          .run();
      } catch (error) {
        console.error("Register insert failed", error);
        throw new AuthError(409, "ACCOUNT_EXISTS", "该邮箱已经注册，请直接登录");
      }

      await clearFailures(env, rateKey);
      return createSessionResponse(request, env, { userId, email, displayName }, 201);
    }

    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      const payload = await readAuthPayload(request);
      const email = normalizeEmail(payload.email);
      const password = typeof payload.password === "string" ? payload.password : "";
      const rateKey = await rateLimitKey(request, email);
      await enforceRateLimit(env, rateKey);

      const user = await findUserByEmail(env, email);
      const matches = user
        ? await verifyPassword(password, user)
        : await fakePasswordCheck(password);
      if (!user || !matches) {
        await recordFailure(env, rateKey);
        throw new AuthError(401, "INVALID_CREDENTIALS", "邮箱或密码不正确");
      }

      await clearFailures(env, rateKey);
      return createSessionResponse(
        request,
        env,
        { userId: user.id, email: user.email, displayName: user.display_name },
        200,
      );
    }

    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      const token = readCookie(request, SESSION_COOKIE);
      if (token) {
        await requireDatabase(env)
          .prepare("DELETE FROM sessions WHERE token_hash = ?")
          .bind(await sha256Hex(new TextEncoder().encode(token)))
          .run();
      }
      return json(
        { ok: true },
        200,
        { "set-cookie": sessionCookie("", request, 0) },
      );
    }

    return json({ error: "接口不存在", code: "NOT_FOUND" }, 404);
  } catch (error) {
    console.error("Auth API error", error);
    if (error instanceof AuthError) {
      return json({ error: error.message, code: error.code }, error.status);
    }
    return json({ error: "账号服务暂时不可用，请稍后重试", code: "AUTH_ERROR" }, 500);
  }
}

export async function authenticatedUser(
  request: Request,
  env: AuthBindings,
): Promise<AuthUser | null> {
  const sitesUser = authenticatedSitesUser(request);
  if (sitesUser) return sitesUser;

  const token = readCookie(request, SESSION_COOKIE);
  if (!token || !env.DB) return null;
  const tokenHash = await sha256Hex(new TextEncoder().encode(token));
  const row = await env.DB
    .prepare(
      "SELECT users.id AS user_id, users.email, users.display_name FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ? LIMIT 1",
    )
    .bind(tokenHash, new Date().toISOString())
    .first<SessionUserRow>();
  if (!row) return null;
  return { userId: row.user_id, email: row.email, displayName: row.display_name };
}

function authenticatedSitesUser(request: Request): AuthUser | null {
  const hostname = new URL(request.url).hostname.toLowerCase();
  if (!hostname.endsWith(".chatgpt.site")) return null;
  const userId = request.headers.get("oai-authenticated-user-id")?.trim();
  const email = request.headers.get("oai-authenticated-user-email")?.trim();
  if (!userId || !email) return null;

  const encodedName = request.headers.get("oai-authenticated-user-full-name");
  const encoding = request.headers.get("oai-authenticated-user-full-name-encoding");
  let displayName = email;
  if (encodedName && encoding === "percent-encoded-utf-8") {
    try {
      displayName = decodeURIComponent(encodedName);
    } catch {
      displayName = email;
    }
  }
  return { userId, email, displayName };
}

async function createSessionResponse(
  request: Request,
  env: AuthBindings,
  user: AuthUser,
  status: number,
): Promise<Response> {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(new TextEncoder().encode(token));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_SECONDS * 1000);
  const db = requireDatabase(env);
  await db
    .prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?")
    .bind(user.userId, now.toISOString())
    .run();
  await db
    .prepare(
      "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(tokenHash, user.userId, now.toISOString(), expiresAt.toISOString())
    .run();
  return json(
    { authenticated: true, account: publicUser(user) },
    status,
    { "set-cookie": sessionCookie(token, request, SESSION_SECONDS) },
  );
}

async function findUserByEmail(env: AuthBindings, email: string): Promise<UserRow | null> {
  return requireDatabase(env)
    .prepare(
      "SELECT id, email, display_name, password_hash, password_salt, password_iterations FROM users WHERE email = ? LIMIT 1",
    )
    .bind(email)
    .first<UserRow>();
}

async function verifyPassword(password: string, user: UserRow): Promise<boolean> {
  const candidate = await derivePassword(password, user.password_salt, user.password_iterations);
  return timingSafeEqual(candidate, user.password_hash);
}

async function fakePasswordCheck(password: string): Promise<boolean> {
  await derivePassword(password || "invalid-password", "AAAAAAAAAAAAAAAAAAAAAA", PASSWORD_ITERATIONS);
  return false;
}

async function derivePassword(password: string, salt: string, iterations: number): Promise<string> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: decodeBase64Url(salt),
      iterations,
    },
    material,
    256,
  );
  return encodeBase64Url(new Uint8Array(bits));
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }
  return difference === 0;
}

async function enforceRateLimit(env: AuthBindings, key: string): Promise<void> {
  const row = await requireDatabase(env)
    .prepare("SELECT attempts, window_started FROM auth_attempts WHERE attempt_key = ? LIMIT 1")
    .bind(key)
    .first<AttemptRow>();
  if (!row) return;
  const age = Date.now() - Date.parse(row.window_started);
  if (age >= ATTEMPT_WINDOW_MS) {
    await clearFailures(env, key);
    return;
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    throw new AuthError(429, "TOO_MANY_ATTEMPTS", "尝试次数过多，请 15 分钟后再试");
  }
}

async function recordFailure(env: AuthBindings, key: string): Promise<void> {
  const db = requireDatabase(env);
  const row = await db
    .prepare("SELECT attempts, window_started FROM auth_attempts WHERE attempt_key = ? LIMIT 1")
    .bind(key)
    .first<AttemptRow>();
  const now = new Date().toISOString();
  if (!row || Date.now() - Date.parse(row.window_started) >= ATTEMPT_WINDOW_MS) {
    await db
      .prepare(
        "INSERT INTO auth_attempts (attempt_key, attempts, window_started) VALUES (?, 1, ?) ON CONFLICT(attempt_key) DO UPDATE SET attempts = 1, window_started = excluded.window_started",
      )
      .bind(key, now)
      .run();
    return;
  }
  await db
    .prepare("UPDATE auth_attempts SET attempts = attempts + 1 WHERE attempt_key = ?")
    .bind(key)
    .run();
}

async function clearFailures(env: AuthBindings, key: string): Promise<void> {
  await requireDatabase(env)
    .prepare("DELETE FROM auth_attempts WHERE attempt_key = ?")
    .bind(key)
    .run();
}

async function rateLimitKey(request: Request, email: string): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") || "local";
  return sha256Hex(new TextEncoder().encode(`${ip}\n${email}`));
}

async function readAuthPayload(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_AUTH_BODY_BYTES) {
    throw new AuthError(413, "REQUEST_TOO_LARGE", "请求内容过大");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_AUTH_BODY_BYTES) {
    throw new AuthError(413, "REQUEST_TOO_LARGE", "请求内容过大");
  }
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    // Converted to a stable client error below.
  }
  throw new AuthError(400, "INVALID_JSON", "请求格式无效");
}

function normalizeEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new AuthError(400, "INVALID_EMAIL", "请输入有效邮箱");
  }
  return email;
}

function validPassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 128) {
    throw new AuthError(400, "INVALID_PASSWORD", "密码需要 8–128 个字符");
  }
  return value;
}

function validDisplayName(value: unknown, email: string): string {
  const fallback = email.split("@")[0] || "简账用户";
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length > 40) {
    throw new AuthError(400, "INVALID_NAME", "昵称不能超过 40 个字符");
  }
  return name || fallback;
}

function publicUser(user: AuthUser) {
  return { email: user.email, displayName: user.displayName };
}

function sessionCookie(token: string, request: Request, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function readCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get("cookie") || "";
  for (const part of cookies.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim() || null;
    }
  }
  return null;
}

function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

function randomToken(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256Hex(value: BufferSource): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requireDatabase(env: AuthBindings): D1Database {
  if (!env.DB) {
    throw new AuthError(503, "DATABASE_UNAVAILABLE", "云数据库尚未完成配置");
  }
  return env.DB;
}

function json(
  value: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
