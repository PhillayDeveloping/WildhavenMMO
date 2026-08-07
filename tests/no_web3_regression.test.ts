import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tsFilesUnder } from './helpers/ts_files_under';

// This fork is web3-free by design, and the removal is a MERGE-FRAGILE property.
//
// Upstream (levy-street/world-of-claudecraft) still ships the Solana wallet, the
// Seeker entitlement, the holder tier, and the external payout runner. Every time
// this fork syncs a new upstream release, git resolves most of that tree without
// asking: a file we deleted and upstream merely edited raises a conflict, but code
// upstream ADDS on lines we never touched merges silently. That is not a
// hypothetical. The v0.35.0 sync auto-merged upstream's payout-runner columns
// (prize_usd, tx_signature, signed_transaction) into our prize_copper schema, and
// taking upstream's package.json wholesale to pick up a version bump dragged ten
// web3 dependencies back in. Neither produced a conflict marker.
//
// So this guard exists to make the next sync fail LOUDLY instead of quietly. It
// deliberately does NOT try to remove anything: an automatic stripper would edit
// code nobody reviewed, and the failure mode of guessing wrong is a silent
// production defect. It reports precisely what came back and leaves the decision
// to a human.
//
// Three tiers, strongest first. The first two are absolute (a violation is always
// wrong); the third is a counted baseline, because prose ABOUT the removal is
// legitimate and cannot be spelled without naming the thing removed.

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Package names that only exist to talk to a chain or a wallet. */
const FORBIDDEN_DEPENDENCIES = [
  /^@solana\//,
  /^@wallet-standard\//,
  /^@reown\//,
  /^@walletconnect\//,
  /^@web3modal\//,
  /^web3$/,
  /^ethers$/,
  /^wagmi$/,
  /^viem$/,
  /^bs58$/,
  /^tweetnacl$/,
  /^@noble\/curves$/,
];

/**
 * Paths whose very existence means a web3 surface came back. Checked as a
 * substring of the repo-relative POSIX path.
 */
const FORBIDDEN_PATHS = [
  'solanaStore',
  'SolanaStore',
  'native_solana',
  'wallet_balance',
  'wallet_connection',
  'wallet_handoff',
  'wallet-return',
  'wallet_e2e',
  'seeker_entitlement',
  'holder_tier',
  'android_seeker',
  'MwaAuthorization',
  'LegacyMwaAuthorization',
];

/**
 * Runtime imports of a chain/wallet module. Matched against import specifiers
 * only, so a comment naming the package is not a violation.
 */
