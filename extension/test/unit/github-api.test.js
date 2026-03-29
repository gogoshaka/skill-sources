import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from '../chrome-mock.js';

// We need to freshly import github-api for each test suite so mocks are in place.
// Use a dynamic import helper that busts the module cache.
let api;
let mockState;

async function loadApi() {
  // Node caches ESM imports; append a query string to force re-evaluation
  const mod = await import(`../../lib/github-api.js?t=${Date.now()}_${Math.random()}`);
  return mod;
}

// ---------------------------------------------------------------------------
// Fetch mock helper
// ---------------------------------------------------------------------------

function mockFetch(handler) {
  globalThis.fetch = async (url, opts) => handler(url, opts);
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockState = installChromeMock();
  // Provide a no-op fetch by default
  globalThis.fetch = async () => jsonResponse({});
});

// Load the API module once (it reads globalThis.chrome at call time, not import time)
api = await loadApi();

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

describe('storeToken / getToken', () => {
  it('stores a token and retrieves it', async () => {
    await api.storeToken('ghp_abc123');
    const token = await api.getToken();
    assert.equal(token, 'ghp_abc123');
  });
});

describe('clearToken', () => {
  it('clears token and username', async () => {
    await api.storeToken('ghp_abc123');
    mockState.store['gh_username'] = 'octocat';
    await api.clearToken();
    assert.equal(await api.getToken(), null);
    assert.equal(mockState.store['gh_username'], undefined);
  });
});

