/**
 * Slack connector — search.messages, the true cookie-bridge case.
 *
 * Slack's web client authenticates with an `xoxc-` session token that is
 * WORTHLESS without the `d` cookie sent alongside it. The bridge supplies the
 * cookie (`credentials: 'include'` + host_permissions on *.slack.com); the
 * token is scraped from an open Slack tab by the content script and stored.
 *
 * Two traps this connector has to handle, both from the KB:
 *  - search.messages returns HTTP 200 with `{ok:false, error:'invalid_auth'}`.
 *    Status-code checks pass forever; you MUST read the body's `ok`/`error`.
 *  - `invalid_auth`/`not_authed` => auth (re-capture token); `ratelimited` and
 *    the rest are NOT auth failures and must not trigger a login prompt.
 */

import type { BridgeClient } from 'mv3-fetch-bridge';
import {
  bridgeErrorToState,
  truncate,
  type SearchResult,
  type SourceResult,
  type SourceState,
} from '../shared.js';

interface SlackMatch {
  ts?: string; // "1699900000.123456" — seconds.micros
  text?: string;
  permalink?: string;
  username?: string;
  channel?: { id?: string; name?: string; is_private?: boolean };
}

interface SlackSearchResponse {
  ok: boolean;
  error?: string;
  messages?: { total?: number; matches?: SlackMatch[] };
}

/** Slack error strings that mean "the session/token is bad", vs everything else. */
const AUTH_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive',
  'no_permission',
  'missing_scope',
]);

function classifySlackError(error: string): { state: SourceState; message: string } {
  if (AUTH_ERRORS.has(error)) {
    return { state: 'auth', message: `Slack session invalid (${error}) — open Slack to re-capture.` };
  }
  if (error === 'ratelimited') {
    return { state: 'error', message: 'Slack rate-limited the search — try again shortly.' };
  }
  return { state: 'error', message: `Slack error: ${error}` };
}

export async function searchSlack(
  bridge: BridgeClient,
  query: string,
  token: string | undefined,
  teamUrl: string | undefined,
): Promise<SourceResult> {
  if (!token) {
    return {
      source: 'slack',
      state: 'unconfigured',
      results: [],
      message: 'Open your Slack workspace in a tab to capture a token.',
    };
  }

  // xoxc tokens are most reliable against the workspace host; fall back to the
  // marketing host. Either way the `d` cookie is what actually authenticates.
  const base = (teamUrl ?? 'https://slack.com').replace(/\/+$/, '');

  // The token rides in the POST body (the classic xoxc path), the `d` cookie
  // rides via credentials:'include'. Nothing goes in an Authorization header.
  const form = new URLSearchParams({
    token,
    query,
    count: '20',
    sort: 'timestamp',
    sort_dir: 'desc',
    highlight: 'false',
  });

  const res = await bridge.fetch(`${base}/api/search.messages`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: form.toString(),
  });

  if (!res.ok) {
    const state = bridgeErrorToState(res.errorType);
    return { source: 'slack', state, results: [], message: res.error };
  }

  const data = res.data as SlackSearchResponse;

  // The load-bearing check: 200 OK does NOT mean success for Slack.
  if (!data || typeof data.ok !== 'boolean') {
    return { source: 'slack', state: 'error', results: [], message: 'Unexpected Slack response.' };
  }
  if (!data.ok) {
    const { state, message } = classifySlackError(data.error ?? 'unknown');
    return { source: 'slack', state, results: [], message };
  }

  const results: SearchResult[] = (data.messages?.matches ?? []).map((m) => {
    const channel = m.channel?.name ? `#${m.channel.name}` : (m.username ?? 'Slack');
    return {
      source: 'slack',
      id: `${m.channel?.id ?? ''}:${m.ts ?? ''}`,
      title: channel,
      snippet: truncate(m.text ?? ''),
      url: m.permalink ?? base,
      timestamp: m.ts ? Math.round(parseFloat(m.ts) * 1000) : undefined,
      author: m.username,
    };
  });

  return { source: 'slack', state: 'ok', results };
}
