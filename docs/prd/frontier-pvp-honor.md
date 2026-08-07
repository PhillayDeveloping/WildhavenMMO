# PRD: Frostreach Frontier (Open PvP Zone) and Honor

| | |
|---|---|
| **Status** | Draft v2. The staked-season layer this doc once carried was cut with the rest of web3; what remains is the free loop. |
| **Owner** | design |
| **Created** | 2026-07-03 |
| **Design reference** | Classic-era Wintergrasp / world PvP zones (two teams, contested objectives, honor currency, timed zone events) |
| **Related systems** | Duel/arena hostility (`src/sim/social/duel.ts`, `src/sim/social/arena.ts`, `isHostileTo`), world boss (`src/sim/world_boss.ts`), rare spawns (`MobTemplate.rare`), currencies (`copper`, `delveMarks` on `CharacterState`), vendors (`NpcDef.vendorItems`), realms (`server/realm.ts`), instance x-bands (`src/sim/data.ts`), headless RL env (`headless/`, `python/`) |
| **Companion docs** | `docs/prd/badges.md` (deterministic-currency precedent), `docs/prd/heroic-mythic-dungeons.md` |
| **Implementation handoff** | `docs/prd/FRONTIER_PHASE1_HANDOFF.md` (Phase 1 slices, verified hook points, executor routing) |

---

## 1. Summary

The **Frostreach Frontier** is a persistent, always-on open-world PvP zone that any
character level 15+ can enter from the overworld. On entry a player is assigned to
one of two teams, **Azure** (blue) or **Crimson** (red), gets a visible team banner
on their back, and is automatically flagged hostile to the opposite team for as long
as they are in the zone. The zone is dense with things worth fighting over: resource
nodes to harvest, rare spawns, a world boss, and a rotating **hourly event**.

Alongside the zone we introduce **Honor Points**, a new account currency earned by
killing enemy players and participating in Frontier content, spent at each team's
**Honor Quartermaster** on PvP gear, consumables, and team cosmetics.

The extraction hook: resources you harvest in the Frontier are **carried, not
banked**. They ride on your character as visible cargo, drop for the enemy when you
die, and only become yours when you turn them in at your team's base. Every full
cargo bag walking home is a PvP objective.

The zone runs on **play stakes only** (sections 5 to 9): the on-ramp, the
skill-builder, and the identity layer. An earlier draft paired this with a
deposit-to-play staked season settling to a token; that layer is gone with the
rest of the web3 surface, and the sim deals in cargo, honor, and copper only.

All outcomes resolve in the authoritative `Sim`; clients mirror via `IWorld` /
`ClientWorld`. Content is declarative in `src/sim/content/`.

## 2. Realm or zone? (resolving the framing)

The pitch says "realm", and the repo does support multiple realms
(`server/realm.ts`, `npm run realms`, `REALM_TYPE: 'PvP'`). But realms are isolated
shards: characters, friends, and guilds are scoped per realm, and there is no
cross-realm travel. Shipping Frostreach as a realm would mean players start blank
characters there and abandon their mains.

**Decision: ship it as a zone.** Frostreach is a new spatial band inside every
realm's world (like arena and delves). Entry is by teleport from the existing
Arena window (the `G` keybind, `src/game/keybinds.ts` id `arena`), which grows
into the general PvP window: the Ashen Coliseum queue section plus a Frostreach
Frontier section with an Enter button, your team, honor balance, and the next
event countdown. This preserves the whole point: your level-20 main, its gear,
and its guild all matter in the Frontier.

A `REALM_TYPE='PvP'` shard where the *entire overworld* uses Frontier flagging
rules remains a config-plus-small-code follow-up (section 13), not v1.

## 3. Current state in the codebase (what this reuses and what is new)

