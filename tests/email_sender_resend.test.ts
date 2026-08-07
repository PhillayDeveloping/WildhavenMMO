// The generic HTTP transport IS the Resend integration: Resend's send endpoint
// takes a bearer key and a JSON body of exactly { from, to, subject, html, text },
// which is what HttpSender already posts. This pins that, because the fit is the
// whole reason a self-hosted realm can get working password-recovery mail with
// three .env values and no new dependency, and nothing else would notice if a
// future edit renamed a field or moved the key into a header of its own.
//
// No SMTP transport exists on purpose (the repo keeps its dependency set tiny and
// every mailer needs one), so this is the recommended path.
import { describe, expect, it, vi } from 'vitest';
import { ConsoleSender, HttpSender, selectSender } from '../server/email/sender';

const RESEND_ENV = {
  EMAIL_API_URL: 'https://api.resend.com/emails',
  EMAIL_API_KEY: 're_testkey_123',
  EMAIL_FROM: 'Wildhaven <no-reply@wildhaven.example>',
} as NodeJS.ProcessEnv;

const MSG = {
  to: 'player@example.com',
  subject: 'Reset your password',
  html: '<p>Reset link</p>',
  text: 'Reset link',
};

describe('Resend through the generic HTTP transport', () => {
  it('is selected by the three EMAIL_API_* values with no EMAIL_PROVIDER set', () => {
    const sender = selectSender(RESEND_ENV);
    expect(sender).toBeInstanceOf(HttpSender);
    expect(sender.name).toBe('http');
  });

  it.each([
    ['EMAIL_API_URL', { ...RESEND_ENV, EMAIL_API_URL: undefined }],
    ['EMAIL_API_KEY', { ...RESEND_ENV, EMAIL_API_KEY: undefined }],
    ['EMAIL_FROM', { ...RESEND_ENV, EMAIL_FROM: undefined }],
  ])('falls back to the console transport when %s is missing', (_name, env) => {
    // Half-configured must never silently drop mail: the console sender logs
    // every send, so an operator who set two of three sees them in the log.
    expect(selectSender(env as NodeJS.ProcessEnv)).toBeInstanceOf(ConsoleSender);
  });

  it('posts the exact envelope Resend documents, with the key as a bearer token', async () => {
    const fetchMock = vi.fn(async () => new Response('{"id":"abc"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await selectSender(RESEND_ENV).send(MSG);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://api.resend.com/emails');
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer re_testkey_123');
      expect(headers['content-type']).toBe('application/json');
      // Field names are the contract; a rename here silently stops mail.
      expect(JSON.parse(String(init.body))).toEqual({
        from: 'Wildhaven <no-reply@wildhaven.example>',
        to: 'player@example.com',
        subject: 'Reset your password',
        html: '<p>Reset link</p>',
        text: 'Reset link',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects with the provider status and body so a bad key is diagnosable', async () => {
    // The service swallows the rejection into a logged failure, so this message
    // is the only place an operator learns WHY delivery failed.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"message":"API key is invalid"}', { status: 401 })),
    );
    try {
      await expect(selectSender(RESEND_ENV).send(MSG)).rejects.toThrow(/401.*API key is invalid/s);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
