'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const CLIENT_ID = 'de4ce836a9fb11f0bc7fb49691aa2236';
const VERSION = '0.4';
const CLIENT = 'python 3 uploader script';
const DEVICE_NAME = 'Solara music player';
const USER_AGENT = `${CLIENT} ${VERSION}`;
const API_URL = 'https://api.ibroadcast.com/s/JSON/';
const UPLOAD_URL = 'https://upload.ibroadcast.com';
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
let supportedExtensions;

function tokenPath() {
  return process.env.IBROADCAST_TOKEN_FILE ||
    path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'ibroadcast-token.json');
}

function readToken() {
  try {
    return JSON.parse(fs.readFileSync(tokenPath(), 'utf8'));
  } catch {
    return null;
  }
}

function saveToken(token) {
  const filename = tokenPath();
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(token), { mode: 0o600 });
  fs.renameSync(temporary, filename);
  fs.chmodSync(filename, 0o600);
}

async function refreshToken(token) {
  if (!token?.refresh_token) {
    throw new Error('Missing iBroadcast refresh token; run npm run ibroadcast:auth');
  }
  const response = await fetch('https://oauth.ibroadcast.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_description || data.error || `OAuth refresh failed (${response.status})`);
  }
  const refreshed = { ...data, expires_at: Date.now() / 1000 + data.expires_in };
  saveToken(refreshed);
  return refreshed;
}

async function getValidToken() {
  let token = readToken();
  if (!token?.access_token) {
    throw new Error('iBroadcast is not authorized; run npm run ibroadcast:auth');
  }
  if (Number(token.expires_at || 0) <= Date.now() / 1000 + 60) {
    token = await refreshToken(token);
  }
  return token;
}

async function authorizedFetch(url, init = {}) {
  let token = await getValidToken();
  let response = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `${token.token_type || 'Bearer'} ${token.access_token}`,
      'User-Agent': USER_AGENT,
    },
  });
  if (response.status === 401) {
    token = await refreshToken(token);
    response = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `${token.token_type || 'Bearer'} ${token.access_token}`,
        'User-Agent': USER_AGENT,
      },
    });
  }
  return response;
}

async function getSupportedExtensions() {
  if (supportedExtensions) return supportedExtensions;
  const token = await getValidToken();
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `${token.token_type || 'Bearer'} ${token.access_token}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      mode: 'status',
      supported_types: 1,
      version: VERSION,
      client: CLIENT,
      device_name: DEVICE_NAME,
      user_agent: USER_AGENT,
    }),
  });
  if (response.status === 401) {
    const refreshed = await refreshToken(token);
    return getSupportedExtensionsWithToken(refreshed);
  }
  if (!response.ok) throw new Error(`iBroadcast account status failed (${response.status})`);
  const account = await response.json();
  if (!account.user || !Array.isArray(account.supported)) {
    throw new Error('iBroadcast did not return supported audio types');
  }
  supportedExtensions = account.supported
    .map((type) => String(type.extension || '').toLowerCase())
    .filter((extension) => /^\.[a-z0-9]{1,8}$/.test(extension));
  return supportedExtensions;
}

async function getSupportedExtensionsWithToken(token) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `${token.token_type || 'Bearer'} ${token.access_token}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      mode: 'status',
      supported_types: 1,
      version: VERSION,
      client: CLIENT,
      device_name: DEVICE_NAME,
      user_agent: USER_AGENT,
    }),
  });
  if (!response.ok) throw new Error(`iBroadcast account status failed (${response.status})`);
  const account = await response.json();
  if (!account.user || !Array.isArray(account.supported)) {
    throw new Error('iBroadcast did not return supported audio types');
  }
  supportedExtensions = account.supported
    .map((type) => String(type.extension || '').toLowerCase())
    .filter((extension) => /^\.[a-z0-9]{1,8}$/.test(extension));
  return supportedExtensions;
}

function isPrivateAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const octets = address.split('.').map(Number);
    return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) || octets[0] >= 224;
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::' || normalized === '::1' ||
      normalized.startsWith('fc') || normalized.startsWith('fd') ||
      normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb') ||
      normalized.startsWith('::ffff:127.') || normalized.startsWith('::ffff:10.') ||
      normalized.startsWith('::ffff:192.168.');
  }
  return true;
}

async function validateAudioUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid audio URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Audio URL must be public HTTP(S)');
  }
  if (net.isIP(url.hostname)) {
    if (isPrivateAddress(url.hostname)) throw new Error('Private audio hosts are not allowed');
  } else {
    const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new Error('Private audio hosts are not allowed');
    }
  }
  return url;
}