| Concern | Exists today | Gap for this feature |
|---|---|---|
| PvP hostility | `isHostileTo` gates on active duels and arena matches only | Add a third gate: both players inside the Frontier band and on opposite teams |
| Teams | `ArenaMatch { teamA, teamB }`, per-match, ephemeral | Persistent per-character team assignment (`frontierTeam` on `CharacterState`) |
| World boss | `src/sim/world_boss.ts`: interval spawns, personal loot, daily gate via `PlayerMeta.worldBossDaily` | Add a Frontier boss entry to `WORLD_BOSSES` (or an event-driven spawn, section 8) |
| Rare spawns | `MobTemplate.rare` + `elite` + `respawnMult`, exclusive loot roll groups (Brutok pattern) | New Frontier rare templates; no engine work |
| Gathering | None. Only quest sparkle pickups (`ground_pickup_lines.ts`) | New: resource node entity type + gather channel + carried cargo (section 6) |
| Currency | `copper`, `delveMarks` counters on `CharacterState`; vendor via `NpcDef.vendorItems` + `sim.buyItem` | New `honor` counter, same pattern; honor-priced vendor stock |
| Timed events | `worldBossNextAt` sim-time scheduler in `sim.ts` | Generalize into a Frontier event scheduler (hourly, Rng-picked, section 8) |
| Spatial bands | Overworld x in [-180, 180]; dungeons 900+; arena 4200+; delves 4800+ (delve band is open-ended along x today) | New Frontier band, `FRONTIER_X_MIN = 9000` (leaves headroom for delve growth; `isDelvePos` must gain an upper bound, see handoff gotcha G1) |
| PvP rewards | Duel/arena kills grant nothing (no XP, no loot) | Honor grants on player kill, with diminishing returns (section 7) |
| Back attachment (flag) | `src/render/characters/` template system | Team banner attachment tinted per team, plus nameplate tint |

## 4. Goals and non-goals

### Goals
- An always-on PvP sandbox at endgame (15 to 20, tuned for 20) with intrinsic
  reasons to fight: nodes, rares, boss, events, cargo.
- **Honor Points**: a deterministic PvP currency, and an Honor Quartermaster per
  team base with gear, consumables, and cosmetics.
- Automatic, unambiguous flagging: inside the zone you are hostile to the other
  team, outside you are not. No flag toggles, no spillover into the overworld.
- Team assignment that is balanced, sticky, and abuse-resistant.
- The extraction loop: harvest, carry, defend, turn in.
- An hourly event system that reshuffles the zone every hour and gives players a
  reason to log in "for the top of the hour".
- Identical behavior online, offline, and headless (the RL env gets a PvP zone for
  free, which is a genuinely interesting training environment).

### Non-goals
- Siege weapons, destructible walls/gates, vehicles (the full Wintergrasp fortress
  siege). The event framework leaves room for it (section 8 backlog).
- Ranked ratings or matchmaking. Honor is a currency, not a rating.
- Cross-realm queueing or realm merging.
- Professions/crafting. Frontier resources are turn-in valuables in v1, not
  crafting mats (future hook, section 13).
- Battleground-style instanced matches with win conditions. The zone is persistent.
- Pure-chance casino mechanics (slots, lockboxes, coin flips). The zone stays
  skill-forward: stat-check combat where bad players can beat good players in a
  fight but skill has the edge over time.
- Liquid honor. Honor never trades, in any mode, ever.
- Perfect bot detection. The bot detector seam (`server/bot_detector/`) is the
  defense; we do not pretend it is complete.

## 5. Teams, flagging, and identity

### 5.1 Assignment
- First entry per character: assigned to the currently smaller team **among players
  in the zone**, ties broken by the zone Rng. Stored as
  `frontierTeam: 'azure' | 'crimson'` on `CharacterState` (additive JSONB field,
  back-compat default unset).
- Assignment is **permanent per character**. No team swapping: swapping enables
  spying, kill-trading, and vendor double-dipping. A player who wants the other
  color plays another character.
- Party members who enter together are assigned to the same team when balance
  allows (party cohesion beats perfect balance within a tolerance of 2).

### 5.2 Flagging rules
- `isHostileTo(a, b)` gains a Frontier clause: true when both entities are players
  physically inside the Frontier band and `frontierTeam` differs.
- No hostility bleed: teleporting out (the Leave button in the PvP window, or
  death-release rules) ends hostility immediately, since the band check does this
  for free. No overworld flagging in v1.
- Leave is a 10 s channel, interrupted by damage and blocked while in combat:
  entry is a free teleport, but the exit must never be an escape button mid-fight
  (hearthstone-style rules).
- Same-team players are never hostile in the zone (duels disabled inside the
  Frontier to keep the rule simple).
- Pets and companions inherit their owner's team, as they inherit hostility today.

### 5.3 Visible identity
- **The flag on the back**: a banner attachment on the character model, cloth tinted
  team color, visible at gameplay distances. Render-side only, driven by
  `frontierTeam` exposed through the wire entity.
