import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Whether this host can actually create a symlink.
//
// Creating one on Windows needs SeCreateSymbolicLinkPrivilege, which an ordinary
// account only holds with Developer Mode enabled. Without it every symlink call
// raises EPERM, and suites whose SETUP builds a symlink fail before they assert
// anything about the code they guard.
//
// PROBED, not inferred from process.platform, deliberately:
//   - a Windows box WITH Developer Mode runs these suites, so the coverage comes
//     back the moment the privilege is granted rather than staying switched off
//     behind a platform name, and
//   - CI (Linux) is unaffected, so the invariants stay enforced where they gate
//     merges.
//
// The probe runs once per process and caches; it never throws.
let cached: boolean | null = null;

export function canCreateSymlinks(): boolean {
  if (cached !== null) return cached;
  let dir: string | null = null;
  try {
    dir = mkdtempSync(path.join(tmpdir(), 'woc-symlink-probe-'));
    const target = path.join(dir, 'target');
    writeFileSync(target, 'probe');
    symlinkSync(target, path.join(dir, 'link'));
    cached = true;
  } catch {
    cached = false;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A probe that cannot clean up must still answer the question.
      }
    }
  }
  return cached;
}

/**
 * Reason string for the skip, so a skipped run says WHY rather than looking like
 * the case was quietly dropped.
 */
export const SYMLINK_SKIP_REASON =
  'requires symlink creation (Windows: enable Developer Mode); covered on POSIX and in CI';

// Whether a POSIX shell is runnable here.
//
// Same probe-not-platform reasoning: a Windows box with Git for Windows on PATH
// has a working `sh`, so a case that only needs one should run there rather than
// be switched off by operating-system name. Cached per process; never throws.
let shellCached: boolean | null = null;

export function canRunPosixShell(): boolean {
  if (shellCached !== null) return shellCached;
  try {
    const probe = spawnSync('sh', ['-c', 'exit 0'], { stdio: 'ignore' });
    shellCached = probe.error === undefined && probe.status === 0;
  } catch {
    shellCached = false;
  }
  return shellCached;
}
