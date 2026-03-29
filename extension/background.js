// Service worker for the Dask extension.
// Handles auth polling using chrome.alarms (survives service worker suspension).

import {
  startDeviceFlow,
  pollForToken,
  storeToken,
  getToken,
  clearToken,
  isAuthenticated,
  getSettings,
  getUsername,
} from './lib/github-api.js';

// Pending auth state — persisted in chrome.storage.session so it survives
// service worker restarts. Keys: clientId, deviceCode, interval, expiresAt.
const AUTH_STATE_KEY = '_auth_pending';
const ALARM_NAME = 'auth-poll';

// ---------------------------------------------------------------------------
// Message handler (popup → service worker)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));
  return true;
});

async function handleMessage(msg) {
  switch (msg.type) {
    case 'START_AUTH': {
      const { clientId } = msg;
      if (!clientId) throw new Error('Client ID is required');

      const flow = await startDeviceFlow(clientId);

      // Persist auth state so polling survives service worker restarts
      const authState = {
        clientId,
        deviceCode: flow.device_code,
        interval: flow.interval || 5,
        expiresAt: Date.now() + (flow.expires_in || 900) * 1000,
      };
      await chrome.storage.session.set({ [AUTH_STATE_KEY]: authState });

      // Start polling via alarms (interval in minutes, minimum 0.5 = 30s)
      // We use a short period and check auth state each time
      await chrome.alarms.create(ALARM_NAME, {
        delayInMinutes: authState.interval / 60,
        periodInMinutes: Math.max(authState.interval / 60, 0.5),
      });

      return {
        userCode: flow.user_code,
        verificationUri: flow.verification_uri,
      };
    }

    case 'START_OAUTH': {
      const { clientId } = msg;
      if (!clientId) throw new Error('Client ID is required');

      // Generate random state for CSRF protection
      const state = crypto.randomUUID();
      await chrome.storage.session.set({ _oauth_state: state, _oauth_client_id: clientId });

      const redirectUrl = chrome.identity.getRedirectURL();
      const authUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUrl)}&scope=repo&state=${state}`;

      const responseUrl = await chrome.identity.launchWebAuthFlow({
        url: authUrl,
        interactive: true,
      });

      // Extract code from the redirect URL
      const url = new URL(responseUrl);
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');

      if (returnedState !== state) throw new Error('OAuth state mismatch');
      if (!code) throw new Error('No authorization code received');

      // Exchange code for token via GitHub (requires a server or proxy)
      // For GitHub OAuth Apps, the code exchange needs client_secret,
      // but for public clients we use the device flow token endpoint with grant_type=authorization_code
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId,
          code,
          redirect_uri: redirectUrl,
        }),
      });

      const tokenData = await tokenRes.json();
      if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);
      if (!tokenData.access_token) throw new Error('No access token received');

      await storeToken(tokenData.access_token);
      notifyPopup('AUTH_SUCCESS');
      return { ok: true };
    }

    case 'CHECK_AUTH':
      return { authenticated: await isAuthenticated() };

    case 'LOGOUT':
      await clearToken();
      await stopPolling();
      return { ok: true };

    case 'GET_USERNAME':
      return { username: await getUsername() };

    default:
      throw new Error(`Unknown message type: ${msg.type}`);
  }
}

// ---------------------------------------------------------------------------
// Alarm-based poll (survives service worker suspension)
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  const data = await chrome.storage.session.get(AUTH_STATE_KEY);
  const authState = data[AUTH_STATE_KEY];

  if (!authState) {
    await stopPolling();
    return;
  }

  // Check if expired
  if (Date.now() > authState.expiresAt) {
    await stopPolling();
    notifyPopup('AUTH_ERROR', 'Authorisation timed out — please try again.');
    return;
  }

  try {
    const token = await pollForToken(authState.clientId, authState.deviceCode, authState.interval);
    if (token) {
      await storeToken(token);
      await stopPolling();
      notifyPopup('AUTH_SUCCESS');
    }
    // null means authorization_pending — alarm fires again automatically
  } catch (err) {
    // Fatal: expired_token, access_denied, etc.
    await stopPolling();
    notifyPopup('AUTH_ERROR', err.message);
  }
});

async function stopPolling() {
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.storage.session.remove(AUTH_STATE_KEY);
}

function notifyPopup(type, error) {
  const msg = error ? { type, error } : { type };
  chrome.runtime.sendMessage(msg).catch(() => {
    // Popup might not be open — that's fine
  });
}
