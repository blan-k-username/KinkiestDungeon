/**
 * Node-layer (Vitest) — guard spec for the co-op turn model (design B).
 *
 * Step 1 of design B: before anything mutes world work inside a non-host player's apply, something
 * has to say WHICH calls are world (run once per round), which are player (run once per player, that
 * is correct), and which are MIXED (both, under one name — the thing that must be split, not muted).
 * `tools/mp-server/turn-classification.js` is that declared table; this spec is the guard that keeps
 * it honest against the live engine, per the turn-model design's own plan step 1: "Parse
 * KinkyDungeonAdvanceTime.toString() and KinkyDungeonUpdateEnemies.toString() ... list every
 * called function ... fail on any not present in one declared classification table."
 *
 * ── WHAT "DISCOVER AT RUNTIME" MEANS HERE ────────────────────────────────────────────────────────
 * Two different things, both done, and kept separate because they answer different questions:
 *
 *  1. CANDIDATE EXTRACTION (still text, but of the LIVE compiled function, not the TS source on
 *     disk): `KinkyDungeonAdvanceTime.toString()` etc are read straight out of the booted headless
 *     world. This is what "parse ... at runtime" in the plan means — it is immune to anything that
 *     happens between `Game/src/**.ts` and the bundle the engine actually runs, which matters because
 *     we never write that tree and it moves under us. It is still necessarily text-derived: knowing
 *     a function CALLS a name is a syntactic fact, not something that can be observed except by
 *     reading the call site.
 *  2. LIVENESS (genuinely runtime): every candidate name is wrapped with a counter and ONE real turn
 *     is driven — a seated player, a hostile enemy, a bullet in flight (cast for real), and an effect
 *     tile underfoot (created for real) — so "effect tiles" and "bullets" are not empty arrays. A
 *     name that is a candidate but never fires in this scenario is reported, not asserted on: some
 *     branches (jail spawns, the Angel tile removal, defeat) need a scenario this spec does not build.
 *     That reporting IS the "note what can't be discovered at runtime" the task asked for.
 *
 * ── THE ONE EXCEPTION, FOUND BY RUNNING THIS SPEC, NOT GUESSED ───────────────────────────────────
 * `KinkyDungeonUpdateEnemies.toString()` cannot be read live: EVERY `HeadlessHost` permanently
 * reassigns it in `boot()` (`_installServerRoleShim`, `headless-host.js:726-742` — an unrelated,
 * pre-existing server/player/world role gate, not the turn-model work), so by the time this spec's
 * world exists the global is already a thin wrapper and `.toString()` returns ITS body, not the
 * engine's. There is no bare host that skips this. So `KinkyDungeonUpdateEnemies`'s candidate set is
 * the one genuinely TEXT-derived extraction here — from `Game/src/enemy/KinkyDungeonEnemies.ts` on
 * disk, same technique `mp-transition-write-audit.spec.ts` uses — while `KinkyDungeonAdvanceTime` and
 * `KinkyDungeonSendEvent` (neither permanently wrapped) are read live, per the plan.
 *
 * R1 (the property that matters): every name EXTRACTED from the three live function bodies — the two
 * audited functions plus `KinkyDungeonSendEvent`'s own dispatch fan-out — must be in the table. This
 * is what turns the guard red when upstream adds or moves a call.
 * R2 (the other direction): every table entry sourced from one of those three bodies must still be
 * found there. A classified name upstream removed is exactly as wrong as an unclassified new one.
 *
 * NAMED_BY_DESIGN_DOC entries (currently just `KinkyDungeonTickBuffs`) are one level deeper than the
 * audited scope — named explicitly by the investigation and by the probe, not by this spec's own
 * extraction — and are therefore exempt from R1/R2; they are listed in the table for the follow-up
 * per-function splitting work, not enforced here.
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HeadlessHost } = require('../../tools/mp-server/headless-host');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TURN_CALL_CLASSIFICATION, TEXT_COUPLED_SITES } = require('../../tools/mp-server/turn-classification');
import * as fs from 'fs';
import * as path from 'path';

const BOOT_TIMEOUT = 240_000;
const GAME_ROOT = path.resolve(__dirname, '../..');

/**
 * Candidate call names out of a live function's own source text. `KD`/`Kinky`-prefixed bare
 * identifiers immediately followed by `(` — the same shape as the manual audit this table was built
 * from (and the extraction `mp-transition-write-audit.spec.ts` already uses for assignments).
 * Excludes the function's own name (self-recursive calls are not "callees").
 */
