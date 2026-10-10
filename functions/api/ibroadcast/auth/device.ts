import type { IBroadcastEnv } from "../../../lib/ibroadcast-token";
import {
  authConfigError,
  createSessionId,
  deviceSessionKey,
  jsonResponse,
  OAUTH_BASE_URL,
  oauthError,
  USER_AGENT,
} from "../../../lib/ibroadcast-auth";
import { storeEncryptedValue } from "../../../lib/ibroadcast-token";

type DeviceResponse = {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  interval?: number;
  expires_in?: number;
};

export async function onRequestPost({ env }: { env: IBroadcastEnv }): Promise<Response> {
  const configError = authConfigError(env);
  if (configError) return jsonResponse({ error: configError }, 503);

  try {
    const query = new URLSearchParams({
      client_id: env.IBROADCAST_CLIENT_ID as string,
      scope: "user.account:read user.upload",
    });
    const response = await fetch(`${OAUTH_BASE_URL}/device/code?${query}`, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) return jsonResponse({ error: await oauthError(response) }, 502);

    const device = await response.json() as DeviceResponse;
    if (
      !device.device_code ||
      !device.user_code ||
      !device.verification_uri ||
      !Number.isFinite(Number(device.expires_in))
    ) {
      return jsonResponse({ error: "iBroadcast returned an invalid device authorization response" }, 502);
    }

    const sessionId = createSessionId();
    const expiresIn = Math.max(60, Math.min(Number(device.expires_in), 1800));
    await storeEncryptedValue(env, deviceSessionKey(sessionId), {
      device_code: device.device_code,
      interval: Math.max(1, Number(device.interval) || 5),
      expires_at: Date.now() + expiresIn * 1000,
    });

    return jsonResponse({
      session_id: sessionId,
      user_code: device.user_code,
      verification_uri: device.verification_uri,
      verification_uri_complete: device.verification_uri_complete || null,
      interval: Math.max(1, Number(device.interval) || 5),
      expires_in: expiresIn,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start iBroadcast authorization";
    console.error("[iBroadcast device authorization]", message);
    return jsonResponse({ error: "无法启动 iBroadcast 授权，请检查 Pages 配置后重试" }, 502);
  }
}
