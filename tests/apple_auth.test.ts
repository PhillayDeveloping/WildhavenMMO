import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleAppleLoginNew,
  resetAppleKeyCacheForTests,
  verifyAppleIdentityToken,
} from '../server/apple_auth';
import {
  consumeApplePendingLogin,
  createApplePendingLogin,
  linkAppleAccount,
  peekApplePendingLogin,
  pruneApplePendingLogins,
} from '../server/apple_auth_db';
import { resetRateLimits } from '../server/ratelimit';
import { FakeRes, makeReq } from './server/helpers';

// Regenerated when the rebrand moved APPLE_CLIENT_ID to com.wildhaven: the
// previous fixture's aud was com.worldofclaudecraft, so verification rejected it
// on audience and this suite was red. The token is RS256-signed, so the audience
// cannot be edited in place; key and token were minted together. Claims are
// otherwise unchanged, so the assertions below still test what they tested.
const APPLE_TOKEN =
  'eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2V5In0.eyJpc3MiOiJodHRwczovL2FwcGxlaWQuYXBwbGUuY29tIiwiYXVkIjoiY29tLndpbGRoYXZlbiIsImV4cCI6NDEwMjQ0NDgwMCwic3ViIjoiYXBwbGUtdXNlci0xIiwibm9uY2UiOiJjaGFsbGVuZ2Utbm9uY2UiLCJlbWFpbCI6InJlbGF5QGV4YW1wbGUuY29tIiwiZW1haWxfdmVyaWZpZWQiOiJ0cnVlIn0.PSBnYbAuVXZdVTiQhtCj5S_Maslq69snyKKDl6FpbgDgwJIMDEFZm98QO9RyQA1gn4u7Z3IEt9c-7EdpQlVgEo5CR85GjLY3ycVGv-P32kHtgIjVvo2mNDkaFoifkVsnVVVnUy5XeBpJWEak2_fz1_MW7jnd26m9Rq40jaaNAhP84Q9AFRb9hRecNncwxUWPbby2_TkA_Pf_eoYJ-UJUZkQgBPn8G3fMk64LVJR8vBPSAJu-eQB-0y4YBEPkXHp6lj6ICgkbioleiVYMVx4NI9eLQfsO9DOahvIoeKJjut4fd-s5nLq3gCf1ECpExD_L61TShn6Eni4lMP7TKitZ2A';
const APPLE_JWK = {
  kty: 'RSA',
  n: 'vSMVaJdo5m-CdBqNRusZ3poYhd7MuVQXJqx1djG-vBIfjg832Z-Q7327wJ5fFBNKHAkeQ5ts0eXawR1LAtww1FHF8YsvLbv1xxLBr65HoqggKs4Ok-psJGI0l2BjLDEiG2Q2B7P9vxCYNRr3G0PUKUC1GFhp8G_cz6UxTyXZjR57Wc__dowF7osBvkG8l0Cz4ZEGOXELXtlarqJWKls7oPqTzviX61C0sc2eltvaV8PUQpE-QQH_P7J4c6c4NPH0h1uMiq0fbAq0wZYHSED4bIj_6O3xZ2kfHVME3ceuQTVxPqjGqp6rHfXt3fV1EYWNVkUaLkAHStIcu9xjHhOIOQ',
  e: 'AQAB',
  kid: 'test-key',
  alg: 'RS256',
} as JsonWebKey;

afterEach(() => {
  vi.unstubAllGlobals();
  resetAppleKeyCacheForTests();
  resetRateLimits();
});

describe('Apple identity token verification', () => {
  it('accepts a signed token with the app audience and matching nonce', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ keys: [APPLE_JWK] }))),
    );
    await expect(verifyAppleIdentityToken(APPLE_TOKEN, 'challenge-nonce')).resolves.toEqual({
      subject: 'apple-user-1',
      email: 'relay@example.com',
      emailVerified: true,
    });
  });

  it('rejects replay under a different native challenge', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ keys: [APPLE_JWK] }))),
    );
    await expect(verifyAppleIdentityToken(APPLE_TOKEN, 'other-nonce')).resolves.toBeNull();
  });

  it('refreshes the JWKS once when Apple rotates to an unknown key ID', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [APPLE_JWK] })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(verifyAppleIdentityToken(APPLE_TOKEN, 'challenge-nonce')).resolves.not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('Apple account attachment guards', () => {
  it('fails closed when either side of the Apple link is already claimed', async () => {
    const pool = { query: vi.fn().mockRejectedValue({ code: '23505' }) };
    await expect(linkAppleAccount(pool as never, 7, 'subject', null)).resolves.toBe(false);
  });
});

describe('Apple pending login choices', () => {
  const row = {
    token: 'choice-token',
    apple_subject: 'apple-user-1',
    apple_email: 'player@example.com',
    apple_email_verified: true,
    display_name: 'Player One',
  };

  it('parks an expiring verified identity for the chooser', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    await createApplePendingLogin({ query } as never, {
      token: row.token,
      subject: row.apple_subject,
      email: row.apple_email,
      emailVerified: true,
      displayName: row.display_name,
      ttlMinutes: 15,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO apple_pending_logins'),
      [row.token, row.apple_subject, row.apple_email, true, row.display_name, '15'],
    );
  });

  it('peeks without consuming, then consumes with one atomic delete', async () => {
    const peekQuery = vi.fn().mockResolvedValue({ rows: [row], rowCount: 1 });
    await expect(peekApplePendingLogin({ query: peekQuery } as never, row.token)).resolves.toEqual(
      row,
    );
    expect(String(peekQuery.mock.calls[0][0])).not.toContain('DELETE');

    const consumeQuery = vi.fn().mockResolvedValue({ rows: [row], rowCount: 1 });
    await expect(
      consumeApplePendingLogin({ query: consumeQuery } as never, row.token),
    ).resolves.toEqual(row);
    expect(String(consumeQuery.mock.calls[0][0])).toContain('DELETE FROM apple_pending_logins');
  });

  it('deletes expired pending identities during maintenance', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 2 });
    await pruneApplePendingLogins({ query } as never);
    expect(query).toHaveBeenCalledWith(
      'DELETE FROM apple_pending_logins WHERE expires_at <= now()',
    );
  });

  it('rejects blocked IP account creation before consuming the pending identity', async () => {
    const req = makeReq({ method: 'POST', url: '/api/auth/apple/login/new' });
    (req.socket as { remoteAddress: string }).remoteAddress = '203.0.113.9';
    const res = new FakeRes();
    const isIpBlocked = vi.fn(() => true);

    await handleAppleLoginNew(req, res as never, { linkToken: row.token }, isIpBlocked);

    expect(isIpBlocked).toHaveBeenCalledWith('203.0.113.9');
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body)).toEqual({
      error: 'rate limited',
      code: 'auth.too_many_attempts',
    });
  });
});
