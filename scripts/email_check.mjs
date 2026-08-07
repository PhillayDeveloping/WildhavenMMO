#!/usr/bin/env node
// Preflight for the outbound-email configuration: prove a real message reaches a
// real inbox BEFORE a player finds out it does not.
//
//   node scripts/email_check.mjs you@your-domain.example
//
// Why this exists. Every send in the game is fire-and-forget by design (a mail
// outage must never fail the HTTP request that triggered it), and with no
// EMAIL_* configured the transport is ConsoleSender, which logs and delivers
// nothing. Both are correct, and together they mean a broken mail setup looks
// EXACTLY like a working one from the outside: registration succeeds, "forgot
// password" reports success, and the letter simply never arrives. The first
// person to notice is a locked-out player.
//
// Reads .env, resolves the transport through the same selectSender the server
// uses, and reports which one answered. Never prints the API key.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

const to = process.argv[2];
if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
  console.error('usage: node scripts/email_check.mjs <your-address@example.com>');
  console.error('Send a test message to an address you can actually read.');
  process.exit(1);
}

try {
  process.loadEnvFile?.();
} catch {
  // .env is optional; an operator may pass EMAIL_* directly.
}

// server/email is TypeScript, and this repo never imports TS sources raw from a
// .mjs script (scripts/CLAUDE.md), so bundle the one entry point with esbuild the
// way the other sim-touching scripts do, then run the bundle.
const work = mkdtempSync(path.join(tmpdir(), 'wildhaven-email-check-'));
const entry = path.join(work, 'entry.mjs');
const bundle = path.join(work, 'bundle.cjs');
writeFileSync(
  entry,
  `import { selectSender } from ${JSON.stringify(path.join(ROOT, 'server/email/sender.ts'))};
const sender = selectSender(process.env);
const to = process.argv[2];
console.log(JSON.stringify({ transport: sender.name }));
if (sender.name === 'console') process.exit(3);
sender
  .send({
    to,
    subject: 'Wildhaven email check',
    html: '<p>If you are reading this, outbound email works. Password recovery will reach your players.</p>',
    text: 'If you are reading this, outbound email works. Password recovery will reach your players.',
  })
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err?.message ?? String(err));
    process.exit(4);
  });
`,
  'utf8',
);

const built = spawnSync(
  process.execPath,
  [
    path.join(ROOT, 'node_modules/esbuild/bin/esbuild'),
    entry,
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--external:@aws-sdk/*',
    `--outfile=${bundle}`,
  ],
  { encoding: 'utf8' },
);
if (built.status !== 0) {
  console.log(`${RED}FAIL${OFF} could not bundle the mail transport.`);
  console.log(built.stderr?.trim() ?? '');
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

const run = spawnSync(process.execPath, [bundle, to], { encoding: 'utf8' });
rmSync(work, { recursive: true, force: true });

const transport = (() => {
  const line = (run.stdout ?? '').split('\n').find((l) => l.includes('"transport"'));
  try {
    return line ? JSON.parse(line).transport : 'unknown';
  } catch {
    return 'unknown';
  }
})();

if (run.status === 3) {
  console.log(`${YELLOW}warn${OFF} The console transport is active: nothing is sent.`);
  console.log(`     ${DIM}Registration and "forgot password" will still report success,`);
  console.log(`     so a locked-out player has no way back in.${OFF}`);
  console.log('');
  console.log('     For Resend (no new dependency, and you can verify your own domain later):');
  console.log('       EMAIL_API_URL=https://api.resend.com/emails');
  console.log('       EMAIL_API_KEY=re_...');
  console.log('       EMAIL_FROM=Wildhaven <no-reply@your-domain.example>');
  console.log('');
  console.log('     Until the domain is verified, Resend only accepts onboarding@resend.dev');
  console.log('     as the from-address, and only to your own account address.');
  process.exit(1);
}

if (run.status !== 0) {
  console.log(`${RED}FAIL${OFF} The ${transport} transport refused the message.`);
  console.log(`     ${(run.stderr ?? '').trim().slice(0, 500)}`);
  console.log('');
  console.log('     A 401 is the API key; a 403 about the from-address means the sending');
  console.log('     domain is not verified with the provider yet.');
  process.exit(1);
}

console.log(`${GREEN}ok${OFF}   Sent through the ${transport} transport.`);
console.log(`     ${DIM}Check ${to} (and its spam folder). If it arrives, password`);
console.log(`     recovery works for your players.${OFF}`);
