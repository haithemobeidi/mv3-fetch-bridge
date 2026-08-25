import { describe, expect, it } from 'vitest';
import {
  createSlidingWindowLimiter,
  isAllowedByPolicy,
  isPrivateOrLocalHostname,
  isSafePublicHttpsUrl,
} from '../src/url-policy.js';

const policy = {
  hosts: ['example.com', 'app.example.com'],
  hostPatterns: [/^[a-z0-9-]+\.example\.com$/i],
};

describe('isAllowedByPolicy', () => {
  it('allows exact hosts, case-insensitively', () => {
    expect(isAllowedByPolicy('https://example.com/a', policy)).toBe(true);
    expect(isAllowedByPolicy('https://EXAMPLE.com/a', policy)).toBe(true);
  });

  it('allows pattern-matched subdomains', () => {
    expect(isAllowedByPolicy('https://team-42.example.com/x', policy)).toBe(true);
  });

  it('denies unlisted hosts, including suffix look-alikes', () => {
    expect(isAllowedByPolicy('https://other.com/', policy)).toBe(false);
    expect(isAllowedByPolicy('https://example.com.evil.com/', policy)).toBe(false);
    expect(isAllowedByPolicy('https://notexample.com/', policy)).toBe(false);
  });

  it('denies non-http(s) protocols and garbage', () => {
    expect(isAllowedByPolicy('ftp://example.com/', policy)).toBe(false);
    expect(isAllowedByPolicy('chrome-extension://abc/', policy)).toBe(false);
    expect(isAllowedByPolicy('not a url', policy)).toBe(false);
    expect(isAllowedByPolicy('https://example.com/' + 'a'.repeat(3000), policy)).toBe(false);
  });

  it('denies private hosts even when a sloppy pattern would match them', () => {
    const sloppy = { hosts: [], hostPatterns: [/.*/] };
    expect(isAllowedByPolicy('https://localhost/', sloppy)).toBe(false);
    expect(isAllowedByPolicy('https://192.168.1.5/', sloppy)).toBe(false);
    expect(isAllowedByPolicy('https://169.254.169.254/', sloppy)).toBe(false);
  });
});

describe('isPrivateOrLocalHostname', () => {
  it.each([
    'localhost',
    'foo.localhost',
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    'metadata.google.internal',
    'router.lan',
    'nas.local',
    'intranet.corp',
    '::1',
    '[2001:db8::1]',
  ])('flags %s', (host) => {
    expect(isPrivateOrLocalHostname(host)).toBe(true);
  });

  it.each(['example.com', 'sub.example.co.uk', '8.8.8.8', '172.32.0.1'])(
    'passes public host %s',
    (host) => {
      expect(isPrivateOrLocalHostname(host)).toBe(false);
    },
  );
});

describe('isSafePublicHttpsUrl', () => {
  it('accepts named public HTTPS hosts', () => {
    expect(isSafePublicHttpsUrl('https://example.com/')).toBe(true);
    expect(isSafePublicHttpsUrl('https://sub.domain.example.org/path?q=1')).toBe(true);
  });

  it('rejects plain http', () => {
    expect(isSafePublicHttpsUrl('http://example.com/')).toBe(false);
  });

  it('rejects IP literals even when public', () => {
    expect(isSafePublicHttpsUrl('https://8.8.8.8/')).toBe(false);
    expect(isSafePublicHttpsUrl('https://127.0.0.1/')).toBe(false);
  });

  it('rejects localhost, bare names, and internal TLDs', () => {
    expect(isSafePublicHttpsUrl('https://localhost/')).toBe(false);
    expect(isSafePublicHttpsUrl('https://intranet/')).toBe(false);
    expect(isSafePublicHttpsUrl('https://server.internal/')).toBe(false);
  });
});

describe('createSlidingWindowLimiter', () => {
  it('allows up to the limit per key, then refuses', () => {
    const limiter = createSlidingWindowLimiter(3, 60_000);
    expect(limiter.isAllowed('a.com')).toBe(true);
    expect(limiter.isAllowed('a.com')).toBe(true);
    expect(limiter.isAllowed('a.com')).toBe(true);
    expect(limiter.isAllowed('a.com')).toBe(false);
    // Separate key has its own bucket.
    expect(limiter.isAllowed('b.com')).toBe(true);
  });
});