describe('isAuthenticated', () => {
  it('returns true when token exists', async () => {
    await api.storeToken('ghp_abc123');
    assert.equal(await api.isAuthenticated(), true);
  });

  it('returns false when no token', async () => {
    assert.equal(await api.isAuthenticated(), false);
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('getSettings', () => {
  it('returns defaults when nothing stored', async () => {
    const s = await api.getSettings();
    assert.equal(s.clientId, '');
    assert.equal(s.repo, 'gogoshaka/dask');
  });

  it('returns stored values', async () => {
    await api.saveSettings({ clientId: 'Iv1.abc', repo: 'user/repo' });
    const s = await api.getSettings();
    assert.equal(s.clientId, 'Iv1.abc');
    assert.equal(s.repo, 'user/repo');
  });
});

describe('saveSettings', () => {
  it('persists clientId and repo', async () => {
    await api.saveSettings({ clientId: 'Iv1.xyz', repo: 'org/repo' });
    assert.equal(mockState.store['gh_client_id'], 'Iv1.xyz');
    assert.equal(mockState.store['gh_repo'], 'org/repo');
  });
});

// ---------------------------------------------------------------------------
// Device Flow
// ---------------------------------------------------------------------------

describe('startDeviceFlow', () => {
  it('sends correct POST to github.com/login/device/code', async () => {
    let capturedUrl, capturedOpts;
    const mockBody = {
      device_code: 'dc_123',
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      interval: 5,
      expires_in: 900,
    };
    mockFetch((url, opts) => {
      capturedUrl = url;
      capturedOpts = opts;
      return jsonResponse(mockBody);
    });

    const result = await api.startDeviceFlow('Iv1.client');
    assert.equal(capturedUrl, 'https://github.com/login/device/code');
    assert.equal(capturedOpts.method, 'POST');
    const body = JSON.parse(capturedOpts.body);
    assert.equal(body.client_id, 'Iv1.client');
    assert.equal(body.scope, 'public_repo');
    assert.deepEqual(result, mockBody);
  });

  it('throws on non-ok response', async () => {
    mockFetch(() => jsonResponse({}, 500));
    await assert.rejects(
      () => api.startDeviceFlow('Iv1.client'),
      { message: /Device flow request failed: 500/ }
    );
  });
});

// ---------------------------------------------------------------------------
// pollForToken
// ---------------------------------------------------------------------------

describe('pollForToken', () => {
  it('returns access_token when present', async () => {
    mockFetch(() => jsonResponse({ access_token: 'gho_token123' }));
    const result = await api.pollForToken('cid', 'dc', 5);
    assert.equal(result, 'gho_token123');
  });

  it('returns null on authorization_pending', async () => {
    mockFetch(() => jsonResponse({ error: 'authorization_pending' }));
    const result = await api.pollForToken('cid', 'dc', 5);
    assert.equal(result, null);
  });

  it('returns null on slow_down', async () => {
    mockFetch(() => jsonResponse({ error: 'slow_down' }));
    const result = await api.pollForToken('cid', 'dc', 5);
    assert.equal(result, null);
  });

  it('throws on expired_token', async () => {
    mockFetch(() => jsonResponse({ error: 'expired_token', error_description: 'Token expired' }));
    await assert.rejects(
      () => api.pollForToken('cid', 'dc', 5),
      { message: /Token expired/ }
    );
  });

  it('throws on access_denied', async () => {
    mockFetch(() => jsonResponse({ error: 'access_denied', error_description: 'User denied' }));
    await assert.rejects(
      () => api.pollForToken('cid', 'dc', 5),
      { message: /User denied/ }
    );
  });
});

// ---------------------------------------------------------------------------
// githubGet / githubPut
// ---------------------------------------------------------------------------

describe('githubGet', () => {
  it('sends correct GET with auth header and returns parsed JSON', async () => {
    let capturedUrl, capturedOpts;
    mockFetch((url, opts) => {
      capturedUrl = url;
      capturedOpts = opts;
      return jsonResponse({ login: 'octocat' });
    });

    const result = await api.githubGet('/user', 'tok_abc');
    assert.equal(capturedUrl, 'https://api.github.com/user');
    assert.equal(capturedOpts.headers['Authorization'], 'Bearer tok_abc');
    assert.equal(capturedOpts.headers['Accept'], 'application/vnd.github.v3+json');
    assert.deepEqual(result, { login: 'octocat' });
  });

  it('throws with status and body on failure', async () => {
    mockFetch(() => ({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
      json: async () => ({}),
    }));

    await assert.rejects(
      () => api.githubGet('/repos/x/y', 'tok'),
      (err) => {
        assert.match(err.message, /404/);
        assert.match(err.message, /Not Found/);
        return true;
      }
    );
  });
});

describe('githubPut', () => {
  it('sends correct PUT with auth header and body', async () => {
    let capturedUrl, capturedOpts;
    mockFetch((url, opts) => {
      capturedUrl = url;
      capturedOpts = opts;
      return jsonResponse({ content: { sha: 'newsha' } });
    });

    const body = { message: 'update', content: 'base64data', sha: 'oldsha' };
    const result = await api.githubPut('/repos/o/r/contents/f.json', body, 'tok_xyz');

    assert.equal(capturedUrl, 'https://api.github.com/repos/o/r/contents/f.json');
    assert.equal(capturedOpts.method, 'PUT');
    assert.equal(capturedOpts.headers['Authorization'], 'Bearer tok_xyz');
    assert.deepEqual(JSON.parse(capturedOpts.body), body);
    assert.deepEqual(result, { content: { sha: 'newsha' } });
  });

  it('throws with status and body on failure', async () => {
    mockFetch(() => ({
      ok: false,
      status: 409,
      text: async () => 'Conflict',
      json: async () => ({}),
    }));

    await assert.rejects(
      () => api.githubPut('/repos/o/r/contents/f.json', {}, 'tok'),
      (err) => {
        assert.match(err.message, /409/);
        assert.match(err.message, /Conflict/);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// getUsername
// ---------------------------------------------------------------------------

describe('getUsername', () => {
  it('returns cached username if available', async () => {
    mockState.store['gh_username'] = 'cached-user';
    const name = await api.getUsername();
    assert.equal(name, 'cached-user');
  });

  it('calls GET /user and caches result when not cached', async () => {
    await api.storeToken('tok_123');
    let fetchCalled = false;
    mockFetch((url) => {
      fetchCalled = true;
      assert.equal(url, 'https://api.github.com/user');
      return jsonResponse({ login: 'fetched-user' });
    });

    const name = await api.getUsername();
    assert.equal(name, 'fetched-user');
    assert.equal(fetchCalled, true);
    // Verify it was cached
    assert.equal(mockState.store['gh_username'], 'fetched-user');
  });

  it('returns null when no token exists', async () => {
    const name = await api.getUsername();
    assert.equal(name, null);
  });
});
