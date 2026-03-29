// GitHub API helper module for the Dask extension.
// Handles OAuth Device Flow authentication and repo interactions.

const STORAGE_KEY_TOKEN = 'gh_token';
const STORAGE_KEY_CLIENT_ID = 'gh_client_id';
const STORAGE_KEY_REPO = 'gh_repo';
const STORAGE_KEY_USERNAME = 'gh_username';

// ---------------------------------------------------------------------------
// Token storage (chrome.storage.sync so it roams across devices)
// ---------------------------------------------------------------------------

export async function storeToken(token) {
  return chrome.storage.sync.set({ [STORAGE_KEY_TOKEN]: token });
}

export async function getToken() {
  const data = await chrome.storage.sync.get(STORAGE_KEY_TOKEN);
  return data[STORAGE_KEY_TOKEN] || null;
}

export async function clearToken() {
  return chrome.storage.sync.remove([STORAGE_KEY_TOKEN, STORAGE_KEY_USERNAME]);
}

export async function isAuthenticated() {
  const token = await getToken();
  return !!token;
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

export async function getSettings() {
  const data = await chrome.storage.sync.get([STORAGE_KEY_CLIENT_ID, STORAGE_KEY_REPO]);
  return {
    clientId: data[STORAGE_KEY_CLIENT_ID] || '',
    repo: data[STORAGE_KEY_REPO] || 'gogoshaka/dask',
  };
}

export async function saveSettings({ clientId, repo }) {
  return chrome.storage.sync.set({
    [STORAGE_KEY_CLIENT_ID]: clientId,
    [STORAGE_KEY_REPO]: repo,
  });
}

// ---------------------------------------------------------------------------
// GitHub OAuth Device Flow
// Step 1 — Request device & user codes from GitHub.
// Step 2 — User visits verification_uri and enters user_code.
// Step 3 — Extension polls for an access token until the user authorises.
// ---------------------------------------------------------------------------

export async function startDeviceFlow(clientId) {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      scope: 'public_repo',
    }),
  });

  if (!res.ok) {
    throw new Error(`Device flow request failed: ${res.status}`);
  }

  return res.json(); // { device_code, user_code, verification_uri, interval, expires_in }
}

export async function pollForToken(clientId, deviceCode, interval = 5) {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });

  if (!res.ok) {
    throw new Error(`Token poll failed: ${res.status}`);
  }

  const data = await res.json();

  if (data.access_token) {
    return data.access_token;
  }

  // GitHub returns an error field while the user hasn't authorised yet.
  // "authorization_pending" → keep polling
  // "slow_down"            → increase interval (handled by caller)
  // "expired_token"        → give up
  // "access_denied"        → user cancelled
  if (data.error === 'authorization_pending') {
    return null; // caller should retry after interval
  }
  if (data.error === 'slow_down') {
    return null; // caller should increase interval
  }

  throw new Error(data.error_description || data.error || 'Unknown auth error');
}

// ---------------------------------------------------------------------------
// GitHub REST API helpers
// ---------------------------------------------------------------------------

export async function githubGet(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub GET ${path} → ${res.status}: ${body}`);
  }

  return res.json();
}

export async function githubPut(path, body, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'PUT',
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub PUT ${path} → ${res.status}: ${text}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Cached GitHub username (fetched once per token via GET /user)
// ---------------------------------------------------------------------------

export async function getUsername() {
  const data = await chrome.storage.sync.get(STORAGE_KEY_USERNAME);
  if (data[STORAGE_KEY_USERNAME]) return data[STORAGE_KEY_USERNAME];

  const token = await getToken();
  if (!token) return null;

  const user = await githubGet('/user', token);
  await chrome.storage.sync.set({ [STORAGE_KEY_USERNAME]: user.login });
  return user.login;
}
