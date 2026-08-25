/**
 * URL validation policies for the fetch bridge.
 *
 * Two regimes, matching the two BridgeModes:
 *
 * 1. Allowlist ('allowlist' mode): the host must exactly match a configured
 *    hostname or one of the configured patterns. Deny by default. Even
 *    allowlisted URLs are rejected if they point at private/internal
 *    infrastructure (defense in depth against a sloppy pattern).
 *
 * 2. Public HTTPS host ('public-probe' mode): any NAMED public HTTPS host is
 *    accepted, because the caller legitimately probes arbitrary user-entered
 *    domains (e.g. "does this domain send an HSTS header?"). SSRF hardening:
 *    no IP literals, no localhost, no bare (dot-less) names, no internal-use
 *    TLDs. A public name that RESOLVES to a private IP (DNS rebinding) is not
 *    caught here — which is exactly why the worker never returns a response
 *    body in this mode, only status and headers.
 */

/** Allowlist configuration for 'allowlist' mode. */
export interface AllowlistPolicy {
  /** Exact hostnames, matched case-insensitively (e.g. 'example.com'). */
  hosts: string[];
  /**
   * Patterns for dynamic hostnames (e.g. per-team subdomains):
   * /^[a-z0-9-]+\.example\.com$/i
   * Anchor them (^...$) — an unanchored pattern is an allowlist hole.
   */
  hostPatterns?: RegExp[];
}

/** Hard cap on URL length; anything longer is rejected outright. */
const MAX_URL_LENGTH = 2048;

/** Parse a URL string defensively. Returns null instead of throwing. */
export function tryParseUrl(url: unknown): URL | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) {
    return null;
  }
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * True when the hostname points at loopback, private, link-local, CGNAT, or
 * cloud-metadata address space, or uses an internal-use TLD.
 * Structured checks on the parsed hostname — NOT regexes over the whole URL
 * string, which misfire on paths like "/v10.2/..." and miss encoded forms.
 */
export function isPrivateOrLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  // Internal-use / non-public TLDs.
  if (/\.(local|internal|lan|home|corp)$/.test(host)) return true;

  // IPv6 literal (URL.hostname keeps brackets/colons). Reject all of them:
  // distinguishing public from private IPv6 is not worth the risk here.
  if (host.includes(':') || host.includes('[')) return true;

  // IPv4 literal: parse octets and check ranges properly.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) {
      return true; // malformed IP-looking host — reject rather than guess
    }
    if (a === 0) return true;                        // 0.0.0.0/8
    if (a === 10) return true;                       // 10.0.0.0/8
    if (a === 127) return true;                      // loopback
    if (a === 169 && b === 254) return true;         // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;         // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  }

  // Known metadata hostnames.
  if (host === 'metadata.google.internal') return true;

  return false;
}

/** Allowlist-mode check: http(s), not private, host explicitly allowed. */
export function isAllowedByPolicy(url: string, policy: AllowlistPolicy): boolean {
  const parsed = tryParseUrl(url);
  if (!parsed) return false;

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

  const host = parsed.hostname.toLowerCase();
  if (isPrivateOrLocalHostname(host)) return false;

  if (policy.hosts.some((h) => h.toLowerCase() === host)) return true;
  return (policy.hostPatterns ?? []).some((p) => p.test(host));
}

/** Public-probe-mode check: HTTPS, named, dotted, public hostname. */
export function isSafePublicHttpsUrl(url: string): boolean {
  const parsed = tryParseUrl(url);
  if (!parsed) return false;

  if (parsed.protocol !== 'https:') return false;

  const host = parsed.hostname.toLowerCase();
  if (isPrivateOrLocalHostname(host)) return false;

  // Require a dotted name: rejects bare intranet names AND all IP literals
  // are already gone via isPrivateOrLocalHostname (IPv4 dotted literals are
  // caught there; IPv6 has no dots that matter because colons reject first).
  if (!host.includes('.')) return false;

  // A dotted IPv4 literal that slipped past the private ranges (i.e. a
  // PUBLIC IP entered directly) is still rejected: probing raw IPs is never
  // the use case, and names are what HSTS/cert checks are about.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;

  return true;
}

/**
 * Sliding-window rate limiter, keyed by an arbitrary string.
 *
 * IMPORTANT: key by HOST, not by full URL. A per-URL limiter looks like
 * protection but provides none against the realistic failure mode — a batch
 * job iterating DISTINCT URLs on one host fires them all through unthrottled.
 */
export interface RateLimiter {
  /** Records the event and returns whether it is within the limit. */
  isAllowed(key: string): boolean;
}

export function createSlidingWindowLimiter(maxEvents: number, windowMs: number): RateLimiter {
  const buckets = new Map<string, number[]>();
  return {
    isAllowed(key: string): boolean {
      const now = Date.now();
      const cutoff = now - windowMs;
      const times = (buckets.get(key) ?? []).filter((t) => t > cutoff);
      if (times.length >= maxEvents) {
        buckets.set(key, times);
        return false;
      }
      times.push(now);
      buckets.set(key, times);
      return true;
    },
  };
}
