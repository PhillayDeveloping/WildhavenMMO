import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const compose = readFileSync('docker-compose.yml', 'utf8');
const envExample = readFileSync('.env.example', 'utf8');
const workflow = readFileSync('.github/workflows/ota-publish.yml', 'utf8');
const desktopWorkflow = readFileSync('.github/workflows/desktop-publish.yml', 'utf8');
const composeEnv = (name: string) => `$${`{${name}:-}`}`;
// GitHub Actions expression syntax, assembled rather than inlined so the linter
// does not read a literal ${{ ... }} as a mistyped template literal.
const ghExpr = (expr: string) => `$${`{{ ${expr} }}`}`;

describe('self-hosted OTA deploy contract', () => {
  // The game service passes an explicit environment allowlist (no env_file), so a
  // value only reaches the container if it is listed here. OTA_MANIFEST_URL is the
  // ONLY switch that lights up POST /api/ota/updates (server/ota_updates.ts):
  // without this line, setting it in the host .env would populate compose
  // interpolation but never reach the process, leaving every device stuck on
  // "no update" with no error anywhere to explain why.
  it('passes OTA_MANIFEST_URL through to the game server container', () => {
    expect(compose).toContain(`OTA_MANIFEST_URL: ${composeEnv('OTA_MANIFEST_URL')}`);
  });

  it('documents OTA_MANIFEST_URL in .env.example, commented out (OTA off by default)', () => {
    expect(envExample).toContain('#OTA_MANIFEST_URL=');
  });

  // The publish-side env is deploy tooling, never game-server config, so it must
  // NOT be in the container allowlist; it is documented for the publish machine.
  it('documents the publish-side env without granting it to the container', () => {
    for (const name of ['OTA_S3_BUCKET', 'OTA_PUBLIC_BASE_URL', 'OTA_S3_ENDPOINT_URL']) {
      expect(envExample).toContain(`#${name}=`);
      expect(compose).not.toContain(`${name}:`);
    }
  });

  // The store is Cloudflare R2 (the bucket that already serves desktop updates),
  // so the manifest and the bundles it points at share one public origin. The
  // server rejects a manifest whose bundle URL origin differs, which would
  // silently disable OTA, so the two documented values must agree.
  it('documents a manifest URL on the same origin as the public base URL', () => {
    const base = envExample.match(/^#OTA_PUBLIC_BASE_URL=(\S+)$/m)?.[1];
    const manifest = envExample.match(/^#OTA_MANIFEST_URL=(\S+)$/m)?.[1];
    expect(base).toBeTruthy();
    expect(manifest).toBeTruthy();
    expect(new URL(String(manifest)).origin).toBe(new URL(String(base)).origin);
    expect(new URL(String(manifest)).protocol).toBe('https:');
  });
});

describe('OTA publish workflow contract', () => {
  // Dispatch-only is a correctness property, not a preference. A tag says code
  // was merged, never that a server runs it, and an OTA bundle must agree with
  // the RUNNING server. A tag trigger here would publish bundles at moments
  // nobody chose.
  it('is dispatch-only, with no tag or push trigger', () => {
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/^on:[\s\S]*?\n {2}push:/m);
    expect(workflow).not.toContain("tags:\n      - 'v*'");
    // Both negatives above are absence assertions, which pass just as happily
    // against a workflow whose trigger block was reformatted out from under
    // them. The desktop workflow used to be the live contrast that ruled that
    // out; it is dispatch-only too now (see below), so prove the matchers
    // still bite by running them at a known-positive sample instead.
    const tagTriggered = "on:\n  push:\n    tags:\n      - 'v*'\n";
    expect(tagTriggered).toMatch(/^on:[\s\S]*?\n {2}push:/m);
    expect(tagTriggered).toContain("tags:\n      - 'v*'");
  });

  // The desktop workflow fired on a release tag upstream, where the update host
  // and both signing identities exist. In this fork neither does, and there are
  // no repository secrets at all, so every tag push started a run that could
  // only fail: the version guard caught it first, and the signing steps refuse
  // an unsigned build regardless. Desktop artifacts are built locally and
  // attached to the release by hand, so the tag trigger is only noise until that
  // provisioning lands.
  it('leaves desktop publishing to manual dispatch while the signing identities are missing', () => {
    expect(desktopWorkflow).toContain('workflow_dispatch:');
    expect(desktopWorkflow).not.toMatch(/^on:[\s\S]*?\n {2}push:/m);
    expect(desktopWorkflow).not.toContain("tags:\n      - 'v*'");
    // The reason has to travel with the removal, or restoring the trigger looks
    // like a one-line fix rather than something gated on real provisioning.
    expect(desktopWorkflow).toContain('Restore the tag trigger once');
  });

  // A stray click must never ship JavaScript to every install.
  it('defaults to a dry run and only uploads when publish is ticked', () => {
    expect(workflow).toMatch(
      /publish:\n {8}description:[^\n]*\n {8}type: boolean\n {8}default: false/,
    );
    expect(workflow).toContain('if [ "${PUBLISH}" != "true" ]; then ARGS+=(--dry-run); fi');
  });

  it('runs the layout-epoch preflight unless it is explicitly skipped', () => {
    expect(workflow).toContain(`if: ${ghExpr('!inputs.skip_server_check')}`);
    expect(workflow).toContain('node scripts/ota/check_server_layout.mjs');
  });

  // The publish is silent on failure server-side, so the run must prove the
  // server actually serves an offer, not merely that an upload succeeded.
  it('verifies the server offer after a real publish', () => {
    expect(workflow).toContain('/api/ota/updates');
    expect(workflow).toContain('publish verified');
  });

  // Reuses the credentials the desktop publish already uses for this bucket, so
  // no second standing secret can ship JavaScript to every install.
  it('reuses the existing R2 secrets and the R2 checksum settings', () => {
    for (const secret of [
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_BUCKET',
      'R2_ACCOUNT_ID',
    ]) {
      expect(workflow).toContain(`secrets.${secret} }}`);
      expect(desktopWorkflow).toContain(`secrets.${secret} }}`);
    }
    expect(workflow).toContain('AWS_REQUEST_CHECKSUM_CALCULATION: when_required');
    expect(workflow).toContain('AWS_RESPONSE_CHECKSUM_VALIDATION: when_required');
  });

  // Operator input must never be string-interpolated into the shell line.
  it('passes dispatch inputs through env, not shell interpolation', () => {
    expect(workflow).toContain(`MIN_NATIVE: ${ghExpr('inputs.min_native')}`);
    expect(workflow).not.toContain(`--min-native $${'{{'}`);
  });
});
