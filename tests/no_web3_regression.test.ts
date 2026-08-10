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
 * Known, pre-existing debt: snake_case payout-runner columns and tables this
 * fork's schema does NOT create (tests/schema_wiring.test.ts asserts their
 * absence from the applied DDL), yet which test fixtures and prose still spell.
 * It predates the v0.35.0 upstream sync: the broken SELECTs were already in the
 * tree at 679546e96^1, inherited from the PhillayDeveloping snapshot, so the
 * merge widened an existing defect rather than introducing one.
 *
 * The EXECUTABLE half of that debt is gone: voidPayout and restorePayout no
 * longer name a column a fresh schema lacks, so no statement this fork runs can
 * raise 42703 on this table any more (tests/daily_rewards_payout_moderation_schema.test.ts
 * is what proves it, by executing them against a column set folded out of
 * ensureSchema's own DDL). What is left never reaches Postgres, and most of it
 * is deletable: besides row fixtures and prose, roughly half the remaining
 * sites are unreachable statement arms in the substring-matching fake at
 * tests/daily_rewards_payout_moderation_db.test.ts, kept out of that change to
 * hold its diff to the defect.
 *
 * Still pinned at the measured count rather than zero: prose about the removal
 * cannot be spelled without naming the thing removed, and the point is that an
 * upstream sync cannot GROW it. As more of the residue clears, lower these
 * numbers in the same change; a count coming in under the pin fails just as
 * loudly as one over, so the guard cannot rot into a rubber stamp.
 */
const KNOWN_LEGACY_SITES: Record<string, number> = {
  prize_usd: 1,
  tx_signature: 11,
  signed_transaction: 7,
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

/**
 * Every package.json position that NAMES a package, not just the three dependency
 * maps. The v0.35.0 sync proved why: dropping upstream's dependency block left
 * `@reown/appkit` sitting in `pnpm.onlyBuiltDependencies`, where it survived the
 * cleanup unremarked because nothing looked there. A build-script allowlist,
 * an override, or an `allowScripts` entry is a standing instruction about a
 * package this fork must not have at all, so each one is swept the same way.
 *
 * Keys carrying a version range (`allowScripts`, the `name@major` override form)
 * are split at the LAST `@` so a scoped name keeps its leading one.
 */
function declaredPackageNames(pkg: Record<string, unknown>): string[] {
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const stripRange = (key: string): string => {
    const at = key.lastIndexOf('@');
    return at > 0 ? key.slice(0, at) : key;
  };
  const pnpm = record(pkg.pnpm);
  const onlyBuilt = Array.isArray(pnpm.onlyBuiltDependencies)
    ? (pnpm.onlyBuiltDependencies as unknown[]).map(String)
    : [];
  return [
    ...Object.keys(record(pkg.dependencies)),
    ...Object.keys(record(pkg.devDependencies)),
    ...Object.keys(record(pkg.optionalDependencies)),
    ...Object.keys(record(pkg.peerDependencies)),
    ...Object.keys(record(pkg.allowScripts)).map(stripRange),
    ...Object.keys(record(pnpm.overrides)).map(stripRange),
    ...onlyBuilt,
  ];
}

describe('web3 removal survives an upstream sync', () => {
  it('names no chain or wallet package anywhere in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const offenders = declaredPackageNames(pkg).filter((name) =>
      FORBIDDEN_DEPENDENCIES.some((re) => re.test(name)),
    );
    expect(
      offenders,
      `package.json names web3 packages again: ${offenders.join(', ')}.\n` +
        'This is what happens when an upstream sync takes their package.json wholesale.\n' +
        'Check the dependency maps AND pnpm.onlyBuiltDependencies / pnpm.overrides /\n' +
        'allowScripts, then re-run the install so the lockfile follows.',
    ).toEqual([]);
  });

  it('sweeps every package.json position that can name a package', () => {
    // The sweep above is only as good as its reach: a position added to
    // package.json but not to declaredPackageNames would go unwatched exactly
    // like onlyBuiltDependencies did. Pin the reach against a fixture rather
    // than against the real file, which happens to be clean.
    const fixture = {
      dependencies: { 'dep-only': '1' },
      devDependencies: { 'dev-only': '1' },
      optionalDependencies: { 'optional-only': '1' },
      peerDependencies: { 'peer-only': '1' },
      allowScripts: { 'scripts-only@1.2.3': true, '@scoped/pkg@0.1.0': true },
      pnpm: {
        overrides: { 'override-only@2': '^2.0.0' },
        onlyBuiltDependencies: ['built-only'],
      },
    };
    expect(declaredPackageNames(fixture).sort()).toEqual([
      '@scoped/pkg',
      'built-only',
      'dep-only',
      'dev-only',
      'optional-only',
      'override-only',
      'peer-only',
      'scripts-only',
    ]);
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
    expect(offenders, `Chain/wallet imports are back:\n${offenders.join('\n')}`).toEqual([]);
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

  it('does not grow the known legacy payout-schema debt', () => {
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
