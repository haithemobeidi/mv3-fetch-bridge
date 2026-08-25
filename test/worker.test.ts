import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFetchBridge } from '../src/worker.js';
import type { BridgeResponse } from '../src/types.js';

const SENDER = {} as chrome.runtime.MessageSender;

/** Build a minimal Response-like object good enough for the worker. */
function fakeResponse(overrides: Partial<{
  status: number;
  statusText: string;
  redirected: boolean;
  url: string;
  contentType: string | null;
  text: string;
  buffer: ArrayBuffer;
}> = {}) {
  const headers = new Headers();
  if (overrides.contentType !== null) {
    headers.set('content-type', overrides.contentType ?? 'text/html; charset=utf-8');
  }
  return {
    status: overrides.status ?? 200,
    statusText: overrides.statusText ?? 'OK',
    redirected: overrides.redirected ?? false,
    url: overrides.url ?? 'https://example.com/page',
    headers,
    text: async () => overrides.text ?? '<html></html>',
    arrayBuffer: async () => overrides.buffer ?? new ArrayBuffer(4),
  };
}

/** Run one message through the bridge and await its sendResponse payload. */
function invoke(
  bridge: ReturnType<typeof createFetchBridge>,
  message: unknown,
): Promise<BridgeResponse> {
  return new Promise((resolve) => {
    const returned = bridge.handleMessage(message, SENDER, resolve as never);
    // Bridge fetches must signal an async response.
    expect(returned).toBe(true);
  });
}

