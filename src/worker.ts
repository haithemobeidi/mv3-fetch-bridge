/**
 * Service-worker side of the fetch bridge.
 *
 * Wire-up in your MV3 background service worker:
 *
 *   import { createFetchBridge } from 'mv3-fetch-bridge';
 *
 *   const bridge = createFetchBridge({
 *     allowlist: { hosts: ['example.com'], hostPatterns: [/^[a-z0-9-]+\.example\.com$/i] },
 *     isAuthRedirect: (finalUrl) => finalUrl.pathname.startsWith('/account/login'),
 *   });
 *   chrome.runtime.onMessage.addListener(bridge.handleMessage);
 *
 * Why the fetch must live here and not in the page that wants the data:
 * - Content scripts share the page's origin for CORS purposes — a cross-origin
 *   fetch from one simply fails. Extension pages (side panel, popup) CAN fetch
 *   cross-origin when host_permissions cover the target, but routing every
 *   caller through this one handler gives a single choke point for URL
 *   policy, rate limiting, and cancellation instead of N copies.
 * - Requests here run with the browser's cookie jar: `credentials: 'include'`
 *   plus a matching host_permissions entry sends the user's existing session
 *   cookies. No stored credentials, no OAuth — if the user is logged in in a
 *   tab, the bridge is logged in.
 */

import type {
  BridgeFailure,
  BridgeRequest,
  BridgeResponse,
  BridgeSuccess,
} from './types.js';
import {
  createSlidingWindowLimiter,
  isAllowedByPolicy,
  isSafePublicHttpsUrl,
  tryParseUrl,
  type AllowlistPolicy,
  type RateLimiter,
} from './url-policy.js';

export interface FetchBridgeConfig {
  /** Hosts callers may fetch in 'allowlist' mode. Deny by default. */
  allowlist: AllowlistPolicy;
  /**
   * Detects "the request bounced to a login page". fetch follows redirects
   * internally, so a 302 → login arrives as a 200 from the login URL; the
   * ONLY reliable signal is response.redirected plus the final URL. A
   * `status === 302` check in the handler is dead code — you will never see
   * a 3xx status with redirect: 'follow'.
   * Example: (u) => u.pathname.startsWith('/accounts/login').
   * Omit to disable auth detection (callers can still inspect finalUrl).
   */
  isAuthRedirect?: (finalUrl: URL) => boolean;
  /** Allow 'public-probe' mode requests (headers-only, any public HTTPS host). Default false. */
  allowPublicProbe?: boolean;
  /** Message action string; must match the client's. Default 'bridge-fetch'. */
  action?: string;
  /** Default per-request timeout. Default 30_000 ms. */
  defaultTimeoutMs?: number;
  /** Sliding-window rate limit PER HOST per minute. Default 60. */
  maxRequestsPerMinutePerHost?: number;
  /**
   * Headers merged under every request's own headers. Note that fetch
   * silently drops forbidden headers (anything Sec-*, Accept-Encoding, …) —
   * don't bother cosplaying a browser with them. The headers that actually
   * change server behavior are the likes of Accept and X-Requested-With.
   */
  defaultHeaders?: Record<string, string>;
  /** Called when a request is refused, for security telemetry. */
  onBlocked?: (url: string, reason: 'security' | 'rateLimit') => void;
}

