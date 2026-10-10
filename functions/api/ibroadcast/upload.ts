import {
  getValidIBroadcastToken,
  ibroadcastFetch,
  type IBroadcastEnv,
} from "../../lib/ibroadcast-token";
import { fetchPublicAudio, parsePublicUrl } from "./source";

const API_URL = "https://api.ibroadcast.com/s/JSON/";
const UPLOAD_URL = "https://upload.ibroadcast.com";
const CLIENT = "python 3 uploader script";
const VERSION = "0.4";
const USER_AGENT = `${CLIENT} ${VERSION}`;
const UPLOADED_SONGS_TABLE = "ibroadcast_uploaded_songs";

type UploadBody = {
  url?: unknown;
  songKey?: unknown;
  song?: {
    id?: unknown;
    source?: unknown;
    name?: unknown;
    artist?: unknown;
  };
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function filenamePart(value: string): string {
  return value.replace(/[\\/:*?"<>|\r\n]/g, "_").trim().slice(0, 160);
}

function textPart(name: string, value: string, boundary: string): Uint8Array {
  return new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
  );
}

function multipartAudioStream(
  audio: ReadableStream<Uint8Array>,
  filename: string,
  contentType: string,
  boundary: string
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const parts = [
    textPart("file_path", filename, boundary),
    textPart("method", CLIENT, boundary),
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename.replace(/[^\x20-\x7e]/g, "_")}"\r\nContent-Type: ${contentType}\r\n\r\n`
    ),
  ];
  const reader = audio.getReader();
  let partIndex = 0;
  let suffixSent = false;
  let audioBytes = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (partIndex < parts.length) {
        controller.enqueue(parts[partIndex++]);
        return;
      }
      if (!suffixSent) {
        const next = await reader.read();
        if (!next.done) {
          audioBytes += next.value.byteLength;
          controller.enqueue(next.value);
          return;
        }
        if (!audioBytes) {
          controller.error(new Error("Audio source returned an empty body"));
          reader.releaseLock();
          return;
        }
        suffixSent = true;
        controller.enqueue(encoder.encode(`\r\n--${boundary}--\r\n`));
        return;
      }
      controller.close();
      reader.releaseLock();
    },
    async cancel(reason) {
      await reader.cancel(reason);
      reader.releaseLock();
    },
  });
}

function getExtension(contentType: string, url: URL): string {
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
  const pathExtension = url.pathname.match(/\.[a-z0-9]{1,8}$/i)?.[0].toLowerCase();
  return pathExtension || extensionByType[contentType] || ".mp3";
}

async function ensureUploadedSongsTable(env: IBroadcastEnv): Promise<void> {
  if (!env.DB) throw new Error("D1 binding DB is required");
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ${UPLOADED_SONGS_TABLE} (song_key TEXT PRIMARY KEY, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`
  ).run();
}

async function hasUploadedSong(env: IBroadcastEnv, songKey: string): Promise<boolean> {
  await ensureUploadedSongsTable(env);
  const row = await env.DB!.prepare(
    `SELECT song_key FROM ${UPLOADED_SONGS_TABLE} WHERE song_key = ?1`
  ).bind(songKey).first<{ song_key: string }>();
  return Boolean(row);
}

async function recordUploadedSong(env: IBroadcastEnv, songKey: string): Promise<void> {
  await ensureUploadedSongsTable(env);
  await env.DB!.prepare(
    `INSERT INTO ${UPLOADED_SONGS_TABLE} (song_key) VALUES (?1) ON CONFLICT(song_key) DO UPDATE SET updated_at = datetime('now')`
  ).bind(songKey).run();
}

function multipartField(value: string): string {
  return value.replace(/[\r\n]/g, " ");
}

export async function onRequestPost({
  request,
  env,
}: {
  request: Request;
  env: IBroadcastEnv;
}): Promise<Response> {
  if (
    !env.DB ||
    !env.IBROADCAST_CLIENT_ID ||
    !env.IBROADCAST_CLIENT_SECRET ||
    !(env.IBROADCAST_TOKEN_ENCRYPTION_KEY || env.IBROADCAST_CLIENT_SECRET)
  ) {
    return json({ error: "Configure iBroadcast client credentials and bind D1 as DB" }, 503);
  }

  const body = await request.json().catch(() => null) as UploadBody | null;
  const sourceUrl = typeof body?.url === "string" ? body.url : "";
  const songKey = typeof body?.songKey === "string" ? body.songKey : "";
  const song = body?.song;
  const name = typeof song?.name === "string" ? song.name.trim() : "";
  const artist = typeof song?.artist === "string"
    ? song.artist
    : Array.isArray(song?.artist)
      ? song.artist.filter((item): item is string => typeof item === "string").join(", ")
      : "";
  const sourceValue = song?.source ?? song?.platform;
  const source = typeof sourceValue === "string" && sourceValue.trim()
    ? sourceValue.trim().toLowerCase()
    : "netease";
  const checkedUrl = parsePublicUrl(sourceUrl);

  if (
    !checkedUrl ||
    !name ||
    name.length > 300 ||
    artist.length > 500 ||
    !source ||
    source.length > 100 ||
    !songKey.startsWith(`${source}:`) ||
    songKey.length > 500
  ) {
    return json({ error: "Invalid audio URL or song metadata" }, 400);
  }

  try {
    if (await hasUploadedSong(env, songKey)) {
      return json({ ok: true, uploaded: false, duplicate: true, knownBySolara: true });
    }

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

    const upstream = await fetchPublicAudio(sourceUrl);
    if (!upstream.ok) return json({ error: `Audio source failed (${upstream.status})` }, 502);
    if (!upstream.body) return json({ error: "Audio source returned an empty body" }, 502);
    const contentType = (upstream.headers.get("Content-Type") || "audio/mpeg")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const extension = getExtension(contentType, checkedUrl);
    if (!account.supported.some((item) => String(item.extension || "").toLowerCase() === extension)) {
      await upstream.body.cancel();
      return json({ error: `iBroadcast does not support ${extension} files` }, 415);
    }

    const filename = `${[artist, name].filter(Boolean).map(filenamePart).join(" - ") || "track"}${extension}`;
    const boundary = `----solara${crypto.randomUUID().replace(/-/g, "")}`;
    const token = await getValidIBroadcastToken(env);
    const headers = new Headers({
      Authorization: `${token.token_type || "Bearer"} ${token.access_token}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "User-Agent": USER_AGENT,
    });

    const upload = await fetch(UPLOAD_URL, {
      method: "POST",
      headers,
      body: multipartAudioStream(
        upstream.body,
        multipartField(filename),
        contentType,
        boundary
      ),
    });
    if (upload.status === 401) {
      return json({ error: "iBroadcast authorization expired; reconnect iBroadcast and retry" }, 502);
    }
    if (!upload.ok) return json({ error: `iBroadcast upload failed (${upload.status})` }, 502);
    const result = await upload.json() as { result?: boolean };
    if (result.result !== true) return json({ error: "iBroadcast rejected the audio" }, 502);

    try {
      await recordUploadedSong(env, songKey);
      return json({ ok: true, uploaded: true });
    } catch (error) {
      console.error("[iBroadcast upload record]", error);
      return json({ ok: true, uploaded: true, tracked: false });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "iBroadcast upload failed";
    console.error("[iBroadcast Pages upload]", message);
    return json({ error: "iBroadcast upload failed; check source availability and retry" }, 502);
  }
}

export const __test = {
  filenamePart,
  getExtension,
  multipartAudioStream,
};