const baseConfig = {
  allowlist: { hosts: ['example.com'] },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('createFetchBridge', () => {
  it('ignores unrelated messages', () => {
    const bridge = createFetchBridge(baseConfig);
    const sendResponse = vi.fn();
    expect(bridge.handleMessage({ action: 'other' }, SENDER, sendResponse)).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('rejects malformed bridge requests synchronously', () => {
    const bridge = createFetchBridge(baseConfig);
    const sendResponse = vi.fn();
    bridge.handleMessage({ action: 'bridge-fetch' }, SENDER, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, errorType: 'security' }),
    );
  });

  it('blocks disallowed URLs before fetching', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const onBlocked = vi.fn();
    const bridge = createFetchBridge({ ...baseConfig, onBlocked });

    const res = await invoke(bridge, {
      action: 'bridge-fetch',
      requestId: 'r1',
      url: 'https://evil.com/',
    });

    expect(res).toMatchObject({ ok: false, errorType: 'security' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalledWith('https://evil.com/', 'security');
  });

  it('enforces the per-host rate limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse()));
    const bridge = createFetchBridge({ ...baseConfig, maxRequestsPerMinutePerHost: 2 });

    const ok1 = await invoke(bridge, { action: 'bridge-fetch', requestId: 'a', url: 'https://example.com/1' });
    const ok2 = await invoke(bridge, { action: 'bridge-fetch', requestId: 'b', url: 'https://example.com/2' });
    const limited = await invoke(bridge, { action: 'bridge-fetch', requestId: 'c', url: 'https://example.com/3' });

    expect(ok1.ok).toBe(true);
    expect(ok2.ok).toBe(true);
    expect(limited).toMatchObject({ ok: false, errorType: 'rateLimit' });
  });

  it('returns text bodies with status, headers, and final URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ text: 'hello', status: 404, statusText: 'Not Found' })));
    const bridge = createFetchBridge(baseConfig);

    const res = await invoke(bridge, { action: 'bridge-fetch', requestId: 'r', url: 'https://example.com/x' });

    // Completed HTTP responses are ok:true regardless of status — callers decide.
    expect(res).toMatchObject({
      ok: true,
      status: 404,
      data: 'hello',
      finalUrl: 'https://example.com/page',
      redirected: false,
    });
  });

  it('parses JSON bodies and falls back to raw text on parse failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ contentType: 'application/json', text: '{"a":1}' })));
    const bridge = createFetchBridge(baseConfig);
    const res = await invoke(bridge, { action: 'bridge-fetch', requestId: 'j', url: 'https://example.com/api' });
    expect(res.ok && res.data).toEqual({ a: 1 });

    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ contentType: 'application/json', text: 'not json' })));
    const res2 = await invoke(bridge, { action: 'bridge-fetch', requestId: 'j2', url: 'https://example.com/api' });
    expect(res2.ok && res2.data).toBe('not json');
  });

  it('base64-encodes binary bodies (ArrayBuffers do not survive sendMessage)', async () => {
    const bytes = new Uint8Array([1, 2, 3, 250]).buffer;
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ contentType: 'application/octet-stream', buffer: bytes })));
    const bridge = createFetchBridge(baseConfig);

    const res = await invoke(bridge, { action: 'bridge-fetch', requestId: 'b', url: 'https://example.com/bin' });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.dataEncoding).toBe('base64');
      expect(res.data).toBe(btoa(String.fromCharCode(1, 2, 3, 250)));
    }
  });

  it('detects auth redirects via redirected + final URL, not status codes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      fakeResponse({ redirected: true, url: 'https://example.com/accounts/login/?next=/x', status: 200 }),
    ));
    const bridge = createFetchBridge({
      ...baseConfig,
      isAuthRedirect: (u) => u.pathname.startsWith('/accounts/login'),
    });

    const res = await invoke(bridge, { action: 'bridge-fetch', requestId: 'l', url: 'https://example.com/x' });

    expect(res).toMatchObject({
      ok: false,
      errorType: 'auth',
      finalUrl: 'https://example.com/accounts/login/?next=/x',
    });
  });

  it('does not flag ordinary redirects when no predicate matches', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ redirected: true, url: 'https://example.com/final' })));
    const bridge = createFetchBridge({
      ...baseConfig,
      isAuthRedirect: (u) => u.pathname.startsWith('/accounts/login'),
    });
    const res = await invoke(bridge, { action: 'bridge-fetch', requestId: 'r', url: 'https://example.com/moved' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.redirected).toBe(true);
  });

  it('answers timeout when the fetch outlives timeoutMs', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      }),
    ));
    const bridge = createFetchBridge(baseConfig);

    const pending = invoke(bridge, {
      action: 'bridge-fetch',
      requestId: 't',
      url: 'https://example.com/slow',
      options: { timeoutMs: 5000 },
    });
    await vi.advanceTimersByTimeAsync(5001);
    const res = await pending;

    expect(res).toMatchObject({ ok: false, errorType: 'timeout' });
    expect(bridge.activeCount()).toBe(0);
  });

  it('answers abort when the caller cancels via the abort action', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      }),
    ));
    const bridge = createFetchBridge(baseConfig);

    const pending = invoke(bridge, { action: 'bridge-fetch', requestId: 'x', url: 'https://example.com/slow' });
    // Let the fetch start before aborting.
    await new Promise((r) => setTimeout(r, 0));
    const sendResponse = vi.fn();
    bridge.handleMessage({ action: 'bridge-fetch:abort', requestId: 'x' }, SENDER, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });

    const res = await pending;
    expect(res).toMatchObject({ ok: false, errorType: 'abort' });
  });

  it('classifies transport failures as network errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    const bridge = createFetchBridge(baseConfig);
    const res = await invoke(bridge, { action: 'bridge-fetch', requestId: 'n', url: 'https://example.com/' });
    expect(res).toMatchObject({ ok: false, errorType: 'network', error: 'Failed to fetch' });
  });

  it('public-probe mode returns headers only and requires opt-in', async () => {
    const fetchSpy = vi.fn(async () => fakeResponse({ text: 'secret body' }));
    vi.stubGlobal('fetch', fetchSpy);

    // Not opted in: refused.
    const closed = createFetchBridge(baseConfig);
    const refused = await invoke(closed, {
      action: 'bridge-fetch',
      requestId: 'p0',
      url: 'https://any-site.org/',
      options: { mode: 'public-probe' },
    });
    expect(refused).toMatchObject({ ok: false, errorType: 'security' });

    // Opted in: any public HTTPS host, but data stays null.
    const open = createFetchBridge({ ...baseConfig, allowPublicProbe: true });
    const res = await invoke(open, {
      action: 'bridge-fetch',
      requestId: 'p1',
      url: 'https://any-site.org/',
      options: { mode: 'public-probe' },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toBeNull();
      expect(res.headers['content-type']).toContain('text/html');
    }
  });
});
