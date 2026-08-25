/**
 * Zendesk connector — ticket search, session-ridden.
 *
 * Auth: Zendesk's REST API accepts the agent's session cookie for same-origin
 * GETs, so a logged-in agent needs NO token: the bridge fetches
 * `<sub>.zendesk.com/api/v2/search.json` with credentials:'include' and the
 * session rides along. Only the subdomain is configured. A 401 here really
 * means "not signed into Zendesk in this browser" (conventional status codes,
 * unlike Slack/Linear).
 *
 * The subdomain is validated to the same shape the worker's anchored
 * allowlist pattern accepts — a full URL or stray dot pasted into settings
 * must fail loudly here, not surface as a confusing "blocked" from the worker.
 */

import type { BridgeClient } from 'mv3-fetch-bridge';
import {
  bridgeErrorToState,
  truncate,
  type SearchResult,
  type SourceResult,
} from '../shared.js';

interface ZendeskTicket {
  id: number;
  subject?: string;
  description?: string;
  created_at?: string; // ISO 8601
  updated_at?: string;
  status?: string;
  via?: { channel?: string };
}

interface ZendeskSearchResponse {
  results?: ZendeskTicket[];
  count?: number;
  error?: string;
  description?: string;
}

function fail(state: SourceResult['state'], message: string): SourceResult {
  return { source: 'zendesk', state, results: [], message };
}

export async function searchZendesk(
  bridge: BridgeClient,
  query: string,
  subdomain: string | undefined,
): Promise<SourceResult> {
  if (!subdomain) return fail('unconfigured', 'Add your Zendesk subdomain in settings.');
  if (!/^[a-z0-9-]+$/i.test(subdomain)) {
    return fail('error', `Zendesk subdomain should be just the name (e.g. "acme"), got "${subdomain}".`);
  }

  const base = `https://${subdomain.toLowerCase()}.zendesk.com`;
  const params = new URLSearchParams({
    query: `${query} type:ticket`,
    per_page: '20',
    sort_by: 'updated_at',
    sort_order: 'desc',
  });

  const res = await bridge.fetch(`${base}/api/v2/search.json?${params}`, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) return fail(bridgeErrorToState(res.errorType), res.error);

  if (res.status === 401 || res.status === 403) {
    return fail('auth', `Not signed into ${subdomain}.zendesk.com in this browser — open it and log in.`);
  }
  if (res.status < 200 || res.status >= 300) {
    const detail = (res.data as ZendeskSearchResponse)?.description;
    return fail('error', `Zendesk HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  const data = res.data as ZendeskSearchResponse;
  const results: SearchResult[] = (data.results ?? []).map((t) => ({
    source: 'zendesk',
    id: String(t.id),
    title: t.subject?.trim() || `Ticket #${t.id}`,
    snippet: truncate(t.description ?? ''),
    url: `${base}/agent/tickets/${t.id}`,
    timestamp: t.updated_at ? Date.parse(t.updated_at) || undefined : undefined,
    author: t.via?.channel,
    status: t.status,
  }));

  return { source: 'zendesk', state: 'ok', results };
}
