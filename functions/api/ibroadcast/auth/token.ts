import type { IBroadcastEnv, OAuthToken } from "../../../lib/ibroadcast-token";
import {
  authConfigError,
  deviceSessionKey,
  jsonResponse,
  OAUTH_BASE_URL,
  USER_AGENT,
} from "../../../lib/ibroadcast-auth";
import {
  deleteEncryptedValue,
  loadEncryptedValue,
  storeOAuthToken,
  storeEncryptedValue,
} from "../../../lib/ibroadcast-token";

type DeviceSession = {
  device_code: string;
  interval: number;
  expires_at: number;
};

export async function onRequestPost({
  request,
  env,
}: {
  request: Request;
  env: IBroadcastEnv;
}): Promise<Response> {
  const configError = authConfigError(env);
  if (configError) return jsonResponse({ error: configError }, 503);

  const body = await request.json().catch(() => ({})) as { session_id?: unknown };
  const sessionId = typeof body.session_id === "string" ? body.session_id : "";
  if (!/^[A-Za-z0-9_-]{32}$/.test(sessionId)) {
    return jsonResponse({ error: "授权会话无效，请重新开始" }, 400);
  }

  try {
    const key = deviceSessionKey(sessionId);
    const session = await loadEncryptedValue<DeviceSession>(env, key);
    if (!session || session.expires_at <= Date.now()) {
      await deleteEncryptedValue(env, key);
      return jsonResponse({ error: "授权已过期，请重新开始" }, 410);
    }

    const response = await fetch(`${OAUTH_BASE_URL}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({
        client_id: env.IBROADCAST_CLIENT_ID as string,
        grant_type: "device_code",
        device_code: session.device_code,
      }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({})) as {
        error?: string;
        error_description?: string;
      };
      if (result.error === "authorization_pending") {
        return jsonResponse({ pending: true, interval: session.interval });
      }
      if (result.error === "slow_down") {
        session.interval = Math.min(session.interval + 5, 30);
        await storeEncryptedValue(env, key, session);
        return jsonResponse({ pending: true, interval: session.interval });
      }
      if (result.error === "expired_token" || result.error === "access_denied") {
        await deleteEncryptedValue(env, key);
        return jsonResponse({
          error: result.error_description || "授权已过期或被拒绝，请重新开始",
        }, 410);
      }
      return jsonResponse({
        error: result.error_description || result.error || `iBroadcast OAuth failed (${response.status})`,
      }, 502);
    }

    const token = await response.json() as OAuthToken;
    if (!token.access_token || !token.refresh_token) {
      return jsonResponse({ error: "iBroadcast token response is incomplete" }, 502);
    }
    token.expires_at = Date.now() / 1000 + Number(token.expires_in || 3600);
    await storeOAuthToken(env, token);
    await deleteEncryptedValue(env, key);
    return jsonResponse({ authorized: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "iBroadcast authorization failed";
    console.error("[iBroadcast token exchange]", message);
    return jsonResponse({ error: "授权处理失败，请稍后重试" }, 502);
  }
}
