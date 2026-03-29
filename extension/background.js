// Minimal service worker — handles OAuth flow which must survive popup close.

const GITHUB_APP_CLIENT_ID = 'Iv23liXEvwmMIjlGO2OM';
const GITHUB_APP_CLIENT_SECRET = '5b84edac02577a99d12aedff9ceed7da0f60710e';
const STORAGE_KEY_TOKEN = 'gh_token';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'LOGIN') {
    handleLogin().then(sendResponse).catch((err) => sendResponse({ error: err.message }));
    return true; // keep channel open for async response
  }
  if (msg.type === 'LOGOUT') {
    chrome.storage.sync.remove([STORAGE_KEY_TOKEN, 'gh_username']).then(() => sendResponse({ ok: true }));
    return true;
  }
});

async function handleLogin() {
  const redirectUrl = `https://${chrome.runtime.id}.chromiumapp.org/`;
  const state = crypto.randomUUID();

  const authUrl = `https://github.com/login/oauth/authorize?` +
    `client_id=${GITHUB_APP_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUrl)}` +
    `&state=${state}`;

  const resultUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl,
    interactive: true,
  });

  const params = new URL(resultUrl).searchParams;
  if (params.get('state') !== state) throw new Error('State mismatch');
  const code = params.get('code');
  if (!code) throw new Error('No authorization code received');

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: GITHUB_APP_CLIENT_ID,
      client_secret: GITHUB_APP_CLIENT_SECRET,
      code,
    }),
  });

  if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
  const data = await tokenRes.json();
  if (data.error) throw new Error(data.error_description || data.error);
  if (!data.access_token) throw new Error('No access token in response');

  await chrome.storage.sync.set({ [STORAGE_KEY_TOKEN]: data.access_token });
  return { ok: true };
}
