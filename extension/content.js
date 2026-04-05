// Content script — runs on reddit.com pages
// 1) Extracts logged-in Reddit username from DOM
// 2) Tracks real engagement (scrolls, clicks, navigation) and sends heartbeats

(function () {
  // ================================================================
  // PART 1: USERNAME DETECTION
  // Selectors sourced from Reddit Enhancement Suite (RES)
  // ================================================================

  const isOldReddit = !!document.documentElement.getAttribute('xmlns');

  function getRedditUsername() {
    return isOldReddit ? getOldRedditUsername() : getNewRedditUsername();
  }

  // OLD REDDIT: '#header-bottom-right > span.user > a'
  function getOldRedditUsername() {
    const link = document.querySelector('#header-bottom-right > span.user > a');
    if (link && !link.classList.contains('login-required')) {
      const match = link.pathname.match(/\/user\/([\w\-]+)/);
      if (match) return match[1];
      const text = link.textContent.trim();
      if (text && text !== 'login' && text !== 'register') return text;
    }
    return null;
  }

  // NEW REDDIT: '#USER_DROPDOWN_ID > *' → first text node
  function getNewRedditUsername() {
    // Method 1: USER_DROPDOWN_ID (from RES — most reliable)
    const button = document.querySelector('#USER_DROPDOWN_ID > *');
    if (button) {
      const textNode = findFirstTextNode(button);
      if (textNode) {
        const text = textNode.textContent.trim();
        if (text && text.length > 0 && !text.includes(' ')) return text;
      }
    }

    // Method 2: header-user-dropdown
    const dropdown = document.querySelector('.header-user-dropdown');
    if (dropdown) {
      const link = dropdown.querySelector('a[href*="/user/"]');
      if (link) {
        const match = link.getAttribute('href').match(/\/user\/([\w\-]+)/);
        if (match) return match[1];
      }
    }

    // Method 3: Various profile link selectors
    const profileSelectors = [
      'faceplate-tracker[noun="profile"] a[href*="/user/"]',
      'a[data-testid="user-profile-link"]',
      'header a[href*="/user/"][href*="/me"]',
      '#left-sidebar a[href*="/user/"]',
      'shreddit-header a[href*="/user/"]',
    ];
    for (const sel of profileSelectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const href = el.getAttribute('href') || '';
      const match = href.match(/\/user\/([\w\-]+)/);
      if (match) return match[1];
    }

    // Method 4: Embedded config
    try {
      const dataEl = document.getElementById('data');
      if (dataEl) {
        const data = JSON.parse(dataEl.textContent);
        if (data?.user?.session?.username) return data.user.session.username;
      }
    } catch (e) { /* not available */ }

    // Method 5: Any /user/ link in header/nav area
    const headerAreas = document.querySelectorAll('header, nav, [role="banner"]');
    for (const area of headerAreas) {
      const links = area.querySelectorAll('a[href*="/user/"]');
      for (const link of links) {
        const match = (link.getAttribute('href') || '').match(/\/user\/([\w\-]+)/);
        if (match) return match[1];
      }
    }

    return null;
  }

  function findFirstTextNode(el) {
    const textNodes = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim());
    if (textNodes.length) return textNodes[0];
    for (const child of el.children) {
      const found = findFirstTextNode(child);
      if (found) return found;
    }
    return null;
  }

  function sendUsername() {
    const username = getRedditUsername();
    if (username) {
      chrome.runtime.sendMessage({ type: 'REDDIT_USERNAME', username });
    }
  }

  sendUsername();
  setTimeout(sendUsername, 2000);
  setTimeout(sendUsername, 5000);
  setTimeout(sendUsername, 10000);

  // SPA navigation watcher
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      engagement.pageNavs++;
      setTimeout(sendUsername, 1500);
    }
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  // ================================================================
  // PART 2: ENGAGEMENT TRACKING
  // Tracks scrolls, clicks, and page navigations.
  // Sends a heartbeat to the background every 30 seconds.
  // If no engagement for 60s, background pauses time counting.
  // ================================================================

  const engagement = {
    scrolls: 0,
    clicks: 0,
    pageNavs: 0,
    lastEventAt: 0,  // FIX: start at 0, not Date.now() — no free credit on page load
    hadInteraction: false,  // true once user actually does something
  };

  function onEngagement() {
    engagement.lastEventAt = Date.now();
    // Send an immediate heartbeat on first interaction (don't wait 30s)
    if (!engagement.hadInteraction) {
      engagement.hadInteraction = true;
      sendHeartbeat();
    }
  }

  // Throttled scroll counter — 1 per 2 seconds max
  let lastScrollTime = 0;
  document.addEventListener('scroll', () => {
    const now = Date.now();
    if (now - lastScrollTime > 2000) {
      engagement.scrolls++;
      lastScrollTime = now;
      onEngagement();
    }
  }, { passive: true });

  // Click counter
  document.addEventListener('click', () => {
    engagement.clicks++;
    onEngagement();
  }, { passive: true });

  // Keyboard activity (typing comments, searching)
  let lastKeyTime = 0;
  document.addEventListener('keydown', () => {
    const now = Date.now();
    if (now - lastKeyTime > 2000) {
      lastKeyTime = now;
      onEngagement();
    }
  }, { passive: true });

  function sendHeartbeat() {
    const now = Date.now();
    const secsSinceLastEvent = engagement.lastEventAt === 0
      ? 9999  // no interaction ever — report as very stale
      : Math.round((now - engagement.lastEventAt) / 1000);

    chrome.runtime.sendMessage({
      type: 'ENGAGEMENT_HEARTBEAT',
      scrolls: engagement.scrolls,
      clicks: engagement.clicks,
      pageNavs: engagement.pageNavs,
      secsSinceLastEvent,
      timestamp: now,
    });

    engagement.scrolls = 0;
    engagement.clicks = 0;
    engagement.pageNavs = 0;
  }

  // Regular heartbeat every 30 seconds
  setInterval(sendHeartbeat, 30000);

  // Also send a heartbeat immediately on script load (so background knows we're alive)
  // secsSinceLastEvent will be 9999 (no interaction yet) so it won't grant free time
  setTimeout(sendHeartbeat, 1000);

})();