export interface FetchBridge {
  /**
   * Register with chrome.runtime.onMessage.addListener. Returns true for
   * bridge messages (keeps the sendResponse channel open across the async
   * work — the classic MV3 footgun), undefined for everything else so other
   * listeners still run.
   */
  handleMessage(
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: BridgeResponse | { ok: true }) => void,
  ): true | undefined;
  /** Number of requests currently in flight (for tests/telemetry). */
  activeCount(): number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Base64-encode in chunks — a single String.fromCharCode(...bytes) call overflows the stack on large bodies. */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function createFetchBridge(config: FetchBridgeConfig): FetchBridge {
  const action = config.action ?? 'bridge-fetch';
  const abortAction = `${action}:abort`;
  const limiter: RateLimiter = createSlidingWindowLimiter(
    config.maxRequestsPerMinutePerHost ?? 60,
    60_000,
  );
  const active = new Map<string, AbortController>();

  async function handleFetch(
    request: BridgeRequest,
    sendResponse: (response: BridgeResponse) => void,
  ): Promise<void> {
    // Single-response guard: the timeout path and the catch path can both
    // try to answer; only the first one wins. (A second sendResponse is a
    // silent no-op in Chrome, but relying on that hides logic bugs.)
    let responded = false;
    const respond = (response: BridgeResponse) => {
      if (responded) return;
      responded = true;
      sendResponse(response);
    };
    const fail = (partial: Omit<BridgeFailure, 'ok'>) => respond({ ok: false, ...partial });

    const { requestId, url, options = {} } = request;
    const mode = options.mode ?? 'allowlist';

    // --- Policy gate ---------------------------------------------------
    const allowed =
      mode === 'public-probe'
        ? config.allowPublicProbe === true && isSafePublicHttpsUrl(url)
        : isAllowedByPolicy(url, config.allowlist);
    if (!allowed) {
      config.onBlocked?.(url, 'security');
      fail({ errorType: 'security', error: 'URL not allowed by bridge policy' });
      return;
    }

    // --- Rate limit (per HOST — a per-URL bucket cannot pace a batch) ---
    const host = tryParseUrl(url)!.hostname.toLowerCase();
    if (!limiter.isAllowed(host)) {
      config.onBlocked?.(url, 'rateLimit');
      fail({ errorType: 'rateLimit', error: `Rate limit exceeded for ${host}` });
      return;
    }

    // --- Execute --------------------------------------------------------
    const controller = new AbortController();
    active.set(requestId, controller);
    const timeoutMs = options.timeoutMs ?? config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);

    try {
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        headers: { ...config.defaultHeaders, ...options.headers },
        body: options.body,
        // The whole point: ride the user's existing session cookies.
        credentials: options.credentials ?? 'include',
        redirect: 'follow',
        signal: controller.signal,
      });

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      // Auth detection — see FetchBridgeConfig.isAuthRedirect for why this
      // is redirected+finalUrl and can never be a status-code check.
      if (response.redirected && config.isAuthRedirect?.(new URL(response.url))) {
        fail({
          errorType: 'auth',
          error: 'Redirected to login — session missing or expired',
          finalUrl: response.url,
          durationMs: elapsed(),
        });
        return;
      }

      const success: BridgeSuccess = {
        ok: true,
        data: null,
        status: response.status,
        statusText: response.statusText,
        headers,
        finalUrl: response.url,
        redirected: response.redirected,
        durationMs: 0, // set below, after the body is read
      };

      if (mode === 'public-probe') {
        // Body is never read in probe mode — that cap is what makes
        // any-public-host validation acceptable.
      } else {
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('json')) {
          const raw = await response.text();
          try {
            success.data = JSON.parse(raw);
          } catch {
            success.data = raw; // malformed JSON: hand back the text as-is
          }
        } else if (contentType.startsWith('text/') || contentType.includes('xml')) {
          success.data = await response.text();
        } else {
          // chrome.runtime messages are JSON-serialized; an ArrayBuffer
          // would silently arrive as {} on the other side. Base64 it.
          success.data = toBase64(await response.arrayBuffer());
          success.dataEncoding = 'base64';
        }
      }

      success.durationMs = elapsed();
      respond(success);
    } catch (error: unknown) {
      const err = error as { name?: string; message?: string };
      if (timedOut) {
        fail({
          errorType: 'timeout',
          error: `Request timed out after ${timeoutMs}ms`,
          durationMs: elapsed(),
        });
      } else if (err?.name === 'AbortError') {
        fail({ errorType: 'abort', error: 'Request aborted by caller', durationMs: elapsed() });
      } else {
        fail({
          errorType: 'network',
          error: err?.message ?? String(error),
          durationMs: elapsed(),
        });
      }
    } finally {
      clearTimeout(timeoutId);
      active.delete(requestId);
    }
  }

  function handleMessage(
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: BridgeResponse | { ok: true }) => void,
  ): true | undefined {
    const msg = message as Partial<BridgeRequest> | undefined;

    if (msg?.action === abortAction && typeof msg.requestId === 'string') {
      active.get(msg.requestId)?.abort();
      sendResponse({ ok: true });
      return undefined; // answered synchronously
    }

    if (msg?.action !== action) return undefined;

    if (typeof msg.requestId !== 'string' || typeof msg.url !== 'string') {
      sendResponse({
        ok: false,
        errorType: 'security',
        error: 'Malformed bridge request (requestId and url are required)',
      } satisfies BridgeFailure);
      return undefined;
    }

    void handleFetch(msg as BridgeRequest, sendResponse);
    return true; // async response — keep the message channel open
  }

  return { handleMessage, activeCount: () => active.size };
}
