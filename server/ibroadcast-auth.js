'use strict';

const { CLIENT_ID, USER_AGENT, saveToken } = require('./ibroadcast');

async function main() {
  const response = await fetch('https://oauth.ibroadcast.com/device/code?' + new URLSearchParams({
    client_id: CLIENT_ID,
    scope: 'user.account:read user.upload',
  }), { headers: { 'User-Agent': USER_AGENT } });
  const device = await response.json();
  if (!response.ok) throw new Error(device.error_description || device.error || 'Could not start device authorization');

  console.log(`Open ${device.verification_uri}`);
  console.log(`Enter code: ${device.user_code}`);
  if (device.verification_uri_complete) console.log(`Or open: ${device.verification_uri_complete}`);

  let intervalMs = Math.max(1000, Number(device.interval || 5) * 1000);
  const expiresAt = Date.now() + Number(device.expires_in || 600) * 1000;
  while (Date.now() < expiresAt) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    const tokenResponse = await fetch('https://oauth.ibroadcast.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: 'device_code',
        device_code: device.device_code,
      }),
    });
    const token = await tokenResponse.json();
    if (tokenResponse.ok) {
      saveToken({ ...token, expires_at: Date.now() / 1000 + token.expires_in });
      console.log('iBroadcast authorization saved.');
      return;
    }
    if (token.error === 'slow_down') {
      intervalMs += 5000;
      continue;
    }
    if (token.error === 'authorization_pending') continue;
    throw new Error(token.error_description || token.error || 'Device authorization failed');
  }
  throw new Error('Device authorization expired; run the command again.');
}

main().catch(error => {
  console.error(`iBroadcast authorization failed: ${error.message}`);
  process.exitCode = 1;
});
