// Popup script for the Dask extension.
// Manages the two-state UI: login vs. save-source form.
// All auth flows (PKCE OAuth + device code fallback) run inline — no background service worker.

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
const settingRepo     = $('#setting-repo');

// Login
const btnConnect       = $('#btn-connect');
const btnDeviceCode    = $('#btn-device-code');
const deviceCodeInfo   = $('#device-code-info');
const verificationLink = $('#verification-link');
const userCodeEl       = $('#user-code');
const authStatusEl     = $('#auth-status');

// Save form
const fieldUrl     = $('#field-url');
const fieldTopic   = $('#field-topic');
const btnSave      = $('#btn-save');
const saveResult   = $('#save-result');
const recentPanel   = $('#recent-panel');
const recentList    = $('#recent-list');
const tabBar        = $('#tab-bar');

// AI summary
const aiSummarySection = $('#ai-summary-section');
const aiSummaryText    = $('#ai-summary-text');
const aiKeyTakeaways   = $('#ai-key-takeaways');
const aiConfigSection  = $('#ai-config-section');
const aiConfiguration  = $('#ai-configuration');
const aiRefsSection    = $('#ai-refs-section');
const aiReferences     = $('#ai-references');
const aiSummaryLoading = $('#ai-summary-loading');

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
const STORAGE_KEY_REPO      = 'gh_repo';
const STORAGE_KEY_USERNAME  = 'gh_username';
const GITHUB_APP_CLIENT_ID  = 'Iv23liXEvwmMIjlGO2OM';

async function getToken()    { return (await chrome.storage.sync.get(STORAGE_KEY_TOKEN))[STORAGE_KEY_TOKEN] || null; }
async function getSettings() {
  const d = await chrome.storage.sync.get([STORAGE_KEY_REPO]);
  return {
    clientId: GITHUB_APP_CLIENT_ID,
    repo:     d[STORAGE_KEY_REPO]      || 'gogoshaka/dask',
  };
}
async function saveSettingsToStorage(repo) {
  return chrome.storage.sync.set({ [STORAGE_KEY_REPO]: repo });
}
async function getUsername() {
  return (await chrome.storage.sync.get(STORAGE_KEY_USERNAME))[STORAGE_KEY_USERNAME] || null;
}

// ---------------------------------------------------------------------------
// Auth helpers (OAuth handled by background service worker)
// ---------------------------------------------------------------------------

const EXTENSION_REDIRECT_URL = `https://${chrome.runtime.id}.chromiumapp.org/`;

// ---------------------------------------------------------------------------
// Device code flow (fallback)
// ---------------------------------------------------------------------------

async function startDeviceFlow() {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: GITHUB_APP_CLIENT_ID }),
  });
  if (!res.ok) throw new Error(`Device flow request failed: ${res.status}`);
  return res.json();
}

