/**
 * Caller side of the fetch bridge — for side panels, popups, options pages,
 * and content scripts.
 *
 *   import { createBridgeClient } from 'mv3-fetch-bridge';
 *
 *   const bridge = createBridgeClient();
 *   const res = await bridge.fetch('https://example.com/admin/users/42/');
 *   if (res.ok) parse(res.data);
 *   else if (res.errorType === 'auth') showLoginPrompt();
 *
 * Error-taxonomy rule (see the KB lesson db-backed-auth-503-not-401): only
 * 'auth' means "the session is bad". 'network' and 'timeout' mean "could not
 * find out" — never tear down auth state or show a login prompt for those,
 * or transient weather signs your user out.
 */

import type { BridgeRequestOptions, BridgeResponse } from './types.js';

export interface BridgeClientOptions {
  /** Must match the worker's configured action. Default 'bridge-fetch'. */
  action?: string;
}

/** Handle for one in-flight request, exposing cancellation. */
export interface BridgeCall {
  requestId: string;
  response: Promise<BridgeResponse>;
  /** Ask the worker to abort. The pending response resolves with errorType 'abort'. */
  abort(): void;
}

export interface BridgeClient {
  /** Fire a request and await its result. Never rejects — inspect `ok`. */
  fetch(url: string, options?: BridgeRequestOptions): Promise<BridgeResponse>;
  /** Like fetch(), but returns a handle so the caller can abort. */
  start(url: string, options?: BridgeRequestOptions): BridgeCall;
  /**
   * Convenience for the scraping case: resolves to the body text of a 2xx
   * response, throws an Error (message = bridge error / HTTP status) otherwise.
   */
  fetchText(url: string, options?: BridgeRequestOptions): Promise<string>;
}

/**
 * Turn chrome.runtime messaging failures into a typed bridge failure.
 * The classic messages here: "Could not establish connection. Receiving end
 * does not exist." (no listener — the worker never registered the bridge) and
 * "The message port closed before a response was received." (the service
 * worker died mid-request, or a listener returned without responding).
 */
function messagingFailure(error: unknown): BridgeResponse {
  const message = (error as { message?: string })?.message ?? String(error);
  return {
    ok: false,
    errorType: 'network',
    error: `Bridge messaging failed: ${message}`,
  };
}

export function createBridgeClient(options: BridgeClientOptions = {}): BridgeClient {
  const action = options.action ?? 'bridge-fetch';
  const abortAction = `${action}:abort`;

  function start(url: string, requestOptions?: BridgeRequestOptions): BridgeCall {
    const requestId = crypto.randomUUID();

    const response: Promise<BridgeResponse> = (async () => {
      try {
        const reply = await chrome.runtime.sendMessage({
          action,
          requestId,
          url,
          options: requestOptions,
        });
        if (!reply) {
          // A listener existed but never called sendResponse.
          return messagingFailure(new Error('empty response from service worker'));
        }
        return reply as BridgeResponse;
      } catch (error) {
        return messagingFailure(error);
      }
    })();

    return {
      requestId,
      response,
      abort() {
        // Fire-and-forget; the in-flight fetch resolves through its own path.
        void chrome.runtime.sendMessage({ action: abortAction, requestId }).catch(() => {});
      },
    };
  }

  async function fetchText(url: string, requestOptions?: BridgeRequestOptions): Promise<string> {
    const result = await start(url, requestOptions).response;
    if (!result.ok) {
      throw new Error(`${result.errorType}: ${result.error}`);
    }
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`HTTP ${result.status} ${result.statusText}`);
    }
    if (typeof result.data !== 'string' || result.dataEncoding === 'base64') {
      throw new Error('Response was not text');
    }
    return result.data;
  }

  return {
    start,
    fetch: (url, requestOptions) => start(url, requestOptions).response,
    fetchText,
  };
}

/**
 * Run `fn` over `items` with at most `limit` in flight at once, preserving
 * input order in the result.
 *
 * This belongs next to the bridge because of a lesson learned the hard way:
 * the worker's per-host rate limiter rejects excess requests, it does not
 * QUEUE them — so a batch caller that fires 250 lookups at once gets ~60
 * results and ~190 rateLimit errors. Batch callers must pace themselves;
 * this is the pacing.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
