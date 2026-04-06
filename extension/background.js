// ============================================================
// Reddit Warmup Tracker — Background Service Worker
// ============================================================

// ----- CONFIG -----
const CONFIG = {
  WEBHOOK_URL: 'https://script.google.com/macros/s/AKfycbxXYA9j9zCu3ps1kGgBwWGzGOKK7fe44MLChNlJT9cAoNrgJ4XSUnB_uu1fe0J2B__e/exec',
  AUTH_TOKEN: 'reddit-tracker-2026-xyz',
  SYNC_INTERVAL_MIN: 2,
  ENGAGE_TIMEOUT_SEC: 120,   // no scroll/click for 2 min = not engaged (was 60 — too strict)
  SESSION_GAP_SEC: 180,
  VERSION: '1.3.0',
  REDDIT_PATTERN: /^https?:\/\/([a-z0-9-]+\.)*reddit\.com/i,
};

// ----- STATE KEYS -----
const KEYS = {
  USERNAME: 'reddit_username',
  TODAY: 'today_date',
  SECONDS: 'reddit_seconds',
  FIRST_ACTIVE: 'first_active',
  LAST_ACTIVE: 'last_active',
  SESSION_COUNT: 'session_count',
  PENDING_SYNCS: 'pending_syncs',
  LAST_SYNC: 'last_sync_time',
  TOTAL_CLICKS: 'total_clicks',
  TOTAL_SCROLLS: 'total_scrolls',
  TOTAL_PAGE_NAVS: 'total_page_navs',
  // Heartbeat-driven tracking
  LAST_ACTIVE_HEARTBEAT: 'last_active_heartbeat',  // timestamp of last heartbeat where user was engaged
  ENGAGED: 'is_engaged',
};

// ----- HELPERS -----

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function nowISO() {
  return new Date().toISOString();
}

async function getState() {
  return chrome.storage.local.get(null);
}

async function setState(obj) {
  return chrome.storage.local.set(obj);
}

function isRedditUrl(url) {
  return url && CONFIG.REDDIT_PATTERN.test(url);
}

// ----- DAY ROLLOVER -----
async function checkDayRollover(state) {
  const today = todayStr();
  if (state[KEYS.TODAY] && state[KEYS.TODAY] !== today) {
    await syncToWebhook(state);
    await setState({
      [KEYS.TODAY]: today,
      [KEYS.SECONDS]: 0,
      [KEYS.FIRST_ACTIVE]: null,
      [KEYS.LAST_ACTIVE]: null,
      [KEYS.SESSION_COUNT]: 0,
      [KEYS.TOTAL_CLICKS]: 0,
      [KEYS.TOTAL_SCROLLS]: 0,
      [KEYS.TOTAL_PAGE_NAVS]: 0,
      [KEYS.ENGAGED]: false,
      [KEYS.LAST_ACTIVE_HEARTBEAT]: 0,
    });
    return await getState();
  }
  if (!state[KEYS.TODAY]) {
    await setState({ [KEYS.TODAY]: today });
    return await getState();
  }
  return state;
}

// ============================================================
// CORE TIME TRACKING — driven by heartbeats, NOT by tick alarm
//
// Every 30s the content script sends a heartbeat with:
//   - secsSinceLastEvent: how long since user scrolled/clicked
//   - scrolls, clicks, pageNavs: counts since last heartbeat
//
// On each heartbeat (only processed if sender is the active Reddit tab):
//   1. Check if user is engaged (secsSinceLastEvent < threshold)
//   2. If yes: calculate elapsed since last ACTIVE heartbeat, add to seconds
//   3. If not: reset the heartbeat anchor (don't count inactive time)
// ============================================================

