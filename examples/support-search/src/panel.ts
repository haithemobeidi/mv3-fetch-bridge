/**
 * Side-panel UI. Owns the search: builds a bridge client, runs the connectors
 * (which route their fetches through the worker), and renders per-source
 * results with an honest status for each — separating "log in" (auth) from
 * "couldn't reach" (unreachable), per the tri-state rule.
 */

import { createBridgeClient } from 'mv3-fetch-bridge';
import {
  loadCredentials,
  saveCredentials,
  onCredentialsChanged,
  type Credentials,
  type Source,
  type SourceResult,
  type SourceState,
} from './shared.js';
import { CONNECTORS, getConnector } from './connectors/index.js';

const bridge = createBridgeClient();

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const queryInput = $<HTMLInputElement>('query');
const goBtn = $<HTMLButtonElement>('go');
const togglesEl = $<HTMLDivElement>('toggles');
const resultsEl = $<HTMLDivElement>('results');

// Everything below renders off the CONNECTORS registry — adding a source in
// connectors/index.ts needs no panel changes beyond a settings field.
const scope = Object.fromEntries(CONNECTORS.map((c) => [c.id, true])) as Record<Source, boolean>;

/** Bumps on each new search so stale in-flight results are ignored. */
let searchToken = 0;

// --- Source toggle buttons (buttons + aria-pressed, NOT a radio group: arrow
//     keys through radios would commit a source the user never chose) --------
for (const connector of CONNECTORS) {
  const btn = document.createElement('button');
  btn.className = 'toggle';
  btn.textContent = connector.label;
  btn.setAttribute('aria-pressed', 'true');
  btn.addEventListener('click', () => {
    scope[connector.id] = !scope[connector.id];
    btn.setAttribute('aria-pressed', String(scope[connector.id]));
  });
  togglesEl.appendChild(btn);
}

// --- Rendering -------------------------------------------------------------
function fmtTime(ms?: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const now = Date.now();
  const days = Math.floor((now - ms) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function pillText(r: SourceResult): { text: string; cls: SourceState } {
  switch (r.state) {
    case 'ok':
      return { text: r.results.length ? `${r.results.length} result${r.results.length === 1 ? '' : 's'}` : 'no matches', cls: 'ok' };
    case 'unconfigured':
      return { text: 'not set up', cls: 'unconfigured' };
    case 'auth':
      return { text: 'sign in', cls: 'auth' };
    case 'unreachable':
      return { text: 'unreachable', cls: 'unreachable' };
    case 'error':
      return { text: 'error', cls: 'error' };
  }
}

function renderGroup(source: Source, r: SourceResult | 'loading'): void {
  const existing = document.getElementById(`group-${source}`);
  const group = existing ?? document.createElement('section');
  group.id = `group-${source}`;
  group.className = 'group';
  group.innerHTML = '';

  const connector = getConnector(source);
  const head = document.createElement('div');
  head.className = 'groupHead';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = connector.color;
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = connector.label;
  head.append(dot, name);

  const pill = document.createElement('span');
  if (r === 'loading') {
    pill.className = 'pill';
    pill.textContent = 'searching…';
  } else {
    const p = pillText(r);
    pill.className = `pill ${p.cls}`;
    pill.textContent = p.text;
  }
  head.appendChild(pill);
  group.appendChild(head);

  if (r !== 'loading') {
    if (r.state !== 'ok' && r.message) {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = r.message;
      if (source === 'slack' && (r.state === 'unconfigured' || r.state === 'auth')) {
        const b = document.createElement('button');
        b.textContent = 'Open Slack';
        b.addEventListener('click', () => openSlack());
        note.appendChild(b);
      }
      group.appendChild(note);
    }
    for (const hit of r.results) {
      const a = document.createElement('a');
      a.className = 'card';
      a.href = hit.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';

      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = hit.title;
      a.appendChild(title);

      if (hit.snippet) {
        const s = document.createElement('p');
        s.className = 'snippet';
        s.textContent = hit.snippet;
        a.appendChild(s);
      }

      const metaBits = [hit.author, hit.status, fmtTime(hit.timestamp)].filter(Boolean);
      if (metaBits.length) {
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = metaBits.join(' · ');
        a.appendChild(meta);
      }
      group.appendChild(a);
    }
  }

  if (!existing) resultsEl.appendChild(group);
}

// --- Search ----------------------------------------------------------------
async function runSearch(): Promise<void> {
  const query = queryInput.value.trim();
  if (!query) return;

  const enabled = CONNECTORS.filter((c) => scope[c.id]);
  if (enabled.length === 0) {
    resultsEl.innerHTML = '<div class="empty">Enable at least one source above.</div>';
    return;
  }

  const token = ++searchToken;
  goBtn.disabled = true;
  resultsEl.innerHTML = '';
  for (const c of enabled) renderGroup(c.id, 'loading');

  const creds = await loadCredentials();

  // Fire all enabled sources at once (distinct hosts — no rate-limit contention)
  // and render each as it lands, so a slow source never blocks a fast one.
  await Promise.all(
    enabled.map(async (connector) => {
      let result: SourceResult;
      try {
        result = await connector.search(bridge, query, creds);
      } catch (err) {
        result = { source: connector.id, state: 'error', results: [], message: (err as Error)?.message ?? 'Unexpected error' };
      }
      if (token === searchToken) renderGroup(connector.id, result);
    }),
  );

  if (token === searchToken) goBtn.disabled = false;
}

goBtn.addEventListener('click', () => void runSearch());
queryInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void runSearch();
});

// --- Settings --------------------------------------------------------------
// Pasted text settings: input id in panel.html === key in Credentials. Adding
// a field there and listing it here is the whole wiring.
const TEXT_SETTINGS = [
  'intercomToken',
  'linearApiKey',
  'zendeskSubdomain',
  'jiraSiteUrl',
] as const;

const settingInput = (key: (typeof TEXT_SETTINGS)[number]): HTMLInputElement => $<HTMLInputElement>(key);
const slackStatus = $<HTMLDivElement>('slackStatus');
const savedMsg = $<HTMLSpanElement>('savedMsg');

function renderSlackStatus(creds: Credentials): void {
  if (creds.slackToken) {
    const where = creds.slackTeamUrl ? ` (${creds.slackTeamUrl.replace('https://', '')})` : '';
    slackStatus.textContent = `Token captured${where}.`;
    slackStatus.style.color = 'var(--ok)';
  } else {
    slackStatus.textContent = 'Not captured yet — open your Slack workspace in a tab.';
    slackStatus.style.color = 'var(--muted)';
  }
}

function openSlack(): void {
  window.open('https://app.slack.com/client', '_blank', 'noopener');
}
$<HTMLButtonElement>('openSlack').addEventListener('click', openSlack);

$<HTMLButtonElement>('save').addEventListener('click', async () => {
  const patch: Partial<Credentials> = {};
  for (const key of TEXT_SETTINGS) {
    patch[key] = settingInput(key).value.trim() || undefined;
  }
  await saveCredentials(patch);
  savedMsg.hidden = false;
  setTimeout(() => (savedMsg.hidden = true), 1500);
});

async function initSettings(): Promise<void> {
  const creds = await loadCredentials();
  for (const key of TEXT_SETTINGS) {
    settingInput(key).value = creds[key] ?? '';
  }
  renderSlackStatus(creds);
}

// Live-update the Slack status when the content script captures a token.
onCredentialsChanged(renderSlackStatus);

void initSettings();
queryInput.focus();
