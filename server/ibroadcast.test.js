'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solara-ibroadcast-test-'));
process.env.DATA_DIR = tempDir;
const { saveToken, uploadAudio } = require('./ibroadcast');

const audio = Buffer.from('test audio fixture');
const audioMd5 = crypto.createHash('md5').update(audio).digest('hex');

function mockFetch({ duplicate = false } = {}) {
  const calls = [];
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/track.mp3')) {
      return new Response(audio, { headers: { 'Content-Type': 'audio/mpeg' } });
    }
    if (url === 'https://api.ibroadcast.com/s/JSON/') {
      const request = JSON.parse(init.body);
      assert.equal(request.mode, 'status');
      assert.equal(request.supported_types, 1);
      return Response.json({ user: {}, supported: [{ extension: '.mp3' }] });
    }
    if (url === 'https://upload.ibroadcast.com' && !init.body) {
      return Response.json({ md5: duplicate ? [audioMd5] : [] });
    }
    if (url === 'https://upload.ibroadcast.com') {
      const multipart = await new Response(init.body).text();
      assert.match(multipart, /name="file_path"\r\n\r\nArtist - Track\.mp3/);
      assert.match(multipart, /name="method"\r\n\r\npython 3 uploader script/);
      assert.match(multipart, /name="file"; filename="Artist - Track\.mp3"/);
      assert.match(multipart, /test audio fixture/);
      return Response.json({ result: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  return calls;
}

test('uploads supported audio with reference-compatible metadata and multipart fields', async (t) => {
  saveToken({ access_token: 'test-token', token_type: 'Bearer', expires_at: Date.now() / 1000 + 3600 });
  const calls = mockFetch();

  const result = await uploadAudio({
    url: 'https://8.8.8.8/track.mp3',
    name: 'Track',
    artist: 'Artist',
    album: 'Album',
  });

  assert.deepEqual(result, { uploaded: true });
  assert.equal(calls.filter(call => call.url === 'https://upload.ibroadcast.com').length, 2);
});

test('skips files whose MD5 is already in the iBroadcast library', async () => {
  const calls = mockFetch({ duplicate: true });
  const result = await uploadAudio({
    url: 'https://8.8.8.8/track.mp3',
    name: 'Track',
    artist: 'Artist',
  });

  assert.deepEqual(result, { uploaded: false, duplicate: true });
  assert.equal(calls.filter(call => call.url === 'https://upload.ibroadcast.com').length, 1);
});

const originalFetch = global.fetch;

test.beforeEach(() => {
  saveToken({ access_token: 'test-token', token_type: 'Bearer', expires_at: Date.now() / 1000 + 3600 });
});

test.after(() => {
  global.fetch = originalFetch;
  fs.rmSync(tempDir, { recursive: true, force: true });
});
