/**
 * Runs all three connectors for one query and returns their per-source
 * outcomes. Each source is independent: three different hosts (so the
 * per-host rate limiter never makes them contend), and one failing source
 * never sinks the others — Promise.all over calls that never reject.
 *
 * NOTE on pacing (KB: batch pacing is caller-owned): each connector fires ONE
 * request per search, so there's nothing to pace here. If you extend a
 * connector to fan out (e.g. fetch each Intercom conversation's full thread),
 * wrap that fan-out in `mapWithConcurrency(items, 4, fn)` from the library —
 * the worker's limiter refuses excess requests, it does not queue them.
 */

import type { BridgeClient } from 'mv3-fetch-bridge';
import { type Credentials, type SourceResult } from '../shared.js';
import { searchIntercom } from './intercom.js';
import { searchSlack } from './slack.js';
import { searchLinear } from './linear.js';

export interface SearchScope {
  intercom: boolean;
  slack: boolean;
  linear: boolean;
}

export const ALL_SOURCES: SearchScope = { intercom: true, slack: true, linear: true };

export async function searchAll(
  bridge: BridgeClient,
  query: string,
  creds: Credentials,
  scope: SearchScope = ALL_SOURCES,
): Promise<SourceResult[]> {
  const tasks: Promise<SourceResult>[] = [];

  if (scope.intercom) {
    tasks.push(searchIntercom(bridge, query, creds.intercomToken, creds.intercomHost));
  }
  if (scope.slack) {
    tasks.push(searchSlack(bridge, query, creds.slackToken, creds.slackTeamUrl));
  }
  if (scope.linear) {
    tasks.push(searchLinear(bridge, query, creds.linearApiKey));
  }

  return Promise.all(tasks);
}

export { searchIntercom, searchSlack, searchLinear };
