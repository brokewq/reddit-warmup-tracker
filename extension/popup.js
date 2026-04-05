function formatTime(totalSeconds) {
  const s = Math.floor(totalSeconds);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function formatSyncTime(iso) {
  if (!iso || iso === 'never') return 'never';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

let lastState = null;

function fetchState() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
    if (!res) return;
    lastState = res;
  });
}

function render() {
  if (!lastState) return;
  const res = lastState;

  document.getElementById('username').textContent = res.username;
  document.getElementById('date').textContent = res.date;
  document.getElementById('sessions').textContent = res.sessionCount;
  document.getElementById('sync').textContent = formatSyncTime(res.lastSync);
  document.getElementById('pending').textContent = res.pendingCount;
  document.getElementById('clicks').textContent = res.clicks;
  document.getElementById('scrolls').textContent = res.scrolls;

  // Live interpolated seconds:
  // If engaged and we have a recent active heartbeat, add elapsed since that heartbeat
  let displaySeconds = res.seconds;
  if (res.engaged && res.lastActiveHeartbeat > 0) {
    const elapsed = (Date.now() - res.lastActiveHeartbeat) / 1000;
    // Only interpolate if reasonable (heartbeat is every 30s)
    if (elapsed >= 0 && elapsed < 45) {
      displaySeconds = res.seconds + elapsed;
    }
  }

  const timerEl = document.getElementById('timer');
  timerEl.textContent = formatTime(displaySeconds);
  const mins = displaySeconds / 60;
  timerEl.className = 'timer' + (mins >= 15 ? '' : mins >= 10 ? ' mid' : ' low');

  const pct = Math.min(100, (mins / 15) * 100);
  const fill = document.getElementById('target-fill');
  fill.style.width = pct + '%';
  fill.className = 'target-fill' + (mins >= 15 ? ' done' : mins >= 10 ? ' mid' : ' low');


  const hasUser = res.username && res.username !== '\u2014';
  const badge = document.getElementById('status-badge');
  if (hasUser && res.engaged) {
    badge.className = 'status-badge tracking';
    badge.textContent = 'TRACKING';
  } else if (hasUser) {
    badge.className = 'status-badge paused';
    badge.textContent = 'PAUSED - NO ENGAGEMENT';
  } else {
    badge.className = 'status-badge offline';
    badge.textContent = 'NO ACCOUNT DETECTED';
  }
}

fetchState();
setInterval(fetchState, 3000);  // fetch data every 3s
setInterval(render, 1000);      // render every 1s for smooth timer
