// Service worker for the Skill Sources extension.
// Handles long-running auth polling so the popup can close without losing state.

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

// Listen for messages from the popup.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));

  // Return true to indicate we will respond asynchronously.
  return true;
});

async function handleMessage(msg) {
  switch (msg.type) {
    // ------------------------------------------------------------------
    // AUTH: kick off the device flow and begin background polling
    // ------------------------------------------------------------------
    case 'START_AUTH': {
      const { clientId } = msg;
      if (!clientId) throw new Error('Client ID is required');

      const flow = await startDeviceFlow(clientId);

      // Start polling in the background — the popup reads the result
      // from chrome.storage when it reopens.
      pollInBackground(clientId, flow.device_code, flow.interval || 5);

      return {
        userCode: flow.user_code,
        verificationUri: flow.verification_uri,
      };
    }

    case 'CHECK_AUTH':
      return { authenticated: await isAuthenticated() };

    case 'LOGOUT':
      await clearToken();
      return { ok: true };

    case 'GET_USERNAME':
      return { username: await getUsername() };

    default:
      throw new Error(`Unknown message type: ${msg.type}`);
  }
}

// ------------------------------------------------------------------
// Background poll loop — survives popup close
// ------------------------------------------------------------------

async function pollInBackground(clientId, deviceCode, interval) {
  const maxAttempts = 120; // ~10 min with 5s interval

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(interval * 1000);

    try {
      const token = await pollForToken(clientId, deviceCode, interval);
      if (token) {
        await storeToken(token);
        // Notify any open popup that auth succeeded
        chrome.runtime.sendMessage({ type: 'AUTH_SUCCESS' }).catch(() => {
          // Popup might not be open — that's fine.
        });
        return;
      }
    } catch (err) {
      // Fatal errors (expired, denied) — stop polling
      chrome.runtime.sendMessage({ type: 'AUTH_ERROR', error: err.message }).catch(() => {});
      return;
    }
  }

  chrome.runtime.sendMessage({ type: 'AUTH_ERROR', error: 'Authorisation timed out' }).catch(() => {});
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
