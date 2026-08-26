/**
 * Node-layer (Vitest) — KDM-273: a standing guard over the pattern that keeps producing this bug.
 *
 * Four times now, a global written by map generation or a floor transition turned out to be WORLD
 * state that the swap layer was replicating per-player, and each time it was found by a feature that
 * happened to make two players' copies diverge:
 *
 *   KDM-228  KDGameData.RoomType / .MapMod            found by a side-room visit
 *   KDM-265  MiniGameKinkyDungeonLevel / .Checkpoint,
 *            JourneyX / JourneyY / HighestLevelCurrent found by ten real descents
 *   KDM-243  KinkyDungeonSeed / KDGameData.LastMapSeed found by a save import, after a bisect
 *
 * Four instances of one pattern is a category, not a coincidence. This file is the attempt to catch
 * the fifth at the moment upstream introduces it rather than when a feature exposes it.
 *
 * ── WHAT THIS GUARD DOES, AND WHAT IT DELIBERATELY DOES NOT ───────────────────────────────────────
 * It does NOT decide classifications. It CANNOT, and it is worth being precise about why, because the
 * obvious rule is wrong in both directions:
 *
 *   "written by a transition ⇒ world"  OVER-fires. `KinkyDungeonFastMovePath` and
 *      `KinkyDungeonTargetTile` are written by `KDInitTempValues` and are plainly per-player — one
 *      player's movement path, one player's targeting cursor. Being RESET to a constant by a
 *      transition is a different thing from being DERIVED from the world by one.
 *
 *   "derived from the world ⇒ world"   UNDER-fires. `KDGameData.ChestsGenerated = []` is a literal
 *      reset and is nonetheless correctly world state, because its SEMANTICS are floor population.
 *
 * So what this guard enforces is that the decision was MADE: every key a transition site writes is
 * either declared world in production code, or recorded below as deliberately per-player with a
 * reason. Its failure mode is "a human must look at key #55", not "state leaks".
 *
 * That distinction is what keeps `PER_PLAYER_BY_DECISION` from being the maintained whitelist this
 * epic exists to delete. A whitelist decides behaviour and is wrong when incomplete; this register
 * decides nothing at runtime and is *checked for rot in both directions* below. It lives in test code
 * for the same reason — it must not be readable as behaviour.
 *
 * ── TEXT COUPLING ─────────────────────────────────────────────────────────────────────────────────
 * This reads the game source, which is a tree we never write and which moves under us on every
 * upstream fast-forward. Per the repo's rule for serve-time/text-coupled work: assert match counts
 * and log drift loudly. Sites are located by function NAME, never by line number — names are stable,
 * line numbers are not — and every extraction is size-checked, so a regex that quietly stops matching
 * fails instead of reporting "no unclassified keys".
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
/* eslint-disable @typescript-eslint/no-var-requires */
const { KDGAMEDATA_WORLD_KEYS, GLOBAL_BLACKLIST } = require('../../tools/mp-server/headless-host');

const GAME_ROOT = path.resolve(__dirname, '../..');

/**
 * The map-generation / floor-transition entry points.
 *
 * `minBodyLines` is an anti-vacuity floor, not a spec: it exists so that an extraction which silently
 * returns an empty body cannot pass this whole file. Set well below the real size so ordinary
 * upstream churn does not trip it.
 */
const SITES = [
	{ fn: 'KinkyDungeonCreateMap',    file: 'Game/src/map/KDMapGen.ts',                minBodyLines: 300 },
	{ fn: 'KDGoThruTile',             file: 'Game/src/map/KDStairActions.ts',          minBodyLines: 100 },
	{ fn: 'KinkyDungeonHandleStairs', file: 'Game/src/map/KDStairActions.ts',          minBodyLines: 5   },
	{ fn: 'KDInitTempValues',         file: 'Game/src/base/game/KinkyDungeonGame.ts',  minBodyLines: 20  },
];

/**
 * Total writes the scan found when this guard was written. A LOWER bound: upstream adding writes is
 * ordinary, and a new key will fail the classification check below on its own merits. A DROP means
 * the extraction broke, which is the failure this bound exists to catch.
 */
