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
const btnConnect       = $('#btn-connect');
const deviceCodeInfo   = $('#device-code-info');
const verificationLink = $('#verification-link');
const userCodeEl       = $('#user-code');
const authStatusEl     = $('#auth-status');

// Save form
const fieldUrl     = $('#field-url');
const fieldTitle   = $('#field-title');
const fieldTopic   = $('#field-topic');
const fieldSummary = $('#field-summary');
const tagInput     = $('#tag-input');
const tagsContainer= $('#tags-container');
const btnSave      = $('#btn-save');
const saveResult   = $('#save-result');
const btnGenerate  = $('#btn-generate');
const aiStatus     = $('#ai-status');

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
// Tags UI
// ---------------------------------------------------------------------------

const tags = [];

function renderTags() {
  tagsContainer.querySelectorAll('.tag').forEach((el) => el.remove());
  tags.forEach((t, i) => {
    const span = document.createElement('span');
    span.className = 'tag';
    span.innerHTML = `${escapeHtml(t)} <span class="remove-tag" data-index="${i}">×</span>`;
    tagsContainer.insertBefore(span, tagInput);
  });
}

tagsContainer.addEventListener('click', (e) => {
  if (e.target.classList.contains('remove-tag')) {
    tags.splice(Number(e.target.dataset.index), 1);
    renderTags();
  }
});

tagInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const val = tagInput.value.trim();
    if (val && !tags.includes(val)) {
      tags.push(val);
      renderTags();
    }
    tagInput.value = '';
  }
  if (e.key === 'Backspace' && tagInput.value === '' && tags.length) {
    tags.pop();
    renderTags();
  }
});

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
  show(loginPanel);
  hide(savePanel);
  hide(settingsPanel);

  loginClientId.value = settings.clientId;

  btnConnect.addEventListener('click', async () => {
    hideError();
    const clientId = loginClientId.value.trim();
    if (!clientId) { showError('Please enter a GitHub OAuth Client ID.'); return; }

    // Persist the client ID for future use
    await saveSettingsToStorage(clientId, settings.repo);

    btnConnect.disabled = true;
    btnConnect.textContent = 'Starting…';

    try {
      // Ask the background service worker to start the device flow.
      const resp = await chrome.runtime.sendMessage({ type: 'START_AUTH', clientId });

      if (resp.error) throw new Error(resp.error);

      // Show the user code so they can enter it on github.com/login/device
      userCodeEl.textContent = resp.userCode;
      verificationLink.href = resp.verificationUri;
      verificationLink.textContent = resp.verificationUri;
      show(deviceCodeInfo);
      authStatusEl.textContent = 'Waiting for authorisation…';
      authStatusEl.className = 'status';
    } catch (err) {
      showError(err.message);
      btnConnect.disabled = false;
      btnConnect.textContent = 'Connect to GitHub';
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
  hide(loginPanel);
  show(savePanel);
  hide(settingsPanel);

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
  await loadTopics(token, settings.repo);

  // Enable generate button and auto-trigger if page excerpt is available
  if (pageExcerpt) {
    btnGenerate.disabled = false;
    triggerGeneration(token);
  }
}

async function loadTopics(token, repo) {
  fieldTopic.innerHTML = '<option value="">Loading topics…</option>';

  try {
    const [owner, name] = repo.split('/');
    const data = await githubGet(`/repos/${owner}/${name}/contents/_index.json`, token);
    const index = JSON.parse(atob(data.content));

    fieldTopic.innerHTML = '';
    const items = index.items || [];

    items.forEach((item) => {
      const id = item.id || item.title;
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      fieldTopic.appendChild(opt);
    });

    if (items.length === 0) {
      fieldTopic.innerHTML = '<option value="">No topics found</option>';
    }
  } catch (err) {
    fieldTopic.innerHTML = '<option value="">Could not load topics</option>';
    console.warn('Failed to load topics:', err);
  }
}

// ---------------------------------------------------------------------------
// AI generation (tags + summary)
// ---------------------------------------------------------------------------

async function triggerGeneration(token) {
  if (!pageExcerpt) return;

  const title = fieldTitle.value.trim();
  const excerpt = [
    pageExcerpt.description,
    pageExcerpt.keywords,
    (pageExcerpt.headings || []).join('. '),
    pageExcerpt.bodyText,
  ].filter(Boolean).join('\n').slice(0, 2000);

  if (!excerpt) return;

  // Show loading state
  aiStatus.textContent = 'Generating…';
  aiStatus.className = 'ai-status loading';
  show(aiStatus);
  btnGenerate.disabled = true;

  try {
    const { generateTagsAndSummary } = await import('../lib/tag-generator.js');
    const result = await generateTagsAndSummary(title, excerpt, token);

    if (result) {
      // Populate tags (merge with any manually entered tags)
      if (result.tags && result.tags.length > 0) {
        const merged = [...new Set([...tags, ...result.tags])].slice(0, 15);
        tags.length = 0;
        merged.forEach((t) => tags.push(t));
        renderTags();
      }

      // Populate summary (only if currently empty)
      if (result.summary && !fieldSummary.value.trim()) {
        fieldSummary.value = result.summary;
      }

      aiStatus.textContent = '✓ Ready to review';
      aiStatus.className = 'ai-status';
    } else {
      aiStatus.textContent = 'Generation failed — add manually';
      aiStatus.className = 'ai-status error';
    }
  } catch {
    aiStatus.textContent = 'Generation failed — add manually';
    aiStatus.className = 'ai-status error';
  } finally {
    btnGenerate.disabled = false;
  }
}

btnGenerate.addEventListener('click', async () => {
  const token = await getToken();
  if (token) triggerGeneration(token);
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

    const newSource = {
      id: url,
      url,
      title,
      summary,
      tags: [...tags],
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

    await githubPut(path, {
      message: `Add source: ${title || url}`,
      content: updatedContent,
      sha: file.sha,
    }, token);

    // Show success
    saveResult.className = 'success';
    saveResult.textContent = `✅ Saved to ${topic} (${existing.items.length} sources)`;
    show(saveResult);

    // Clear form fields for next save
    fieldSummary.value = '';
    tags.length = 0;
    renderTags();
  } catch (err) {
    showError(`Save failed: ${err.message}`);
  } finally {
    btnSave.disabled = false;
    btnSave.textContent = 'Save Source';
  }
});
