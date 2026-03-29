// Popup script for the Skill Sources extension.
// Manages the two-state UI: login vs. save-source form.

// We can't use ES module imports directly from popup scripts that reference
// the background service worker, so we interact via chrome.runtime messaging
// and duplicate the minimal github-api surface we need here.

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

const headerActions = $('#header-actions');
const settingsPanel = $('#settings-panel');
const loginPanel    = $('#login-panel');
const savePanel     = $('#save-panel');
const loadingEl     = $('#loading');
const errorEl       = $('#error-msg');

// Settings
const settingClientId = $('#setting-client-id');
const settingRepo     = $('#setting-repo');

// Login
const loginClientId    = $('#login-client-id');
const btnOauthLogin    = $('#btn-oauth-login');
const btnDeviceLogin   = $('#btn-device-login');
const deviceCodeInfo   = $('#device-code-info');
const verificationLink = $('#verification-link');
const userCodeEl       = $('#user-code');
const authStatusEl     = $('#auth-status');

// Save form
const fieldUrl     = $('#field-url');
const fieldTitle   = $('#field-title');
const fieldTopic   = $('#field-topic');
const fieldSummary = $('#field-summary');
const btnSave      = $('#btn-save');
const saveResult   = $('#save-result');
const recentPanel   = $('#recent-panel');
const recentList    = $('#recent-list');
const tabBar        = $('#tab-bar');

// New topic
const btnNewTopic    = $('#btn-new-topic');
const newTopicForm   = $('#new-topic-form');
const newTopicId     = $('#new-topic-id');
const newTopicDesc   = $('#new-topic-desc');
const newTopicTags   = $('#new-topic-tags');
const btnCreateTopic = $('#btn-create-topic');
const btnCancelTopic = $('#btn-cancel-topic');

// ---------------------------------------------------------------------------
// Storage helpers (direct chrome.storage access — no background needed)
// ---------------------------------------------------------------------------

const STORAGE_KEY_TOKEN     = 'gh_token';
const STORAGE_KEY_CLIENT_ID = 'gh_client_id';
const STORAGE_KEY_REPO      = 'gh_repo';
const STORAGE_KEY_USERNAME  = 'gh_username';

async function getToken()    { return (await chrome.storage.sync.get(STORAGE_KEY_TOKEN))[STORAGE_KEY_TOKEN] || null; }
async function getSettings() {
  const d = await chrome.storage.sync.get([STORAGE_KEY_CLIENT_ID, STORAGE_KEY_REPO]);
  return {
    clientId: d[STORAGE_KEY_CLIENT_ID] || '',
    repo:     d[STORAGE_KEY_REPO]      || 'gogoshaka/skill-sources',
  };
}
async function saveSettingsToStorage(clientId, repo) {
  return chrome.storage.sync.set({ [STORAGE_KEY_CLIENT_ID]: clientId, [STORAGE_KEY_REPO]: repo });
}
async function getUsername() {
  return (await chrome.storage.sync.get(STORAGE_KEY_USERNAME))[STORAGE_KEY_USERNAME] || null;
}

// ---------------------------------------------------------------------------
// GitHub REST helpers (used directly from popup for fetch operations)
// ---------------------------------------------------------------------------