const MIN_GAMEDATA_WRITES = 34;
const MIN_GLOBAL_WRITES = 91;

/**
 * ── THE DECISION REGISTER ─────────────────────────────────────────────────────────────────────────
 * Keys a transition site writes that are deliberately NOT world state. Every entry is a recorded
 * decision with a reason; `flagged` entries are decisions too — "left per-player for now, reviewed,
 * tracked by KDM-277" — and KDM-277's acceptance criteria are that none remain.
 *
 * Do not add an entry to silence a failure. A new key here means someone looked at it.
 */
type Verdict = 'player' | 'flagged';
const PER_PLAYER_BY_DECISION: Record<string, { verdict: Verdict; why: string }> = {
	// ── decided per-player ────────────────────────────────────────────────────────────────────────
	'KinkyDungeonFastMovePath':      { verdict: 'player', why: 'one player\'s queued movement path' },
	'KinkyDungeonTargetTile':        { verdict: 'player', why: 'one player\'s targeting cursor' },
	'KinkyDungeonTargetTileLocation':{ verdict: 'player', why: 'targeting cursor, with the above' },
	'KinkyDungeonTotalSleepTurns':   { verdict: 'player', why: 'one player\'s sleep counter' },
	'KinkyDungeonShopIndex':         { verdict: 'player', why: 'which shop page this player is on' },
	'KinkyDungeonAid':               { verdict: 'player', why: 'per-player aid offers' },
	'KinkyDungeonRescued':           { verdict: 'player', why: 'per-player rescue record' },
	'KinkyDungeonClassModeChoice':   { verdict: 'player', why: 'a player\'s class selection' },
	'KinkyDungeonState':             { verdict: 'player', why: 'which SCREEN a client is on; per-client by construction' },
	'KinkyDungeonPlayerEntity':      { verdict: 'player', why: 'the player entity itself — the definition of per-player' },
	'KDModalArea':                   { verdict: 'player', why: 'a client\'s modal UI flag' },
	'KDTileToTest':                  { verdict: 'player', why: 'editor/test scratch, not session state' },
	'KDGenMapCallback':              { verdict: 'player', why: 'a transient generation callback slot, null between maps' },
	'KinkyDungeonCanvas':            { verdict: 'player', why: 'the browser canvas element (KDMapGen.ts:256) — the server has no screen' },
	'KDPathCacheIgnoreLocks':        { verdict: 'player', why: 'pathing cache for the acting player\'s lock knowledge' },
	'KDGameData.ChampionCurrent':    { verdict: 'player', why: 'this player\'s champion-fight counter' },
	'KDGameData.HeartTaken':         { verdict: 'player', why: 'whether THIS player took the heart' },
	'KDGameData.KeysNeeded':         { verdict: 'player', why: 'escape requirement shown to this player' },
	'KDGameData.KinkyDungeonPenance':{ verdict: 'player', why: 'this player\'s penance flag' },
	'KDGameData.OfferFatigue':       { verdict: 'player', why: 'this player\'s offer cooldown' },
	'KDGameData.RescueFlag':         { verdict: 'player', why: 'this player\'s rescue flag' },
	'KDGameData.ShortcutIndex':      { verdict: 'player', why: 'this player\'s chosen shortcut' },

	// ── reviewed, left per-player FOR NOW, tracked by KDM-277 ─────────────────────────────────────
	// These are the audit's yield. Each looks like world state; none is being moved here, because a
	// classification change without its own divergence test is exactly the unproven state the epic
	// already carries one of (NPCRestraints). KDM-277 decides them one at a time, with tests.
	'KDGameData.PersistentItems':    { verdict: 'flagged', why: 'KDM-277: keyed by RoomType + KDCurrentWorldSlot (KDMapGen.ts:69-73)' },
	'KDCommanderRoles':              { verdict: 'flagged', why: 'KDM-277: Map<number,string> — a number key is an entity id, criterion (a)' },
	'KDGameData.AlreadyOpened':      { verdict: 'flagged', why: 'KDM-277: pushes {x,y} map coords; sibling of ChestsGenerated which IS world' },
	'KDGameData.KeyringLocations':   { verdict: 'flagged', why: 'KDM-277: map locations, reset by KDInitTempValues' },
	'KDStageBossGenerated':          { verdict: 'flagged', why: 'KDM-277: generation state, criterion (b)' },
	'KinkyDungeonPOI':               { verdict: 'flagged', why: 'KDM-277: map points of interest emitted by the generator' },
	'KinkyDungeonGrid_Last':         { verdict: 'flagged', why: 'KDM-277: cache over KDMapData.Grid, i.e. derived from shared world state' },
	'KinkyDungeonUpdateLightGrid':   { verdict: 'flagged', why: 'KDM-277: render dirty flag; category already blacklisted (KDVisionUpdate et al)' },
	'KDRedrawFog':                   { verdict: 'flagged', why: 'KDM-277: render dirty flag, with the above' },
	'KDTileModes':                   { verdict: 'flagged', why: 'KDM-277: draw-time alpha oscillator (KinkyDungeonTiles.ts:392) — presentation' },
	'KDGameData.PrisonerState':      { verdict: 'flagged', why: 'KDM-277: jail is world furniture but "is THIS player a prisoner" reads per-player' },
	'KDGameData.PreferredJailPointTick': { verdict: 'flagged', why: 'KDM-277: same jail question' },
	'KDGameData.PriorJailbreaksDecay':   { verdict: 'flagged', why: 'KDM-277: same jail question' },
	'KDGameData.Journey':            { verdict: 'flagged', why: 'KDM-277: run-level journey type; confirm it is not a per-player choice' },
	'MiniGameVictory':               { verdict: 'flagged', why: 'KDM-277: a victory ends the run for the party' },
	'KinkyDungeonRep':               { verdict: 'flagged', why: 'KDM-277: its own decl comment points at legacy server rep plumbing' },
	'KDRestraintsCache':             { verdict: 'flagged', why: 'KDM-277: derived cache; excluded by accident rather than decision (cf. KDM-202)' },
};