async function handleHeartbeat(msg) {
  let state = await getState();
  state = await checkDayRollover(state);

  if (!state[KEYS.USERNAME]) return;

  // Is user engaged? (scrolled/clicked within the timeout)
  const isEngaged = msg.secsSinceLastEvent <= CONFIG.ENGAGE_TIMEOUT_SEC;

  // We already verified this heartbeat is from the active Reddit tab
  // (filtered in onMessage handler), so just check engagement
  const updates = {
    [KEYS.TOTAL_CLICKS]: (state[KEYS.TOTAL_CLICKS] || 0) + (msg.clicks || 0),
    [KEYS.TOTAL_SCROLLS]: (state[KEYS.TOTAL_SCROLLS] || 0) + (msg.scrolls || 0),
    [KEYS.TOTAL_PAGE_NAVS]: (state[KEYS.TOTAL_PAGE_NAVS] || 0) + (msg.pageNavs || 0),
    [KEYS.ENGAGED]: isEngaged,
  };

  if (isEngaged) {
    // User is actively engaging with Reddit
    const lastActiveHB = state[KEYS.LAST_ACTIVE_HEARTBEAT] || 0;
    let elapsed = 0;

    if (lastActiveHB > 0) {
      elapsed = Math.round((msg.timestamp - lastActiveHB) / 1000);
      // Cap at 45 seconds (heartbeat is every 30s, allow some slack)
      // If gap is too large, it means there was an inactive period — just count 0
      if (elapsed > 45) elapsed = 0;
      if (elapsed < 0) elapsed = 0;
    }

    updates[KEYS.SECONDS] = (state[KEYS.SECONDS] || 0) + elapsed;
    updates[KEYS.LAST_ACTIVE_HEARTBEAT] = msg.timestamp;
    updates[KEYS.LAST_ACTIVE] = nowISO();

    if (!state[KEYS.FIRST_ACTIVE]) {
      updates[KEYS.FIRST_ACTIVE] = nowISO();
    }

    // Session tracking: if gap since last active heartbeat > SESSION_GAP, new session
    if (lastActiveHB === 0 || (msg.timestamp - lastActiveHB) > CONFIG.SESSION_GAP_SEC * 1000) {
      updates[KEYS.SESSION_COUNT] = (state[KEYS.SESSION_COUNT] || 0) + 1;
    }
  } else {
    // Not engaged or not on Reddit — reset heartbeat anchor
    // Next active heartbeat will start fresh (elapsed = 0 for first one, then counting)
    updates[KEYS.LAST_ACTIVE_HEARTBEAT] = 0;
  }

  await setState(updates);
}

// ----- WEBHOOK SYNC -----
async function syncToWebhook(stateOverride) {
  const state = stateOverride || await getState();

  if (!state[KEYS.USERNAME] || !state[KEYS.SECONDS]) return;

  const payload = {
    reddit_username: state[KEYS.USERNAME],
    date: state[KEYS.TODAY] || todayStr(),
    reddit_seconds: state[KEYS.SECONDS] || 0,
    first_active: state[KEYS.FIRST_ACTIVE] || null,
    last_active: state[KEYS.LAST_ACTIVE] || null,
    session_count: state[KEYS.SESSION_COUNT] || 0,
    total_clicks: state[KEYS.TOTAL_CLICKS] || 0,
    total_scrolls: state[KEYS.TOTAL_SCROLLS] || 0,
    total_page_navs: state[KEYS.TOTAL_PAGE_NAVS] || 0,
    extension_version: CONFIG.VERSION,
    timestamp: nowISO(),
    auth_token: CONFIG.AUTH_TOKEN,
  };

  try {
    const resp = await fetch(CONFIG.WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });

    if (resp.status < 400) {
      await setState({ [KEYS.LAST_SYNC]: nowISO() });
      await retryPendingSyncs();
    } else {
      throw new Error(`HTTP ${resp.status}`);
    }
  } catch (e) {
    console.warn('[Warmup Tracker] Sync failed, queuing:', e.message);
    await queuePendingSync(payload);
  }
}

async function queuePendingSync(payload) {
  const state = await getState();
  const pending = state[KEYS.PENDING_SYNCS] || [];
  pending.push(payload);
  if (pending.length > 100) pending.splice(0, pending.length - 100);
  await setState({ [KEYS.PENDING_SYNCS]: pending });
}

async function retryPendingSyncs() {
  const state = await getState();
  const pending = state[KEYS.PENDING_SYNCS] || [];
  if (pending.length === 0) return;

  const stillPending = [];
  for (const payload of pending) {
    try {
      const resp = await fetch(CONFIG.WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload),
        redirect: 'follow',
      });
      if (resp.status >= 400) stillPending.push(payload);
    } catch (e) {
      stillPending.push(payload);
      break;
    }
  }
  await setState({ [KEYS.PENDING_SYNCS]: stillPending });
}

// ----- ALARMS -----
// Sync alarm — pushes data to Google Sheet
chrome.alarms.create('tracker-sync', { periodInMinutes: CONFIG.SYNC_INTERVAL_MIN });
// Keep-alive alarm — prevents service worker from dying
chrome.alarms.create('tracker-keepalive', { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'tracker-sync') {
    await syncToWebhook();
  }
  // keepalive: just waking the service worker is enough, no action needed
});

