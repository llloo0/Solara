'use strict';

const { Router } = require('express');
const { readToken, uploadAudio } = require('../ibroadcast');

const MAX_URL_LENGTH = 8192;

module.exports = function createIBroadcastRouter() {
  const router = Router();

  router.post('/upload', async (req, res) => {
    if (!readToken()?.access_token) {
      return res.json({ ok: true, disabled: true });
    }
    const { url, song } = req.body || {};
    if (typeof url !== 'string' || url.length > MAX_URL_LENGTH ||
        !song || typeof song !== 'object' || Array.isArray(song)) {
      return res.status(400).json({ error: 'Invalid upload request' });
    }

    try {
      const result = await uploadAudio({
        url,
        name: song.name,
        artist: Array.isArray(song.artist) ? song.artist.join(', ') : song.artist,
        album: song.album,
        source: song.source,
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      console.error('[iBroadcast upload]', error.message);
      return res.status(502).json({ error: 'iBroadcast upload failed' });
    }
  });

  return router;
};