// ── extraction ────────────────────────────────────────────────────────────────────────────────────

/**
 * Assignment targets.
 *
 * `CHAIN` matters more than it looks. The first cut of this required the assignment operator to
 * follow the key IMMEDIATELY, and it missed `KDGameData.PersistentItems[...] = {}`
 * (`KDMapGen.ts:70`) — writing THROUGH a key is still writing it, and `PersistentItems` is the
 * strongest world-state candidate the whole audit turned up. It was caught by the register's own
 * rot check, which is the argument for having a guard whose parts check each other.
 *
 * `RE_GAMEDATA` is not anchored to the line start, because `if (!KDGameData.X) KDGameData.X = {}` is
 * an ordinary shape in this source and the write is the second clause. `RE_GLOBAL` stays anchored:
 * un-anchoring it would match the tail of any dotted expression.
 *
 * `=(?!=)` with the operator characters listed explicitly is what keeps `==`, `!=`, `>=` and `<=`
 * out — a comparison is not a write, and counting one would put a phantom key in front of a human.
 */
const ASSIGN_OP = String.raw`\s*(?:[+\-*/|&^%]?=(?!=)|\+\+|--)`;
const CHAIN = String.raw`(?:\s*(?:\[[^\]\n]*\]|\.[A-Za-z_][A-Za-z0-9_]*))*`;
const RE_GAMEDATA = new RegExp(
	String.raw`(?:^|[^.A-Za-z0-9_])KDGameData\.([A-Za-z_][A-Za-z0-9_]*)${CHAIN}${ASSIGN_OP}`);
const RE_GLOBAL = new RegExp(String.raw`^\s*([A-Z][A-Za-z0-9_]*)${CHAIN}${ASSIGN_OP}`);

/**
 * Drop comment text before matching. This source discusses assignments in prose constantly, and a
 * commented-out `KDGameData.Foo = bar` would otherwise be reported as a live write.
 */