const FORBIDDEN_IMPORT_RE =
  /\bfrom\s+['"](@solana\/[^'"]*|@wallet-standard\/[^'"]*|@reown\/[^'"]*|@walletconnect\/[^'"]*|@web3modal\/[^'"]*|web3|ethers|wagmi|viem|bs58|tweetnacl|@noble\/curves)['"]/;

/**
 * Identifiers that are load-bearing web3 CODE rather than prose. These are the
 * ones the v0.35.0 sync actually reintroduced, so they are pinned at zero in
 * source positions (see the baseline tier below for prose).
 */
const FORBIDDEN_CODE_TOKENS = [
  'prizeUsd',
  'signedTransaction',
  'claimPayoutResend',
  'markPayoutResend',
  'internalPayoutRow',
  'DailyRewardInternalPayoutRow',
  'DailyRewardPayoutAttemptRow',
  'wocUsdPrice',
  'prizePoolSol',
  'solUsdPrice',
  'setWalletUiEnabled',
  'buildWalletConnectionView',
  'resolveWocBalanceUpdate',
];

/**
 * Known, pre-existing debt: snake_case payout-runner columns this fork's schema
 * does NOT create (tests/schema_wiring.test.ts asserts their absence from the
 * applied DDL), yet which voidPayout/restorePayout still SELECT and a few test
 * fixtures still spell. Those reads only work against a database migrated from an
 * older web3-era build; against a fresh schema they raise "column does not exist".
 *
 * This predates the v0.35.0 upstream sync, so it is pinned at its measured count
 * rather than zero: the point is that an upstream sync cannot GROW it while the
 * cleanup is still pending. When that cleanup lands, lower these numbers in the
 * same change; a count coming in under the pin fails just as loudly as one over,
 * so the guard cannot rot into a rubber stamp.
 */
const KNOWN_LEGACY_SITES: Record<string, number> = {
  prize_usd: 3,
  tx_signature: 15,
  signed_transaction: 8,
  daily_reward_payout_attempts: 3,
};

const SOURCE_DIRS = ['src', 'server', 'scripts', 'tests', 'bot', 'electron'];

/**
 * Files whose JOB is to contain chain/wallet import text, so a match there is the
 * feature rather than a regression. The malware scanner's suite carries wallet-drain
 * import lines as string fixtures precisely so the scanner can be proven to catch
 * that shape in a supply-chain attack: this fork having no wallet is exactly why an
 * unexpected one must still be detectable.
 *
 * Keep this list to files that store such text as DATA, never to a real importer.
 * And do NOT spell a drain signature literally anywhere in this file: the malware
 * scanner reads it too, and a quoted example here trips its web3-drain rule (which
 * is the scanner working correctly, so the fix is to describe rather than quote).
 */
const SIGNATURE_FIXTURE_FILES = new Set([
  'tests/malware_scan.test.ts',
  'scripts/malware_scan.mjs',
  // This guard names every pattern it forbids, in both its rules and the prose
  // explaining them, so it necessarily matches itself.
  'tests/no_web3_regression.test.ts',
]);

/** Repo-relative path plus absolute path, for every scanned source file. */
function sourceFiles(): Array<{ path: string; full: string }> {
  const files: Array<{ path: string; full: string }> = [];
  for (const dir of SOURCE_DIRS) {
    for (const found of tsFilesUnder(join(ROOT, dir))) {
      files.push({ path: `${dir}/${found.file}`, full: found.full });
    }
  }
  return files;
}

describe('web3 removal survives an upstream sync', () => {
  it('declares no chain or wallet dependency', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const declared = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ];
    const offenders = declared.filter((name) =>
      FORBIDDEN_DEPENDENCIES.some((re) => re.test(name)),
    );
    expect(
      offenders,
      `package.json declares web3 dependencies again: ${offenders.join(', ')}.\n` +
        'This is what happens when an upstream sync takes their package.json wholesale.\n' +
        'Drop them and re-run the install so the lockfile follows.',
    ).toEqual([]);
  });

  it('imports no chain or wallet module', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (SIGNATURE_FIXTURE_FILES.has(file.path)) continue;
      const text = readFileSync(file.full, 'utf8');
      for (const [index, line] of text.split('\n').entries()) {
        if (FORBIDDEN_IMPORT_RE.test(line)) {
          offenders.push(`${file.path}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    expect(
      offenders,
      `Chain/wallet imports are back:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('ships none of the removed web3 modules', () => {
    const offenders = sourceFiles()
      .map((file) => file.path)
      .filter((path) => FORBIDDEN_PATHS.some((needle) => path.includes(needle)));
    expect(
      offenders,
      `Removed web3 modules reappeared:\n${offenders.join('\n')}\n` +
        'An upstream sync restores these whenever we deleted a file they only edited.',
    ).toEqual([]);
  });

  it('carries no payout-runner or wallet-UI identifiers', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      // This guard names every token it forbids, so it would flag itself.
      if (SIGNATURE_FIXTURE_FILES.has(file.path)) continue;
      const text = readFileSync(file.full, 'utf8');
      for (const [index, line] of text.split('\n').entries()) {
        // A line that ASSERTS absence is the opposite of a regression.
        if (line.includes('not.toContain') || line.includes('not.toMatch')) continue;
        for (const token of FORBIDDEN_CODE_TOKENS) {
          if (line.includes(token)) {
            offenders.push(`${file.path}:${index + 1}: ${line.trim()}`);
          }
        }
      }
    }
    expect(
      offenders,
      `Payout-runner / wallet-UI code is back:\n${offenders.join('\n')}\n` +
        'The prize is in-game copper delivered by Ravenpost; there is no external\n' +
        'payment rail, so none of these identifiers has a counterpart in this fork.',
    ).toEqual([]);
  });

  it('does not grow the known legacy payout-column debt', () => {
    const counted: Record<string, number> = {};
    const sites: Record<string, string[]> = {};
    for (const token of Object.keys(KNOWN_LEGACY_SITES)) {
      counted[token] = 0;
      sites[token] = [];
    }

    for (const file of sourceFiles()) {
      if (SIGNATURE_FIXTURE_FILES.has(file.path)) continue;
      const text = readFileSync(file.full, 'utf8');
      for (const [index, line] of text.split('\n').entries()) {
        if (line.includes('not.toContain') || line.includes('not.toMatch')) continue;
        for (const token of Object.keys(KNOWN_LEGACY_SITES)) {
          if (line.includes(token)) {
            counted[token]++;
            sites[token].push(`${file.path}:${index + 1}`);
          }
        }
      }
    }

    const report = Object.keys(KNOWN_LEGACY_SITES)
      .map((token) => `${token}: ${sites[token].join(', ')}`)
      .join('\n');
    expect(
      counted,
      `The legacy payout-column debt moved. Current sites:\n${report}\n\n` +
        'UP means an upstream sync reintroduced payout-runner SQL: review the new\n' +
        'sites and drop them. DOWN means the cleanup landed: lower the pin here in\n' +
        'the same change.',
    ).toEqual(KNOWN_LEGACY_SITES);
  });
});
