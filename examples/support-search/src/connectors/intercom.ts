/**
 * Intercom connector — searches conversations by body text.
 *
 * Auth: Intercom's API is token-based, not cookie-based, so this rides a
 * pasted access token (Settings -> Developer Hub -> your app). The request
 * still goes through the bridge for the single allowlist/rate-limit/timeout
 * choke point — it just carries a Bearer header instead of session cookies.
 *
 * Search model: Intercom's search is a structured query language, not free
 * text. We use `source.body ~ <query>` ("first message contains"), which is
 * the closest thing to a full-text match the API offers. Deeper matching
 * (conversation parts, notes) would need per-conversation fetches.
 */

import type { BridgeClient } from 'mv3-fetch-bridge';
import {
  bridgeErrorToState,
  htmlToText,
  truncate,
  type SearchResult,
  type SourceResult,
} from '../shared.js';

interface IntercomConversation {
  id: string;
  title?: string | null;
  created_at?: number; // unix seconds
  state?: string;
  source?: { body?: string; author?: { name?: string } };
}

interface IntercomSearchResponse {
  type?: string;
  conversations?: IntercomConversation[];
  total_count?: number;
  errors?: { code?: string; message?: string }[];
}

function fail(state: SourceResult['state'], message: string): SourceResult {
  return { source: 'intercom', state, results: [], message };
}

export async function searchIntercom(
  bridge: BridgeClient,
  query: string,
  token: string | undefined,
  host = 'https://api.intercom.io',
): Promise<SourceResult> {
  if (!token) return fail('unconfigured', 'Add an Intercom access token in settings.');

  const res = await bridge.fetch(`${host}/conversations/search`, {
    method: 'POST',
    // Token auth — no cookies needed. Keep them off to avoid leaking an
    // unrelated intercom.io session cookie into an app-token request.
    credentials: 'omit',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Intercom-Version': '2.11',
    },
    body: JSON.stringify({
      query: { field: 'source.body', operator: '~', value: query },
      pagination: { per_page: 20 },
    }),
  });

  if (!res.ok) return fail(bridgeErrorToState(res.errorType), res.error);

  // Intercom uses conventional status codes (unlike Slack/Linear), so a 401
  // here really is an auth failure.
  if (res.status === 401 || res.status === 403) {
    return fail('auth', 'Intercom rejected the token — check it in settings.');
  }
  if (res.status < 200 || res.status >= 300) {
    const detail = (res.data as IntercomSearchResponse)?.errors?.[0]?.message;
    return fail('error', `Intercom HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  const data = res.data as IntercomSearchResponse;
  const results: SearchResult[] = (data.conversations ?? []).map((c) => {
    const body = htmlToText(c.source?.body ?? '');
    return {
      source: 'intercom',
      id: c.id,
      title: c.title?.trim() || truncate(body, 80) || `Conversation ${c.id}`,
      snippet: truncate(body),
      // Best-effort deep link. Intercom resolves the `_` app placeholder to the
      // signed-in workspace; if you have multiple, replace `_` with the app id.
      url: `https://app.intercom.com/a/inbox/_/inbox/conversation/${c.id}`,
      timestamp: c.created_at ? c.created_at * 1000 : undefined,
      author: c.source?.author?.name,
      status: c.state,
    };
  });

  return { source: 'intercom', state: 'ok', results };
}