function decomment(line: string): string {
	const t = line.trim();
	if (t.startsWith('*') || t.startsWith('/*') || t.startsWith('//')) return '';
	const i = line.indexOf('//');
	return i >= 0 ? line.slice(0, i) : line;
}

interface Write { key: string; site: string; file: string; line: number; }

/**
 * Names declared as a LOCAL inside a function body — `let x`, `var x`, `const x`, and the parameter
 * list — collected per site.
 *
 * This is the filter that makes `RE_GLOBAL` honest. A bare `Foo = 1` at the start of a statement is
 * indistinguishable by regex from an assignment to a local declared earlier in the same function, and
 * the transition sites have several: `KDGoThruTile` declares `Advance` and `AdvanceAmount` at
 * `KDStairActions.ts:42-43` and reassigns both ten lines later. A local cannot be replicated
 * per-player, so it is not this guard's business.
 *
 * Excluding LOCALS rather than including known top-level declarations is the deliberate choice, and
 * it is the difference between catching `MiniGameVictory` and missing it: that global is ASSIGNED at
 * `KDStairActions.ts:115`/`:144` and DECLARED nowhere in `Game/src` — an implicit global. An
 * inclusion filter built from declaration sites would drop it, and an implicitly-created global is
 * exactly the kind this guard should be most interested in.
 */
function localsOf(lines: string[]): Set<string> {
	const out = new Set<string>();
	// The parameter list: everything from `function name(` to the closing `)` of the signature.
	const sig = lines.join('\n');
	const open = sig.indexOf('(');
	if (open >= 0) {
		let depth = 0, close = open;
		for (let i = open; i < sig.length; i++) {
			if (sig[i] === '(') depth++;
			else if (sig[i] === ')') { depth--; if (depth === 0) { close = i; break; } }
		}
		for (const m of sig.slice(open + 1, close).matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*[?:,)=]/g)) {
			out.add(m[1]);
		}
	}
	for (const l of lines) {
		for (const m of l.matchAll(/(?:^|[^.A-Za-z0-9_])(?:let|var|const)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
			out.add(m[1]);
		}
	}
	return out;
}

/**
 * The body of a top-level function: from `function <name>` to the first following line that is
 * exactly `}` at column 0.
 *
 * Deliberately crude. A real parser would be more precise and would also be a dependency and a second
 * thing to be wrong; the size floor below is what makes the crudeness safe, because the only failure
 * this shape can have is stopping EARLY, and stopping early shrinks the body.
 */
function bodyOf(site: typeof SITES[number]): { lines: string[]; startLine: number } {
	const abs = path.join(GAME_ROOT, site.file);
	const src = fs.readFileSync(abs, 'utf8').split('\n');
	const re = new RegExp(String.raw`^function\s+${site.fn}\s*[(<]`);
	const hits: number[] = [];
	src.forEach((l, i) => { if (re.test(l)) hits.push(i); });

	// R5: site discovery must be exact. A rename upstream must fail loudly, not scan less.
	expect(hits.length,
		`R5 DRIFT: expected exactly one top-level \`function ${site.fn}\` in ${site.file}, found `
		+ `${hits.length}. Upstream has renamed or moved it — update SITES, do not delete this check.`)
		.toBe(1);

	const start = hits[0];
	let end = src.length - 1;
	for (let i = start + 1; i < src.length; i++) {
		if (/^\}\s*$/.test(src[i])) { end = i; break; }
	}
	return { lines: src.slice(start, end + 1), startLine: start + 1 };
}

function scan(): { gameData: Write[]; globals: Write[] } {
	const gameData: Write[] = [];
	const globals: Write[] = [];

	for (const site of SITES) {
		const { lines, startLine } = bodyOf(site);

		// Anti-vacuity: an empty or truncated body would produce zero unclassified keys and read as a
		// pass. This is the check that stops "found nothing" from meaning "nothing is wrong".
		expect(lines.length,
			`R5 DRIFT: extracted only ${lines.length} lines for ${site.fn} (${site.file}), expected at `
			+ `least ${site.minBodyLines}. The body extraction is broken — this guard would report a `
			+ `false clean.`)
			.toBeGreaterThanOrEqual(site.minBodyLines);

		const locals = localsOf(lines);
		lines.forEach((raw, i) => {
			const l = decomment(raw);
			if (!l.trim()) return;
			const at = { site: site.fn, file: site.file, line: startLine + i };
			const gd = RE_GAMEDATA.exec(l);
			if (gd) gameData.push({ key: `KDGameData.${gd[1]}`, ...at });
			const g = RE_GLOBAL.exec(l);
			if (g && g[1] !== 'KDGameData' && !locals.has(g[1])) globals.push({ key: g[1], ...at });
		});
	}
	return { gameData, globals };
}