async function fetchAudioResponse(rawUrl) {
  let currentUrl = rawUrl;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const checkedUrl = await validateAudioUrl(currentUrl);
    const response = await fetch(checkedUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(120000),
      redirect: 'manual',
    });
    if (response.status < 300 || response.status >= 400) return { response, checkedUrl };
    const location = response.headers.get('location');
    if (!location || redirects === 5) throw new Error('Audio source redirect limit exceeded');
    currentUrl = new URL(location, checkedUrl).toString();
  }
  throw new Error('Audio source redirect limit exceeded');
}

function makeMultipartStream(fields, filename, filePath, boundary) {
  async function* parts() {
    for (const [name, value] of Object.entries(fields)) {
      yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    }
    yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    yield* Readable.toWeb(fs.createReadStream(filePath));
    yield Buffer.from(`\r\n--${boundary}--\r\n`);
  }
  return Readable.from(parts());
}

async function downloadAudio(url, filePath) {
  const { response, checkedUrl } = await fetchAudioResponse(url);
  if (!response.ok || !response.body) {
    throw new Error(`Audio download failed (${response.status})`);
  }
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_AUDIO_BYTES) throw new Error('Audio file exceeds 100 MB');
  const contentType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  let downloaded = 0;
  const hash = crypto.createHash('md5');
  const source = Readable.fromWeb(response.body);
  source.on('data', (chunk) => {
    downloaded += chunk.length;
    if (downloaded > MAX_AUDIO_BYTES) source.destroy(new Error('Audio file exceeds 100 MB'));
    else hash.update(chunk);
  });
  await pipeline(source, fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 }));
  const extensionByType = {
    'audio/aac': '.aac',
    'audio/flac': '.flac',
    'audio/mp4': '.m4a',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'audio/opus': '.opus',
    'audio/wav': '.wav',
    'audio/x-flac': '.flac',
    'audio/x-wav': '.wav',
  };
  const urlExtension = path.extname(checkedUrl.pathname).toLowerCase();
  return {
    md5: hash.digest('hex'),
    extension: /^\.[a-z0-9]{1,8}$/.test(urlExtension)
      ? urlExtension
      : (extensionByType[contentType] || '.mp3'),
  };
}

async function uploadAudio({ url, name, artist, album, source }) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'solara-ibroadcast-'));
  const filePath = path.join(tempDir, 'audio');
  try {
    const { md5, extension } = await downloadAudio(url, filePath);
    const supported = await getSupportedExtensions();
    if (!supported.includes(extension)) {
      throw new Error(`iBroadcast does not support ${extension} files`);
    }
    const lookup = await authorizedFetch(UPLOAD_URL, { method: 'POST' });
    if (!lookup.ok) throw new Error(`iBroadcast MD5 lookup failed (${lookup.status})`);
    const known = await lookup.json();
    if (!Array.isArray(known.md5)) throw new Error('Invalid iBroadcast MD5 lookup response');
    if (known.md5.includes(md5)) {
      return { uploaded: false, duplicate: true };
    }

    const safePart = (value) => String(value || '').replace(/[\\/:*?"<>|]/g, '_').trim();
    const trackName = [safePart(artist), safePart(name)].filter(Boolean).join(' - ') || 'track';
    const filename = `${trackName}${extension}`;
    const boundary = `----solara${crypto.randomBytes(18).toString('hex')}`;
    const token = await getValidToken();
    const makeUploadRequest = (activeToken) => {
      const body = makeMultipartStream({
        file_path: filename,
        method: CLIENT,
      }, filename, filePath, boundary);
      return fetch(UPLOAD_URL, {
        method: 'POST',
        headers: {
          Authorization: `${activeToken.token_type || 'Bearer'} ${activeToken.access_token}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'User-Agent': USER_AGENT,
        },
        body,
        duplex: 'half',
        signal: AbortSignal.timeout(180000),
      });
    };
    let response = await makeUploadRequest(token);
    if (response.status === 401) {
      response = await makeUploadRequest(await refreshToken(token));
    }
    if (!response.ok) throw new Error(`iBroadcast upload failed (${response.status})`);
    const result = await response.json();
    if (result.result !== true) throw new Error('iBroadcast rejected the audio upload');
    return { uploaded: true };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

module.exports = {
  CLIENT_ID,
  USER_AGENT,
  CLIENT,
  getValidToken,
  readToken,
  saveToken,
  uploadAudio,
};
