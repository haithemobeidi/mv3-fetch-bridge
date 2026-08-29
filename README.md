# mv3-fetch-bridge

Cookie-authenticated fetch bridge for Chrome Manifest V3 extensions.

Route HTTP requests from a side panel, popup, or content script through the
background service worker, where they run with the browser's cookie jar
(`credentials: 'include'`) and, thanks to `host_permissions`, without CORS
restrictions. If the user is logged in to the target site in a tab, the bridge
is logged in — no stored credentials, no tokens, no OAuth.

Extracted and generalized from a production support-assistant extension; the
design rules at the bottom encode the incidents that shaped it — read them
before modifying the bridge.

**See it in action:** [`examples/support-search`](examples/support-search) is
a working side-panel extension built on the bridge that searches five tools
(Slack, Zendesk, Jira, Intercom, Linear) in parallel via a pluggable
connector registry. Its README explains the architecture end-to-end and the
recipe for adding a source — start there if you're new to the project.

## What you get

- **One choke point** for every privileged request: URL allowlist, per-host
  rate limiting, timeouts, cancellation, and telemetry live in one handler
  instead of N call sites.
- **Typed error taxonomy** — `security | rateLimit | timeout | abort | auth |
  network` — as a discriminated union (`ok: true/false`), so callers switch on
  a field instead of sniffing for error strings. Only `auth` means "session is
  bad"; `network`/`timeout` mean "couldn't find out" and must never be treated
  as a logout signal.
- **Honest auth-redirect detection.** `fetch` follows redirects internally, so
  a 302-to-login arrives as a 200 from the login URL. The bridge detects auth
  bounces from `response.redirected` + a final-URL predicate you supply.
  (Checking `status === 302` is dead code — you will never see a 3xx with
  `redirect: 'follow'`.)
- **SSRF-safe "public probe" mode** (opt-in): fetch ANY public HTTPS host —
  for probing user-entered domains (HSTS/header checks) — but the response
  body is never read; only status + headers come back. Loose validation and
  the body cap are deliberately one setting.
- **Binary-safe transport.** `chrome.runtime` messages are JSON-serialized; an
  `ArrayBuffer` silently arrives as `{}`. Binary bodies are base64-encoded and
  flagged with `dataEncoding: 'base64'`.
- **Batch pacing helper.** The worker's rate limiter *refuses* excess
  requests, it doesn't queue them — batch callers must pace themselves.
  `mapWithConcurrency(items, limit, fn)` is that pacing.

## Usage

### 1. Service worker (background)

```ts
import { createFetchBridge } from 'mv3-fetch-bridge';

const bridge = createFetchBridge({
  allowlist: {
    hosts: ['app.example.com', 'app.slack.com', 'linear.app'],
    hostPatterns: [/^[a-z0-9-]+\.example\.com$/i],
  },
  // Site-specific: where does this app's login page live?
  isAuthRedirect: (u) => u.pathname.startsWith('/accounts/login'),
  defaultHeaders: {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  },
  onBlocked: (url, reason) => console.warn(`[bridge] blocked (${reason}):`, url),
});

chrome.runtime.onMessage.addListener(bridge.handleMessage);
```

### 2. Caller (side panel / popup / content script)