function extractCalls(src: string, selfName: string): Set<string> {
	const names = new Set<string>();
	const re = /\b((?:KD|Kinky)[A-Za-z0-9_]*)\s*\(/g;
	let m: RegExpExecArray | null;
	// eslint-disable-next-line no-cond-assign
	while ((m = re.exec(src))) {
		if (m[1] !== selfName) names.add(m[1]);
	}
	return names;
}

/** Anti-vacuity: a toString() that came back as a stub/native stand-in would extract ~0 names. */
function assertRealBody(src: string, fnName: string, minLength: number) {
	expect(src.length, `R5 DRIFT: ${fnName}.toString() in the live world is only ${src.length} chars `
		+ `(expected >= ${minLength}). Either the function was replaced with a stub, or toString() did `
		+ 'not return real source — this guard would report a false clean.')
		.toBeGreaterThanOrEqual(minLength);
}

/**
 * The TS-source fallback for `KinkyDungeonUpdateEnemies` (see header: it is permanently wrapped by
 * every `HeadlessHost`, so `.toString()` never returns the engine body). Same crude-but-safe shape as
 * `mp-transition-write-audit.spec.ts`'s `bodyOf()`: from `function <name>` to the next line that is
 * exactly `}` at column 0. R5-checked here by the caller via `assertRealBody` on the returned text.
 */
function bodySourceOf(file: string, fnName: string): string {
	const abs = path.join(GAME_ROOT, file);
	const src = fs.readFileSync(abs, 'utf8').split('\n');
	const re = new RegExp(String.raw`^function\s+${fnName}\s*\(`);
	const start = src.findIndex((l) => re.test(l));
	expect(start, `R5 DRIFT: expected exactly one top-level \`function ${fnName}\` in ${file}; found none. `
		+ 'Upstream has renamed or moved it.').toBeGreaterThanOrEqual(0);
	let end = src.length - 1;
	for (let i = start + 1; i < src.length; i++) {
		if (/^\}\s*$/.test(src[i])) { end = i; break; }
	}
	return src.slice(start, end + 1).join('\n');
}

let h: any;
let bodies: { advanceTime: string; updateEnemies: string; sendEvent: string };
let candidates: { advanceTime: Set<string>; updateEnemies: Set<string>; sendEvent: Set<string> };
let liveCounts: Record<string, number>;

