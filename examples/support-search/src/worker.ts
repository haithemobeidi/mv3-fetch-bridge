/**
 * Background service worker.
 *
 * Its ONLY job is to host the fetch bridge: it validates each URL against the
 * allowlist, applies per-host rate limiting + timeouts, performs the fetch
 * with the user's cookies, and answers. The search logic lives in the side
 * panel — deliberately, because an MV3 worker is killed after ~30s idle and
 * must not own anything long-running.
 */

import { createFetchBridge } from 'mv3-fetch-bridge';

const bridge = createFetchBridge({
  allowlist: {
    hosts: [
      // Intercom API regions.
      'api.intercom.io',
      'api.eu.intercom.io',
      'api.au.intercom.io',
      // Slack marketing host (xoxc also works against the workspace host below).
      'slack.com',
      // Linear GraphQL.
      'api.linear.app',
    ],
    // Slack/Zendesk/Jira live on per-company subdomains. ANCHOR every
    // pattern — an unanchored /slack\.com/ would match slack.com.evil.net.
    hostPatterns: [
      /^[a-z0-9-]+\.slack\.com$/i,
      /^[a-z0-9-]+\.zendesk\.com$/i,
      /^[a-z0-9-]+\.atlassian\.net$/i,
    ],
  },

  // These APIs answer auth failures with a JSON error body, not a login
  // redirect (Slack: 200 {ok:false}; Linear: 200 errors[]) — connectors
  // classify those. This predicate only catches an actual bounce to a login
  // page, which is still worth flagging cleanly if it ever happens.
  isAuthRedirect: (u) =>
    /\/(signin|login|sign_in|workspace-signin)/i.test(u.pathname),

  // Slack's search tier is strict; keep the per-host ceiling conservative.
  maxRequestsPerMinutePerHost: 30,
  defaultTimeoutMs: 20_000,

  onBlocked: (url, reason) => {
    console.warn(`[support-search] blocked (${reason}):`, url);
  },
});

chrome.runtime.onMessage.addListener(bridge.handleMessage);

// Open the side panel when the toolbar icon is clicked.
chrome.sidePanel
  ?.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn('[support-search] setPanelBehavior failed', err));
