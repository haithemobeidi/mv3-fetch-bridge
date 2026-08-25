/**
 * Shared protocol types for the MV3 fetch bridge.
 *
 * The bridge is a request/response protocol over chrome.runtime messaging:
 * an extension page (side panel, popup) or content script sends a
 * BridgeRequest; the service worker validates the URL, performs the fetch
 * with the user's session cookies, and answers with a BridgeResponse.
 *
 * Design notes (differences from ad-hoc implementations this was extracted from):
 * - `ok` is a discriminant. Callers switch on it instead of sniffing for an
 *   `error` string on an untyped object.
 * - A completed HTTP response is ALWAYS `ok: true`, whatever the status code
 *   (mirrors fetch semantics). Only transport-level failures, policy blocks,
 *   timeouts, aborts, and detected auth redirects are failures. This matters
 *   for header-probe use cases (e.g. HSTS checks) where a 403 still carries
 *   the header you came for, and for scrapers that want 404 bodies.
 */

/** Categorized failure reasons — stable strings callers can switch on. */
export type BridgeErrorType =
  /** URL rejected by the allowlist / public-host policy before any fetch. */
  | 'security'
  /** Per-host sliding-window rate limit exceeded. */
  | 'rateLimit'
  /** The configured timeout elapsed before the response completed. */
  | 'timeout'
  /** The caller explicitly aborted the request. */
  | 'abort'
  /** The final (post-redirect) URL matched the configured auth predicate. */
  | 'auth'
  /** DNS/TCP/TLS failure, service worker unreachable, or other transport error. */
  | 'network';

/**
 * Validation regime for a request.
 *
 * - 'allowlist' (default): the URL's host must match the configured allowlist.
 *   Full response bodies are returned.
 * - 'public-probe': ANY public HTTPS hostname is accepted (SSRF-hardened:
 *   no IP literals, no localhost, no internal TLDs) but the response BODY is
 *   never read or returned — only status and headers. The loose validation
 *   and the body ban are deliberately one setting: arbitrary-host requests
 *   are only safe because their blast radius is capped at headers.
 */
export type BridgeMode = 'allowlist' | 'public-probe';

/** Options the caller may attach to a single bridge request. */
export interface BridgeRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** String body only — structured bodies must be serialized by the caller. */
  body?: string;
  /** Per-request timeout. Falls back to the worker's defaultTimeoutMs. */
  timeoutMs?: number;
  /**
   * Defaults to 'include' — riding the user's existing session cookies is
   * the point of the bridge. Pass 'omit' for genuinely anonymous requests.
   */
  credentials?: RequestCredentials;
  /** Validation regime; defaults to 'allowlist'. See BridgeMode. */
  mode?: BridgeMode;
}

/** The message sent from client to service worker. */
export interface BridgeRequest {
  /** Message discriminator, configurable to avoid collisions (default 'bridge-fetch'). */
  action: string;
  /** Unique per call — keys the worker's in-flight/abort map. */
  requestId: string;
  url: string;
  options?: BridgeRequestOptions;
}

/** Successful completion: an HTTP response of ANY status was received. */
export interface BridgeSuccess {
  ok: true;
  /**
   * Parsed body:
   * - JSON content types → the parsed value (raw text if parsing fails)
   * - text/xml-ish content types → string
   * - anything else → base64 string, flagged by dataEncoding
   * - 'public-probe' mode → always null (body is never read)
   *
   * Binary bodies are base64-encoded because chrome.runtime messages are
   * JSON-serialized: an ArrayBuffer silently becomes `{}` in transit.
   */
  data: unknown;
  /** Set to 'base64' when data is a base64-encoded binary body. */
  dataEncoding?: 'base64';
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /**
   * The URL the response actually came from, after redirects. fetch follows
   * redirects internally, so a 302 to a login page arrives as a 200 with
   * redirected: true — inspect finalUrl, never expect to see a 3xx status.
   */
  finalUrl: string;
  redirected: boolean;
  durationMs: number;
}

/** Failure: no usable HTTP response (or an auth redirect was detected). */
export interface BridgeFailure {
  ok: false;
  errorType: BridgeErrorType;
  /** Human-readable detail, safe to surface in UI. */
  error: string;
  /** Present for 'auth' failures: where the redirect chain ended. */
  finalUrl?: string;
  durationMs?: number;
}

export type BridgeResponse = BridgeSuccess | BridgeFailure;
