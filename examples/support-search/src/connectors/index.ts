/**
 * The connector registry — the "plugin" seam of this extension.
 *
 * A connector is one object: an id, a display label + dot color, and a
 * search function that takes the bridge + query + stored credentials and
 * returns a normalized SourceResult. The panel renders toggles, runs
 * searches, and paints status pills purely by iterating CONNECTORS — it has
 * no per-source code.
 *
 * To add a source:
 *   1. Write src/connectors/<name>.ts returning a SourceResult (copy the one
 *      whose auth model matches: slack/zendesk/jira = session-riding,
 *      intercom/linear = pasted token).
 *   2. Add its id to the Source union in shared.ts (+ any credential fields).
 *   3. Register it in CONNECTORS below.
 *   4. Allow its host in src/worker.ts AND manifest.json host_permissions.
 *   5. If it needs a pasted setting, add the field to panel.html + panel.ts.
 *
 * Each source is independent: different hosts (so the per-host rate limiter
 * never makes them contend), and one failing source never sinks the others —
 * every search function resolves to a SourceResult, it never rejects.
 *
 * NOTE on pacing (KB: batch pacing is caller-owned): each connector fires ONE
 * request per search, so there's nothing to pace here. If you extend a
 * connector to fan out (e.g. fetch each Intercom conversation's full thread),
 * wrap that fan-out in `mapWithConcurrency(items, 4, fn)` from the library —
 * the worker's limiter refuses excess requests, it does not queue them.
 */

import type { BridgeClient } from 'mv3-fetch-bridge';
import { type Credentials, type Source, type SourceResult } from '../shared.js';
import { searchIntercom } from './intercom.js';
import { searchSlack } from './slack.js';
import { searchLinear } from './linear.js';
import { searchZendesk } from './zendesk.js';
import { searchJira } from './jira.js';

export interface Connector {
  id: Source;
  label: string;
  /** Dot color in the panel UI. */
  color: string;
  search(bridge: BridgeClient, query: string, creds: Credentials): Promise<SourceResult>;
}

export const CONNECTORS: Connector[] = [
  {
    id: 'intercom',
    label: 'Intercom',
    color: '#1f8ded',
    search: (b, q, c) => searchIntercom(b, q, c.intercomToken, c.intercomHost),
  },
  {
    id: 'slack',
    label: 'Slack',
    color: '#611f69',
    search: (b, q, c) => searchSlack(b, q, c.slackToken, c.slackTeamUrl),
  },
  {
    id: 'linear',
    label: 'Linear',
    color: '#5e6ad2',
    search: (b, q, c) => searchLinear(b, q, c.linearApiKey),
  },
  {
    id: 'zendesk',
    label: 'Zendesk',
    color: '#03363d',
    search: (b, q, c) => searchZendesk(b, q, c.zendeskSubdomain),
  },
  {
    id: 'jira',
    label: 'Jira',
    color: '#0052cc',
    search: (b, q, c) => searchJira(b, q, c.jiraSiteUrl),
  },
];

export function getConnector(id: Source): Connector {
  const c = CONNECTORS.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown source: ${id}`);
  return c;
}

/** Run the given sources (default: all) for one query; one result per source. */
export async function searchAll(
  bridge: BridgeClient,
  query: string,
  creds: Credentials,
  sources: Source[] = CONNECTORS.map((c) => c.id),
): Promise<SourceResult[]> {
  return Promise.all(sources.map((id) => getConnector(id).search(bridge, query, creds)));
}

export { searchIntercom, searchSlack, searchLinear, searchZendesk, searchJira };
