// Pure layout math for the player card compositor (#3125). DOM-free so it is
// testable without a canvas: converts content presence/counts into the exact
// regions the drawHeader/drawStats/drawGear/drawDevBadge painters in
// player_card.ts use, so a fully populated card reflows its bands instead of
// letting a later one (the footer band) collide with an earlier one (gear).
//
// The right-column stack, top to bottom: name -> subtitle/flex chip -> realm
// -> title (its own row, never sharing the realm baseline) -> dev badge ->
// stats panel -> gear panel -> footer band. Each band below the
// header is either a fixed budget the content is guaranteed to fit (stats,
// via a row height computed from the row count) or grows with its content
// (gear, via a computed panel height), so a heavier field set reflows the
// stack instead of running past the next band's top edge.

export const CARD_W = 1200;
export const CARD_H = 630;

// The header text column: every header line (name, subtitle, realm, title)
// starts here, clamped left of the right-edge column that keeps text clear of
// the top-right brand mark.
export const HEADER_X = 478;
export const HEADER_RIGHT_EDGE = 1018;

export const NAME_BASELINE = 96;
export const SUBTITLE_BASELINE = 130;
export const CHIP_Y = 109;
export const CHIP_H = 26;
export const REALM_BASELINE = 158;

// The Book of Deeds title gets its OWN row below the realm line: a long title
// no longer fights the realm text for the y=158 baseline (the #3125 root
// cause), and a title that would still be unreadably clamped just doesn't
// draw (see titleLayout below).
export const TITLE_BASELINE = 183;

// The developer badge sits just below the title row instead of the old
// realm-to-stats gap, since the title now claims that band.
export const DEV_BADGE_CX = HEADER_X + 11;
export const DEV_BADGE_CY = 204;
export const DEV_BADGE_R = 11;

export const STATS_Y = 225;
export const STATS_H = 172;
export const STATS_W = 690;
// Row baselines are `y + i*rowH + 18` against a `y` that already carries the
// panel's +22 top pad (see drawStatColumn); this is the "+40" that formula
// contributes before the per-row term.
const STATS_ROW_BASELINE_OFFSET = 40;
const STATS_BOTTOM_PAD = 14;
const STATS_ROW_H_MAX = 27;
const STATS_ROW_H_MIN = 18;

/** Row height for a stat column so `rowCount` rows always stay inside the
 *  fixed-height stats panel, regardless of how many extra rows (arena
 *  rating, prestige) are appended. Shrinks below the default 27px spacing
 *  only once a row count would otherwise overflow; never below 18px, a
 *  20px stat value stays readable at that floor. */
export function statRowHeight(rowCount: number, panelH: number = STATS_H): number {
  if (rowCount <= 1) return STATS_ROW_H_MAX;
  const budget = panelH - STATS_ROW_BASELINE_OFFSET - STATS_BOTTOM_PAD;
  const fitted = Math.floor(budget / (rowCount - 1));
  return Math.max(STATS_ROW_H_MIN, Math.min(STATS_ROW_H_MAX, fitted));
}

/** Baseline y of the last stat row, for overflow assertions. */
export function statsLastRowBaseline(rowCount: number, panelY: number = STATS_Y): number {
  if (rowCount <= 0) return panelY + STATS_ROW_BASELINE_OFFSET;
  const rowH = statRowHeight(rowCount);
  return panelY + STATS_ROW_BASELINE_OFFSET + (rowCount - 1) * rowH;
}

export const GEAR_Y = STATS_Y + STATS_H + 14;
export const GEAR_W = STATS_W;
export const GEAR_ROW_H = 34;
const GEAR_TOP_PAD = 20;
const GEAR_NAME_OFFSET = 22; // name baseline is gy + this, below the slot label
const GEAR_BOTTOM_PAD = 14;

/** Panel height that fits every gear row (2 columns) without the last row's
 *  name baseline running past the panel, however many slots are shown. */
export function gearPanelHeight(itemCount: number): number {
  const rows = Math.max(1, Math.ceil(itemCount / 2));
  return GEAR_TOP_PAD + (rows - 1) * GEAR_ROW_H + GEAR_NAME_OFFSET + GEAR_BOTTOM_PAD;
}

/** Baseline y of the last gear row's item name, for overflow assertions. */
export function gearLastRowNameBaseline(itemCount: number, panelY: number = GEAR_Y): number {
  const rows = Math.max(1, Math.ceil(itemCount / 2));
  return panelY + GEAR_TOP_PAD + (rows - 1) * GEAR_ROW_H + GEAR_NAME_OFFSET;
}

// The footer band at the bottom of the right column: unlike stats/gear it never
// reflows vertically, since the footer's referral/CTA text shares its row and
// that boundary is unaffected by how much gear/stat content is shown. It is the
// hard floor the growing gear panel above must stay clear of.
//
// Upstream anchors a $WOC holder badge here (centre y=575, r=30) and derives the
// band top from it. This fork ships no wallet and draws no such badge, so the
// boundary is stated directly at the same y, which keeps the card's geometry
// byte-identical to the upstream layout it was tuned against.
export const FOOTER_BAND_TOP = 545;

/** Where the title line sits on the header, or null when nothing may draw.
 *  Pure (no canvas): the title now owns its own row below the realm line, so
 *  it can never collide with the realm baseline regardless of either
 *  string's length. Null for an absent / empty / whitespace titleText, which
 *  is what keeps an untitled card drawing nothing extra here. */
export function cardTitleLayout(
  titleText: string | undefined,
): { text: string; x: number; y: number; maxW: number } | null {
  const text = (titleText ?? '').trim();
  if (!text) return null;
  return { text, x: HEADER_X, y: TITLE_BASELINE, maxW: HEADER_RIGHT_EDGE - HEADER_X };
}
