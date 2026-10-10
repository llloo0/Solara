const USER_AGENT = "python 3 uploader script 0.4";

export type IBroadcastEnv = {
  DB?: D1Database;
  IBROADCAST_CLIENT_ID?: string;
  IBROADCAST_CLIENT_SECRET?: string;
  IBROADCAST_TOKEN_ENCRYPTION_KEY?: string;
};

export type OAuthToken = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_at?: number;
  expires_in?: number;
};

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function encryptionKey(env: IBroadcastEnv): Promise<CryptoKey> {
  const secret = env.IBROADCAST_TOKEN_ENCRYPTION_KEY || env.IBROADCAST_CLIENT_SECRET || "";
  if (secret.length < 32) {
    throw new Error("Configure IBROADCAST_TOKEN_ENCRYPTION_KEY or a 32-character IBROADCAST_CLIENT_SECRET");
  }
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function ensureTable(db: D1Database): Promise<void> {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS ibroadcast_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)"
  ).run();
}

export async function storeEncryptedValue(env: IBroadcastEnv, key: string, payload: unknown): Promise<void> {
  if (!env.DB) throw new Error("D1 binding DB is required");
  await ensureTable(env.DB);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(env),
    new TextEncoder().encode(JSON.stringify(payload))
  ));
  const encryptedValue = `${toBase64(iv)}.${toBase64(encrypted)}`;
  await env.DB.prepare(
    "INSERT INTO ibroadcast_store (key, value, updated_at) VALUES (?1, ?2, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).bind(key, encryptedValue).run();
}

export async function loadEncryptedValue<T>(env: IBroadcastEnv, key: string): Promise<T | null> {
  if (!env.DB) throw new Error("D1 binding DB is required");
  await ensureTable(env.DB);
  const row = await env.DB.prepare(
    "SELECT value FROM ibroadcast_store WHERE key = ?1"
  ).bind(key).first<{ value: string }>();
  if (!row?.value) return null;
  const [iv, ciphertext] = row.value.split(".");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv) },
    await encryptionKey(env),
    fromBase64(ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

export async function hasEncryptedValue(env: IBroadcastEnv, key: string): Promise<boolean> {
  if (!env.DB) throw new Error("D1 binding DB is required");
  await ensureTable(env.DB);
  const row = await env.DB.prepare(
    "SELECT value FROM ibroadcast_store WHERE key = ?1"
  ).bind(key).first<{ value: string }>();
  return Boolean(row?.value);
}

export async function deleteEncryptedValue(env: IBroadcastEnv, key: string): Promise<void> {
  if (!env.DB) throw new Error("D1 binding DB is required");
  await ensureTable(env.DB);
  await env.DB.prepare("DELETE FROM ibroadcast_store WHERE key = ?1").bind(key).run();
}

export async function storeOAuthToken(env: IBroadcastEnv, token: OAuthToken): Promise<void> {
  await storeEncryptedValue(env, "token", token);
}

async function loadToken(env: IBroadcastEnv): Promise<OAuthToken> {
  if (!env.DB) throw new Error("D1 binding DB is required");
  const stored = await loadEncryptedValue<OAuthToken>(env, "token");
  if (stored) return stored;
  throw new Error("iBroadcast is not authorized; visit /ibroadcast-auth.html");
}

export async function getValidIBroadcastToken(env: IBroadcastEnv): Promise<OAuthToken> {
  let token = await loadToken(env);
  if (Number(token.expires_at || 0) <= Date.now() / 1000 + 60) {
    token = await refreshToken(env, token);
  }
  return token;
}

async function refreshToken(env: IBroadcastEnv, token: OAuthToken): Promise<OAuthToken> {
  if (!token.refresh_token) throw new Error("iBroadcast refresh token missing; authorize again");
  const response = await fetch("https://oauth.ibroadcast.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body: new URLSearchParams({
      client_id: env.IBROADCAST_CLIENT_ID || "",
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
    }),
  });
  const result = await response.json() as OAuthToken & { error?: string; error_description?: string };
  if (!response.ok) throw new Error(result.error_description || result.error || "iBroadcast token refresh failed");
  const updated = { ...result, expires_at: Date.now() / 1000 + Number(result.expires_in || 3600) };
  await storeOAuthToken(env, updated);
  return updated;
}

export async function ibroadcastFetch(
  env: IBroadcastEnv,
  url: string,
  makeInit: () => RequestInit
): Promise<Response> {
  let token = await getValidIBroadcastToken(env);
  const send = (activeToken: OAuthToken) => {
    const init = makeInit();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `${activeToken.token_type || "Bearer"} ${activeToken.access_token}`);
    headers.set("User-Agent", USER_AGENT);
    return fetch(url, { ...init, headers });
  };
  let response = await send(token);
  if (response.status === 401) {
    token = await refreshToken(env, token);
    response = await send(token);
  }
  return response;
}
