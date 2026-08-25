/**
 * Jira connector — Cloud issue search via JQL, session-ridden.
 *
 * Auth: Jira Cloud's REST API honors the browser's `cloud.session.token`
 * cookie on the site's own origin (`<site>.atlassian.net`), so a logged-in
 * user needs NO API token — the bridge sends the request with
 * credentials:'include'. A 401 means "not signed into this Jira site".
 *
 * Endpoint: `/rest/api/3/search/jql` — the enhanced-search endpoint. The old
 * `/rest/api/3/search` was removed from Cloud in 2025; if your company runs
 * self-hosted Jira Server/DC instead, switch to `/rest/api/2/search` and add
 * its host to the worker allowlist.
 */

import type { BridgeClient } from 'mv3-fetch-bridge';
import {
  bridgeErrorToState,
  truncate,
  type SearchResult,
  type SourceResult,
} from '../shared.js';

interface JiraIssue {
  id: string;
  key: string; // e.g. "SUP-123"
  fields?: {
    summary?: string;
    updated?: string; // ISO 8601
    status?: { name?: string };
    assignee?: { displayName?: string } | null;
  };
}

interface JiraSearchResponse {
  issues?: JiraIssue[];
  errorMessages?: string[];
}

function fail(state: SourceResult['state'], message: string): SourceResult {
  return { source: 'jira', state, results: [], message };
}

/** JQL string literal: backslashes and quotes must be escaped inside "". */
function jqlQuote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export async function searchJira(
  bridge: BridgeClient,
  query: string,
  siteUrl: string | undefined,
): Promise<SourceResult> {
  if (!siteUrl) return fail('unconfigured', 'Add your Jira site URL in settings.');

  const base = siteUrl.trim().replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.atlassian\.net$/i.test(base)) {
    return fail('error', `Jira site should look like https://acme.atlassian.net, got "${siteUrl}".`);
  }

  const params = new URLSearchParams({
    jql: `text ~ ${jqlQuote(query)} ORDER BY updated DESC`,
    maxResults: '20',
    fields: 'summary,status,assignee,updated',
  });

  const res = await bridge.fetch(`${base}/rest/api/3/search/jql?${params}`, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) return fail(bridgeErrorToState(res.errorType), res.error);

  if (res.status === 401 || res.status === 403) {
    return fail('auth', `Not signed into ${base.replace('https://', '')} in this browser — open it and log in.`);
  }
  if (res.status < 200 || res.status >= 300) {
    const detail = (res.data as JiraSearchResponse)?.errorMessages?.[0];
    return fail('error', `Jira HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  const data = res.data as JiraSearchResponse;
  const results: SearchResult[] = (data.issues ?? []).map((i) => ({
    source: 'jira',
    id: i.id,
    title: `${i.key} · ${i.fields?.summary ?? ''}`.trim(),
    snippet: truncate(i.fields?.summary ?? ''),
    url: `${base}/browse/${i.key}`,
    timestamp: i.fields?.updated ? Date.parse(i.fields.updated) || undefined : undefined,
    author: i.fields?.assignee?.displayName ?? undefined,
    status: i.fields?.status?.name,
  }));

  return { source: 'jira', state: 'ok', results };
}