const found = scan();
const uniq = (ws: Write[]) => [...new Set(ws.map((w) => w.key))].sort();

/** A key is classified if production code declares it world, or the register records a decision. */
function isClassified(key: string): boolean {
	if (PER_PLAYER_BY_DECISION[key]) return true;
	if (key.startsWith('KDGameData.')) return KDGAMEDATA_WORLD_KEYS.includes(key.slice(11));
	return GLOBAL_BLACKLIST.includes(key);
}

function describeWrite(w: Write) { return `${w.key}  (${w.site} — ${w.file}:${w.line})`; }

describe('KDM-273 — every transition-written key carries a recorded classification', () => {
	it('reports what the scan found (drift is visible, not inferred)', () => {
		// Not an assertion about correctness — a deliberate, always-on drift log. Text coupling to a
		// tree that moves under us is only safe if the coupling is loud.
		const gdKeys = uniq(found.gameData);
		const gKeys = uniq(found.globals);
		// eslint-disable-next-line no-console
		console.log(
			`[KDM-273 audit] sites=${SITES.length} `
			+ `KDGameData writes=${found.gameData.length} (${gdKeys.length} distinct) `
			+ `global writes=${found.globals.length} (${gKeys.length} distinct)`);
		expect(SITES.length).toBeGreaterThan(0);
	});

	it('R5: the scan still finds at least as many writes as when it was written', () => {
		// A LOWER bound. Growth is ordinary upstream churn and is handled by the classification check;
		// a drop means the extraction broke, and a broken extraction reports a false clean.
		expect(found.gameData.length,
			`R5 DRIFT: KDGameData writes fell to ${found.gameData.length} from ${MIN_GAMEDATA_WRITES}. `
			+ 'Either upstream removed writes (raise the bound deliberately) or RE_GAMEDATA stopped matching.')
			.toBeGreaterThanOrEqual(MIN_GAMEDATA_WRITES);
		expect(found.globals.length,
			`R5 DRIFT: global writes fell to ${found.globals.length} from ${MIN_GLOBAL_WRITES}. `
			+ 'Either upstream removed writes (raise the bound deliberately) or RE_GLOBAL stopped matching.')
			.toBeGreaterThanOrEqual(MIN_GLOBAL_WRITES);
	});

	it('R5: the scan finds the keys already known to be world state', () => {
		// A positive control on the extraction. The bounds above prove it found SOMETHING; this proves
		// it found the RIGHT something — the keys three prior bugs already moved to the world lists.
		// If these stop appearing, the regexes are matching noise rather than the writes that matter.
		const all = new Set([...uniq(found.gameData), ...uniq(found.globals)]);
		for (const known of ['KDGameData.LastMapSeed', 'KDGameData.RoomType', 'KDGameData.MapMod',
			'KDGameData.ChestsGenerated', 'KDMapData']) {
			expect(all, `positive control: ${known} is written by a transition site and must be found`)
				.toContain(known);
		}
	});

	it('R3/R4: no transition-written KDGameData key is unclassified', () => {
		const unknown = found.gameData.filter((w) => !isClassified(w.key));
		expect(unknown.map(describeWrite),
			'A floor transition writes these KDGameData keys and nothing records whether they are world '
			+ 'state or per-player. This is the KDM-228 / KDM-265 / KDM-243 pattern arriving again. '
			+ 'Decide each one against the criteria over KDGAMEDATA_WORLD_KEYS in headless-host.js, then '
			+ 'either declare it world or record it in PER_PLAYER_BY_DECISION with a reason.')
			.toEqual([]);
	});

	it('R3/R4: no transition-written global is unclassified', () => {
		const unknown = found.globals.filter((w) => !isClassified(w.key));
		expect(unknown.map(describeWrite),
			'A floor transition writes these globals and nothing records whether they are world state or '
			+ 'per-player. Left per-player by default, each turn\'s restorePlayer installs the acting '
			+ 'player\'s copy over the world\'s. Decide each against the criteria in GLOBAL_BLACKLIST, '
			+ 'then declare it or record it in PER_PLAYER_BY_DECISION with a reason.')
			.toEqual([]);
	});

	it('the register does not rot: every entry is still written by a site', () => {
		// Half one of the two-directional rot check. Without it the register only ever grows, and a
		// register that only grows IS the maintained whitelist this epic exists to delete.
		const written = new Set([...uniq(found.gameData), ...uniq(found.globals)]);
		const orphans = Object.keys(PER_PLAYER_BY_DECISION).filter((k) => !written.has(k));
		expect(orphans,
			'These register entries name keys no transition site writes any more. Upstream has moved on; '
			+ 'delete them rather than carrying a decision about code that is gone.')
			.toEqual([]);
	});

	it('the register does not rot: no entry has since been declared world', () => {
		// Half two. A key in both places is a contradiction: production code says world, the register
		// says deliberately per-player. Whichever is right, they cannot both be.
		const contradictions = Object.keys(PER_PLAYER_BY_DECISION).filter((k) =>
			k.startsWith('KDGameData.')
				? KDGAMEDATA_WORLD_KEYS.includes(k.slice(11))
				: GLOBAL_BLACKLIST.includes(k));
		expect(contradictions,
			'These keys are declared WORLD in production code AND recorded as deliberately per-player in '
			+ 'the register. Remove the register entry — the production list is the source of truth.')
			.toEqual([]);
	});

	it('every register entry carries a reason', () => {
		const bare = Object.entries(PER_PLAYER_BY_DECISION)
			.filter(([, v]) => !v.why || v.why.trim().length < 10)
			.map(([k]) => k);
		expect(bare, 'A register entry without a reason is a silenced failure, not a decision')
			.toEqual([]);
		// Assert the register is non-empty outside the filter, so "no bare entries" cannot be
		// satisfied by an empty register.
		expect(Object.keys(PER_PLAYER_BY_DECISION).length).toBeGreaterThan(20);
	});

	it('MUTATION TEST: the guard actually fails on an unclassified key', () => {
		// A guard that cannot be shown to fail is not evidence. Everything above is an assertion that
		// a list is empty, and an empty list is also what a broken scan produces. This drives the
		// classifier directly with a key that exists nowhere, and proves the verdict is "unclassified".
		const invented = '__KDM273NoSuchKeyEver';
		expect(isClassified(invented),
			'the classifier must reject a key that is in neither list nor the register').toBe(false);
		expect(isClassified(`KDGameData.${invented}`),
			'…and the same for the KDGameData half').toBe(false);

		// The matching positive: a key that IS declared world must be accepted, so the mutation above
		// is not passing merely because `isClassified` answers false to everything.
		expect(isClassified('KinkyDungeonSeed'), 'control: a blacklisted global is classified').toBe(true);
		expect(isClassified('KDGameData.LastMapSeed'), 'control: a world KDGameData key is classified').toBe(true);
		expect(isClassified('KinkyDungeonFastMovePath'), 'control: a register entry is classified').toBe(true);
	});

	it('MUTATION TEST: the extractor really reads the game source', () => {
		// The other way this file could be vacuous: `bodyOf` returning something unrelated to the game.
		// Pin one line of one site by content, not by position.
		const { lines } = bodyOf(SITES.find((s) => s.fn === 'KDInitTempValues')!);
		const joined = lines.join('\n');
		expect(joined,
			'KDInitTempValues must still contain the seed statement this whole task is about')
			.toContain('KDGameData.LastMapSeed = KinkyDungeonSeed');
	});
});
