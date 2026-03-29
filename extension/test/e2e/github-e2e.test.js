// End-to-end test for the Dask extension.
// Exercises the real GitHub API — requires GITHUB_TOKEN env var.
//
// Run:   GITHUB_TOKEN=ghp_... node --test extension/test/e2e/github-e2e.test.js
// Skip:  Automatically skipped if GITHUB_TOKEN is not set.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.SKILL_SOURCES_REPO || 'gogoshaka/dask';
const [OWNER, NAME] = REPO.split('/');
const TEST_TOPIC = `_e2e-test-${Date.now()}`;
const API = 'https://api.github.com';

if (!TOKEN) {
  console.log('⏭️  Skipping E2E tests — set GITHUB_TOKEN to enable');
  process.exit(0);
}

async function githubGet(path) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `Bearer ${TOKEN}`,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

async function githubPut(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'PUT',
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function githubDelete(path, sha) {
  const res = await fetch(`${API}${path}`, {
    method: 'DELETE',
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: `e2e cleanup: delete ${TEST_TOPIC}`,
      sha,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.warn(`Cleanup failed: DELETE ${path} → ${res.status}: ${text}`);
  }
}

function encode(obj) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(obj, null, 2))));
}

function decode(base64) {
  return JSON.parse(decodeURIComponent(escape(atob(base64))));
}

describe('E2E: GitHub API', () => {
  const topicPath = `/repos/${OWNER}/${NAME}/contents/topics/${TEST_TOPIC}.json`;
  let fileSha = null;

  after(async () => {
    // Cleanup: delete the test topic file
    if (fileSha) {
      await githubDelete(topicPath, fileSha);
      console.log(`🧹 Cleaned up test topic: ${TEST_TOPIC}`);
    }
  });

  it('authenticates and reads user info', async () => {
    const user = await githubGet('/user');
    assert.ok(user.login, 'should return a GitHub username');
    console.log(`   Authenticated as: ${user.login}`);
  });

  it('reads _index.json from the repo', async () => {
    const file = await githubGet(`/repos/${OWNER}/${NAME}/contents/_index.json`);
    assert.ok(file.content, 'should have base64 content');
    assert.ok(file.sha, 'should have a sha');

    const index = decode(file.content);
    assert.ok(Array.isArray(index.items), 'should have an items array');
    console.log(`   Index has ${index.items.length} topic(s)`);
  });

  it('creates a new test topic file', async () => {
    const topicData = {
      version: 'https://jsonfeed.org/version/1.1',
      title: TEST_TOPIC,
      description: 'E2E test topic — will be deleted',
      language: 'en',
      _tags: ['e2e-test'],
      items: [],
    };

    const result = await githubPut(topicPath, {
      message: `e2e: create test topic ${TEST_TOPIC}`,
      content: encode(topicData),
    });

    assert.ok(result.content.sha, 'should return a sha');
    fileSha = result.content.sha;
    console.log(`   Created topic: ${TEST_TOPIC}`);
  });

  it('appends a source to the test topic', async () => {
    const file = await githubGet(topicPath);
    const existing = decode(file.content);

    const newSource = {
      id: 'https://example.com/e2e-test-article',
      url: 'https://example.com/e2e-test-article',
      title: 'E2E Test Article',
      summary: 'This source was created by an automated E2E test',
      tags: ['e2e-test'],
      date_published: new Date().toISOString(),
      authors: [{ name: 'e2e-test' }],
      _source_author: 'Test Runner',
      _source_date: '2026-03',
      _priority: 'P2',
    };

    existing.items.push(newSource);

    const result = await githubPut(topicPath, {
      message: `e2e: add test source to ${TEST_TOPIC}`,
      content: encode(existing),
      sha: file.sha,
    });

    fileSha = result.content.sha;

    // Verify by reading back
    const updated = await githubGet(topicPath);
    const parsed = decode(updated.content);

    assert.equal(parsed.items.length, 1, 'should have 1 item');
    assert.equal(parsed.items[0].url, 'https://example.com/e2e-test-article');
    console.log(`   Source appended (${parsed.items.length} total)`);
  });

  it('fails on sha mismatch (409 conflict)', async () => {
    const staleContent = encode({ version: 'https://jsonfeed.org/version/1.1', title: TEST_TOPIC, items: [] });

    const res = await fetch(`${API}${topicPath}`, {
      method: 'PUT',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: 'e2e: should fail with stale sha',
        content: staleContent,
        sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      }),
    });

    assert.equal(res.status, 409, 'should return 409 on sha mismatch');
    console.log(`   Correctly rejected stale sha (409)`);
  });
});
