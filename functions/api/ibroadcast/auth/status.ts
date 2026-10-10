import type { IBroadcastEnv } from "../../../lib/ibroadcast-token";
import { authConfigError, jsonResponse } from "../../../lib/ibroadcast-auth";
import { hasEncryptedValue } from "../../../lib/ibroadcast-token";

export async function onRequestGet({ env }: { env: IBroadcastEnv }): Promise<Response> {
  const configError = authConfigError(env);
  if (configError) return jsonResponse({ configured: false, authorized: false, error: configError });
  try {
    return jsonResponse({
      configured: true,
      authorized: await hasEncryptedValue(env, "token"),
    });
  } catch {
    return jsonResponse({ configured: false, authorized: false, error: "读取 D1 授权状态失败" }, 503);
  }
}