- Nameplates and target frames tint blue/red for enemy players in the zone.
- Team is also shown on the zone map and in the Frontier HUD widget (section 9).

### 5.4 Death and respawn
- Dying to a player or mob in the Frontier: release and respawn at your **team
  base graveyard** (each team has a safe base at opposite ends of the band, with
  guards, the Quartermaster, and the turn-in officer).
- Base perimeters are safe zones: entering the enemy base applies a stacking
  guard threat response (elite guards, level 22, leash to base). No camping the
  spawn.
- Carried cargo drops on death (section 6.3). Equipped gear never drops.

## 6. Resources: harvest, carry, extract

### 6.1 Nodes
A new sim concept: the **resource node**, a stationary interactable entity with
health-like charge, spawned from declarative content records.

- Node types (working set): **Frostvein Ore** (common, everywhere), **Emberbloom**
  (uncommon, cluster spawns), **Ancient Relic Cache** (rare, marked on the zone map
  for both teams when it spawns).
- Harvesting is a **channel** (3 s common, 6 s rare), interrupted by damage or
  movement. Contested by design: you are stationary and visible while gathering.
- Nodes have 1 to 3 charges, deplete on harvest, respawn on a `respawnMult`-style
  timer via the zone Rng at randomized points from a spawn-point pool (same pattern
  as mob camps).
- Node picks, charges, and respawn draws all go through the zone `Rng`; identical
  across hosts.

### 6.2 Carried cargo
- Harvested resources go into a separate **cargo hold**, not the inventory: capacity
  10 units, visible on the character model (saddlebags/backpack bulge scaling with
  load) and as a HUD counter.
- Cargo cannot be traded, mailed, banked, or listed. It exists only in the Frontier.
- Teleporting out of the zone with cargo forfeits it (announced in the Leave
  confirm dialog). The only way to realize value is the turn-in officer at your base.

### 6.3 Dropping and looting
- On death, the victim's entire cargo drops as a lootable satchel for 60 s,
  lootable **by the opposing team only** (prevents kill-trading with a same-team
  friend to launder cargo).