```ts
import { createBridgeClient, mapWithConcurrency } from 'mv3-fetch-bridge';

const bridge = createBridgeClient();

// Simple: never rejects — inspect `ok`.
const res = await bridge.fetch('https://app.example.com/admin/users/42/');
if (res.ok) {
  const doc = new DOMParser().parseFromString(res.data as string, 'text/html');
} else if (res.errorType === 'auth') {
  // Session expired — the ONLY errorType that should prompt a re-login.
}

// Throwing convenience for the common scrape case:
const html = await bridge.fetchText('https://app.example.com/search/?q=test');

// Cancellable:
const call = bridge.start('https://app.example.com/slow-page');
cancelButton.onclick = () => call.abort();
const result = await call.response;

// Batch lookups — pace yourself; the worker rate limiter refuses, not queues:
const rows = await mapWithConcurrency(ids, 4, (id) =>
  bridge.fetch(`https://app.example.com/admin/articles/${id}/`),
);
```

### 3. Manifest requirements

```jsonc
{
  "manifest_version": 3,
  "host_permissions": [
    "https://app.example.com/*",
    "https://*.example.com/*"
    // one entry per allowlisted host — host_permissions is what grants
    // both the CORS exemption and cookie attachment for extension fetches
  ]
}
```

The `cookies` permission is NOT required — that's for the `chrome.cookies`
API. Cookie attachment on `fetch` comes from `host_permissions` +
`credentials: 'include'`.

## Design rules (each one is a paid-for lesson)

1. **Auth lives in the browser's cookie jar, not in the extension.** Never
   copy cookies around; cookie-filtering middleware here is security theater.
2. **Completed HTTP responses are `ok: true` whatever the status.** A 403 can
   still carry the header you're probing for; a 404 body can still be worth
   parsing. Transport failures, policy blocks, timeouts, and auth bounces are
   the only failures.
3. **Rate-limit by host, never by URL.** A per-URL bucket looks like
   protection and provides none against the realistic failure mode (a batch of
   distinct URLs on one host).
4. **Don't cosplay a browser in headers.** `Sec-*`, `Accept-Encoding` etc. are
   forbidden header names — fetch silently drops them. The headers that
   actually change server behavior are `Accept` and (for Django-style
   backends) `X-Requested-With: XMLHttpRequest`.
5. **Anchor allowlist patterns** (`^...$`) and validate hostnames structurally
   — `hostname.includes('example.com')` matches `example.com.evil.net`.

## Limits and non-goals

- **MV3 service-worker lifetime:** an in-flight request with an open message
  channel generally keeps the worker alive, but if the worker dies anyway the
  client maps the resulting messaging error to `errorType: 'network'`.
- **Message size:** runtime messages have a hard size cap (tens of MB). This
  bridge is for pages and API payloads, not file downloads.
- **No request queueing:** over-limit requests are refused, not delayed.
  Callers own their pacing (`mapWithConcurrency`).
- **No DNS-rebinding defense in probe mode** — accepted because probe mode
  never returns a body. Don't weaken that trade.

## Development

```
npm ci          # never `npm install` in CI — see Supply chain below
npm run typecheck
npm test        # vitest, 50 tests
npm run build   # emits dist/
```

Consume it from a sibling extension project via `npm install ../mv3-fetch-bridge`
(or copy `src/` in — it has zero runtime dependencies).

## Supply chain

This package ships **zero runtime dependencies**. Nothing third-party reaches an
extension that consumes it — the published artifact is this repo's own `src/` and
`dist/`. CI enforces that invariant and fails if a runtime dependency is ever added.

The dependency tree that does exist is entirely build- and test-time:

| | |
|---|---|
| Direct dependencies | 3, all `devDependencies` (`typescript`, `vitest`, `@types/chrome`) |
| Runtime dependencies | 0 |
| Lockfile entries | 93 — of which 46 are optional per-platform native binaries |
| Actually installed on one machine | ~52 |
| Packages declaring an install script | 1 (`fsevents`, optional, macOS-only) |
| Sources | `registry.npmjs.org` only, every entry integrity-pinned, lockfile v3 |

Two residual risks are worth naming honestly rather than rounding to zero:

1. **Build tools sit in the trust path for shipped output.** `tsc` produces `dist/`,
   and `vite`/`rolldown` bundle the example extension. A compromised release of
   either could inject code into a shipped artifact.
2. **`npm ci` runs on developer machines and CI runners.** Even with lifecycle
   scripts disabled, test and build steps execute dependency code.

Mitigations in place:

- **`.npmrc` sets `ignore-scripts=true`**, disabling dependency
  `preinstall`/`install`/`postinstall` hooks — the primary propagation vector for
  npm worm attacks. (This also suppresses the root package's own `prepare` and
  `prepublishOnly` hooks; there are none, so run `npm run build` explicitly before
  publishing.)
- **`.npmrc` sets `save-exact=true`** and all direct dependencies are pinned to
  exact versions, so every upgrade is an explicit, reviewable diff.
- **`npm ci` everywhere, never `npm install`** — refuses to deviate from the
  lockfile, verifies integrity hashes, and fails on package.json/lockfile drift.
- **CI** (`.github/workflows/ci.yml`) runs install-from-lockfile, the
  zero-runtime-dependency assertion, typecheck, tests, build, and
  `npm audit --audit-level=high` on every pull request, with `contents: read` only.

Not yet done, in rough order of value:

- **Adopt a minimum release age** before taking any new version. Most npm
  compromises are detected and yanked within hours; a cooldown keeps you out of the
  blast radius. pnpm supports this natively (`minimumReleaseAge`); npm's nearest
  equivalent is `npm config set before <date>`.
- **Pin GitHub Actions to full commit SHAs** rather than tags, which are mutable.
- **Enable 2FA and OIDC trusted publishing** if this package is published to npm, so
  there is no long-lived token to steal.
- **Reduce the tree further.** `vitest` could be replaced by Node's built-in
  `node --test` runner (removing roughly 40 packages), `@types/chrome` by a local
  `chrome.d.ts`, and the example's `vite` bundler by plain `tsc` output — the service
  worker and panel are already ES modules and the content script has no imports.
  That would leave `typescript` as the sole third-party dependency.
