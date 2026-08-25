import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBridgeClient, mapWithConcurrency } from '../src/client.js';

function stubChrome(sendMessage: (message: unknown) => Promise<unknown>) {
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(sendMessage) } });
  return (globalThis as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createBridgeClient', () => {
  it('sends the protocol message and returns the worker reply', async () => {
    const stub = stubChrome(async () => ({ ok: true, status: 200, data: 'x' }));
    const client = createBridgeClient();

    const res = await client.fetch('https://example.com/', { method: 'GET' });

    expect(res).toMatchObject({ ok: true, status: 200 });
    const sent = stub.runtime.sendMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.action).toBe('bridge-fetch');
    expect(sent.url).toBe('https://example.com/');
    expect(typeof sent.requestId).toBe('string');
  });

  it('maps messaging failures to a typed network error instead of throwing', async () => {
    stubChrome(async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    });
    const client = createBridgeClient();

    const res = await client.fetch('https://example.com/');

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorType).toBe('network');
      expect(res.error).toContain('Receiving end does not exist');
    }
  });

  it('maps an empty reply (listener never responded) to a network error', async () => {
    stubChrome(async () => undefined);
    const client = createBridgeClient();
    const res = await client.fetch('https://example.com/');
    expect(res).toMatchObject({ ok: false, errorType: 'network' });
  });

  it('fetchText returns 2xx text and throws on bridge or HTTP errors', async () => {
    stubChrome(async () => ({ ok: true, status: 200, statusText: 'OK', data: 'body' }));
    expect(await createBridgeClient().fetchText('https://example.com/')).toBe('body');

    stubChrome(async () => ({ ok: true, status: 500, statusText: 'Server Error', data: 'oops' }));
    await expect(createBridgeClient().fetchText('https://example.com/')).rejects.toThrow('HTTP 500');

    stubChrome(async () => ({ ok: false, errorType: 'auth', error: 'login required' }));
    await expect(createBridgeClient().fetchText('https://example.com/')).rejects.toThrow('auth: login required');
  });

  it('start() sends an abort message with the same requestId', async () => {
    const stub = stubChrome(async () => ({ ok: true, status: 200, data: '' }));
    const client = createBridgeClient({ action: 'custom-fetch' });

    const call = client.start('https://example.com/');
    call.abort();
    await call.response;

    const actions = stub.runtime.sendMessage.mock.calls.map(
      (c) => (c[0] as Record<string, unknown>).action,
    );
    expect(actions).toContain('custom-fetch');
    expect(actions).toContain('custom-fetch:abort');
    const abortMsg = stub.runtime.sendMessage.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((m) => m.action === 'custom-fetch:abort');
    expect(abortMsg?.requestId).toBe(call.requestId);
  });
});

describe('mapWithConcurrency', () => {
  it('preserves order and caps concurrent workers', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = [1, 2, 3, 4, 5, 6, 7, 8];

    const results = await mapWithConcurrency(items, 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n * 10;
    });

    expect(results).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('handles empty input and limit larger than input', async () => {
    expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([]);
    expect(await mapWithConcurrency([1], 99, async (x) => x + 1)).toEqual([2]);
  });
});