async function githubGet(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { 'Accept': 'application/vnd.github.v3+json', 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GitHub GET ${path} → ${res.status}`);
  return res.json();
}

async function githubPut(path, body, token) {
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
// UI helpers
// ---------------------------------------------------------------------------

function show(el)  { el.classList.remove('hidden'); }
function hide(el)  { el.classList.add('hidden'); }

function showError(msg) {
  errorEl.textContent = msg;
  show(errorEl);
}
function hideError() { hide(errorEl); }

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

tabBar.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;

  const targetId = btn.dataset.tab;
  tabBar.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  btn.classList.add('active');

  // Toggle panels
  [savePanel, recentPanel].forEach((p) => hide(p));
  const target = document.getElementById(targetId);
  if (target) show(target);
});

// ---------------------------------------------------------------------------
// Init: decide which panel to show
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  hideError();
  const token = await getToken();
  const settings = await getSettings();

  if (token) {
    await showSavePanel(token, settings);
  } else {
    showLoginPanel(settings);
  }
});

// Listen for auth success from the background service worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'AUTH_SUCCESS') {
    // Reload popup to switch to save panel
    location.reload();
  }
  if (msg.type === 'AUTH_ERROR') {
    authStatusEl.textContent = `Error: ${msg.error}`;
    authStatusEl.className = 'error';
  }
});

// ---------------------------------------------------------------------------
// Login panel
// ---------------------------------------------------------------------------

function showLoginPanel(settings) {
  hide(headerActions);
  hide(tabBar);
  show(loginPanel);
  hide(savePanel);
  hide(settingsPanel);
  hide(recentPanel);

  loginClientId.value = settings.clientId;

  // Auto-check if auth already completed (user reopened popup after authorizing)
  const authCheckInterval = setInterval(async () => {
    const token = await getToken();
    if (token) {
      clearInterval(authCheckInterval);
      location.reload();
    }
  }, 2000);

  // Standard OAuth web flow login
  btnOauthLogin.addEventListener('click', async () => {
    hideError();
    const clientId = loginClientId.value.trim();
    if (!clientId) { showError('Please enter a GitHub OAuth Client ID.'); return; }

    await saveSettingsToStorage(clientId, settings.repo);

    btnOauthLogin.disabled = true;
    btnOauthLogin.textContent = 'Logging in…';

    try {
      const resp = await chrome.runtime.sendMessage({ type: 'START_OAUTH', clientId });
      if (resp.error) throw new Error(resp.error);
      // OAuth flow opens a browser tab; token will be stored by background.js
      // The auto-check interval above will detect the token and reload
      authStatusEl.textContent = 'Complete the login in the browser tab…';
      authStatusEl.className = 'status';
      show(deviceCodeInfo);
    } catch (err) {
      showError(err.message);
      btnOauthLogin.disabled = false;
      btnOauthLogin.textContent = 'Login with GitHub';
    }
  });

  // Device code flow (fallback for environments without redirect support)
  btnDeviceLogin.addEventListener('click', () => {
    hide(btnOauthLogin.parentElement.querySelector('#btn-oauth-login'));
    hide(btnDeviceLogin);
    showDeviceCodeFlow(settings);
  });
}

function showDeviceCodeFlow(settings) {
  const btnStart = document.createElement('button');
  btnStart.className = 'btn-primary full-width';
  btnStart.textContent = 'Start Device Code Flow';
  btnDeviceLogin.parentElement.appendChild(btnStart);

  btnStart.addEventListener('click', async () => {
    hideError();
    const clientId = loginClientId.value.trim();
    if (!clientId) { showError('Please enter a GitHub OAuth Client ID.'); return; }

    await saveSettingsToStorage(clientId, settings.repo);

    btnStart.disabled = true;
    btnStart.textContent = 'Starting…';

    try {
      const resp = await chrome.runtime.sendMessage({ type: 'START_AUTH', clientId });
      if (resp.error) throw new Error(resp.error);

      userCodeEl.textContent = resp.userCode;
      verificationLink.href = resp.verificationUri;
      verificationLink.textContent = resp.verificationUri;
      show(deviceCodeInfo);
      authStatusEl.textContent = 'Waiting for authorisation…';
      authStatusEl.className = 'status';
    } catch (err) {
      showError(err.message);
      btnStart.disabled = false;
      btnStart.textContent = 'Start Device Code Flow';
    }
  });
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

$('#btn-settings').addEventListener('click', async () => {
  const settings = await getSettings();
  settingClientId.value = settings.clientId;
  settingRepo.value     = settings.repo;
  show(settingsPanel);
  hide(savePanel);
});

$('#btn-save-settings').addEventListener('click', async () => {
  await saveSettingsToStorage(settingClientId.value.trim(), settingRepo.value.trim());
  hide(settingsPanel);
  show(savePanel);
});

$('#btn-cancel-settings').addEventListener('click', () => {
  hide(settingsPanel);
  show(savePanel);
});

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

$('#btn-logout').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'LOGOUT' });
  location.reload();
});

// ---------------------------------------------------------------------------
// Save panel
// ---------------------------------------------------------------------------

// Cached page excerpt extracted via chrome.scripting.executeScript
let pageExcerpt = null;

async function showSavePanel(token, settings) {
  show(headerActions);
  show(tabBar);
  hide(loginPanel);
  show(savePanel);
  hide(settingsPanel);
  hide(recentPanel);

  // Pre-fill URL and title from the active tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      fieldUrl.value   = tab.url  || '';
      fieldTitle.value = tab.title || '';

      // Extract page content for tag generation (activeTab + scripting)
      if (tab.id && tab.url && !tab.url.startsWith('chrome://')) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['lib/content-extractor.js'],
          });
          if (results && results[0] && results[0].result) {
            pageExcerpt = results[0].result;
          }
        } catch { /* some pages block injection — that's fine */ }
      }
    }
  } catch { /* activeTab might not be available yet */ }

  // Ensure we have a cached username (fires GET /user on first call)
  chrome.runtime.sendMessage({ type: 'GET_USERNAME' }).catch(() => {});

  // Load topics from _index.json
  const topicIds = await loadTopics(token, settings.repo);

  // Load recent links in background (non-blocking)
  loadRecentLinks(token, settings.repo, topicIds);
}

async function loadTopics(token, repo) {
  fieldTopic.innerHTML = '<option value="">Loading topics…</option>';

  try {
    const [owner, name] = repo.split('/');
    const data = await githubGet(`/repos/${owner}/${name}/contents/_index.json`, token);
    const index = JSON.parse(atob(data.content));

    fieldTopic.innerHTML = '';
    const items = index.items || [];
    const topicIds = [];

    items.forEach((item) => {
      const id = item.id || item.title;
      topicIds.push(id);
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      fieldTopic.appendChild(opt);
    });

    if (items.length === 0) {
      fieldTopic.innerHTML = '<option value="">No topics found</option>';
    }

    return topicIds;
  } catch (err) {
    fieldTopic.innerHTML = '<option value="">Could not load topics</option>';
    console.warn('Failed to load topics:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Recent links
// ---------------------------------------------------------------------------

function relativeTime(dateStr) {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

async function loadRecentLinks(token, repo, topicIds) {
  if (!topicIds.length) return;

  recentList.innerHTML = '<span class="ai-status loading">Loading…</span>';

  try {
    const [owner, name] = repo.split('/');

    // Fetch all topic files in parallel
    const fetches = topicIds.map(async (id) => {
      try {
        const data = await githubGet(`/repos/${owner}/${name}/contents/topics/${id}.json`, token);
        const topic = JSON.parse(atob(data.content));
        return (topic.items || []).map((item) => ({ ...item, _topic: id }));
      } catch { return []; }
    });

    const results = await Promise.all(fetches);
    const allItems = results.flat();

    // Sort by date_published descending, take latest 8
    allItems.sort((a, b) => new Date(b.date_published) - new Date(a.date_published));
    const recent = allItems.slice(0, 8);

    if (recent.length === 0) {
      recentList.innerHTML = '<span class="ai-status">No links yet</span>';
      return;
    }

    recentList.innerHTML = '';
    recent.forEach((item) => {
      const div = document.createElement('div');
      div.className = 'recent-item';
      const commitSha = item._commit_sha || '';
      const likeHtml = commitSha
        ? `<button class="recent-like" data-sha="${escapeHtml(commitSha)}" data-repo="${owner}/${name}" title="Like">👍 <span class="like-count">…</span></button>`
        : '';
      div.innerHTML = `
        <span class="recent-topic">${escapeHtml(item._topic)}</span>
        <a href="${escapeHtml(item.url)}" target="_blank" title="${escapeHtml(item.title || item.url)}">${escapeHtml(item.title || item.url)}</a>
        ${likeHtml}
        <span class="recent-date">${relativeTime(item.date_published)}</span>
        <button class="recent-delete" data-topic="${escapeHtml(item._topic)}" data-url="${escapeHtml(item.url)}" title="Delete">×</button>
      `;
      recentList.appendChild(div);
    });

    // Fetch like counts for items with commit SHAs
    loadLikeCounts(token, owner, name, recent);
  } catch {
    recentList.innerHTML = '<span class="ai-status error">Could not load recent links</span>';
  }
}

recentList.addEventListener('click', async (e) => {
  const btn = e.target.closest('.recent-delete');
  if (!btn) return;

  const topic = btn.dataset.topic;
  const url = btn.dataset.url;
  if (!confirm(`Delete this link from ${topic}?`)) return;

  const row = btn.closest('.recent-item');
  btn.disabled = true;
  btn.textContent = '…';

  try {
    const token = await getToken();
    const settings = await getSettings();
    const [owner, name] = settings.repo.split('/');
    const path = `/repos/${owner}/${name}/contents/topics/${topic}.json`;

    const file = await githubGet(path, token);
    const existing = JSON.parse(atob(file.content));

    existing.items = (existing.items || []).filter((item) => item.url !== url);

    const updatedContent = btoa(unescape(encodeURIComponent(JSON.stringify(existing, null, 2))));
    await githubPut(path, {
      message: `Remove source: ${url}`,
      content: updatedContent,
      sha: file.sha,
    }, token);

    row.remove();
    if (!recentList.querySelector('.recent-item')) {
      recentList.innerHTML = '<span class="ai-status">No links yet</span>';
    }
  } catch (err) {
    btn.textContent = '×';
    btn.disabled = false;
    showError(`Delete failed: ${err.message}`);
  }
});

function prependRecentItem(item) {
  // Remove "No links yet" placeholder
  const placeholder = recentList.querySelector('.ai-status');
  if (placeholder) placeholder.remove();

  const commitSha = item._commit_sha || '';
  const div = document.createElement('div');
  div.className = 'recent-item';
  div.innerHTML = `
    <span class="recent-topic">${escapeHtml(item._topic)}</span>
    <a href="${escapeHtml(item.url)}" target="_blank" title="${escapeHtml(item.title || item.url)}">${escapeHtml(item.title || item.url)}</a>
    ${commitSha ? `<button class="recent-like" data-sha="${escapeHtml(commitSha)}" title="Like">👍 <span class="like-count">0</span></button>` : ''}
    <span class="recent-date">${relativeTime(item.date_published)}</span>
    <button class="recent-delete" data-topic="${escapeHtml(item._topic)}" data-url="${escapeHtml(item.url)}" title="Delete">×</button>
  `;
  recentList.prepend(div);
}

// ---------------------------------------------------------------------------
// Like system (commit comment reactions)
// ---------------------------------------------------------------------------

async function loadLikeCounts(token, owner, name, items) {
  const withSha = items.filter((i) => i._commit_sha);
  if (!withSha.length) return;

  // Fetch comment counts in parallel (batch)
  await Promise.all(withSha.map(async (item) => {
    try {
      const comments = await githubGet(
        `/repos/${owner}/${name}/commits/${item._commit_sha}/comments`,
        token
      );
      // Count 👍 reactions across all comments, plus count comments themselves as likes
      let total = comments.length;
      // Find the button in DOM and update
      const btn = recentList.querySelector(`.recent-like[data-sha="${item._commit_sha}"]`);
      if (btn) {
        const countEl = btn.querySelector('.like-count');
        if (countEl) countEl.textContent = total;
      }
    } catch { /* ignore */ }
  }));
}

recentList.addEventListener('click', async (e) => {
  const likeBtn = e.target.closest('.recent-like');
  if (!likeBtn) return;

  const sha = likeBtn.dataset.sha;
  const repo = likeBtn.dataset.repo;
  if (!sha) return;

  likeBtn.disabled = true;

  try {
    const token = await getToken();
    const settings = await getSettings();
    const [owner, name] = settings.repo.split('/');

    // Create a commit comment (acts as a "like")
    await fetch(`https://api.github.com/repos/${owner}/${name}/commits/${sha}/comments`, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: '👍' }),
    });

    // Update count
    const countEl = likeBtn.querySelector('.like-count');
    if (countEl) countEl.textContent = Number(countEl.textContent) + 1;
    likeBtn.classList.add('liked');
  } catch {
    showError('Like failed');
  } finally {
    likeBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// New topic
// ---------------------------------------------------------------------------

btnNewTopic.addEventListener('click', () => {
  show(newTopicForm);
  hide(btnNewTopic);
});

btnCancelTopic.addEventListener('click', () => {
  hide(newTopicForm);
  show(btnNewTopic);
});

btnCreateTopic.addEventListener('click', async () => {
  hideError();
  const topicId  = newTopicId.value.trim();
  const topicDesc = newTopicDesc.value.trim();
  const topicTags = newTopicTags.value.split(',').map((s) => s.trim()).filter(Boolean);

  if (!topicId) { showError('Topic ID is required.'); return; }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(topicId)) {
    showError('Topic ID must be kebab-case (e.g. my-new-topic).');
    return;
  }

  btnCreateTopic.disabled = true;
  btnCreateTopic.textContent = 'Creating…';

  try {
    const token = await getToken();
    const settings = await getSettings();
    const [owner, name] = settings.repo.split('/');

    const topicData = {
      version: 'https://jsonfeed.org/version/1.1',
      title: topicId,
      description: topicDesc,
      language: 'en',
      _tags: topicTags,
      items: [],
    };

    const content = btoa(unescape(encodeURIComponent(JSON.stringify(topicData, null, 2))));

    await githubPut(`/repos/${owner}/${name}/contents/topics/${topicId}.json`, {
      message: `Add topic: ${topicId}`,
      content,
    }, token);

    // Add new topic to dropdown and select it
    const opt = document.createElement('option');
    opt.value = topicId;
    opt.textContent = topicId;
    fieldTopic.appendChild(opt);
    fieldTopic.value = topicId;

    hide(newTopicForm);
    show(btnNewTopic);
    newTopicId.value = '';
    newTopicDesc.value = '';
    newTopicTags.value = '';
  } catch (err) {
    showError(`Failed to create topic: ${err.message}`);
  } finally {
    btnCreateTopic.disabled = false;
    btnCreateTopic.textContent = 'Create';
  }
});

