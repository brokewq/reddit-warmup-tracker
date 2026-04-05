# Reddit Warmup Tracker

Passively tracks active Reddit browsing time across AdsPower browser profiles and syncs to Google Sheets.

## How It Works

```
Content Script (reddit.com) → reads logged-in Reddit username from page
Background Service Worker   → tracks active time (1-min alarm ticks, timestamp-based)
                            → POSTs to Google Apps Script every 5 min
Apps Script Webhook         → upserts data into Google Sheet
Google Sheet                → Dashboard auto-colors cells (green/yellow/red)
```

**Account identification:** The extension reads the Reddit username directly from the page DOM. No cookies, no manual input, no AdsPower API needed. Each profile has a different Reddit account logged in, so the username is the unique identifier.

---

## Setup Guide (Step by Step)

### Step 1: Create the Google Sheet

1. Go to [Google Sheets](https://sheets.google.com) → create a new blank spreadsheet
2. Name it **"Reddit Warmup Tracker"**
3. Go to **Extensions → Apps Script**
4. Delete any existing code in `Code.gs`
5. Paste the entire contents of `apps-script/Code.gs`
6. **IMPORTANT:** Change the `AUTH_TOKEN` on line 6 to a random string (e.g., `my-secret-token-abc123`)
7. Save (Ctrl+S)

### Step 2: Run Initial Setup

1. In the Apps Script editor, select **`setupSheets`** from the function dropdown (top bar)
2. Click **Run** (play button)
3. It will ask for authorization — click **Review Permissions → Allow**
4. This creates 3 sheets: **Dashboard**, **Raw Logs**, **Account Map**

### Step 3: Deploy the Webhook

1. In Apps Script, click **Deploy → New deployment**
2. Click the gear icon → select **Web app**
3. Set:
   - **Description:** `Warmup Tracker v1`
   - **Execute as:** `Me`
   - **Who has access:** `Anyone`
4. Click **Deploy**
5. **Copy the Web app URL** — you'll need this next

### Step 4: Configure the Extension

1. Open `extension/background.js`
2. Update these two values at the top:
   ```javascript
   WEBHOOK_URL: 'https://script.google.com/macros/s/YOUR_DEPLOY_ID/exec',  // paste your URL
   AUTH_TOKEN: 'my-secret-token-abc123',  // must match Apps Script
   ```
3. Save the file

### Step 5: Install in AdsPower

1. Zip the entire `extension/` folder (select all files inside, not the folder itself)
2. In AdsPower, go to **Extensions → Team Extensions → Upload**
3. Upload the `.zip` file
4. Create a category called **"Tracking"** and assign this extension
5. Apply the "Tracking" category to all 13 profiles:
   - Select all profiles → **Edit → Extensions → add "Tracking"**

### Step 6: Verify It Works

1. Open any AdsPower profile
2. Navigate to reddit.com (make sure the account is logged in)
3. Wait 5 minutes
4. Check your Google Sheet — you should see data in **Raw Logs** and the **Dashboard**

---

## File Structure

```
reddit tracking extension/
├── extension/              ← Chrome extension (zip this for AdsPower)
│   ├── manifest.json       ← Extension config (Manifest V3)
│   ├── background.js       ← Service worker: time tracking + webhook sync
│   ├── content.js          ← Content script: reads Reddit username from DOM
│   ├── popup.html          ← Status popup UI (display only, no controls)
│   ├── popup.js            ← Popup logic
│   └── icons/              ← Extension icons
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
├── apps-script/
│   └── Code.gs             ← Google Apps Script webhook code
└── README.md               ← This file
```

## Google Sheet Structure

### Dashboard (auto-generated)
- Rows: Each Reddit account (USA-3 through USA-17)
- Columns: Each day of the month
- Cells: Minutes of active Reddit time
- Colors: Green (15+ min), Yellow (10-14 min), Red (< 10 min), Blank (no data)
- Summary columns: Days Done, Avg Min, Total Min

### Raw Logs
- Every sync event, one row per account per day (upserted)
- Columns: Reddit Username, Account, Date, Seconds, Minutes, First/Last Active, Sessions, Version, Synced At

### Account Map
- Reference table: Reddit Username → Account Label
- Pre-filled with your 12 accounts

---

## Account Mapping

| Reddit Username        | Account Label | AdsPower acc_id |
|------------------------|---------------|-----------------|
| Business-Sir-4099      | USA-3         | 5               |
| MaleficentTheory3018   | USA-5         | 8               |
| West-Treat1116         | USA-6         | 9               |
| Flimsy_Turnip7679      | USA-8         | 11              |
| Spiritual_Some382      | USA-9         | 12              |
| Island_Helpful631      | USA-11        | 14              |
| Camera_Runny429        | USA-12        | 15              |
| Warm_Syllabub_7759     | USA-13        | 16              |
| Bench_Mean456          | USA-14        | 17              |
| Particular-Basil-974   | USA-15        | 21              |
| Ring_Everlastig506     | USA-16        | 22              |
| Notice-Practical254    | USA-17        | 23              |

---

## Tracking Rules

| Condition | Counts as time? |
|-----------|----------------|
| Reddit tab active + focused + user active | YES |
| Reddit open but another tab focused | NO |
| Browser minimized | NO |
| No mouse/keyboard for 2+ minutes | NO |
| old.reddit.com / new.reddit.com / www.reddit.com | YES |

---

## Tamper Resistance

| Threat | Mitigation |
|--------|-----------|
| Worker disables extension | Installed via Team Extensions — worker can't manage |
| Worker opens Reddit but doesn't interact | Idle detection pauses after 120s of no input |
| Worker modifies extension code | Cloud-synced from Extensions Center |
| Worker blocks webhook | Missing data is itself a red flag; extension queues retries |
| Worker runs auto-scroller | Session count reveals suspicious patterns |

---

## Troubleshooting

**No data appearing in sheet:**
- Check that the webhook URL in `background.js` is correct
- Check that AUTH_TOKEN matches in both files
- Open the profile, go to reddit.com, click the extension icon — it should show a username
- Check Apps Script execution logs: Apps Script editor → Executions (left sidebar)

**Username showing as "—":**
- Reddit must be logged in for the content script to find the username
- Try refreshing the reddit page
- Reddit may have changed their DOM — check content.js selectors

**Extension not visible in profile:**
- Make sure the "Tracking" category is applied to the profile
- Restart the profile after adding the extension

**Pending syncs piling up:**
- The profile's proxy may be blocking script.google.com
- Check proxy settings allow outbound HTTPS to Google
