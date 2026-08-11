import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as THREE from 'three';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbilityVfxFx } from '../src/render/ability_vfx/fx';
import { abilityVfxTextures } from '../src/render/ability_vfx/fx_textures';
import { GroundAuras } from '../src/render/ability_vfx/ground_auras';
import { OverlaySprites } from '../src/render/ability_vfx/overlay_sprites';
import { AbilityVfxRibbons } from '../src/render/ability_vfx/ribbons';
import { ABILITY_VFX_FULL_SPECS } from '../src/render/ability_vfx_full_specs';
import { createVfxAnchor } from '../src/render/vfx_anchor';
import { expectScansOnlyThroughSharedWalkers } from './helpers/scan_guard_self_audit';
import { tsFilesUnder } from './helpers/ts_files_under';

// The steady-state combat cost of the ability-VFX subsystem: anchors resolved
// every frame must not allocate, and the two immediate-mode buffers must upload
// only the prefix the frame wrote instead of their whole worst-case capacity.
// Both are driven through the REAL classes here (not a stub), because the
// regression these guard against is a call site quietly dropping its scratch or
// its update range, which only shows up when the live update() walk runs.
//
// The fixture half below is one live state (two held entities, a comet trail, a
// jagged bolt, one instant sequence) ticked for a few frames, so it can only
// ever speak for the call sites that state happens to walk. A per-frame anchor
// path nobody wrote a fixture for would allocate every frame and leave it
// green, which is the reach a doc must not claim it has. The SOURCE SCAN at the
// bottom of this file is what closes that gap, over every call site
// `AbilityVfxFx.update()` can reach rather than the ones one fixture reaches.

const FIREBALL_SPEC = ABILITY_VFX_FULL_SPECS.fireball;

function installCanvasStub(): void {
  const noop = () => {};
  const gradient = { addColorStop: noop };
  const context = {
    arc: noop,
    beginPath: noop,
    clip: noop,
    closePath: noop,
    createImageData: (width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
    }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    ellipse: noop,
    fill: noop,
    fillRect: noop,
    lineTo: noop,
    moveTo: noop,
    putImageData: noop,
    rect: noop,
    restore: noop,
    rotate: noop,
    save: noop,
    scale: noop,
    stroke: noop,
    translate: noop,
  };
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  });
}

/** The renderer's real anchor, wrapped to record how each resolve was made. */
function countingAnchor(heightById: (id: number) => number | null) {
  const counts = { withScratch: 0, allocating: 0 };
  const base = createVfxAnchor((id, pose) => {
    const height = heightById(id);
    if (height === null) return false;
    pose.x = id * 2;
    pose.y = 0;
    pose.z = -5;
    pose.height = height;
    return true;
  });
  const anchor = (id: number, frac: number, out?: THREE.Vector3) => {
    if (out) counts.withScratch++;
    else counts.allocating++;
    return base(id, frac, out);
  };
  return { anchor, counts };
}

