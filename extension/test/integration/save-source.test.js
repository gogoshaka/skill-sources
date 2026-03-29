import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from '../chrome-mock.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let api;
let mockState;

async function loadApi() {
  const mod = await import(`../../lib/github-api.js?t=${Date.now()}_${Math.random()}`);
  return mod;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function encode(obj) {
  return Buffer.from(JSON.stringify(obj, null, 2), 'utf-8').toString('base64');
}

function decode(b64) {
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
}

const TOKEN = 'ghp_test_token';
const REPO = 'testowner/testrepo';
const TOPIC_ID = 'python';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockState = installChromeMock();
  globalThis.fetch = async () => jsonResponse({});
});

api = await loadApi();

// ---------------------------------------------------------------------------
// Save source to existing topic
// ---------------------------------------------------------------------------

describe('Save source to existing topic', () => {
  it('appends new source to existing topic file', async () => {
    const existingTopic = {
      version: 'https://jsonfeed.org/version/1.1',
      title: TOPIC_ID,
      description: 'Python resources',
      _tags: ['python'],
      items: [
        { id: 'https://old.example.com', url: 'https://old.example.com', title: 'Old Source', tags: [] },
      ],
    };

    const requests = [];
    globalThis.fetch = async (url, opts) => {
      requests.push({ url, method: opts?.method || 'GET', body: opts?.body });

      // GET — return existing topic file with sha
      if (url.includes('/contents/topics/python.json') && (!opts?.method || opts.method === 'GET')) {
        return jsonResponse({
          content: encode(existingTopic),
          sha: 'abc123sha',
        });
      }

      // PUT — accept the update
      if (url.includes('/contents/topics/python.json') && opts?.method === 'PUT') {
        const putBody = JSON.parse(opts.body);
        return jsonResponse({ content: { sha: 'newsha456' } });
      }

      return jsonResponse({});
    };

    // Store token and settings
    await api.storeToken(TOKEN);
    await api.saveSettings({ clientId: 'cid', repo: REPO });

    const token = await api.getToken();
    const settings = await api.getSettings();
    const [owner, name] = settings.repo.split('/');

    // Step 1: GET existing file
    const path = `/repos/${owner}/${name}/contents/topics/${TOPIC_ID}.json`;
    const file = await api.githubGet(path, token);
    const existing = decode(file.content);

    // Step 2: Append new source
    const newSource = {
      id: 'https://new.example.com',
      url: 'https://new.example.com',
      title: 'New Resource',
      summary: 'Great article',
      tags: ['beginner'],
      date_published: new Date().toISOString(),
      authors: [{ name: 'testuser' }],
      _source_author: '',
      _source_date: '',
      _priority: 'P0',
    };
    existing.items.push(newSource);

    // Step 3: PUT updated file
    const updatedContent = encode(existing);
    await api.githubPut(path, {
      message: `Add source: New Resource`,
      content: updatedContent,
      sha: file.sha,
    }, token);

    // Verify the PUT request
    const putReq = requests.find((r) => r.method === 'PUT');
    assert.ok(putReq, 'PUT request was made');
    const putBody = JSON.parse(putReq.body);
    assert.equal(putBody.sha, 'abc123sha');

    // Verify the content contains both items
    const decoded = decode(putBody.content);
    assert.equal(decoded.items.length, 2);
    assert.equal(decoded.items[0].url, 'https://old.example.com');
    assert.equal(decoded.items[1].url, 'https://new.example.com');
    assert.equal(decoded.items[1].summary, 'Great article');
  });
});

// ---------------------------------------------------------------------------
// Duplicate URL detection
// ---------------------------------------------------------------------------

describe('Save source — duplicate URL detection', () => {
  it('rejects duplicate URLs within the same topic', async () => {
    const existingTopic = {
      version: 'https://jsonfeed.org/version/1.1',
      title: TOPIC_ID,
      items: [{ id: 'https://dup.example.com', url: 'https://dup.example.com', title: 'First', tags: [] }],
    };

    globalThis.fetch = async (url, opts) => {
      if (!opts?.method || opts.method === 'GET') {
        return jsonResponse({ content: encode(existingTopic), sha: 'sha1' });
      }
      if (opts.method === 'PUT') {
        return jsonResponse({ content: { sha: 'sha2' } });
      }
      return jsonResponse({});
    };

    await api.storeToken(TOKEN);
    await api.saveSettings({ clientId: 'cid', repo: REPO });

    const token = await api.getToken();
    const path = `/repos/testowner/testrepo/contents/topics/${TOPIC_ID}.json`;

    const file = await api.githubGet(path, token);
    const existing = decode(file.content);

    // Check for duplicate before adding
    const dupUrl = 'https://dup.example.com';
    const isDuplicate = existing.items.some((item) => item.url === dupUrl);

    assert.ok(isDuplicate, 'Duplicate URL is detected');
    assert.equal(existing.items.length, 1, 'No duplicate was added');
  });
});

// ---------------------------------------------------------------------------
// Create new topic then save
// ---------------------------------------------------------------------------