- The satchel is a world entity; anyone on the killing team can grab it (fastest
  finger, encourages the killer's group to hold the field).

### 6.4 Turn-in
- The turn-in officer converts cargo: base rate 2 honor per common unit, 5 per
  uncommon, 25 per relic, plus a copper stipend. Rates are content data, not code.
- Turn-ins also feed the hourly **team score** (section 8.4).

## 7. Honor Points

### 7.1 Earning
| Source | Honor | Notes |
|---|---|---|
| Enemy player kill (killing blow's group, split) | 20 base | Scaled by victim level: full at equal level, 0 for victims 5+ levels below the killer |
| Same-victim diminishing returns | 100% / 50% / 25% / 0 | Per killer-victim pair, resets hourly; kills at 0 still count for events but pay nothing |
| Assist (damaged victim within 10 s) | 5 | Flat, same DR schedule |
| Resource turn-in | 2 / 5 / 25 per unit | Section 6.4 |
| Rare spawn kill (participation) | 15 | Personal-loot style eligibility, reuses the world boss contributor logic |
| Frontier world boss (participation) | 100 | Once per boss per day, same `worldBossDaily` gate pattern |
| Hourly event participation / win | 10 to 50 | Per event definition, section 8 |

- Honor is a plain counter on `CharacterState` (`honor: number`), granted
  server-side in the sim exactly like `delveMarks`. Additive JSONB field.
- **Honor is soulbound, permanently**: no trading, no mailing. It is the identity
  asset, and keeping it illiquid
  is what keeps kill DR a balance knob instead of wash-trading security.
- Anti-farm: level-difference gating and per-pair DR above; no honor from kills
  where killer and victim share a party (defense in depth; cross-team parties
  cannot exist anyway); server-side, the existing moderation surface can review
  top honor earners (out of sim scope).

### 7.2 Honor Quartermaster (one per team base, mirrored stock)
- **Gear**: a level-20 PvP set per armor class, priced 150 to 800 honor per slot.
  Stat-budgeted exactly like PvE epics (the `tests/item_level` budget gate applies:
  compute `expectedStatBudget` first). Flavor lean: stamina-heavy relative to PvE
  counterparts, slightly below raid drops so raiding stays aspirational (same
  positioning rule as Badges of Valor).
- **Consumables**: battle standards (short AoE team buff), bandage-style heal item
  usable in the Frontier, a cargo-capacity +5 satchel (1 hour duration).
- **Cosmetics**: team tabard and cloak skins (Azure/Crimson), title unlocks at
  lifetime honor milestones (mirrors the lifetimeXp prestige pattern), a
  `lifetimeHonor` counter backs these.
- Vendor mechanics reuse `NpcDef.vendorItems` + `sim.buyItem` with a price
  currency field extension (`priceHonor` alongside copper prices).

## 8. Hourly events

### 8.1 Framework
- A Frontier **event scheduler** in the sim, generalizing the `worldBossNextAt`
  pattern: every 3600 sim-seconds, draw the next event from a weighted rotation via
  the zone `Rng` (no repeat of the previous event; some events, like the world
  boss, are on fixed rotation slots instead of random draw).
- Hourly means **sim-time hours**, keeping headless/offline determinism. On the
  live server sim-time tracks wall clock closely, so players get a predictable
  "top of the hour" rhythm.
- 5 minutes before an event: zone-wide announcement (stable event key + values,
  re-localized client-side via `sim_i18n.ts`, never English from the sim). The HUD
  shows a countdown.
- Events last 10 to 15 minutes, then the zone returns to baseline.

### 8.2 v1 event rotation (ship these six)
1. **Resource Rush**: all nodes respawn instantly, double charges, double yield.
   The whole zone converges on the node fields.
2. **Bloodmoon**: player kills award double honor, and every player is pinged on
   the zone map every 10 s. Nowhere to hide.
3. **The Caravan**: a neutral NPC caravan crosses the zone on a fixed route.
   Damage-contribution decides which team it pays out to when it reaches the
   center; it drops a cargo pile if destroyed. Escort or ambush.
4. **Relic Surge**: 5 Ancient Relic Caches spawn at once, all marked on the map.
5. **Rare Hunt**: three named rare elites (Frontier-exclusive loot roll groups)
   spawn at announced landmarks.
6. **Warlord of the Frontier** (fixed slot, every 6th hour): the Frontier world
   boss spawns at the central ruin. Both teams want the personal loot and the 100
   honor; neither can safely ignore the other while fighting it.

### 8.3 Event backlog (brainstorm, post-v1 candidates)
- **King of the Hill**: capture-and-hold the central tower; the holding team gets
  a zone-wide +10% honor aura while they hold it (first zone-wide team aura;
  needs a small aura-broadcast mechanism).
- **Supply Drop**: one high-value chest at a random marked point, opened by a long
  contested channel (reuse the delve lockpick minigame as the opener).
- **Bounty Hour**: the top honor earner on each team is marked with a bounty;
  killing them pays 100 honor and clears the mark.
- **Fog of War**: heavy weather rolls in, nameplate/render draw distance halved,
  stealth detection reduced (render-side fog cue, sim-side detection change).
- **Sudden Death**: respawn timers triple for the duration; every kill matters.
- **Free-for-all Ring**: a marked subzone where team hostility is suspended and
  replaced by everyone-hostile; solo bragging rights, honor per kill, no DR.
- **The Vault Opens**: the hourly team score winner (8.4) gets 10 minutes of
  access to a vault room with a loot boss, guarded from the losing team by a
  gate only the winners can pass. The closest v1-adjacent nod to Wintergrasp's
  Vault of Archavon.
- **Gold Vein**: one super-node with 20 charges and a 10 s channel per harvest.
- **Payload Push**: tug-of-war escort, the caravan reversed: each team pushes a
  siege engine toward the enemy base; first to arrive drops the enemy base
  guards for 5 minutes.
- **Night of the Dead** (seasonal): PvE wave defense on both bases
  simultaneously; teams may truce or exploit each other's distraction.
- **Full fortress siege**: walls, gates, siege engines, attacker/defender role
  swap. The real Wintergrasp. Large; its own PRD if the zone proves out.

### 8.4 Team score
Each hour accumulates a per-team score (kills 1 pt, turn-ins 1 pt/unit, event
objectives per event definition). At the hour boundary the winning team's members
in the zone get a 25 honor payout and a 10-minute cosmetic banner buff. Score
feeds future events (The Vault Opens) and gives the hour a narrative arc even
between events.

## 9. Player-facing surfaces (IWorld first)

Extend `IWorld` (`src/world_api.ts`) before touching either world, implement in
both `Sim` and `ClientWorld`:
- `frontierState()`: my team, honor, cargo load, active/next event + countdown,
  team scores.
- Wire entity additions: `frontierTeam` on players, node/satchel/caravan entity
  kinds, cargo-load visual scalar.
- Commands: `frontier_enter`, `frontier_leave`, `gather_node`, `loot_satchel`,
  `turn_in_cargo` (dispatched in `server/game.ts` like `enter_dungeon`).

HUD (each its own module the HUD composes, not new `hud.ts` banner sections):
- PvP window (`G`): the existing Arena window gains a Frostreach Frontier section
  with Enter/Leave, team, honor balance, and next-event countdown alongside the
  Ashen Coliseum queue. Keybind label updates from "Arena (Ashen Coliseum)" to a
  PvP label (i18n key change, completeness gate applies).
- Frontier widget (in-zone): team, honor, cargo 0-10, event countdown, team scores.
- Zone map layer: bases, node fields, event markers, Bloodmoon pings.
- Vendor window reuse with honor prices; FCT shows honor gains like XP.

## 10. Invariant compliance checklist

- **Determinism**: all node spawns, event draws, team tiebreaks via the zone
  `Rng`; hourly timers on sim-time; daily gates via `ctx.utcDay`. No wall-clock.
- **Sim purity**: everything above the render line lives in `src/sim/`
  (new `src/sim/frontier/` directory with an `index.ts` barrel + local CLAUDE.md);
  zero DOM/Three imports; `tests/architecture.test.ts` must stay green.
- **Server authority**: honor grants, cargo, turn-ins, team assignment all resolve
  in the server's sim; the client renders.
- **i18n**: sim/server emit stable keys + values only. Known gates from prior
  work: new item names need translation in all locales
  (`tests/localization_coverage`), event/mechanic names go through the
  `sim_i18n.ts` matcher dictionaries, new HUD chrome keys hit the completeness
  gate (coordinate with the maintainer or stage keys per the release-tier
  workflow), and level-20 vendor gear must hit exact `expectedStatBudget`
  (`tests/item_level`).
- **Content as data**: nodes, events, rares, vendor stock, prices are records in
  `src/sim/content/frontier.ts` merged by `data.ts`; regenerate `/wiki` content
  (`npm run wiki:content`), mind spoiler-safety for rares/boss.
- **Classic fidelity**: honor DR schedules and level-gating mirror classic honor
  rules; no invented balance numbers without a `docs/design/` note.
- **Money firewall**: no payment, token, or settlement code or imports anywhere in
  `src/sim/` (extend `tests/architecture.test.ts` with this scan). The sim's
  vocabulary ends at cargo, honor, copper.

## 11. Phasing

| Phase | Scope | Acceptance |
|---|---|---|
| 1. Skeleton | Frontier band + G-window enter/leave teleport, team assignment, back banner, auto-flagging, base graveyards, honor counter, honor on kills with DR | Two clients on opposite teams can fight and earn honor; `isHostileTo` tests; parity goldens |
| 2. Economy | Nodes, gather channel, cargo, death drop, turn-in, Honor Quartermaster (gear + consumables) | Full harvest-carry-die-loot-turn-in loop deterministic in a headless test |
| 3. Events | Event scheduler + the six v1 events, team score, HUD countdown | Seeded sim replays the same event sequence; each event has a sim test |
| 4. Apex | Frontier world boss, rare trio, cosmetics/titles, zone map layer, wiki content | Boss daily gate works; i18n gates green at PR tier |

## 13. Future hooks (explicitly deferred)
- `REALM_TYPE='PvP'` shard where overworld zones use Frontier flagging.
- Frontier resources as crafting mats when professions land.
- Fortress siege event (own PRD).
- Cross-realm event calendar alignment.

## 14. Decisions and open questions

Resolved in this revision:
1. Entry level: 15+ (diminishing-returns level-gating protects them).
2. Cargo on teleport-out: forfeit, no tax exit. Cleaner rule, and it keeps the
   extraction tension the whole loop rests on.
3. Stealth openers on mid-channel gatherers: allowed. Getting sapped at a node
   is the point; incomplete information is a feature.
4. Offline worlds: the Frontier exists offline with nodes, rares, and events
   (no bot teams in v1).

Still open:
1. Honor cap per day/week, or let diminishing returns do the work? (Lean: no
   cap, measure first.)