function rangeOf(attr: THREE.BufferAttribute): { start: number; count: number } | null {
  const ranges = attr.updateRanges;
  return ranges.length === 1 ? { start: ranges[0].start, count: ranges[0].count } : null;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ability VFX steady-state frame cost', () => {
  it('resolves every per-frame anchor into a scratch vector, allocating none', () => {
    installCanvasStub();
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.updateMatrixWorld();
    const { anchor, counts } = countingAnchor(() => 2);
    const fx = new AbilityVfxFx(new THREE.Scene(), camera, anchor, () => 0);
    fx.setDelegates(vi.fn(), vi.fn(), vi.fn(), vi.fn());

    // The held families are frame-stamped, so the painter re-holds them every
    // frame: mirror that, or the pools sweep themselves and the walk goes quiet.
    const holdHeldFamilies = () => {
      for (const id of [7, 8]) {
        fx.windup(id, 0xff0000, 0.5, 'runes');
        fx.orbit(id, 'runes', 0x00ff00);
        fx.holdShell(id, 0x0000ff);
        fx.holdGroundAura(id, 0, 0x00ffff, true);
        fx.holdCcBand(id, 'stun', 3);
      }
    };
    holdHeldFamilies();
    // travelling ribbons (both anchored ends) and a live sequence, whose
    // per-frame transients (the release flash) anchor the caster every frame
    fx.cometTrail(7, 8, 0xffff00, 0.2, false);
    fx.jaggedBolt(7, 8, 0xffffff);
    fx.sequenceInstant('fireball', FIREBALL_SPEC, 7, 8, 0xff8800, 0);

    fx.update(1 / 60);
    counts.withScratch = 0;
    counts.allocating = 0;
    // three more frames of the same live state: the steady state is what costs
    for (let i = 0; i < 3; i++) {
      holdHeldFamilies();
      fx.update(1 / 60);
    }

    expect(counts.withScratch).toBeGreaterThan(20);
    expect(counts.allocating).toBe(0);
  });

  it('drops a per-frame anchor cleanly when the entity loses its view', () => {
    installCanvasStub();
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.updateMatrixWorld();
    const alive = new Set([7, 8]);
    const { anchor, counts } = countingAnchor((id) => (alive.has(id) ? 2 : null));
    const fx = new AbilityVfxFx(new THREE.Scene(), camera, anchor, () => 0);
    fx.setDelegates(vi.fn(), vi.fn(), vi.fn(), vi.fn());
    fx.holdShell(8, 0x0000ff);
    fx.holdGroundAura(8, 0, 0x00ffff, true);
    fx.update(1 / 60);
    expect(fx.groundAuraCountOf(8)).toBe(1);

    alive.delete(8);
    fx.update(1 / 60);
    // the null reading releases the pools rather than drawing at a stale point
    expect(fx.groundAuraCountOf(8)).toBe(0);
    expect(counts.allocating).toBe(0);
  });

  it('stops re-draping a standing wearer once, instead of chasing the breath', () => {
    installCanvasStub();
    const auras = new GroundAuras(new THREE.Scene(), abilityVfxTextures());
    let samples = 0;
    const groundY = () => {
      samples++;
      return 0;
    };
    const { anchor } = countingAnchor(() => 2);
    auras.hold(7, 0, 0x00ffff, true, 0);
    // Four seconds of a perfectly still wearer: more than a full breath cycle
    // (0.4 Hz), which used to cross the old absolute scale threshold several
    // times a second and re-drape all 42 vertices each time.
    let settledFrom = 0;
    for (let frame = 1; frame <= 240; frame++) {
      auras.hold(7, 0, 0x00ffff, true, frame);
      auras.update(1 / 60, frame / 60, frame, anchor, groundY, 0, 0);
      if (frame === 120) settledFrom = samples;
    }
    // the disc drapes while it grows in, then settles: the whole second half is
    // one center-height read per frame and not a single vertex resample
    expect(samples - settledFrom).toBe(120);
    // 3 drapes in all, every one of them inside the 0.4s grow-in, at the full
    // 42 vertices (this disc is 15 yards from the camera, inside the exact band)
    expect(samples).toBe(240 + 3 * 42);

    // ...and real movement still re-drapes: the terrain under the disc changed
    let moved = 0;
    const movingAnchor = (id: number, frac: number, out?: THREE.Vector3) => {
      const at = anchor(id, frac, out);
      if (at) at.x += moved;
      return at;
    };
    const before = samples;
    for (let frame = 241; frame <= 250; frame++) {
      moved += 0.4;
      auras.hold(7, 0, 0x00ffff, true, frame);
      auras.update(1 / 60, frame / 60, frame, movingAnchor, groundY, 0, 0);
    }
    expect(samples - before).toBeGreaterThan(100);
  });

  it('uploads only the ribbon prefix the frame wrote', () => {
    installCanvasStub();
    const { anchor } = countingAnchor(() => 2);
    const scene = new THREE.Scene();
    const ribbons = new AbilityVfxRibbons(scene, anchor, abilityVfxTextures());
    const geo = (ribbons as unknown as { geo: THREE.BufferGeometry }).geo;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const col = geo.attributes.aCol as THREE.BufferAttribute;
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    const index = geo.index as THREE.BufferAttribute;

    ribbons.spawnBoltPoints(0, 0, 0, 4, 0, 0, 0xffffff, 0.5, 0.1, 1);
    ribbons.update(1 / 60, new THREE.Vector3(0, 2, 8));

    const drawn = geo.drawRange.count;
    expect(drawn).toBeGreaterThan(0);
    // the strip is two vertices per point, and the index prefix IS the draw range
    const verts = (rangeOf(pos)?.count ?? 0) / 3;
    expect(verts).toBeGreaterThan(0);
    expect(rangeOf(pos)).toEqual({ start: 0, count: verts * 3 });
    expect(rangeOf(col)).toEqual({ start: 0, count: verts * 3 });
    expect(rangeOf(uv)).toEqual({ start: 0, count: verts * 2 });
    expect(rangeOf(index)).toEqual({ start: 0, count: drawn });
    // and that prefix is a small fraction of the worst-case buffers it lives in
    expect(verts * 3).toBeLessThan(pos.array.length / 4);

    // a second frame REPLACES the range instead of stacking one per frame
    ribbons.update(1 / 60, new THREE.Vector3(0, 2, 8));
    expect(pos.updateRanges.length).toBe(1);
    expect(index.updateRanges.length).toBe(1);
  });

  it('uploads only the overlay sprites the frame pushed', () => {
    installCanvasStub();
    const overlay = new OverlaySprites(new THREE.Scene(), abilityVfxTextures());
    const geo = (overlay as unknown as { geo: THREE.BufferGeometry }).geo;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const size = geo.attributes.aSize as THREE.BufferAttribute;
    const capacity = pos.array.length / 3;

    overlay.beginFrame();
    for (let i = 0; i < 3; i++) overlay.push(i, 1, 0, 0xffffff, 0.3, 0, 1);
    overlay.commit();
    expect(geo.drawRange.count).toBe(3);
    expect(rangeOf(pos)).toEqual({ start: 0, count: 9 });
    expect(rangeOf(size)).toEqual({ start: 0, count: 3 });
    expect(capacity).toBeGreaterThan(3);

    // a busier frame widens the range; a quieter one narrows it back
    overlay.beginFrame();
    for (let i = 0; i < 40; i++) overlay.push(i, 1, 0, 0xffffff, 0.3, 0, 1);
    overlay.commit();
    expect(rangeOf(pos)).toEqual({ start: 0, count: 120 });
    overlay.beginFrame();
    overlay.push(0, 1, 0, 0xffffff, 0.3, 0, 1);
    overlay.commit();
    expect(rangeOf(pos)).toEqual({ start: 0, count: 3 });
    expect(pos.updateRanges.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The source scan: every anchor resolve `AbilityVfxFx.update()` can reach
// ---------------------------------------------------------------------------
//
// WHY A SCAN AND NOT MORE FIXTURES. The fixture above counts allocations on ONE
// live state. A new per-frame anchor path the fixture does not happen to walk
// (a new held family, a new transient draw) would resolve without a scratch,
// allocate a THREE.Vector3 every frame for every entity wearing it, and leave
// this file green. Enumerating live states until they cover the subsystem is
// not a thing a fixture can promise; enumerating CALL SITES is, so the reach
// question is answered structurally.
//
// WHY A DECLARED ONE-SHOT TABLE RATHER THAN A FLAT BAN. `update()` reaches both
// kinds of resolve, and the difference is not visible in the call: the sequencer
// advances its slots every frame, but the release, impact, motif and beat work
// inside that walk each fire ONCE behind a latch (`slot.impactDone`,
// `slot.swing2Done`, a beat's `active` flag, a dot drip's 0.5s timer). Those
// keep the historical contract on purpose (a fresh vector the caller may
// retain), which `src/render/vfx_anchor.ts` documents. So the scan is
// default-deny with declared exceptions: a destination-less resolve reachable
// from `update()` fails until a row here names it and says which latch makes it
// one-shot, and the table is diffed BOTH ways so a row outliving its call site
// fails too.
//
// WHAT IT STILL CANNOT SEE, stated rather than implied. The walk resolves
// callees by BARE NAME across the whole directory, which over-approximates on
// an ambiguous name (every body with that name is pulled in) and reaches
// nothing behind a value it cannot name (a callback handed in from another
// module, a dynamic `host[key]()`). Over-approximation is the safe direction
// for a budget; the second is the standing limit of a source walk, and the
// live-engine fixture above is the half that covers what a walk cannot.

const ABILITY_VFX_DIR = 'src/render/ability_vfx';
/** The one entry point the renderer calls per frame; the scan is its reach. */
const FRAME_ENTRY = { className: 'AbilityVfxFx', method: 'update' };
/** Both spellings of the shared resolver: the raw `VfxAnchorResolver` and the
 *  `SequencerHost` adapter that forwards to it. */
const RESOLVER_NAMES = new Set(['anchor', 'anchorOf']);

/** One resolve found inside a body the walk reached. */
interface AnchorResolve {
  /** Path relative to `ABILITY_VFX_DIR`. */
  readonly file: string;
  /** Enclosing body, `Class.method` for a class member. */
  readonly fn: string;
  /** The call as the source writes it, whitespace-normalized. */
  readonly text: string;
  /** 1-based line. For failure messages only, never pinned (a line rots). */
  readonly line: number;
  /** True when a caller-owned destination was passed. */
  readonly withDestination: boolean;
}

interface AnchorScan {
  /** Every `.ts` the walker found under the root, relative paths. */
  readonly files: readonly string[];
  /** Bodies the walk reached from the entry point, `Class.method`, sorted. */
  readonly reached: readonly string[];
  readonly resolves: readonly AnchorResolve[];
}

interface IndexedBody {
  readonly file: string;
  readonly fn: string;
  readonly sf: ts.SourceFile;
  readonly body: ts.Node;
}

/** Every named function body in one module, keyed by the BARE name a call site
 *  spells: class methods and accessors, function-valued class properties,
 *  function declarations, object-literal methods, and `const f = () => {}`. */
function indexBodies(file: string, sf: ts.SourceFile, into: Map<string, IndexedBody[]>): void {
  const add = (bare: string, fn: string, body: ts.Node): void => {
    const existing = into.get(bare);
    const entry: IndexedBody = { file, fn, sf, body };
    if (existing) existing.push(entry);
    else into.set(bare, [entry]);
  };
  const asFunction = (node: ts.Node): ts.Node | null =>
    ts.isArrowFunction(node) || ts.isFunctionExpression(node) ? node.body : null;
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const owner = node.name?.text ?? '<anonymous class>';
      for (const member of node.members) {
        const bare = member.name ? member.name.getText(sf) : null;
        if (bare === null) continue;
        if (
          (ts.isMethodDeclaration(member) ||
            ts.isGetAccessorDeclaration(member) ||
            ts.isSetAccessorDeclaration(member)) &&
          member.body
        ) {
          add(bare, `${owner}.${bare}`, member.body);
        }
        const property =
          ts.isPropertyDeclaration(member) && member.initializer
            ? asFunction(member.initializer)
            : null;
        if (property) add(bare, `${owner}.${bare}`, property);
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isMethodDeclaration(property) && property.body) {
          add(property.name.getText(sf), property.name.getText(sf), property.body);
        }
        if (ts.isPropertyAssignment(property)) {
          const fn = asFunction(property.initializer);
          if (fn) add(property.name.getText(sf), property.name.getText(sf), fn);
        }
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      add(node.name.text, node.name.text, node.body);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const fn = asFunction(node.initializer);
      if (fn) add(node.name.text, node.name.text, fn);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** Every callee name the node mentions, in any spelling a call site can wear:
 *  `f()`, `x.f()`, `x?.f()` and `x['f']()`. The receiver is deliberately not
 *  restricted (this walk crosses modules, so `this.sequencer.update()` and
 *  `host.spiritAt?.()` both have to resolve). */
function calleeNames(node: ts.Node): string[] {
  const names: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee)) names.push(callee.text);
      else if (ts.isPropertyAccessExpression(callee)) names.push(callee.name.text);
      else if (
        ts.isElementAccessExpression(callee) &&
        ts.isStringLiteralLike(callee.argumentExpression)
      ) {
        names.push(callee.argumentExpression.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return names;
}

/** Whether the call is an anchor resolve, in the same three spellings
 *  {@link calleeNames} follows. The `['anchorOf']()` arm is not decoration: the
 *  reachability walk already resolves that spelling, so leaving it out here
 *  would let a resolve stay reachable and stop being SEEN. */
function isResolverCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return RESOLVER_NAMES.has(callee.text);
  if (ts.isPropertyAccessExpression(callee)) return RESOLVER_NAMES.has(callee.name.text);
  return (
    ts.isElementAccessExpression(callee) &&
    ts.isStringLiteralLike(callee.argumentExpression) &&
    RESOLVER_NAMES.has(callee.argumentExpression.text)
  );
}

/**
 * Whether a real caller-owned destination was passed. `undefined`/`null` in the
 * slot reads as absent on purpose: both type-check against `out?:` and both
 * send the resolver down its allocating arm, so counting arity alone would hand
 * a per-frame path a one-token way out of this scan.
 */
function passesDestination(call: ts.CallExpression): boolean {
  const out = call.arguments[2];
  if (!out) return false;
  return (
    out.kind !== ts.SyntaxKind.NullKeyword && !(ts.isIdentifier(out) && out.text === 'undefined')
  );
}

/**
 * Every anchor resolve reachable from `<className>.<method>` under `root`.
 *
 * Throws when the entry point is absent rather than returning an empty scan: an
 * extraction that renames `update()` must be a red test, never a quiet zero
 * (the same rule `tests/helpers/method_call_sites.ts` states for its own seed).
 */
function scanUpdateAnchorResolves(
  root: string,
  entry: { className: string; method: string } = FRAME_ENTRY,
): AnchorScan {
  const found = tsFilesUnder(root);
  const bodies = new Map<string, IndexedBody[]>();
  for (const { file, full } of found) {
    const sf = ts.createSourceFile(
      file,
      readFileSync(full, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    indexBodies(file, sf, bodies);
  }

  const wanted = `${entry.className}.${entry.method}`;
  const seed = (bodies.get(entry.method) ?? []).filter((b) => b.fn === wanted);
  if (seed.length === 0) {
    throw new Error(
      `${wanted}() not found under ${root}: it was renamed, extracted, or moved. Re-point this guard at the new per-frame entry point rather than deleting the read.`,
    );
  }

  const visited = new Set<ts.Node>(seed.map((b) => b.body));
  const reached: IndexedBody[] = [...seed];
  const queue: IndexedBody[] = [...seed];
  const seenNames = new Set<string>();
  while (queue.length) {
    const current = queue.shift() as IndexedBody;
    for (const name of calleeNames(current.body)) {
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      for (const body of bodies.get(name) ?? []) {
        if (visited.has(body.body)) continue;
        visited.add(body.body);
        reached.push(body);
        queue.push(body);
      }
    }
  }

  // Keyed by source position, because a nested body indexed under its own name
  // (`const paint = () => {...}` inside a reached method) is walked BOTH as part
  // of its parent and, if anything calls it, on its own. Counting the same call
  // twice would read as an extra undeclared resolve nobody wrote.
  const resolves = new Map<string, AnchorResolve>();
  for (const holder of reached) {
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && isResolverCall(n)) {
        const start = n.getStart(holder.sf);
        resolves.set(`${holder.file}:${start}`, {
          file: holder.file,
          fn: holder.fn,
          text: n.getText(holder.sf).replace(/\s+/g, ' '),
          line: holder.sf.getLineAndCharacterOfPosition(start).line + 1,
          withDestination: passesDestination(n),
        });
      }
      ts.forEachChild(n, visit);
    };
    visit(holder.body);
  }
  return {
    files: found.map((f) => f.file),
    reached: reached.map((b) => b.fn).sort(),
    resolves: [...resolves.values()],
  };
}

/** A body reachable from `update()` whose resolves are ONE-SHOT, with the latch
 *  that makes them so. Anything not listed must resolve into a scratch. */
interface OneShotBody {
  readonly file: string;
  readonly fn: string;
  /** Every destination-less resolve in that body, as the source writes it. */
  readonly resolves: readonly string[];
  /** What makes it one-shot. Read this before adding a row. */
  readonly why: string;
}

const ONE_SHOT_RESOLVES: readonly OneShotBody[] = [
  {
    file: 'fx.ts',
    fn: 'AbilityVfxFx.anchorOf',
    resolves: ['this.anchor(id, frac)'],
    why: 'the SequencerHost adapter itself: this arm IS the no-destination contract, and every caller of anchorOf is checked by this same scan (they pass a scratch and land in the with-destination list).',
  },
  {
    file: 'fx.ts',
    fn: 'AbilityVfxFx.spiritAt',
    resolves: ['this.anchor(anchorId, 0)', 'this.anchor(casterId, 0)', 'this.anchor(targetId, 0)'],
    why: 'a spirit-puppet SPAWN, reached once through impact() and never re-driven; the puppet then carries its own path.',
  },
  {
    file: 'sequencer.ts',
    fn: 'ArchetypeSequencer.update',
    resolves: ['host.anchorOf(slot.targetId, 0.55)', 'host.anchorOf(slot.targetId, 0.5)'],
    why: 'the two latched beats inside the slot walk: the strike echo behind slot.swing2Done (once per slot) and the dot drip behind slot.dotTimer (every 0.5s, not every frame).',
  },
  {
    file: 'sequencer.ts',
    fn: 'ArchetypeSequencer.release',
    resolves: ['host.anchorOf(slot.casterId, 0.58)'],
    why: 'the release flash, fired once per slot behind slot.releaseDone.',
  },
  {
    file: 'sequencer.ts',
    fn: 'ArchetypeSequencer.impact',
    resolves: ['host.anchorOf(slot.targetId, 0.55)'],
    why: 'the impact stack, fired once per slot behind slot.impactDone.',
  },
  {
    file: 'sequencer.ts',
    fn: 'ArchetypeSequencer.archetypeImpact',
    resolves: [
      'host.anchorOf(slot.targetId, 0.55)',
      'host.anchorOf(slot.targetId, 0.3)',
      'host.anchorOf(slot.casterId, 0.55)',
      'host.anchorOf(slot.targetId, 0.8)',
      'host.anchorOf(slot.casterId, 0.3)',
      'host.anchorOf(slot.targetId, 0.3)',
    ],
    why: 'the per-archetype half of that same one-shot impact beat.',
  },
  {
    file: 'sequencer.ts',
    fn: 'ArchetypeSequencer.runOneMotif',
    resolves: [
      'host.anchorOf(anchorId, 0.4)',
      'host.anchorOf(slot.casterId, 0.05)',
      'host.anchorOf(slot.casterId, 0.5)',
    ],
    why: 'a motif set-piece, staged through the pooled beat queue: each beat fires once and clears its active flag.',
  },
  {
    file: 'sequencer.ts',
    fn: 'ArchetypeSequencer.impactAnchor',
    resolves: [
      'host.anchorOf(selfCentered ? slot.casterId : slot.targetId, 0.4)',
      'host.anchorOf(slot.casterId, 0.4)',
    ],
    why: 'resolved once when the slot latches its impact point into slot.ix/iy/iz; every later frame reads those numbers instead.',
  },
  {
    file: 'sequencer.ts',
    fn: 'ArchetypeSequencer.wireContact',
    resolves: ['host.anchorOf(slot.casterId, 0.68)', 'host.anchorOf(slot.targetId, 0.74)'],
    why: 'the wire-strangle contact beat, reached only from the two latched strike beats above.',
  },
];

const resolveKey = (r: { file: string; fn: string; text: string }): string =>
  `${r.file} :: ${r.fn} :: ${r.text}`;

/** Run `body` against a throwaway source tree, cleaned up either way. */
function withFixture(prefix: string, body: (root: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('ability VFX anchor resolves reachable from update()', () => {
  const scan = scanUpdateAnchorResolves(ABILITY_VFX_DIR);

  it('resolves into a scratch everywhere except the declared one-shot beats', () => {
    const declared = ONE_SHOT_RESOLVES.flatMap((row) =>
      row.resolves.map((text) => resolveKey({ file: row.file, fn: row.fn, text })),
    ).sort();
    const allocating = scan.resolves.filter((r) => !r.withDestination);
    const found = allocating.map(resolveKey).sort();

    const undeclared = allocating.filter((r) => {
      const key = resolveKey(r);
      return found.filter((k) => k === key).length > declared.filter((k) => k === key).length;
    });
    expect(
      undeclared.map((r) => `${r.file}:${r.line} ${r.fn} ${r.text}`),
      'a destination-less anchor resolve is reachable from AbilityVfxFx.update(). A per-frame path must pass its own scratch (see src/render/vfx_anchor.ts); if this one is a latched one-shot beat, add it to ONE_SHOT_RESOLVES with the latch that makes it so.',
    ).toEqual([]);

    const stale = declared.filter(
      (key) => declared.filter((k) => k === key).length > found.filter((k) => k === key).length,
    );
    expect(
      [...new Set(stale)],
      'ONE_SHOT_RESOLVES names a resolve the scan no longer finds: delete the row, or re-point it if the call moved or was reworded.',
    ).toEqual([]);
  });

  it('reaches the per-frame draws in every module the frame walk crosses', () => {
    // Anti-vacuity: a walk that stopped at fx.ts would pass the assertion above
    // while covering none of the pools whose per-frame anchor reads it exists
    // to police. Named bodies, not a count, so a rename fails loudly.
    for (const fn of [
      'AbilityVfxFx.drawWindup',
      'AbilityVfxFx.drawOrbit',
      // Upstream's v0.36.0 rename of drawStunStars: the same per-frame
      // crowd-control overhead draw, now a band rather than only stars.
      'AbilityVfxFx.drawCcBand',
      'ArchetypeSequencer.drawTransients',
      'AbilityVfxRibbons.update',
      'BuffShells.update',
      'GroundAuras.update',
    ]) {
      expect(scan.reached, `${fn} is no longer reachable from AbilityVfxFx.update()`).toContain(fn);
    }
    const withScratch = scan.resolves.filter((r) => r.withDestination);
    const files = new Set(withScratch.map((r) => r.file));
    expect([...files].sort()).toEqual([
      'fx.ts',
      'ground_auras.ts',
      'ribbons.ts',
      'sequencer.ts',
      'shells.ts',
    ]);
    expect(withScratch.length).toBeGreaterThanOrEqual(18);
    // and the walker really did read the whole directory, not a slice of it
    expect(scan.files.length).toBeGreaterThanOrEqual(15);
    expect(scan.files).toContain('sequencer.ts');
  });

  it('reads call sites in a SUBDIRECTORY of the scan root', () => {
    // Every file under src/render/ability_vfx sits at the top level today, so
    // nothing asserted against the real tree can tell a recursive walk from a
    // flat one. Drive the guard's own producer over a planted fixture instead:
    // the day the subsystem grows a subdirectory, a per-frame resolve inside it
    // must not leave the scan (tests/CLAUDE.md, #2485 and #2502).
    withFixture('ability-vfx-scan-', (root) => {
      mkdirSync(path.join(root, 'nested'));
      writeFileSync(
        path.join(root, 'fx.ts'),
        'export class AbilityVfxFx {\n  update(dt: number): void {\n    paintBand(dt);\n  }\n}\n',
      );
      writeFileSync(
        path.join(root, 'nested', 'bands.ts'),
        'export function paintBand(id: number): void {\n  anchor(id, 0.5);\n}\n',
      );

      const planted = scanUpdateAnchorResolves(root);
      expect(planted.files).toContain('nested/bands.ts');
      expect(
        planted.resolves.map((r) => `${r.file} ${r.fn} ${r.text} ${r.withDestination}`),
      ).toEqual(['nested/bands.ts paintBand anchor(id, 0.5) false']);
    });
  });

  it('counts `undefined` in the destination slot as no destination', () => {
    withFixture('ability-vfx-slot-', (root) => {
      writeFileSync(
        path.join(root, 'fx.ts'),
        'export class AbilityVfxFx {\n  update(dt: number): void {\n' +
          '    this.anchor(1, 0.5, undefined);\n' +
          '    this.anchor(2, 0.5, scratch);\n' +
          '  }\n}\n',
      );
      expect(scanUpdateAnchorResolves(root).resolves.map((r) => r.withDestination)).toEqual([
        false,
        true,
      ]);
    });
  });

  it('fails loudly when the per-frame entry point is gone', () => {
    withFixture('ability-vfx-seed-', (root) => {
      writeFileSync(path.join(root, 'fx.ts'), 'export class AbilityVfxFx {}\n');
      expect(() => scanUpdateAnchorResolves(root)).toThrow(/not found under/);
    });
  });

  it('scans the directory only through the shared walker', () => {
    expectScansOnlyThroughSharedWalkers(import.meta.url, ['ts_files_under']);
  });
});
