/**
 * Content script (runs on app.slack.com) that captures the Slack `xoxc-`
 * session token from the web client and stores it for the connector.
 *
 * The token is worthless on its own — it only authenticates paired with the
 * `d` cookie, which the bridge sends from the service worker. So this scrapes
 * ONLY the token string; the actual credential (the cookie) never leaves the
 * browser's jar. Content scripts share the page's DOM, so `localStorage` here
 * is Slack's own storage for app.slack.com.
 *
 * Storage shape (Slack `localConfig_v2`), defensively parsed:
 *   { teams: { <id>: { token: "xoxc-...", url|domain, name } },
 *     lastActiveTeamId | activeTeamId }
 */

const STORAGE_KEY = 'support-search:creds';

interface TeamConfig {
  token?: string;
  url?: string;
  domain?: string;
  name?: string;
}

function readSlackConfig(): { token?: string; teamUrl?: string } {
  try {
    const raw = localStorage.getItem('localConfig_v2');
    if (!raw) return {};
    const cfg = JSON.parse(raw) as {
      teams?: Record<string, TeamConfig>;
      lastActiveTeamId?: string;
      activeTeamId?: string;
    };
    const teams = cfg.teams ?? {};
    const activeId = cfg.lastActiveTeamId ?? cfg.activeTeamId;

    const team =
      (activeId && teams[activeId]) ||
      Object.values(teams).find((t) => typeof t.token === 'string');
    if (!team?.token) return {};

    const teamUrl =
      team.url?.replace(/\/+$/, '') ||
      (team.domain ? `https://${team.domain}.slack.com` : undefined);

    return { token: team.token, teamUrl };
  } catch {
    return {};
  }
}

async function captureToken(): Promise<void> {
  const { token, teamUrl } = readSlackConfig();
  if (!token) return;

  const obj = await chrome.storage.local.get(STORAGE_KEY);
  const creds = (obj[STORAGE_KEY] as Record<string, unknown> | undefined) ?? {};

  // Only write when something actually changed.
  if (creds.slackToken === token && creds.slackTeamUrl === teamUrl) return;

  await chrome.storage.local.set({
    [STORAGE_KEY]: { ...creds, slackToken: token, slackTeamUrl: teamUrl ?? creds.slackTeamUrl },
  });
  console.debug('[support-search] captured Slack token for', teamUrl ?? 'workspace');
}

void captureToken();