// ----- MESSAGES FROM CONTENT SCRIPT -----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'REDDIT_USERNAME' && msg.username) {
    setState({ [KEYS.USERNAME]: msg.username });
  }

  if (msg.type === 'ENGAGEMENT_HEARTBEAT') {
    // Only process heartbeats from the active tab to prevent
    // stale tabs from resetting the heartbeat anchor
    const senderTabId = sender.tab?.id;
    if (senderTabId != null) {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        if (tabs.length > 0 && tabs[0].id === senderTabId) {
          handleHeartbeat(msg);
        }
      });
    }
  }

  if (msg.type === 'GET_STATUS') {
    getState().then((state) => {
      sendResponse({
        username: state[KEYS.USERNAME] || '—',
        seconds: state[KEYS.SECONDS] || 0,
        date: state[KEYS.TODAY] || todayStr(),
        lastSync: state[KEYS.LAST_SYNC] || 'never',
        pendingCount: (state[KEYS.PENDING_SYNCS] || []).length,
        sessionCount: state[KEYS.SESSION_COUNT] || 0,
        engaged: state[KEYS.ENGAGED] || false,
        clicks: state[KEYS.TOTAL_CLICKS] || 0,
        scrolls: state[KEYS.TOTAL_SCROLLS] || 0,
        lastActiveHeartbeat: state[KEYS.LAST_ACTIVE_HEARTBEAT] || 0,
      });
    });
    return true;
  }
});

// ----- STARTUP -----
chrome.runtime.onStartup.addListener(async () => {
  // Just ensure state exists
  const state = await getState();
  if (!state[KEYS.TODAY]) {
    await setState({ [KEYS.TODAY]: todayStr(), [KEYS.SECONDS]: 0 });
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  // Only reset counters if fresh install (not on update/reload)
  const state = await getState();
  if (!state[KEYS.TODAY]) {
    await setState({
      [KEYS.TODAY]: todayStr(),
      [KEYS.SECONDS]: 0,
      [KEYS.SESSION_COUNT]: 0,
      [KEYS.PENDING_SYNCS]: [],
      [KEYS.TOTAL_CLICKS]: 0,
      [KEYS.TOTAL_SCROLLS]: 0,
      [KEYS.TOTAL_PAGE_NAVS]: 0,
      [KEYS.ENGAGED]: false,
      [KEYS.LAST_ACTIVE_HEARTBEAT]: 0,
    });
  }

  // Re-inject content scripts into any open Reddit tabs
  // (needed after extension reload/update — old scripts are destroyed)
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.reddit.com/*' });
    for (const tab of tabs) {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js', 'video_hider.js'],
      }).catch(() => { }); // ignore tabs we can't inject into
    }
  } catch (e) { /* scripting API might not be available */ }
});

// ============================================================
// SITE BLOCKER — Whitelist-based site restriction
// ============================================================

const ALLOWED_PATTERNS = [
  /^https?:\/\/([a-z0-9-]+\.)*reddit\.com/i,
  /^https?:\/\/([a-z0-9-]+\.)*google\.com/i,
  /^https?:\/\/([a-z0-9-]+\.)*google\.[a-z.]+/i,
  /^https?:\/\/script\.google\.com/i,
  /^https?:\/\/script\.googleusercontent\.com/i,
  /^chrome/i,
  /^about:/i,
  /^chrome-extension:/i,
  /^edge:/i,
  /^data:/i,
];

function isAllowedUrl(url) {
  if (!url) return true;
  return ALLOWED_PATTERNS.some(p => p.test(url));
}

function getBlockedPageUrl(blockedUrl) {
  return chrome.runtime.getURL(`blocked.html?url=${encodeURIComponent(blockedUrl)}`);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  if (isAllowedUrl(changeInfo.url)) return;
  if (changeInfo.url.includes('blocked.html')) return;
  chrome.tabs.update(tabId, { url: getBlockedPageUrl(changeInfo.url) });
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.pendingUrl && !isAllowedUrl(tab.pendingUrl) && !tab.pendingUrl.includes('blocked.html')) {
    chrome.tabs.update(tab.id, { url: getBlockedPageUrl(tab.pendingUrl) });
  }
});
