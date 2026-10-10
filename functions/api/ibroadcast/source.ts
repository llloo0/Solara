const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const MAX_REDIRECTS = 5;

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) return false;

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split(".").map(Number);
    if (parts.some((part) => part > 255)) return false;
    return !(
      parts[0] === 0 ||
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      parts[0] >= 224
    );
  }

  if (host.includes(":")) {
    return false;
  }
  return true;
}

function parsePublicUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      !isPublicHost(url.hostname)
    ) return null;
    return url;
  } catch {
    return null;
  }
}

async function fetchPublicAudio(rawUrl: string): Promise<Response> {
  let url = parsePublicUrl(rawUrl);
  if (!url) throw new Error("Invalid public audio URL");

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(url, { redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("Location");
    if (!location || redirects === MAX_REDIRECTS) {
      throw new Error("Audio source has too many redirects");
    }
    url = parsePublicUrl(new URL(location, url).toString());
    if (!url) throw new Error("Audio source redirected to an invalid URL");
  }
  throw new Error("Audio source has too many redirects");
}

export async function onRequest(context: {
  request: Request;
  env: {
    DB?: unknown;
    IBROADCAST_CLIENT_ID?: string;
    IBROADCAST_CLIENT_SECRET?: string;
    IBROADCAST_TOKEN_ENCRYPTION_KEY?: string;
  };
}): Promise<Response> {
  const { request, env } = context;
  if (request.method === "HEAD") {
    if (
      !env.DB ||
      !env.IBROADCAST_CLIENT_ID ||
      !env.IBROADCAST_CLIENT_SECRET ||
      !(env.IBROADCAST_TOKEN_ENCRYPTION_KEY || env.IBROADCAST_CLIENT_SECRET)
    ) {
      return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  if (request.method !== "GET") return jsonError("Method not allowed", 405);

  const rawUrl = new URL(request.url).searchParams.get("url") || "";
  if (!parsePublicUrl(rawUrl)) return jsonError("Invalid public audio URL", 400);

  try {
    const upstream = await fetchPublicAudio(rawUrl);
    if (!upstream.ok) return jsonError(`Audio source failed (${upstream.status})`, 502);
    const contentLength = Number(upstream.headers.get("Content-Length") || 0);
    if (contentLength > MAX_AUDIO_BYTES) {
      await upstream.body?.cancel();
      return jsonError("Audio exceeds the 24 MB Pages upload limit", 413);
    }
    if (!upstream.body) return jsonError("Audio source returned an empty body", 502);

    const headers = new Headers({
      "Content-Type": upstream.headers.get("Content-Type") || "audio/mpeg",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    const reader = upstream.body.getReader();
    let total = 0;
    const limitedStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          total += value.byteLength;
          if (total > MAX_AUDIO_BYTES) {
            await reader.cancel();
            controller.error(new Error("Audio exceeds the 24 MB Pages upload limit"));
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return new Response(limitedStream, { status: 200, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to fetch audio source";
    return jsonError(message, message.includes("24 MB") ? 413 : 502);
  }
}

export const __test = { MAX_AUDIO_BYTES, isPublicHost, parsePublicUrl };
