// Video Post Hider — Content script for reddit.com
// Hides all video posts from the feed. Only text and image posts remain visible.

(function () {
  const isOldReddit = !!document.documentElement.getAttribute('xmlns');

  // Domains that host video content
  const VIDEO_DOMAINS = [
    'v.redd.it', 'youtube.com', 'youtu.be', 'streamable.com',
    'gfycat.com', 'twitch.tv', 'vimeo.com', 'tiktok.com',
    'dailymotion.com', 'clips.twitch.tv', 'medal.tv',
  ];

  let hiddenCount = 0;

  // ---- NEW REDDIT ----
  function hideNewRedditVideos() {
    // shreddit-post is the web component for posts on new Reddit
    document.querySelectorAll('shreddit-post:not([data-video-checked])').forEach(post => {
      post.setAttribute('data-video-checked', '1');

      // Check 1: Has a video player element
      if (post.querySelector('shreddit-player, shreddit-player-2, video, [data-click-id="media"] video')) {
        hidePost(post);
        return;
      }

      // Check 2: Post type attribute
      const postType = post.getAttribute('post-type');
      if (postType === 'video' || postType === 'gif') {
        hidePost(post);
        return;
      }

      // Check 3: Link to a video domain
      const permalink = post.getAttribute('permalink') || '';
      const contentHref = post.getAttribute('content-href') || '';
      if (isVideoDomain(contentHref)) {
        hidePost(post);
        return;
      }

      // Check 4: Has a video thumbnail/embed
      if (post.querySelector('[slot="video-player"], [slot="media"] video')) {
        hidePost(post);
        return;
      }
    });

    // Also check for article/div based post containers (Reddit A/B tests layouts)
    document.querySelectorAll('article:not([data-video-checked])').forEach(article => {
      article.setAttribute('data-video-checked', '1');
      if (article.querySelector('video, shreddit-player, [data-click-id="media"] video')) {
        hidePost(article);
      }
    });
  }

  // ---- OLD REDDIT ----
  function hideOldRedditVideos() {
    document.querySelectorAll('.thing.link:not([data-video-checked])').forEach(post => {
      post.setAttribute('data-video-checked', '1');

      // Check 1: data-domain attribute
      const domain = (post.getAttribute('data-domain') || '').toLowerCase();
      if (VIDEO_DOMAINS.some(vd => domain.includes(vd))) {
        hidePost(post);
        return;
      }

      // Check 2: Has video expando
      const expando = post.querySelector('.expando .video-player, .expando video');
      if (expando) {
        hidePost(post);
        return;
      }

      // Check 3: Reddit hosted video (v.redd.it)
      const link = post.querySelector('a.title');
      if (link && isVideoDomain(link.href)) {
        hidePost(post);
        return;
      }
    });
  }

  function isVideoDomain(url) {
    if (!url) return false;
    const lower = url.toLowerCase();
    return VIDEO_DOMAINS.some(d => lower.includes(d));
  }

  function hidePost(el) {
    el.style.display = 'none';
    hiddenCount++;
  }

  // ---- MAIN LOOP ----
  function scan() {
    if (isOldReddit) {
      hideOldRedditVideos();
    } else {
      hideNewRedditVideos();
    }
  }

  // Run immediately
  scan();

  // Watch for new posts (infinite scroll / SPA navigation)
  const observer = new MutationObserver(() => {
    scan();
  });

  const target = document.body || document.documentElement;
  observer.observe(target, { childList: true, subtree: true });

  // Also run periodically as a safety net (some posts load lazily)
  setInterval(scan, 3000);
})();