beforeAll(() => {
	// Deliberately a bare HeadlessHost, NOT a SwapSession: SwapSession's `ready()` calls
	// `installTurnModel()` (the turn-model implementation task, running concurrently), which
	// reassigns KinkyDungeonAdvanceTime/KinkyDungeonUpdateEnemies/KinkyDungeonTickBuffs to thin
	// cooperative wrappers — real engine behaviour, but `.toString()` on them would return the
	// WRAPPER's own few-hundred-char body, not the engine source this spec needs to read. A bare
	// host never calls it, so these names stay the pristine compiled functions.
	h = new HeadlessHost({ id: 'turn-audit' });
	h.boot();
	h.init({ seed: 'turn-audit-seed' });
	h.setServerMode('world');
	const t = h.findOpenTile();
	h.placePlayer(t.x, t.y);
	h.eval('KinkyDungeonStatManaMax = 100; KinkyDungeonStatMana = 100;');

	// Populate the floor: a real hostile enemy, a real bullet in flight (cast, not hand-built, so
	// its shape is whatever KinkyDungeonCastSpell really produces), and a real effect tile underfoot.
	const p = h.getPlayerPos();
	const enemy = h.summonEnemy(p.x + 2, p.y, 'NawashiZombie', { rad: 4 });
	expect(enemy, 'setup: a hostile enemy exists').toBeTruthy();
	h.eval(`(function(){
		var e = KDMapData.Entities.find(function(x){ return x.id === ${enemy.id}; });
		if (e) { e.aware = true; e.hostile = 9999; }
	})()`);
	h.eval(`(function(){ KDCreateEffectTile(${p.x | 0}, ${p.y | 0}, { name: "Ice" }, 0); })()`);
	h.applyInput('tryCastSpell', { tx: enemy.x, ty: enemy.y, spellname: 'Firecracker', player: { __kdEnt: 'player' } });

	// Extract candidates from the LIVE compiled bodies (AdvanceTime, SendEvent — neither is
	// permanently wrapped) plus the TS-source fallback for UpdateEnemies (see header exception).
	const live = h.eval(`(function(){
		return {
			advanceTime: KinkyDungeonAdvanceTime.toString(),
			sendEvent: KinkyDungeonSendEvent.toString(),
		};
	})()`);
	bodies = {
		advanceTime: live.advanceTime,
		sendEvent: live.sendEvent,
		updateEnemies: bodySourceOf('Game/src/enemy/KinkyDungeonEnemies.ts', 'KinkyDungeonUpdateEnemies'),
	};
	assertRealBody(bodies.advanceTime, 'KinkyDungeonAdvanceTime (live)', 2000);
	assertRealBody(bodies.sendEvent, 'KinkyDungeonSendEvent (live)', 200);
	assertRealBody(bodies.updateEnemies, 'KinkyDungeonUpdateEnemies (Game/src fallback)', 4000);
	candidates = {
		advanceTime: extractCalls(bodies.advanceTime, 'KinkyDungeonAdvanceTime'),
		updateEnemies: extractCalls(bodies.updateEnemies, 'KinkyDungeonUpdateEnemies'),
		sendEvent: extractCalls(bodies.sendEvent, 'KinkyDungeonSendEvent'),
	};

	// LIVENESS: wrap every candidate name (across all three sets) with a counter, then drive one
	// real turn. Sentinel-guarded and test-local, like the investigation probe's own wrappers.
	const allCandidates = [...new Set([
		...candidates.advanceTime, ...candidates.updateEnemies, ...candidates.sendEvent,
	])];
	h.eval(`(function(){
		if (globalThis.__kdAuditInstalled) return true;
		globalThis.__kdAuditInstalled = true;
		globalThis.__kdAuditCounts = {};
		function bump(k){ var C = globalThis.__kdAuditCounts; C[k] = (C[k] || 0) + 1; }
		${JSON.stringify(allCandidates)}.forEach(function(name){
			if (typeof eval(name) !== 'function') return; // a few candidates are non-function (rare false match)
			var prev = eval(name);
			var wrapped = function(){ bump(name); return prev.apply(this, arguments); };
			eval(name + ' = wrapped;');
		});
		return true;
	})()`);
	h.eval('globalThis.__kdAuditCounts = {};');
	h.step(1);
	liveCounts = h.eval('globalThis.__kdAuditCounts') || {};
}, BOOT_TIMEOUT);

/** A name is classified if the register records it (any of the three verdicts). */
function isClassified(name: string): boolean {
	return !!TURN_CALL_CLASSIFICATION[name];
}

function describeMissing(names: string[]): string[] {
	return names.map((n) => {
		const live = liveCounts[n] | 0;
		return `${n} (${live > 0 ? `fired ${live}x in the probe turn` : 'candidate only — not observed live in this scenario'})`;
	});
}