describe('Create new topic then save', () => {
  it('creates topic file then appends a source', async () => {
    const requests = [];

    globalThis.fetch = async (url, opts) => {
      requests.push({ url, method: opts?.method || 'GET', body: opts?.body });

      // PUT for new topic (no sha needed)
      if (url.includes('/contents/topics/new-topic.json') && opts?.method === 'PUT') {
        return jsonResponse({ content: { sha: 'created_sha' } });
      }

      // GET for the newly created topic
      if (url.includes('/contents/topics/new-topic.json') && (!opts?.method || opts.method === 'GET')) {
        const topicData = {
          version: 'https://jsonfeed.org/version/1.1',
          title: 'new-topic',
          description: 'A new topic',
          _tags: [],
          items: [],
        };
        return jsonResponse({ content: encode(topicData), sha: 'created_sha' });
      }

      return jsonResponse({});
    };

    await api.storeToken(TOKEN);
    await api.saveSettings({ clientId: 'cid', repo: REPO });

    const token = await api.getToken();
    const basePath = '/repos/testowner/testrepo/contents/topics/new-topic.json';

    // Step 1: Create the new topic file
    const topicData = {
      version: 'https://jsonfeed.org/version/1.1',
      title: 'new-topic',
      description: 'A new topic',
      language: 'en',
      _tags: ['general'],
      items: [],
    };

    await api.githubPut(basePath, {
      message: 'Add topic: new-topic',
      content: encode(topicData),
    }, token);

    // Step 2: Fetch the newly created topic
    const file = await api.githubGet(basePath, token);
    const existing = decode(file.content);

    // Step 3: Add a source and save
    existing.items.push({
      id: 'https://first-source.com',
      url: 'https://first-source.com',
      title: 'First Source',
      tags: [],
      date_published: new Date().toISOString(),
      authors: [{ name: 'testuser' }],
    });

    await api.githubPut(basePath, {
      message: 'Add source: First Source',
      content: encode(existing),
      sha: file.sha,
    }, token);

    // Verify: one PUT for create, one GET, one PUT for source
    const puts = requests.filter((r) => r.method === 'PUT');
    assert.equal(puts.length, 2);

    // First PUT should have no sha (new file)
    const createBody = JSON.parse(puts[0].body);
    assert.equal(createBody.sha, undefined);

    // Second PUT should have sha from GET
    const updateBody = JSON.parse(puts[1].body);
    assert.equal(updateBody.sha, 'created_sha');

    const finalContent = decode(updateBody.content);
    assert.equal(finalContent.items.length, 1);
    assert.equal(finalContent.items[0].url, 'https://first-source.com');
  });
});

// ---------------------------------------------------------------------------
// Network error
// ---------------------------------------------------------------------------

describe('Save fails on network error', () => {
  it('propagates fetch errors', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };

    await api.storeToken(TOKEN);

    await assert.rejects(
      () => api.githubGet('/repos/o/r/contents/x.json', TOKEN),
      { name: 'TypeError', message: 'Failed to fetch' }
    );
  });
});

// ---------------------------------------------------------------------------
// 409 Conflict
// ---------------------------------------------------------------------------

describe('Save fails on 409 conflict', () => {
  it('throws error with 409 status on sha mismatch', async () => {
    globalThis.fetch = async (url, opts) => {
      if (opts?.method === 'PUT') {
        return {
          ok: false,
          status: 409,
          text: async () => '{"message":"409: SHA does not match"}',
          json: async () => ({ message: '409: SHA does not match' }),
        };
      }
      return jsonResponse({});
    };

    await api.storeToken(TOKEN);

    await assert.rejects(
      () => api.githubPut('/repos/o/r/contents/f.json', {
        message: 'update',
        content: 'base64',
        sha: 'stale_sha',
      }, TOKEN),
      (err) => {
        assert.match(err.message, /409/);
        assert.match(err.message, /SHA/i);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Auth flow end-to-end
// ---------------------------------------------------------------------------

describe('Auth flow end-to-end', () => {
  it('completes device flow with polling retries', async () => {
    let pollCount = 0;

    globalThis.fetch = async (url, opts) => {
      // Device code request
      if (url === 'https://github.com/login/device/code') {
        return jsonResponse({
          device_code: 'dc_test',
          user_code: 'TEST-CODE',
          verification_uri: 'https://github.com/login/device',
          interval: 5,
          expires_in: 900,
        });
      }

      // Token poll
      if (url === 'https://github.com/login/oauth/access_token') {
        pollCount++;
        if (pollCount <= 2) {
          return jsonResponse({ error: 'authorization_pending' });
        }
        return jsonResponse({ access_token: 'gho_final_token' });
      }

      return jsonResponse({});
    };

    // Step 1: Start device flow
    const flow = await api.startDeviceFlow('Iv1.testclient');
    assert.equal(flow.user_code, 'TEST-CODE');
    assert.equal(flow.verification_uri, 'https://github.com/login/device');
    assert.equal(flow.device_code, 'dc_test');

    // Step 2: Poll — first two return pending
    const poll1 = await api.pollForToken('Iv1.testclient', flow.device_code, 5);
    assert.equal(poll1, null);

    const poll2 = await api.pollForToken('Iv1.testclient', flow.device_code, 5);
    assert.equal(poll2, null);

    // Step 3: Third poll returns token
    const poll3 = await api.pollForToken('Iv1.testclient', flow.device_code, 5);
    assert.equal(poll3, 'gho_final_token');

    // Step 4: Store the token
    await api.storeToken(poll3);
    const stored = await api.getToken();
    assert.equal(stored, 'gho_final_token');
    assert.equal(await api.isAuthenticated(), true);
  });
});
