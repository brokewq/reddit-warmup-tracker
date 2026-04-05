# Reddit Warmup Tracker - Technical Documentation

**Version:** 1.3.0
**Platform:** Chrome Extension (Manifest V3) for AdsPower SunBrowser
**Purpose:** Passively track and verify that Reddit accounts are being warmed up for 15 minutes daily

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Feature 1: Time Tracking](#3-feature-1-time-tracking)
4. [Feature 2: Video Post Hider](#4-feature-2-video-post-hider)
5. [Feature 3: Site Blocker](#5-feature-3-site-blocker)
6. [Account Identification](#6-account-identification)
7. [Google Sheet Integration](#7-google-sheet-integration)
8. [Tamper Resistance](#8-tamper-resistance)
9. [File Reference](#9-file-reference)
10. [Configuration](#10-configuration)

---

## 1. Overview

The extension has three jobs:

1. **Track active Reddit time** per account per day and sync it to a Google Sheet
2. **Hide video posts** from Reddit feeds so the worker focuses on text/image content
3. **Block all non-Reddit sites** so the worker can't browse YouTube, social media, etc. during warmup

It runs inside AdsPower browser profiles. Each profile has a different Reddit account logged in. The extension auto-detects which Reddit account it's running in by reading the username from the page.

---

## 2. Architecture

```
                          REDDIT PAGE (reddit.com)
                                  |
                    +-------------+-------------+
                    |             |              |
              content.js    video_hider.js    (page DOM)
              - username    - hides video       |
              - engagement    posts              |
              - heartbeats                       |
                    |                            |
                    v                            |
             background.js (Service Worker)      |
             - receives heartbeats               |
             - calculates active time            |
             - checks if Reddit is focused tab   |
             - syncs to Google Sheet             |
             - blocks non-whitelisted sites      |
                    |
                    v
         Google Apps Script Webhook
             - receives POST data
             - upserts into Raw Logs
             - updates Dashboard colors
                    |
                    v
            Google Sheet
             - Dashboard (calendar grid)
             - Raw Logs (detailed data)
             - Account Map (username->label)
```

---

## 3. Feature 1: Time Tracking

### How It Decides to Count Time

Time tracking is **heartbeat-driven**. The content script sends a heartbeat to the background every 30 seconds. Each heartbeat contains engagement data. The background decides whether to count those 30 seconds.

**Two conditions must BOTH be true to count time:**

| Condition | How it's checked | What it catches |
|---|---|---|
| **User is engaged** | Content script tracks scroll, click, and keyboard events. If none happened in the last 120 seconds, user is "not engaged" | Person opens Reddit and walks away. Person stares at screen without interacting. |
| **Reddit is the active focused tab** | Background calls `chrome.tabs.query({ active: true, lastFocusedWindow: true })` and checks if the URL matches `reddit.com` | Reddit open in background tab while watching YouTube. Browser minimized. |

### The Heartbeat System

The content script (`content.js`) runs on every Reddit page. It:

1. Listens for `scroll`, `click`, and `keydown` events on the page
2. Records the timestamp of the most recent event (`lastEventAt`)
3. Every 30 seconds, sends a heartbeat message to the background:

```
{
  type: 'ENGAGEMENT_HEARTBEAT',
  scrolls: 5,              // scroll events since last heartbeat (throttled: max 1 per 2s)
  clicks: 2,               // click events since last heartbeat
  pageNavs: 1,             // SPA page navigations since last heartbeat
  secsSinceLastEvent: 12,  // seconds since the last scroll/click/keypress
  timestamp: 1712345678000 // Date.now() when heartbeat was sent
}
```

On the very first user interaction (scroll/click/keypress), an **immediate heartbeat** is sent instead of waiting 30 seconds. This ensures tracking starts as soon as the user engages.

### How the Background Processes Heartbeats

When `background.js` receives a heartbeat:

```
1. Is secsSinceLastEvent <= 120 seconds?
   NO  -> User is idle. Set ENGAGED=false. Reset heartbeat anchor. Stop.
   YES -> Continue...

2. Is Reddit the active tab in the focused window?
   NO  -> Not on Reddit. Set ENGAGED=false. Reset heartbeat anchor. Stop.
   YES -> Continue...

3. Both checks passed. Calculate elapsed time:
   - Look at LAST_ACTIVE_HEARTBEAT (timestamp of previous active heartbeat)
   - elapsed = current_timestamp - LAST_ACTIVE_HEARTBEAT
   - If elapsed > 45 seconds: set to 0 (gap too large, was inactive)
   - If elapsed < 0: set to 0 (clock skew)
   - Add elapsed to SECONDS total

4. Update LAST_ACTIVE_HEARTBEAT = current timestamp
5. Update cumulative clicks, scrolls, page navigation counts
```

### Why 120 Seconds for Engagement Timeout?

Normal Reddit browsing involves reading long posts. A user might:
- Open a text post and read it for 90 seconds without scrolling
- Read a long comment thread, scrolling occasionally
- Click into a post, read it for a minute, then scroll to comments

A 60-second timeout (our original value) flagged normal reading as "idle." 120 seconds is generous enough for reading but still catches someone who opens Reddit and walks away.

### What Counts as Engagement

| Action | Counts? | Details |
|---|---|---|
| Scrolling the page | YES | Throttled to 1 event per 2 seconds to avoid inflated numbers |
| Clicking anywhere on Reddit | YES | Every click counts (links, upvotes, posts, comments) |
| Typing (comments, search) | YES | Throttled to 1 event per 2 seconds |
| Mouse movement without clicking | NO | Moving the mouse is not engagement |
| Having Reddit open in background | NO | Tab must be active and window must be focused |
| Reddit open but no interaction for 2+ min | NO | Engagement timeout catches this |
| Using old.reddit.com | YES | Both old and new Reddit are supported |

### Idle Detection Scenarios

**Scenario 1: Worker opens Reddit and walks away**
```
T=0s    Opens Reddit. Content script loads.
T=1s    Initial heartbeat: secsSinceLastEvent=9999 (no interaction ever)
        -> ENGAGED=false. Timer stays at 0.
T=31s   Heartbeat: secsSinceLastEvent=9999. Still no interaction.
        -> ENGAGED=false. Nothing counted.
...     Timer stays at 0 forever until they actually scroll/click.
```

**Scenario 2: Worker browses Reddit normally**
```
T=0s    Opens Reddit, starts scrolling.
T=2s    First scroll. Immediate heartbeat: secsSinceLastEvent=0.
        -> ENGAGED=true. LAST_ACTIVE_HEARTBEAT=T=2.
T=32s   Heartbeat: secsSinceLastEvent=5 (scrolled at T=27).
        -> elapsed = 32-2 = 30s. SECONDS += 30. Total: 30s.
T=62s   Heartbeat: secsSinceLastEvent=10 (clicked at T=52).
        -> elapsed = 30s. SECONDS += 30. Total: 60s.
...     Every 30 seconds, ~30 seconds are added. Accurate to within a few seconds.
```

**Scenario 3: Worker reads a long post (no scroll for 90 seconds)**
```
T=0s    Scrolling feed, clicks into a long post.
T=10s   Last scroll event.
T=40s   Heartbeat: secsSinceLastEvent=30. Still under 120s threshold.
        -> ENGAGED=true. 30 seconds counted.
T=70s   Heartbeat: secsSinceLastEvent=60. Still under 120s.
        -> ENGAGED=true. 30 seconds counted.
T=100s  Heartbeat: secsSinceLastEvent=90. Still under 120s.
        -> ENGAGED=true. 30 seconds counted.
T=130s  Heartbeat: secsSinceLastEvent=120. Equals threshold.
        -> 120 <= 120 is TRUE. ENGAGED=true. 30 seconds counted.
T=160s  Heartbeat: secsSinceLastEvent=150. Over threshold.
        -> ENGAGED=false. Not counted. Heartbeat anchor reset.
```
Result: Worker gets credit for the reading time up to ~2 minutes. After 2 minutes of zero interaction, tracking pauses.

**Scenario 4: Worker switches to another tab**
```
T=0s    Browsing Reddit, timer is counting.
T=30s   Switches to YouTube tab.
T=31s   Heartbeat fires from Reddit content script.
        secsSinceLastEvent=5 (was scrolling at T=26).
        -> ENGAGED check: YES (5 <= 120).
        -> Reddit active tab check: NO (YouTube is the active tab).
        -> Not counted. Heartbeat anchor reset.
T=60s   Heartbeat: same result. Not counted.
T=120s  Switches back to Reddit, scrolls.
        Immediate heartbeat: secsSinceLastEvent=0.
        -> Both checks pass. Counting resumes.
```

**Scenario 5: Worker minimizes the browser**
```
When the browser window loses focus, chrome.tabs.query with
lastFocusedWindow returns the last focused window. If no window
is focused (all minimized), the query may return no results.
-> isRedditActive = false. Not counted.
Additionally, scroll/click events don't fire when the window is
not visible, so secsSinceLastEvent grows and engagement fails too.
```

### Session Tracking

A "session" is a continuous period of Reddit engagement. A new session starts when:
- The gap between the current heartbeat and the last active heartbeat exceeds 180 seconds (3 minutes)
- This happens when the worker takes a break, switches profiles, etc.

The session count appears in the Raw Logs sheet. Patterns like "15 minutes, 1 session, 0 page navigations" every single day could indicate automation.

### Data Sync to Google Sheet

Every 2 minutes, the background POSTs the cumulative daily totals to the Google Apps Script webhook:

```json
{
  "reddit_username": "Heavy_Foundation_956",
  "date": "2026-04-05",
  "reddit_seconds": 847,
  "first_active": "2026-04-05T09:12:33Z",
  "last_active": "2026-04-05T09:26:40Z",
  "session_count": 2,
  "total_clicks": 45,
  "total_scrolls": 120,
  "total_page_navs": 8,
  "extension_version": "1.3.0",
  "timestamp": "2026-04-05T09:30:00Z",
  "auth_token": "reddit-tracker-2026-xyz"
}
```

This is an **upsert** (update or insert). For the same username + date, the existing row is overwritten. So the sheet always shows the latest cumulative total, not incremental updates. This makes the system idempotent: duplicate syncs are harmless.

If the sync fails (network error, proxy blocks Google), the payload is queued in `chrome.storage.local` and retried on the next successful sync. Up to 100 failed payloads are kept.

### Popup Display

The popup shows a live-interpolated timer that counts every second:
- It fetches the stored `seconds` total from the background every 3 seconds
- Between fetches, it adds `(now - lastActiveHeartbeat)` to simulate smooth counting
- This interpolation only runs when the user is engaged (green "TRACKING" badge)
- When paused, the timer freezes at the last known value

The popup also shows: clicks, scrolls, sessions, last sync time, pending sync count, and a progress bar toward the 15-minute daily target.

---

## 4. Feature 2: Video Post Hider

**File:** `video_hider.js` (content script, runs on all reddit.com pages)

### Purpose

Hides all video posts from Reddit feeds so the worker only sees text and image content. This keeps the warmup focused on engagement that matters (reading, commenting) rather than passively watching videos.

### How It Works

The script runs three detection passes:

**New Reddit** (`shreddit-post` web components):
1. Checks for video player elements: `shreddit-player`, `video`, media slots
2. Checks the `post-type` attribute: hides if `"video"` or `"gif"`
3. Checks the `content-href` attribute: hides if it links to a video domain
4. Checks for video thumbnails/embeds in media slots

**Old Reddit** (`.thing.link` elements):
1. Reads the `data-domain` attribute: hides if it matches a video domain
2. Checks for `.video-player` expandos
3. Checks the post title link: hides if it links to a video domain

### Blocked Video Domains

```
v.redd.it, youtube.com, youtu.be, streamable.com,
gfycat.com, twitch.tv, vimeo.com, tiktok.com,
dailymotion.com, clips.twitch.tv, medal.tv
```

### Handling Infinite Scroll

Reddit loads new posts as you scroll down. The script handles this with:
1. A `MutationObserver` watching `document.body` for new child elements
2. A `setInterval` every 3 seconds as a safety net
3. Each post is marked with `data-video-checked="1"` to avoid reprocessing

Posts are hidden with `display: none` - they're invisible but still in the DOM (no layout shift).

---

## 5. Feature 3: Site Blocker

**Files:** `background.js` (blocker logic) + `blocked.html` (warning page)

### Purpose

Restricts the worker to only browse Reddit and Google during warmup sessions. Any attempt to visit another site shows a full-screen warning page.

### Whitelisted Sites

| Site | Why allowed |
|---|---|
| `*.reddit.com` | The warmup target |
| `*.google.com` (all regional variants) | For searching Reddit topics |
| `script.google.com` | Extension webhook endpoint |
| `script.googleusercontent.com` | Webhook redirect target |
| `chrome://` pages | Browser settings, extensions page |
| `chrome-extension://` | Extension's own pages (popup, blocked page) |
| `about:` pages | about:blank, etc. |

Everything else is blocked.

### How It Works

Two `chrome.tabs` event listeners in the background:

1. **`chrome.tabs.onUpdated`** - Fires when any tab navigates to a new URL. If the URL doesn't match the whitelist, the tab is redirected to `blocked.html`.

2. **`chrome.tabs.onCreated`** - Fires when a new tab is created. If it has a `pendingUrl` that's not whitelisted, immediately redirect.

### The Blocked Page

When blocked, the user sees:
- A red "Site Blocked" heading
- The URL they tried to visit
- A message: "This website is not allowed during warmup sessions"
- Quick links to go to Reddit or Google

The blocked page is an internal extension page (`chrome-extension://[id]/blocked.html`) served via `web_accessible_resources`.

### URL Matching

Uses regex patterns tested against the full URL:

```javascript
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
```

---

## 6. Account Identification

**File:** `content.js` (Part 1: Username Detection)

### How It Detects the Reddit Account

The extension reads the logged-in username directly from the Reddit page DOM. No cookies, no API calls, no manual input needed.

**Detection methods (tried in order):**

For **New Reddit** (www.reddit.com):
1. `#USER_DROPDOWN_ID > *` - Walk the DOM tree for the first text node (from Reddit Enhancement Suite source)
2. `.header-user-dropdown a[href*="/user/"]` - Profile link in user dropdown
3. Various `faceplate-tracker`, `data-testid`, sidebar, and header selectors
4. Embedded page config (`document.getElementById('data')`)
5. Any `/user/` link in header/nav areas

For **Old Reddit** (old.reddit.com):
1. `#header-bottom-right > span.user > a` - The username link in the top right

### Version Detection

The script detects which Reddit version is loaded:
```javascript
const isOldReddit = !!document.documentElement.getAttribute('xmlns');
```
Old Reddit has an `xmlns` attribute on the `<html>` element. New Reddit doesn't.

### When Detection Runs

- Immediately on page load
- After 2 seconds (for slow-rendering SPAs)
- After 5 seconds (fallback)
- After 10 seconds (last resort)
- On every SPA navigation (MutationObserver watches for URL changes)

### After Extension Reload

When the extension is updated or reloaded, existing content scripts are destroyed. The `onInstalled` handler re-injects `content.js` and `video_hider.js` into all open Reddit tabs using `chrome.scripting.executeScript`.

---

## 7. Google Sheet Integration

### Architecture

```
Extension --(POST JSON)--> Apps Script Webhook --(upsert)--> Google Sheet
```

The webhook is a Google Apps Script deployed as a Web App ("Execute as Me", "Anyone can access"). It receives JSON via POST, validates the auth token, and writes data to the sheet.

### Sheet Structure

**Sheet 1: Dashboard**
- Row 1: Title
- Row 2: Day names (Mon, Tue, Wed...)
- Row 3: Dates (2026-04-01, 2026-04-02...)
- Rows 4-15: Account labels (USA-3, USA-5, etc.)
- Last row: TOTAL (formula: count of accounts meeting 15 min target)
- After date columns: Days OK, Avg Min, Total Min (formulas)
- Cell colors: Green (15+ min), Yellow (10-14 min), Red (< 10 min)

**Sheet 2: Raw Logs**
One row per account per day (upserted on each sync):

| Column | Example | Source |
|---|---|---|
| Reddit Username | Heavy_Foundation_956 | Content script DOM detection |
| Account | USA-3 | Looked up from Account Map sheet |
| Date | 2026-04-05 | Extension local date |
| Seconds | 1033 | Cumulative active seconds |
| Time | 17m 13s | Formatted for readability |
| Minutes | 17.22 | Decimal for formulas |
| First Active | 2026-04-05T09:12:33Z | First engagement of the day |
| Last Active | 2026-04-05T09:26:40Z | Most recent engagement |
| Sessions | 2 | Gaps > 3 min = new session |
| Clicks | 45 | Total clicks on Reddit |
| Scrolls | 120 | Total scroll events (throttled) |
| Pages | 8 | SPA page navigations |
| Version | 1.3.0 | Extension version |
| Synced At | 2026-04-05T09:30:00Z | When this data was sent |

**Sheet 3: Account Map**
Manual mapping table:

| Reddit Username | Account Label | Notes |
|---|---|---|
| Business-Sir-4099 | USA-3 | |
| MaleficentTheory3018 | USA-5 | |

To add a new account: just add a row here. If an unknown username syncs before being added, it's auto-appended with a note "AUTO-ADDED".

### Date Handling

Google Sheets auto-converts date strings like "2026-04-05" into Date objects. The Apps Script handles this with:
```javascript
const cellDate = allData[i][2] instanceof Date
  ? Utilities.formatDate(allData[i][2], Session.getScriptTimeZone(), 'yyyy-MM-dd')
  : String(allData[i][2]);
```

### Monthly Reset

Run `resetDashboardForNewMonth()` from the Apps Script editor on the 1st of each month. It:
1. Renames the current Dashboard to "Dashboard -- Apr 2026" (archive)
2. Creates a fresh Dashboard with the new month's dates
3. Pre-fills account rows from the Account Map

---

## 8. Tamper Resistance

| Threat | Mitigation | Risk |
|---|---|---|
| Worker disables extension | Installed via AdsPower Extensions Center (Team Extensions). Worker's Employee role cannot manage team extensions. | Low |
| Worker opens Reddit but doesn't interact | Engagement tracking requires actual scroll/click events within 120 seconds. Just opening the page doesn't count. | Low |
| Worker modifies extension code | Extension is synced from AdsPower cloud. Worker can't edit source files without admin access. | Low |
| Worker blocks webhook requests | Failed syncs are queued and retried. Missing data for a day is itself a red flag. | Low |
| Worker wiggles mouse without scrolling/clicking | Mouse movement does NOT count as engagement. Must scroll, click, or type. | Low |
| Worker uses auto-scroller script | The session count, clicks/minute ratio, and page navigation count reveal patterns. A single 15-min session with 0 clicks and 200 scrolls is suspicious. | Medium |
| Worker visits non-Reddit sites | Site blocker redirects to warning page. Only reddit.com and google.com are allowed. | Low |
| Worker watches Reddit videos instead of engaging | Video hider removes all video posts from the feed. Only text and image posts are visible. | Low |

---

## 9. File Reference

```
extension/
  manifest.json       Manifest V3 config: permissions, content scripts, service worker
  background.js       Service worker: heartbeat processing, time tracking, sync, site blocker
  content.js          Content script: username detection, engagement tracking, heartbeats
  video_hider.js      Content script: hides video posts from Reddit feeds
  popup.html          Extension popup: dark-themed status display with live timer
  popup.js            Popup logic: fetches state, interpolates timer, renders UI
  blocked.html        Warning page shown when worker tries to visit a blocked site
  icons/              Extension icons (16, 48, 128px)

apps-script/
  Code.gs             Google Apps Script: webhook handler, sheet management, dashboard

Reddit_Warmup_Tracker_Template.xlsx   Upload to Google Sheets as starting template
```

---

## 10. Configuration

### Extension Config (background.js, top of file)

| Constant | Default | Description |
|---|---|---|
| `WEBHOOK_URL` | (your deploy URL) | Google Apps Script web app URL |
| `AUTH_TOKEN` | `reddit-tracker-2026-xyz` | Shared secret, must match Apps Script |
| `SYNC_INTERVAL_MIN` | `2` | Minutes between webhook syncs |
| `ENGAGE_TIMEOUT_SEC` | `120` | Seconds without scroll/click before pausing |
| `SESSION_GAP_SEC` | `180` | Seconds gap to start a new session |
| `VERSION` | `1.3.0` | Extension version sent in payload |

### Apps Script Config (Code.gs, line 6)

| Constant | Description |
|---|---|
| `AUTH_TOKEN` | Must match the extension's AUTH_TOKEN |

### Adding a New Account

1. Open the Google Sheet
2. Go to the **Account Map** tab
3. Add a row: `Reddit Username` | `Account Label`
4. Done. Next sync from that account auto-appears on the Dashboard.

### Monthly Dashboard Reset

1. Open the Google Sheet
2. Go to **Extensions > Apps Script**
3. Select `resetDashboardForNewMonth` from the function dropdown
4. Click Run
5. Old dashboard is archived, new one is created with fresh dates
