// Service worker for the Skill Sources extension.
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
