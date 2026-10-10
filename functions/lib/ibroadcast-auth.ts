import type { IBroadcastEnv } from "./ibroadcast-token";

export const OAUTH_BASE_URL = "https://oauth.ibroadcast.com";
export const USER_AGENT = "python 3 uploader script 0.4";

export function authConfigError(env: IBroadcastEnv): string | null {
  if (!env.DB) return "请先绑定 D1 数据库，绑定名称为 DB";
  if (!env.IBROADCAST_CLIENT_ID || !env.IBROADCAST_CLIENT_SECRET) {
    return "请配置 IBROADCAST_CLIENT_ID 和 IBROADCAST_CLIENT_SECRET Pages Secrets";
  }
  if (
    (env.IBROADCAST_TOKEN_ENCRYPTION_KEY || env.IBROADCAST_CLIENT_SECRET).length < 32
  ) {
    return "客户端密钥至少需要 32 个字符，或另设 IBROADCAST_TOKEN_ENCRYPTION_KEY";
  }
  return null;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export function deviceSessionKey(sessionId: string): string {
  return `device:${sessionId}`;
}

export function createSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function oauthError(response: Response): Promise<string> {
  const result = await response.json().catch(() => ({})) as {
    error?: string;
    error_description?: string;
  };
  return result.error_description || result.error || `iBroadcast OAuth failed (${response.status})`;
}