async function pollForToken(deviceCode) {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: GITHUB_APP_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  if (!res.ok) throw new Error(`Token poll failed: ${res.status}`);
  const data = await res.json();
  if (data.access_token) return data.access_token;
  if (data.error === 'authorization_pending' || data.error === 'slow_down') return null;
  throw new Error(data.error_description || data.error || 'Unknown auth error');
}

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

  // Primary: OAuth flow (handled by background service worker so it survives popup close)
  btnConnect.addEventListener('click', async () => {
    hideError();
    btnConnect.disabled = true;
    btnConnect.textContent = 'Authorising…';

    // Send to background — the popup may close while the user authorizes on GitHub.
    // The background completes the flow and stores the token.
    chrome.runtime.sendMessage({ type: 'LOGIN' });

    // Poll for login completion (user will reopen popup after authorizing)
    const checkInterval = setInterval(async () => {
      const token = await getToken();
      if (token) {
        clearInterval(checkInterval);
        location.reload();
      }
    }, 1000);
  });

  // Fallback: Device code flow
  let devicePollInterval = null;

  btnDeviceCode.addEventListener('click', async () => {
    hideError();
    btnDeviceCode.disabled = true;

    try {
      const flow = await startDeviceFlow();

      userCodeEl.textContent = flow.user_code;
      verificationLink.href = flow.verification_uri;
      verificationLink.textContent = flow.verification_uri;
      show(deviceCodeInfo);
      authStatusEl.textContent = 'Waiting for authorisation…';
      authStatusEl.className = 'status';

      // Poll inline with setInterval
      const interval = (flow.interval || 5) * 1000;
      devicePollInterval = setInterval(async () => {
        try {
          const token = await pollForToken(flow.device_code);
          if (token) {
            clearInterval(devicePollInterval);
            await chrome.storage.sync.set({ [STORAGE_KEY_TOKEN]: token });
            location.reload();
          }
        } catch (err) {
          clearInterval(devicePollInterval);
          authStatusEl.textContent = `Error: ${err.message}`;
          authStatusEl.className = 'status error';
        }
      }, interval);
    } catch (err) {
      showError(err.message);
      btnDeviceCode.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

$('#btn-settings').addEventListener('click', async () => {
  const settings = await getSettings();
  settingRepo.value     = settings.repo;
  show(settingsPanel);
  hide(savePanel);
});

$('#btn-save-settings').addEventListener('click', async () => {
  await saveSettingsToStorage(settingRepo.value.trim(), settingModelsToken.value.trim());
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
// Cached transcript for YouTube videos
let pageTranscript = null;
// Cached AI result for use in save handler
let cachedAIResult = null;
// Page title (from active tab, not shown in UI)
let pageTitle = '';

async function generateAISummary(token) {
  show(aiSummaryLoading);
  aiSummaryLoading.innerHTML = '<span class="spinner"></span> Generating summary…';
  hide(aiSummarySection);

  // Prefer YouTube transcript over regular page content
  let excerpt;
  if (pageTranscript) {
    excerpt = pageTranscript.slice(0, 3000);
  } else {
    excerpt = [
      pageExcerpt.description,
      pageExcerpt.keywords,
      (pageExcerpt.headings || []).join('. '),
      pageExcerpt.bodyText,
    ].filter(Boolean).join('\n').slice(0, 2000);
  }

  if (!excerpt) {
    aiSummaryLoading.innerHTML = '⚠️ Could not extract page content for summary.';
    aiSummaryLoading.className = 'ai-status';
    return;
  }

  try {
    const { generateTagsAndSummary } = await import('../lib/tag-generator.js');
    console.log('[Dask] Sending to AI:', excerpt.length, 'chars');
    const result = await generateTagsAndSummary(pageTitle, excerpt, token);
    console.log('[Dask] AI result:', result);
    if (result) {
      cachedAIResult = result;

      aiSummaryText.textContent = result.summary;

      aiKeyTakeaways.innerHTML = '';
      (result.key_takeaways || []).forEach((point) => {
        const li = document.createElement('li');
        li.textContent = point;
        aiKeyTakeaways.appendChild(li);
      });

      // Configuration section (only shown when present)
      if (result.configuration && result.configuration.length > 0) {
        aiConfiguration.innerHTML = '';
        result.configuration.forEach((item) => {
          const li = document.createElement('li');
          li.textContent = item;
          aiConfiguration.appendChild(li);
        });
        show(aiConfigSection);
      } else {
        hide(aiConfigSection);
      }

      // References section (only shown when present)
      if (result.references && result.references.length > 0) {
        aiReferences.innerHTML = '';
        result.references.forEach((item) => {
          const li = document.createElement('li');
          li.textContent = item;
          aiReferences.appendChild(li);
        });
        show(aiRefsSection);
      } else {
        hide(aiRefsSection);
      }

      hide(aiSummaryLoading);
      show(aiSummarySection);

    } else {
      aiSummaryLoading.innerHTML = '⚠️ Summary generation returned empty result.';
      aiSummaryLoading.className = 'ai-status';
    }
  } catch (err) {
    const msg = err.message || 'Unknown error';
    aiSummaryLoading.innerHTML = `❌ Summary failed: ${msg}`;
    aiSummaryLoading.className = 'ai-status';
    console.error('AI summary error:', err);
  }
}

async function showSavePanel(token, settings) {
  show(headerActions);
  show(tabBar);
  hide(loginPanel);
  show(savePanel);
  hide(settingsPanel);
  hide(recentPanel);

  // Show spinner immediately while content is being extracted
  show(aiSummaryLoading);

  // Pre-fill URL and title from the active tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      fieldUrl.value   = tab.url  || '';
      pageTitle = tab.title || '';

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

        // Extract transcript from YouTube videos
        const { isYouTubeVideo } = await import('../lib/youtube-utils.js');
        if (isYouTubeVideo(tab.url)) {
          try {
            const tResults = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['lib/youtube-transcript.js'],
            });
            if (tResults && tResults[0] && tResults[0].result) {
              pageTranscript = tResults[0].result;
              console.log('[Dask] YouTube transcript extracted:', pageTranscript.length, 'chars');
              console.log('[Dask] Transcript preview:', pageTranscript.slice(0, 500));
              aiSummaryLoading.innerHTML = '<span class="spinner"></span> 📺 Summarizing video transcript…';
            }
          } catch { /* transcript extraction failed — continue without it */ }
        }
      }
    }
  } catch { /* activeTab might not be available yet */ }

  // Auto-generate AI summary (non-blocking)
  if (pageExcerpt || pageTranscript) {
    generateAISummary(token);
  } else {
    aiSummaryLoading.innerHTML = '⚠️ Could not extract page content for summary.';
    aiSummaryLoading.className = 'ai-status';
  }

  // Ensure we have a cached username
  const cachedUser = await chrome.storage.sync.get(STORAGE_KEY_USERNAME);
  if (!cachedUser[STORAGE_KEY_USERNAME]) {
    try {
      const user = await githubGet('/user', token);
      await chrome.storage.sync.set({ [STORAGE_KEY_USERNAME]: user.login });
    } catch { /* non-critical */ }
  }

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
  const title    = pageTitle;
  const topic    = fieldTopic.value;
  const summary  = cachedAIResult?.summary || '';
  const priority = 'P0';

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

    // Use cached AI result (already generated on popup open) or generate now
    let autoTags = [];
    let autoSummary = summary;
    if (cachedAIResult) {
      autoTags = cachedAIResult.tags || [];
      if (!autoSummary && cachedAIResult.summary) autoSummary = cachedAIResult.summary;
    } else if (pageTranscript || pageExcerpt) {
      let excerpt;
      if (pageTranscript) {
        excerpt = pageTranscript.slice(0, 3000);
      } else {
        excerpt = [
          pageExcerpt.description,
          pageExcerpt.keywords,
          (pageExcerpt.headings || []).join('. '),
          pageExcerpt.bodyText,
        ].filter(Boolean).join('\n').slice(0, 2000);
      }

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

    if (pageTranscript) {
      const { TRANSCRIPT_MAX_LENGTH } = await import('../lib/youtube-utils.js');
      newSource._transcript = pageTranscript.length > TRANSCRIPT_MAX_LENGTH
        ? pageTranscript.slice(0, TRANSCRIPT_MAX_LENGTH)
        : pageTranscript;
    }

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

    // Reset cached AI result for next save
    cachedAIResult = null;
  } catch (err) {
    showError(`Save failed: ${err.message}`);
  } finally {
    btnSave.disabled = false;
    btnSave.textContent = 'Save Source';
  }
});