// ---------------------------------------------------------------------------
// Save source
// ---------------------------------------------------------------------------

btnSave.addEventListener('click', async () => {
  hideError();
  hide(saveResult);

  const url      = fieldUrl.value.trim();
  const title    = fieldTitle.value.trim();
  const topic    = fieldTopic.value;
  const summary  = fieldSummary.value.trim();
  const priority = document.querySelector('input[name="priority"]:checked')?.value || 'P0';

  if (!url)   { showError('URL is required.');   return; }
  if (!topic) { showError('Please select a topic.'); return; }

  btnSave.disabled = true;
  btnSave.textContent = 'Saving…';

  try {
    const token = await getToken();
    const settings = await getSettings();
    const [owner, name] = settings.repo.split('/');
    const username = await getUsername() || 'unknown';

    const path = `/repos/${owner}/${name}/contents/topics/${topic}.json`;

    // Fetch current file to get sha and existing content
    const file = await githubGet(path, token);
    const existing = JSON.parse(atob(file.content));

    // Reject duplicate URLs
    if (existing.items && existing.items.some((item) => item.url === url)) {
      showError('This URL already exists in this topic.');
      return;
    }

    // Auto-generate tags + summary from page content
    let autoTags = [];
    let autoSummary = summary;
    if (pageExcerpt) {
      const excerpt = [
        pageExcerpt.description,
        pageExcerpt.keywords,
        (pageExcerpt.headings || []).join('. '),
        pageExcerpt.bodyText,
      ].filter(Boolean).join('\n').slice(0, 2000);

      if (excerpt) {
        try {
          const { generateTagsAndSummary } = await import('../lib/tag-generator.js');
          const result = await generateTagsAndSummary(title, excerpt, token);
          if (result) {
            autoTags = result.tags || [];
            if (!autoSummary && result.summary) autoSummary = result.summary;
          }
        } catch { /* tag generation unavailable */ }
      }
    }

    const newSource = {
      id: url,
      url,
      title,
      summary: autoSummary,
      tags: autoTags.slice(0, 15),
      date_published: new Date().toISOString(),
      authors: [{ name: username }],
      _source_author: '',
      _source_date: '',
      _priority: priority,
    };

    // Append to items array
    if (!existing.items) existing.items = [];
    existing.items.push(newSource);

    const updatedContent = btoa(unescape(encodeURIComponent(JSON.stringify(existing, null, 2))));

    const putResult = await githubPut(path, {
      message: `Add source: ${title || url}`,
      content: updatedContent,
      sha: file.sha,
    }, token);

    // Store the commit SHA in the source item for like tracking
    const commitSha = putResult.commit?.sha;
    if (commitSha) {
      newSource._commit_sha = commitSha;
      const withSha = btoa(unescape(encodeURIComponent(JSON.stringify(existing, null, 2))));
      await githubPut(path, {
        message: `Record commit ref for: ${title || url}`,
        content: withSha,
        sha: putResult.content.sha,
      }, token);
    }

    // Show success
    saveResult.className = 'success';
    saveResult.textContent = `✅ Saved to ${topic} (${existing.items.length} sources)`;
    show(saveResult);

    // Immediately prepend to recent list
    prependRecentItem({ ...newSource, _topic: topic });

    // Clear form fields for next save
    fieldSummary.value = '';
  } catch (err) {
    showError(`Save failed: ${err.message}`);
  } finally {
    btnSave.disabled = false;
    btnSave.textContent = 'Save Source';
  }
});
