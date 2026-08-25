/**
 * Linear connector — GraphQL issue search.
 *
 * Auth: a personal API key, sent RAW in the Authorization header (Linear does
 * NOT want a "Bearer " prefix for personal keys). The KB explicitly flags that
 * Linear has a clean public API — so we hold a key rather than cookie-riding
 * the internal endpoint. The bridge here is the allowlist/rate-limit choke
 * point, not a cookie carrier.
 *
 * Trap (KB negative-control): GraphQL returns HTTP 200 with an `errors[]`
 * array. Auth failures look like a 200 with `errors[0].extensions.type ===
 * 'authentication error'` (or a 400). Classify from the body.
 */

import type { BridgeClient } from 'mv3-fetch-bridge';
import {
  bridgeErrorToState,
  truncate,
  type SearchResult,
  type SourceResult,
} from '../shared.js';

const ENDPOINT = 'https://api.linear.app/graphql';

const SEARCH_QUERY = `query SupportSearch($term: String!) {
  searchIssues(term: $term, first: 20) {
    nodes {
      id
      identifier
      title
      url
      createdAt
      state { name type }
      assignee { name }
    }
  }
}`;

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  url: string;
  createdAt: string; // ISO 8601
  state?: { name?: string; type?: string };
  assignee?: { name?: string };
}

interface LinearResponse {
  data?: { searchIssues?: { nodes?: LinearIssueNode[] } };
  errors?: { message?: string; extensions?: { type?: string; code?: string } }[];
}

function isAuthError(errors: NonNullable<LinearResponse['errors']>): boolean {
  return errors.some((e) => {
    const type = (e.extensions?.type ?? e.extensions?.code ?? '').toLowerCase();
    return type.includes('auth') || /authenticat/i.test(e.message ?? '');
  });
}

export async function searchLinear(
  bridge: BridgeClient,
  query: string,
  apiKey: string | undefined,
): Promise<SourceResult> {
  if (!apiKey) {
    return {
      source: 'linear',
      state: 'unconfigured',
      results: [],
      message: 'Add a Linear API key in settings.',
    };
  }

  const res = await bridge.fetch(ENDPOINT, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      Authorization: apiKey, // raw, no "Bearer " for personal keys
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: SEARCH_QUERY, variables: { term: query } }),
  });

  if (!res.ok) {
    return { source: 'linear', state: bridgeErrorToState(res.errorType), results: [], message: res.error };
  }

  if (res.status === 401 || res.status === 403) {
    return { source: 'linear', state: 'auth', results: [], message: 'Linear rejected the API key.' };
  }

  const data = res.data as LinearResponse;

  if (data?.errors?.length) {
    if (isAuthError(data.errors)) {
      return { source: 'linear', state: 'auth', results: [], message: 'Linear rejected the API key.' };
    }
    return { source: 'linear', state: 'error', results: [], message: `Linear: ${data.errors[0]?.message ?? 'query error'}` };
  }

  const results: SearchResult[] = (data?.data?.searchIssues?.nodes ?? []).map((n) => ({
    source: 'linear',
    id: n.id,
    title: `${n.identifier} · ${n.title}`,
    snippet: truncate(n.title),
    url: n.url,
    timestamp: n.createdAt ? Date.parse(n.createdAt) || undefined : undefined,
    author: n.assignee?.name,
    status: n.state?.name,
  }));

  return { source: 'linear', state: 'ok', results };
}