describe('turn-model call audit — every direct callee of AdvanceTime/UpdateEnemies/SendEvent is classified', () => {
	it('reports the scan (drift is visible, not inferred)', () => {
		// eslint-disable-next-line no-console
		console.log('[turn-audit] candidates', JSON.stringify({
			advanceTime: candidates.advanceTime.size,
			updateEnemies: candidates.updateEnemies.size,
			sendEvent: candidates.sendEvent.size,
		}));
		const textOnly = [...new Set([...candidates.advanceTime, ...candidates.updateEnemies, ...candidates.sendEvent])]
			.filter((n) => !(liveCounts[n] > 0));
		// eslint-disable-next-line no-console
		console.log('[turn-audit] text-derived only (not confirmed live in this scenario):', JSON.stringify(textOnly));
		expect(candidates.advanceTime.size).toBeGreaterThan(0);
	});

	it('R1: no call KinkyDungeonAdvanceTime makes is unclassified', () => {
		const unknown = [...candidates.advanceTime].filter((n) => !isClassified(n));
		expect(describeMissing(unknown),
			'KinkyDungeonAdvanceTime calls these and nothing records whether they are world, player or '
			+ 'mixed. Classify each in tools/mp-server/turn-classification.js (ADVANCE_TIME) against the '
			+ 'criteria in that file\'s header.')
			.toEqual([]);
	});

	it('R1: no call KinkyDungeonUpdateEnemies makes is unclassified', () => {
		const unknown = [...candidates.updateEnemies].filter((n) => !isClassified(n));
		expect(describeMissing(unknown),
			'KinkyDungeonUpdateEnemies calls these and nothing records whether they are world, player or '
			+ 'mixed. Classify each in tools/mp-server/turn-classification.js (UPDATE_ENEMIES) — the default '
			+ 'for a per-enemy helper is world (criterion a); override it if the call touches the player slot.')
			.toEqual([]);
	});

	it('R1: no event-dispatch call KinkyDungeonSendEvent makes is unclassified', () => {
		const unknown = [...candidates.sendEvent].filter((n) => !isClassified(n));
		expect(describeMissing(unknown),
			'KinkyDungeonSendEvent fans out to these and nothing records whether each dispatcher is world, '
			+ 'player or mixed. Classify in tools/mp-server/turn-classification.js (EVENT_DISPATCH).')
			.toEqual([]);
	});

	it('R2: no ADVANCE_TIME-sourced entry has drifted out of KinkyDungeonAdvanceTime', () => {
		const { ADVANCE_TIME } = requireSections();
		const orphans = Object.keys(ADVANCE_TIME).filter((k) => !candidates.advanceTime.has(k));
		expect(orphans,
			'These names are classified as direct callees of KinkyDungeonAdvanceTime but the live function '
			+ 'no longer calls them (upstream moved or removed the call). Delete or re-home the entry.')
			.toEqual([]);
	});

	it('R2: no UPDATE_ENEMIES-sourced entry has drifted out of KinkyDungeonUpdateEnemies', () => {
		const { UPDATE_ENEMIES } = requireSections();
		const orphans = Object.keys(UPDATE_ENEMIES).filter((k) => !candidates.updateEnemies.has(k));
		expect(orphans,
			'These names are classified as direct callees of KinkyDungeonUpdateEnemies but the live function '
			+ 'no longer calls them (upstream moved or removed the call). Delete or re-home the entry.')
			.toEqual([]);
	});

	it('R2: no EVENT_DISPATCH-sourced entry has drifted out of KinkyDungeonSendEvent', () => {
		const { EVENT_DISPATCH } = requireSections();
		const orphans = Object.keys(EVENT_DISPATCH).filter((k) => !candidates.sendEvent.has(k));
		expect(orphans,
			'These names are classified as dispatchers KinkyDungeonSendEvent fans out to, but the live '
			+ 'function no longer calls them. Delete or re-home the entry.')
			.toEqual([]);
	});

	it('LIVENESS: the wrap-and-drive mechanism really observes a populated turn', () => {
		// Anti-vacuity for the liveness half: these five are expected to fire given the scenario this
		// spec builds (a hostile enemy, a cast bullet, an effect tile underfoot). If any read 0, either
		// the scenario stopped doing what its name says, or the wrapper mechanism is broken.
		expect(liveCounts.KinkyDungeonItemCheck, 'control: player-local work runs every turn').toBeGreaterThan(0);
		expect(liveCounts.KinkyDungeonUpdateEnemies, 'control: the world enemy pass runs every turn').toBeGreaterThan(0);
		expect(liveCounts.KinkyDungeonSendEvent, 'control: the tick event fires every turn').toBeGreaterThan(0);
		expect(liveCounts.KDUpdateEffectTiles, 'the Ice tile this spec created makes this fire').toBeGreaterThan(0);
		expect(liveCounts.KinkyDungeonUpdateBullets, 'the Firecracker bullet this spec cast makes this fire').toBeGreaterThan(0);
	});

	it('every register entry has a verdict and a reason with a Game/src citation', () => {
		const bad = Object.entries(TURN_CALL_CLASSIFICATION).filter(([, v]: [string, any]) =>
			!['world', 'player', 'mixed', 'split'].includes(v.verdict)
			|| !v.why || v.why.length < 20
			|| !/Game\/src\//.test(v.why));
		expect(bad.map(([k]) => k),
			'a register entry must have verdict world|player|mixed|split and a reason citing Game/src/**')
			.toEqual([]);
		expect(Object.keys(TURN_CALL_CLASSIFICATION).length).toBeGreaterThan(50);
	});

	it('MUTATION TEST: the classifier really rejects an unclassified name', () => {
		const invented = '__TurnAuditNoSuchCallEver';
		expect(isClassified(invented), 'an invented name must read as unclassified').toBe(false);
		// Matching positive, so the mutation above is not passing because isClassified rejects everything.
		expect(isClassified('KinkyDungeonItemCheck'), 'control: a real classified name is accepted').toBe(true);
	});

	it('MUTATION TEST: extraction really reads the live engine, not a fixture', () => {
		expect(bodies.advanceTime, 'the live AdvanceTime body must still contain its own clock increment')
			.toContain('KinkyDungeonCurrentTick += delta');
		expect(bodies.updateEnemies, 'the live UpdateEnemies body must still call its target-choice hook')
			.toContain('KinkyDungeonNearestPlayer(');
	});

	it('MIXED functions — the per-function splitting work\'s input list (reported, not just asserted non-empty)', () => {
		const mixed = Object.entries(TURN_CALL_CLASSIFICATION)
			.filter(([, v]: [string, any]) => v.verdict === 'mixed')
			.map(([k, v]: [string, any]) => `${k} :: ${v.why}`);
		// eslint-disable-next-line no-console
		console.log(`[turn-audit] MIXED (${mixed.length}):\n` + mixed.map((m) => '  - ' + m).join('\n'));
		expect(mixed.length, 'the mixed bucket must be non-empty, or this whole audit found nothing to split')
			.toBeGreaterThan(5);
	});
});

describe('text-coupled sites — pinned by exact match count', () => {
	for (const [key, site] of Object.entries(TEXT_COUPLED_SITES) as [string, any][]) {
		it(`${key}: "${site.pattern.slice(0, 40)}…" appears exactly ${site.expectedCount}x in ${site.file}`, () => {
			const src = fs.readFileSync(path.join(GAME_ROOT, site.file), 'utf8');
			const count = src.split(site.pattern).length - 1;
			expect(count,
				`R5 DRIFT: expected "${site.pattern}" exactly ${site.expectedCount}x in ${site.file}, found `
				+ `${count}. ${site.why}`)
				.toBe(site.expectedCount);
		});
	}
});

/** The module's sub-tables, for this spec's own R2 provenance checks (test-only accessor). */
function requireSections() {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const mod = require('../../tools/mp-server/turn-classification');
	return mod.__sections();
}
