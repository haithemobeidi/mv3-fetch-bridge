/**
 * Shared types + credential storage for the Support Search extension.
 *
 * Connectors run in the side panel and call the bridge CLIENT; the service
 * worker performs the actual cookie-authenticated fetch. Credentials live in
 * chrome.storage.local and flow panel -> worker inside the request headers.
 */

import type { BridgeErrorType } from 'mv3-fetch-bridge';

export type Source = 'intercom' | 'slack' | 'linear';

export const SOURCES: Source[] = ['intercom', 'slack', 'linear'];

export const SOURCE_LABEL: Record<Source, string> = {
  intercom: 'Intercom',
  slack: 'Slack',
  linear: 'Linear',
};

/** One normalized hit, whatever the source. */
export interface SearchResult {
  source: Source;
  id: string;
  title: string;
  snippet: string;
  url: string;
  /** Epoch milliseconds, when known. */
  timestamp?: number;
  author?: string;
  status?: string;
}

/**
 * Auth/health of one source, kept as a tri-state (+ two book-ends) so the UI
 * never confuses "the session is bad" with "I couldn't reach the server".
 * This is the db-backed-auth-503-not-401 rule: only a genuine credential
 * rejection may prompt a re-login; a timeout or DNS blip must NOT.
 *
 * - 'ok'           got a response (results may be empty)
 * - 'unconfigured' no credential set yet — prompt to add one
 * - 'auth'         credential present but rejected (401 / invalid_auth) — re-auth
 * - 'unreachable'  network / timeout — "couldn't reach, try again", never a login prompt
 * - 'error'        anything else (rate limit, 5xx, bad query) — show the message
 */
export type SourceState = 'ok' | 'unconfigured' | 'auth' | 'unreachable' | 'error';

/** Per-source outcome. A failed source never sinks the others. */
export interface SourceResult {
  source: Source;
  state: SourceState;
  results: SearchResult[];
  /** Human-readable detail, safe to show in the UI. */
  message?: string;
}

export interface Credentials {
  /** Intercom access token (Bearer). */
  intercomToken?: string;
  /** Intercom region host; defaults to api.intercom.io. */
  intercomHost?: string;
  /** Linear personal API key (sent raw in Authorization). */
  linearApiKey?: string;
  /** Slack xoxc session token, auto-captured from an open Slack tab. */
  slackToken?: string;
  /** e.g. https://acme.slack.com — xoxc tokens are most reliable against the workspace host. */
  slackTeamUrl?: string;
}

const STORAGE_KEY = 'support-search:creds';

export async function loadCredentials(): Promise<Credentials> {
  const obj = await chrome.storage.local.get(STORAGE_KEY);
  return (obj[STORAGE_KEY] as Credentials | undefined) ?? {};
}

/** Merge a partial update into stored credentials and return the result. */
export async function saveCredentials(patch: Partial<Credentials>): Promise<Credentials> {
  const current = await loadCredentials();
  const next: Credentials = { ...current, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

/** Subscribe to credential changes (e.g. the Slack content script capturing a token). */
export function onCredentialsChanged(cb: (creds: Credentials) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY]) {
      cb((changes[STORAGE_KEY].newValue as Credentials | undefined) ?? {});
    }
  });
}

/** Strip HTML tags and decode the handful of entities that show up in bodies. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncate(text: string, max = 240): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Map a transport-level bridge failure to a source state. Crucially,
 * timeout/network/abort -> 'unreachable' (NOT 'auth'): a flaky request must
 * never sign the user out. Only errorType 'auth' means the session is bad.
 */
export function bridgeErrorToState(errorType: BridgeErrorType): SourceState {
  switch (errorType) {
    case 'auth':
      return 'auth';
    case 'timeout':
    case 'network':
    case 'abort':
      return 'unreachable';
    case 'security':
    case 'rateLimit':
      return 'error';
  }
}
