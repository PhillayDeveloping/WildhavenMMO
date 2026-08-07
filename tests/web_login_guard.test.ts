import { describe, expect, it } from 'vitest';
import {
  allowedCorsOrigin,
  DESKTOP_APP_ORIGINS,
  isDesktopAppRequest,
  isNativeAppRequest,
  isWebClientRequest,
  webLoginEnforced,
} from '../server/web_login_guard';

const req = (headers: Record<string, string>) => ({ headers }) as any;

describe('web login guard (anti-bot)', () => {
  it('enforces in production, is off in dev/test, and honours REQUIRE_WEB_LOGIN', () => {
    expect(webLoginEnforced({ NODE_ENV: 'production' } as any)).toBe(true);
    expect(webLoginEnforced({ NODE_ENV: 'test' } as any)).toBe(false);
    expect(webLoginEnforced({ NODE_ENV: 'development' } as any)).toBe(false);
    expect(webLoginEnforced({ NODE_ENV: 'production', REQUIRE_WEB_LOGIN: '0' } as any)).toBe(false);
    expect(webLoginEnforced({ NODE_ENV: 'development', REQUIRE_WEB_LOGIN: '1' } as any)).toBe(true);
  });

  it('rejects requests with no Origin (curl / headless scripts / multibox)', () => {
    expect(isWebClientRequest(req({}))).toBe(false);
    expect(isWebClientRequest(req({ 'user-agent': 'Mozilla/5.0' }))).toBe(false); // spoofed UA, still no Origin
  });

  it('accepts a same-origin browser POST (Origin host matches Host / X-Forwarded-Host)', () => {
    expect(
      isWebClientRequest(req({ origin: 'https://play.example.com', host: 'play.example.com' })),
    ).toBe(true);
    expect(
      isWebClientRequest(
        req({ origin: 'https://play.example.com', 'x-forwarded-host': 'play.example.com' }),
      ),
    ).toBe(true);
  });

  it('accepts an explicit WEB_ORIGINS allow-list entry and localhost dev', () => {
    expect(
      isWebClientRequest(req({ origin: 'https://play.example.com' }), {
        WEB_ORIGINS: 'https://play.example.com',
      } as any),
    ).toBe(true);
    expect(
      isWebClientRequest(req({ origin: 'http://localhost:5173', host: '127.0.0.1:8787' })),
    ).toBe(true);
  });

  it('rejects a tunnelled login when the proxy rewrote Host, until WEB_ORIGINS names the public origin', () => {
    // The failure mode for a realm exposed through a tunnel or reverse proxy.
    // Enforcement is on in production, and the guard matches the browser's Origin
    // against the request's OWN Host: a proxy configured to rewrite Host to its
    // upstream leaves nothing to match, so every login and registration 403s
    // while the site itself loads fine. It reads like broken credentials.
    const tunnelled = req({ origin: 'https://play.example.com', host: 'localhost:8787' });
    expect(isWebClientRequest(tunnelled, {} as any)).toBe(false);
    expect(isWebClientRequest(tunnelled, { WEB_ORIGINS: 'https://play.example.com' } as any)).toBe(
      true,
    );
    // A proxy that forwards the original host instead needs no configuration.
    expect(
      isWebClientRequest(
        req({
          origin: 'https://play.example.com',
          host: 'localhost:8787',
          'x-forwarded-host': 'play.example.com',
        }),
        {} as any,
      ),
    ).toBe(true);
  });

  it('accepts Capacitor native app origins', () => {
    expect(
      isWebClientRequest(req({ origin: 'capacitor://localhost', host: 'wildhaven.example' })),
    ).toBe(true);
    expect(isWebClientRequest(req({ origin: 'http://localhost', host: 'wildhaven.example' }))).toBe(
      true,
    );
    expect(
      isWebClientRequest(req({ origin: 'https://localhost', host: 'wildhaven.example' })),
    ).toBe(true);
  });

  it('identifies native app origins for Turnstile bypass', () => {
    expect(
      isNativeAppRequest(req({ origin: 'capacitor://localhost', host: 'wildhaven.example' })),
    ).toBe(true);
    expect(isNativeAppRequest(req({ origin: 'http://localhost', host: 'wildhaven.example' }))).toBe(
      true,
    );
    expect(
      isNativeAppRequest(req({ origin: 'https://localhost', host: 'wildhaven.example' })),
    ).toBe(true);
    expect(
      isNativeAppRequest(req({ origin: 'https://wildhaven.example', host: 'wildhaven.example' })),
    ).toBe(false);
    expect(
      isNativeAppRequest(req({ origin: 'https://evil.example.com', host: 'wildhaven.example' })),
    ).toBe(false);
    expect(isNativeAppRequest(req({ host: 'wildhaven.example' }))).toBe(false);
  });

  it('rejects a foreign origin', () => {
    expect(
      isWebClientRequest(req({ origin: 'https://evil.example.com', host: 'play.example.com' })),
    ).toBe(false);
  });
});

describe('desktop app origins (Electron shell)', () => {
  it('identifies every desktop app origin for the Turnstile bypass', () => {
    for (const origin of DESKTOP_APP_ORIGINS) {
      expect(isDesktopAppRequest(req({ origin }))).toBe(true);
    }
  });

  it('rejects look-alike, web, native, and missing origins', () => {
    expect(isDesktopAppRequest(req({ origin: 'app://evil' }))).toBe(false);
    expect(isDesktopAppRequest(req({ origin: 'app://wildhaven.evil' }))).toBe(false);
    expect(isDesktopAppRequest(req({ origin: 'https://wildhaven.example' }))).toBe(false);
    expect(isDesktopAppRequest(req({ origin: 'capacitor://localhost' }))).toBe(false);
    expect(isDesktopAppRequest(req({}))).toBe(false);
  });

  it('passes the web-login guard for every desktop origin while enforcement is on', () => {
    expect(webLoginEnforced({ NODE_ENV: 'production' } as any)).toBe(true);
    for (const origin of DESKTOP_APP_ORIGINS) {
      expect(isWebClientRequest(req({ origin, host: 'wildhaven.example' }))).toBe(true);
    }
    expect(isWebClientRequest(req({ origin: 'app://evil', host: 'wildhaven.example' }))).toBe(
      false,
    );
  });
});

describe('API CORS reflection allow-list (allowedCorsOrigin)', () => {
  it('reflects each desktop app origin', () => {
    for (const origin of DESKTOP_APP_ORIGINS) {
      expect(allowedCorsOrigin(origin)).toBe(origin);
    }
  });

  it('reflects native app origins', () => {
    expect(allowedCorsOrigin('capacitor://localhost')).toBe('capacitor://localhost');
    expect(allowedCorsOrigin('http://localhost')).toBe('http://localhost');
    expect(allowedCorsOrigin('https://localhost')).toBe('https://localhost');
  });

  it('does not reflect look-alikes, unlisted origins, or a missing Origin', () => {
    expect(allowedCorsOrigin('app://evil')).toBeNull();
    expect(allowedCorsOrigin('app://wildhaven.evil')).toBeNull();
    // Unlisted here because REALM_ORIGINS is empty in the test env; a
    // deployment that lists the site origin as a realm URL reflects it. The
    // same-origin page never needs CORS either way.
    expect(allowedCorsOrigin('https://wildhaven.example')).toBeNull();
    expect(allowedCorsOrigin(undefined)).toBeNull();
    expect(allowedCorsOrigin('')).toBeNull();
  });
});
