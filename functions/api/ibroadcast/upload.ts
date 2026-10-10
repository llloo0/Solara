import { ibroadcastFetch, type IBroadcastEnv } from "../../lib/ibroadcast-token";

const API_URL = "https://api.ibroadcast.com/s/JSON/";
const UPLOAD_URL = "https://upload.ibroadcast.com";
const CLIENT = "python 3 uploader script";
const VERSION = "0.4";
const USER_AGENT = `${CLIENT} ${VERSION}`;
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function decodedHeader(value: string | null): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function filenamePart(value: string): string {
  return value.replace(/[\\/:*?"<>|\r\n]/g, "_").trim().slice(0, 160);
}

async function readAudio(request: Request): Promise<Uint8Array> {
  if (!request.body) throw new Error("Audio body is missing");
  const reader = request.body.getReader();
  const buffer = new Uint8Array(MAX_AUDIO_BYTES);
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (length + value.length > MAX_AUDIO_BYTES) {
      await reader.cancel();
      throw new Error("Audio exceeds the 24 MB Pages upload limit");
    }
    buffer.set(value, length);
    length += value.length;
  }
  if (!length) throw new Error("Audio body is empty");
  return buffer.subarray(0, length);
}

export async function onRequestPost({ request, env }: { request: Request; env: IBroadcastEnv }): Promise<Response> {
  if (
    !env.DB ||
    !env.IBROADCAST_CLIENT_ID ||
    !env.IBROADCAST_CLIENT_SECRET ||
    !(env.IBROADCAST_TOKEN_ENCRYPTION_KEY || env.IBROADCAST_CLIENT_SECRET)
  ) {
    return json({ error: "Configure iBroadcast client credentials and bind D1 as DB" }, 503);
  }

  const name = decodedHeader(request.headers.get("X-Track-Name"));
  const artist = decodedHeader(request.headers.get("X-Track-Artist"));
  const digest = request.headers.get("X-Content-MD5")?.toLowerCase() || "";
  const contentType = request.headers.get("Content-Type")?.split(";")[0].toLowerCase() || "audio/mpeg";
  if (!name || name.length > 300 || artist.length > 500 || !/^[a-f0-9]{32}$/.test(digest)) {
    return json({ error: "Invalid track metadata or MD5" }, 400);
  }
  if (Number(request.headers.get("Content-Length") || 0) > MAX_AUDIO_BYTES) {
    return json({ error: "Audio exceeds the 24 MB Pages upload limit" }, 413);
  }

  try {
    const audio = await readAudio(request);
    const status = await ibroadcastFetch(env, API_URL, () => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "status",
        supported_types: 1,
        version: VERSION,
        client: CLIENT,
        device_name: "Solara music player",
        user_agent: USER_AGENT,
      }),
    }));
    if (!status.ok) return json({ error: `iBroadcast account check failed (${status.status})` }, 502);
    const account = await status.json() as {
      user?: unknown;
      supported?: Array<{ extension?: string }>;
    };
    if (!account.user || !Array.isArray(account.supported)) {
      return json({ error: "iBroadcast account response is invalid" }, 502);
    }

    const extensionByType: Record<string, string> = {
      "audio/aac": ".aac",
      "audio/flac": ".flac",
      "audio/mp4": ".m4a",
      "audio/mpeg": ".mp3",
      "audio/ogg": ".ogg",
      "audio/opus": ".opus",
      "audio/wav": ".wav",
      "audio/x-flac": ".flac",
      "audio/x-wav": ".wav",
    };
    const extension = extensionByType[contentType] || ".mp3";
    if (!account.supported.some((item) => String(item.extension || "").toLowerCase() === extension)) {
      return json({ error: `iBroadcast does not support ${extension} files` }, 415);
    }

    const lookupResponse = await ibroadcastFetch(env, UPLOAD_URL, () => ({ method: "POST" }));
    if (!lookupResponse.ok) {
      return json({ error: `iBroadcast MD5 lookup failed (${lookupResponse.status})` }, 502);
    }
    const lookup = await lookupResponse.json() as { md5?: string[] };
    if (!Array.isArray(lookup.md5)) return json({ error: "iBroadcast MD5 response is invalid" }, 502);
    if (lookup.md5.includes(digest)) return json({ ok: true, uploaded: false, duplicate: true });

    const filename = `${[artist, name].filter(Boolean).map(filenamePart).join(" - ") || "track"}${extension}`;
    const form = new FormData();
    form.set("file_path", filename);
    form.set("method", CLIENT);
    form.set("file", new Blob([audio], { type: contentType }), filename);
    const upload = await ibroadcastFetch(env, UPLOAD_URL, () => ({
      method: "POST",
      body: new FormData(form),
    }));
    if (!upload.ok) return json({ error: `iBroadcast upload failed (${upload.status})` }, 502);
    const result = await upload.json() as { result?: boolean };
    if (result.result !== true) return json({ error: "iBroadcast rejected the audio" }, 502);
    return json({ ok: true, uploaded: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "iBroadcast upload failed";
    console.error("[iBroadcast Pages upload]", message);
    return json({ error: message }, message.includes("24 MB") ? 413 : 502);
  }
}

export const __test = { MAX_AUDIO_BYTES };
