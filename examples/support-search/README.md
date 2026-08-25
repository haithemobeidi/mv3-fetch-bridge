# Support Search

A Chrome MV3 side-panel extension that searches **Intercom, Slack, Linear,
Zendesk, and Jira** in parallel for tickets/messages/issues matching a
customer's query, built on [`mv3-fetch-bridge`](../../).

## The general idea (read this first)

Most internal tools don't need an API integration to be searchable — **your
browser is already logged into them**. This extension rides those existing
sessions:

1. The **side panel** owns the UI and the search logic. It never fetches
   directly.
2. Every request goes through the **background service worker**, which hosts
   the fetch bridge: one choke point that validates the URL against an
   anchored host allowlist, applies per-host rate limiting and timeouts, and
   performs the fetch **with the user's cookies** (`credentials: 'include'`),
   exactly as if the web app itself had made the call.
3. Each tool is a **connector**: one file that builds that tool's own search
   request and normalizes the response into a common `SearchResult` shape.
   Connectors are registered in `src/connectors/index.ts` (`CONNECTORS`); the
   panel renders toggles, runs searches, and paints status purely by iterating
   that registry.

Nothing leaves the machine except the requests to the tools themselves — no
server, no third parties, no AI. Credentials sit in `chrome.storage.local`
(local to the Chrome profile, never synced); session cookies never leave the
browser's cookie jar.

## How each source authenticates

The tools do **not** share an auth model, and that shapes each connector:

| Source | Endpoint | Credential | Session-ridden? |
|---|---|---|---|
| **Slack** | `api/search.messages` | `xoxc-` token (auto-scraped from an open Slack tab) **+ your `d` cookie** | **Yes** — token is dead without the cookie; the bridge sends the cookie. |
| **Zendesk** | `api/v2/search.json` | None — just your subdomain | **Yes** — the agent session cookie authenticates same-origin API GETs. |
| **Jira Cloud** | `rest/api/3/search/jql` | None — just your site URL | **Yes** — the `cloud.session.token` cookie authenticates REST calls on your site's origin. |
| **Intercom** | `conversations/search` | Access token you paste | No — token auth; bridged only for the allowlist/rate-limit choke point. |
| **Linear** | GraphQL `searchIssues` | Personal API key you paste | No — cookie auth is refused by design (verified); a personal key is the fallback. |

Session-riding is the default here; a pasted key is the exception, used only
where riding is genuinely impossible (Linear) or where a token is the app's
native model (Intercom).

## Build & load

Dependencies (Vite, TypeScript, chrome types) come from the repo root —
install there once:

```bash
# from the repo root
npm install

# then build the example
cd examples/support-search
npm run build
```

Then: `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select this `examples/support-search` folder → click the toolbar icon.

## Set up each source

Open the panel → **Settings & credentials**:

- **Slack** — nothing to paste. Click **Open Slack to capture**, load your
  workspace, return to the panel; the status flips to "Token captured".
- **Zendesk** — enter just your subdomain (`acme` for `acme.zendesk.com`) and
  be logged into Zendesk in this browser.
- **Jira** — enter your site URL (`https://acme.atlassian.net`) and be logged
  into Jira in this browser. (Self-hosted Jira Server/DC uses a different
  endpoint — see the note in `connectors/jira.ts`.)
- **Intercom access token** — Developer Hub → your app → Access token.
- **Linear API key** — Settings → Security & access → Personal API keys.

## Adding a new source (the plugin recipe)

1. Write `src/connectors/<name>.ts` returning a `SourceResult`. Copy the
   connector whose auth model matches: **zendesk/jira** (pure session-riding),
   **slack** (session + scraped token), or **intercom/linear** (pasted token).
2. Add the id to the `Source` union in `src/shared.ts`, plus any credential
   fields.
3. Register it in `CONNECTORS` in `src/connectors/index.ts` (id, label, dot
   color, search function).
4. Allow its host in `src/worker.ts` (anchored!) **and** in `manifest.json`
   `host_permissions`.
5. If it needs a pasted setting: add the input to `panel.html` (input id ==
   `Credentials` key) and list the id in `TEXT_SETTINGS` in `panel.ts`.

The panel needs no other changes — toggles, result groups, and status pills
all come from the registry.

## What each source status means

The panel reports an honest per-source state rather than collapsing everything
to "0 results" (the tri-state auth rule — a blip must never read as "log in
again"):

- **N results / no matches** — the search ran.
- **not set up** — no credential/config yet; add it in settings.
- **sign in** — the credential or session was *rejected* (401 / Slack
  `invalid_auth` / Linear auth error). Log into the tool or re-add the token.
- **unreachable** — network error or timeout. Says nothing about your
  session; just retry.
- **error** — something else (rate limit, HTTP 5xx, bad query) — the message
  explains.

## Gotchas baked in (from hard-won lessons)

- **Slack & Linear return HTTP 200 with an error body.** `search.messages`
  answers `{ok:false, error:'invalid_auth'}` and GraphQL answers `errors[]`,
  both with a 200. The connectors classify auth/rate-limit failures from the
  **body**, not the status code — otherwise a logged-out Slack renders as an
  empty result set. (Zendesk/Jira/Intercom use conventional status codes.)
- **Test logged out.** The happy-path probe is blind to auth bugs. Before
  trusting a connector, run it in an incognito window / with cookies cleared
  and confirm you get **sign in**, not **no matches**.
- **Anchored subdomain allowlists.** The worker allows
  `/^[a-z0-9-]+\.slack\.com$/i` (same for zendesk/atlassian), never
  `includes('slack.com')` — which would match `slack.com.evil.net`.
- **Batch pacing is the caller's job.** Each connector fires one request per
  search. If you extend one to fan out (e.g. fetch each Intercom thread), wrap
  it in `mapWithConcurrency(items, 4, fn)` — the worker's limiter *refuses*
  excess requests, it doesn't queue them.

## Extending

- **Deeper Intercom search:** the current query is `source.body ~ <query>`
  (first message contains). To match replies/notes you'd search, then fetch
  each conversation and scan its parts — fan that out with
  `mapWithConcurrency`.
- **Ranking:** results are grouped by source. To interleave by relevance,
  merge the `SourceResult.results` arrays and sort by `timestamp` or a score.
