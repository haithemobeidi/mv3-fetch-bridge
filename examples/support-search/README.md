# Support Search

A Chrome MV3 side-panel extension that searches **Intercom**, **Slack**, and
**Linear** in parallel for tickets/messages/issues matching a customer's query,
built on [`mv3-fetch-bridge`](../../). Every request is routed through the
background service worker — one choke point for URL allowlisting, per-host rate
limiting, timeouts, and (for Slack) riding your existing session cookies.

## How each source authenticates

The three tools do **not** share an auth model, and that shapes the design:

| Source | Endpoint | Credential | Cookie bridge? |
|---|---|---|---|
| **Slack** | `search.messages` | `xoxc-` session token (auto-scraped) **+ your `d` cookie** | **Yes** — this is the real use case. The token is dead without the cookie; the bridge sends the cookie from the worker. |
| **Intercom** | `conversations/search` | Access token you paste | No — token auth. Routed through the bridge only for the allowlist/rate-limit/timeout choke point. |
| **Linear** | GraphQL `searchIssues` | Personal API key you paste | No — Linear has a clean public API, so we hold a key instead of cookie-riding the internal endpoint. |

Only Slack needs the cookie trick. For Slack you just need to be **logged into
Slack in your browser** (not the desktop app) — open your workspace at
`app.slack.com` once and a content script captures the `xoxc` token into
`chrome.storage.local`. The cookie itself never leaves the browser's jar.

## Build & load

Dependencies (Vite, TypeScript, chrome types) come from the repo root — install
there once:

```bash
# from the repo root
npm install

# then build the example
cd examples/support-search
npm run build
```

This emits `dist/worker.js`, `dist/panel.js`, and `dist/slack-token.js`. Then:

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `examples/support-search` folder.
3. Click the toolbar icon to open the side panel.

## Set up credentials

Open the panel → **Settings & credentials**:

- **Intercom access token** — Developer Hub → your app → Access token.
- **Linear API key** — Linear → Settings → Security & access → Personal API keys.
- **Slack** — nothing to paste. Click **Open Slack to capture**, load your
  workspace, then return to the panel; the status flips to "Token captured".

Then type a query, toggle which sources to include, and search.

## What each source status means

The panel reports an honest per-source state rather than collapsing everything
to "0 results" (this is the tri-state auth rule — a blip must never read as
"log in again"):

- **N results / no matches** — the search ran.
- **not set up** — no credential yet; add one in settings.
- **sign in** — the credential was *rejected* (Intercom 401 / Slack
  `invalid_auth` / Linear auth error). Re-add the token, or re-capture Slack.
- **unreachable** — network error or timeout. The request could not complete;
  it says nothing about your session. Just retry.
- **error** — something else (rate limit, HTTP 5xx, bad query) — the message
  explains.

## Gotchas baked in (from hard-won lessons)

- **Slack & Linear return HTTP 200 with an error body.** `search.messages`
  answers `{ok:false, error:'invalid_auth'}` and GraphQL answers `errors[]`,
  both with a 200 status. The connectors classify auth/rate-limit failures from
  the **body**, not the status code — otherwise a logged-out Slack renders as an
  empty result set.
- **Test logged out.** The happy-path probe is blind to auth bugs on these
  APIs. Before trusting a connector, run it in an incognito window / with the
  Slack cookie cleared and confirm you get **sign in**, not **no matches**.
- **Anchored Slack subdomain allowlist.** The worker allows
  `/^[a-z0-9-]+\.slack\.com$/i`, not `includes('slack.com')` (which would match
  `slack.com.evil.net`).
- **Batch pacing is the caller's job.** Each connector fires one request per
  search, so nothing needs pacing today. If you extend a connector to fan out
  (e.g. fetch each Intercom thread), wrap it in `mapWithConcurrency(items, 4,
  fn)` — the worker's limiter *refuses* excess requests, it doesn't queue them.

## Extending

- **Deeper Intercom search:** the current query is `source.body ~ <query>`
  (first message contains). To match conversation replies/notes you'd search,
  then fetch each conversation and scan its parts — fan that out with
  `mapWithConcurrency`.
- **Ranking:** results are grouped by source. To interleave by relevance,
  merge the `SourceResult.results` arrays and sort by `timestamp` or a score.
- **More sources:** add a connector in `src/connectors/` returning a
  `SourceResult`, register its host in the worker allowlist, and add it to
  `searchAll` + the panel toggles.
