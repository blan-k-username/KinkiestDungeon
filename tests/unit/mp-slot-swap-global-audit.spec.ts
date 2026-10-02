/**
 * Node-layer (Vitest) — class guard for the co-op turn model's per-enemy slot switch clobbering a
 * global it should not.
 *
 * THE CLASS OF BUG. Inside the round's one real engine tick, the per-enemy slot switch
 * (`swap-session.js` `_slotSwapTo`, armed by `headless-host.js`'s `installTurnModel`/`armSlotSwitch`)
 * moves the player slot between joined humans MID-PASS, as each real enemy decides its target.
 * `_slotSwapTo` captures the OUTGOING human's bundle (`HeadlessHost.capturePlayer`) and restores the
 * INCOMING human's bundle (`HeadlessHost.restorePlayer`) — and restore overwrites every watched global
 * NOT in `GLOBAL_BLACKLIST` with that incoming human's STALE, pre-round value. Any global the pass
 * writes earlier in the SAME pass, that is not protected, is silently clobbered the next time the
 * slot moves. This happened twice already, each found by luck while testing something else:
 * `__kdWorldMuted` (the round's own clock-mute flag) and `KDCustomDefeat`/`KDCustomDefeatEnemy` (an
 * engine-triggered defeat, dropped entirely). This spec makes it a standing guard instead of a thing
 * found by luck a third time.
 *
 * MECHANISM. A real 2-player round is driven with several real enemies engaged with BOTH players
 * (one grabbing/binding enemy per player, by adjacency — `NawashiZombie`, the same enemy type
 * `mp-enemy-ai-once-per-round.spec.ts` and `mp-turn-world-player-audit.spec.ts` already use for real
 * bind attempts), a bullet in flight (a real `tryCastSpell` dispatch, not hand-built — the exact
 * recipe `mp-turn-world-player-audit.spec.ts` and `mp-spell-cast.spec.ts` use), a real effect tile
 * underfoot (`KDCreateEffectTile`), and a forced engine-triggered defeat (the same
 * `KinkyDungeonEnemyLoop`-wrap one-shot technique `mp-defeat-routing.spec.ts` uses — every other
 * field stays exactly what the real engine computed). `_slotSwapTo` and `applyInputObserved` are
 * wrapped (test-local, not product code) to snapshot every WATCHED global (`HeadlessHost._watchNames`
 * — the same list `_restoreGlobals` itself walks on every restore, so this audits the actual risk
 * surface, not a guess at it) and every `KDGameData` key, hashed, at each swap boundary; a changed
 * hash between two consecutive boundaries is a WRITE this spec attributes to the pass.
 *
 * CLASSIFICATION. Every name this scenario observes written must appear in
 * `turn-classification.js`'s new `SLOT_SWAP_GLOBALS` / `SLOT_SWAP_GAMEDATA_KEYS` registers, as either
 *   - `per-player`  — correctly follows the human: captured on swap-out, restored on swap-in, or
 *   - `pass-world`  — must survive the swap: protected by actually being in `GLOBAL_BLACKLIST` (for a
 *                     bare global) or `KDGAMEDATA_RESTORE_SKIP_KEYS` (for a `KDGameData` key — the
 *                     set `restorePlayer` itself skips, which is `KDGAMEDATA_WORLD_KEYS` — genuinely
 *                     cross-player shared state — PLUS `KDGAMEDATA_PASS_SCOPED_KEYS` — reset every
 *                     real pass, so not genuinely shared, but still needing mid-pass protection).
 * A `pass-world` entry that is NOT actually protected is exactly the clobber class above — this is
 * checked independently of whether this scenario happens to observe the name written, so the guard
 * does not depend on timing luck.
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GLOBAL_BLACKLIST, KDGAMEDATA_RESTORE_SKIP_KEYS } = require('../../tools/mp-server/headless-host');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SLOT_SWAP_GLOBALS, SLOT_SWAP_GAMEDATA_KEYS } = require('../../tools/mp-server/turn-classification');
import { freeNeighbour } from '../helpers/session-tiles';

const BOOT_TIMEOUT = 240_000;

/** A free tile at least `min` (Chebyshev) steps from `from` — found, never assumed. */
function farTile(s: any, from: { x: number, y: number }, min: number) {
	return s.world.eval(`(function(){
		for (var r = ${min | 0}; r < ${min | 0} + 30; r++)
			for (var dx = -r; dx <= r; dx++) for (var dy = -r; dy <= r; dy++) {
				if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
				var x = ${from.x | 0} + dx, y = ${from.y | 0} + dy;
				if (x <= 0 || y <= 0 || x >= KDMapData.GridWidth || y >= KDMapData.GridHeight) continue;
				if (KinkyDungeonMovableTilesEnemy.includes(KinkyDungeonMapGet(x, y)) && !KinkyDungeonEntityAt(x, y)) return { x: x, y: y };
			}
		return null;
	})()`);
}

/** Move a joined player's authoritative position (bundle + avatar) to (x,y) directly. */
function moveClientTo(s: any, cid: string, x: number, y: number) {
	s.world.restorePlayer(s.bundles.get(cid));
	s.world.eval(`(function(){ KinkyDungeonPlayerEntity.x = ${x | 0}; KinkyDungeonPlayerEntity.y = ${y | 0}; })()`);
	s.bundles.set(cid, s.world.capturePlayer());
	s.world.moveAvatar(s.avatars.get(cid), x, y);
}

/** Place a REAL shared enemy (by id) on a free tile beside `cid`, so "nearest" engagement picks them. */
function placeEnemyBeside(s: any, enemyId: number, cid: string) {
	const nb = freeNeighbour(s, cid);
	if (!nb) throw new Error(`setup invalid: no free tile beside ${cid}`);
	s.world.moveAvatar(enemyId, nb.x, nb.y);
}

/** Arm a real enemy to act for real this round: aware, maximally hostile. */
function armEnemy(s: any, enemyId: number) {
	s.world.eval(`(function(){
		var e = KDMapData.Entities.find(function(x){ return x.id === ${enemyId}; });
		if (e) { e.aware = true; e.hostile = 9999; KDUpdateEnemyCache = true; }
	})()`);
}

/** Second real enemy near (x,y) — direct KinkyDungeonSummonEnemy (see mp-defeat-routing.spec.ts header
 * comment for why HeadlessHost.summonEnemy's convenience wrapper is the wrong tool for a mid-test spawn). */
function summonSecondEnemy(s: any, x: number, y: number, type: string): number {
	const id = s.world.eval(`(function(){
		var created = KinkyDungeonSummonEnemy(${x | 0}, ${y | 0}, ${JSON.stringify(type)}, 1, 6,
			false, undefined, false, false, "Beast", true, 1, true, true, undefined, false);
		return created.length ? created[0].id : null;
	})()`);
	if (id == null) throw new Error(`setup invalid: could not summon a second ${type} near (${x},${y})`);
	return id;
}

/**
 * Force exactly ONE enemy's next real `KinkyDungeonEnemyLoop` call to report a defeat, without
 * changing anything else that call computes — same one-shot technique `mp-defeat-routing.spec.ts`
 * uses, duplicated here (test-local, not product code) rather than imported: that file does not
 * export it.
 */
function armForcedDefeat(s: any, enemyId: number) {
	s.world.eval(`(function(){
		if (!globalThis.__kdForceDefeatWrapped) {
			var _prev = KinkyDungeonEnemyLoop;
			KinkyDungeonEnemyLoop = function(enemy){
				var ret = _prev.apply(this, arguments);
				if (enemy && enemy.id === globalThis.__kdForceDefeatEnemyId) {
					globalThis.__kdForceDefeatEnemyId = null;
					return Object.assign({}, ret, { defeat: true, defeatEnemy: enemy });
				}
				return ret;
			};
			globalThis.__kdForceDefeatWrapped = true;
		}
		globalThis.__kdForceDefeatEnemyId = ${enemyId};
		return true;
	})()`);
}

/** Stub `KDRunRegularJailDefeatAttempt` to succeed immediately — room selection is not under test. */
function stubJailRoomSelection(s: any) {
	s.world.eval(`(function(){
		if (globalThis.__kdStubJailAttempt) return true;
		KDRunRegularJailDefeatAttempt = function(){ return true; };
		globalThis.__kdStubJailAttempt = true;
		return true;
	})()`);
}

/** The watched-global list `_restoreGlobals` itself walks on every restore — the actual risk surface. */
function watchedNames(s: any): string[] {
	if (!s.world._watchNames) s.world._captureBaseline();
	return s.world._watchNames as string[];
}

const HASH_FN = 'function __auditHash(str){ var x = 5381, i = str.length; '
	+ 'while (i) { x = (x * 33) ^ str.charCodeAt(--i); } return x >>> 0; }';

/** Hash every watched global's current serialised value, by name. Unserialisable/undefined skipped. */
function snapshotGlobals(s: any, names: string[]): Record<string, number> {
	return s.world.eval(`(function(){
		${HASH_FN}
		var names = ${JSON.stringify(names)};
		var out = {};
		for (var i = 0; i < names.length; i++) {
			var n = names[i], v;
			try { v = eval(n); } catch (e) { continue; }
			if (v === undefined || typeof v === 'function') continue;
			try { var str = JSON.stringify(v); if (str === undefined) continue; out[n] = __auditHash(str); }
			catch (e) { continue; }
		}
		return out;
	})()`);
}

/** Hash every KDGameData key's current serialised value, by key. */
function snapshotGameData(s: any): Record<string, number> {
	return s.world.eval(`(function(){
		${HASH_FN}
		var out = {};
		if (typeof KDGameData === 'undefined') return out;
		for (var k in KDGameData) {
			if (!Object.prototype.hasOwnProperty.call(KDGameData, k)) continue;
			var v = KDGameData[k];
			if (v === undefined || typeof v === 'function') continue;
			try { var str = JSON.stringify(v); if (str === undefined) continue; out[k] = __auditHash(str); }
			catch (e) { continue; }
		}
		return out;
	})()`);
}

function diffKeys(prev: Record<string, number>, curr: Record<string, number>): string[] {
	const out = new Set<string>();
	for (const k of Object.keys(curr)) if (prev[k] !== curr[k]) out.add(k);
	for (const k of Object.keys(prev)) if (!(k in curr)) out.add(k);
	return [...out];
}

/**
 * Install the audit: wraps `_slotSwapTo` (the mid-pass per-enemy engine switch) and
 * `applyInputObserved` (the per-player apply boundary, including the round's one real/unmuted apply)
 * so every real swap boundary diffs a before/after snapshot of every watched global AND every
 * `KDGameData` key against the snapshot taken at the PREVIOUS boundary, and unions the changed names
 * into a running report. Test-local monkeypatching of instance methods — never touches the class or
 * any other session's instance.
 */
function installGlobalWriteAudit(s: any) {
	const names = watchedNames(s);
	const globalsWritten = new Set<string>();
	const gameDataWritten = new Set<string>();
	let prevG = snapshotGlobals(s, names);
	let prevD = snapshotGameData(s);
	const flush = () => {
		const currG = snapshotGlobals(s, names);
		const currD = snapshotGameData(s);
		diffKeys(prevG, currG).forEach((n) => globalsWritten.add(n));
		diffKeys(prevD, currD).forEach((n) => gameDataWritten.add(n));
		prevG = currG;
		prevD = currD;
	};
	const origSwap = s._slotSwapTo.bind(s);
	// eslint-disable-next-line no-param-reassign
	s._slotSwapTo = (targetId: string) => { flush(); origSwap(targetId); flush(); };
	const origApply = s.world.applyInputObserved.bind(s.world);
	// eslint-disable-next-line no-param-reassign
	s.world.applyInputObserved = (kdType: string, data: any) => {
		flush();
		const r = origApply(kdType, data);
		flush();
		return r;
	};
	return { globalsWritten, gameDataWritten };
}

/** Build the real 2-player scenario: enemies engaged with both players, a bullet, an effect tile, a
 * forced defeat — then run exactly one round and return everything the pass wrote. */
async function runAuditedRound() {
	const s = new SwapSession({ requiredPlayers: 2, seed: 'slot-swap-global-audit', enemyType: 'NawashiZombie' });
	s.join('A'); s.join('B');
	await s.ready();
	expect(s.enemyId, 'setup: the shared enemy exists').not.toBeNull();

	// B applies first (non-host, muted); A applies last (host, drives the one real tick) — so the
	// host's own engaged enemy is processed AFTER B's, which is what makes a mid-pass swap happen at
	// all (same shuffle shape mp-defeat-routing.spec.ts uses).
	s._shuffle = () => ['B', 'A'];

	const far = farTile(s, s.posOf('B'), 12);
	expect(far, 'setup: a tile far from B').not.toBeNull();
	moveClientTo(s, 'A', far.x, far.y);
	// Mana for A's cast, set AFTER the move (which already re-captured A's bundle) so it survives.
	s.world.eval('KinkyDungeonStatManaMax = 100; KinkyDungeonStatMana = 100;');
	s.bundles.set('A', s.world.capturePlayer());

	// Enemy engaged with B — grabs/binds for real.
	placeEnemyBeside(s, s.enemyId, 'B');
	armEnemy(s, s.enemyId);

	// A second enemy engaged with A (the host) — processed in the LAST group, the one that pulls the
	// slot away from B and is where a clobber of an earlier group's write would show up.
	const enemy2 = summonSecondEnemy(s, s.posOf('A').x, s.posOf('A').y, 'NawashiZombie');
	placeEnemyBeside(s, enemy2, 'A');
	armEnemy(s, enemy2);

	// A third enemy, engaged with B, forced to report an engine-triggered defeat.
	const enemy3 = summonSecondEnemy(s, s.posOf('B').x, s.posOf('B').y, 'Rat');
	placeEnemyBeside(s, enemy3, 'B');
	armEnemy(s, enemy3);
	armForcedDefeat(s, enemy3);
	stubJailRoomSelection(s);

	// A real effect tile underfoot.
	const posB = s.posOf('B');
	s.world.eval(`(function(){ KDCreateEffectTile(${posB.x | 0}, ${posB.y | 0}, { name: "Ice", duration: 10 }, 0); })()`);

	const audit = installGlobalWriteAudit(s);

	s.submit('B', { kind: 'wait' });
	// A's own action is a real spell cast — a real bullet in flight during the same real pass that
	// runs the per-enemy slot switch.
	const posEnemy1 = s.enemyView();
	s.submit('A', {
		kdType: 'tryCastSpell',
		data: { tx: posEnemy1 ? posEnemy1.x : posB.x, ty: posEnemy1 ? posEnemy1.y : posB.y, spellname: 'Firecracker', player: { __kdEnt: 'player' } },
	});

	return { s, ...audit };
}

describe('slot-swap global write audit (class guard for the __kdWorldMuted / KDCustomDefeat clobber class)', () => {
	it('liveness: the real pass actually writes globals and KDGameData keys in this scenario', async () => {
		const { globalsWritten, gameDataWritten } = await runAuditedRound();
		expect(globalsWritten.size, 'control: a real multi-enemy, multi-swap pass must write at least one global '
			+ '— zero would mean the audit probe itself is not seeing anything, not that the pass is clean')
			.toBeGreaterThan(0);
		expect(gameDataWritten.size, 'control: KDGameData must receive at least one write this round')
			.toBeGreaterThan(0);
	}, BOOT_TIMEOUT);

	it('every global the pass writes mid-pass is classified (per-player or pass-world)', async () => {
		const { globalsWritten } = await runAuditedRound();
		const unclassified = [...globalsWritten].filter((n) => !(n in SLOT_SWAP_GLOBALS));
		expect(unclassified, 'unclassified global(s) written by the enemy pass — add each to '
			+ 'SLOT_SWAP_GLOBALS in turn-classification.js as per-player or pass-world: '
			+ unclassified.join(', ')).toEqual([]);
	}, BOOT_TIMEOUT);

	it('every KDGameData key the pass writes mid-pass is classified (per-player or pass-world)', async () => {
		const { gameDataWritten } = await runAuditedRound();
		const unclassified = [...gameDataWritten].filter((k) => !(k in SLOT_SWAP_GAMEDATA_KEYS));
		expect(unclassified, 'unclassified KDGameData key(s) written by the enemy pass — add each to '
			+ 'SLOT_SWAP_GAMEDATA_KEYS in turn-classification.js as per-player or pass-world: '
			+ unclassified.join(', ')).toEqual([]);
	}, BOOT_TIMEOUT);

	it('every pass-world global is actually protected from bundle restore (in GLOBAL_BLACKLIST)', () => {
		const unprotected = Object.entries(SLOT_SWAP_GLOBALS)
			.filter(([, c]: any) => c.verdict === 'pass-world')
			.map(([name]) => name)
			.filter((name) => !GLOBAL_BLACKLIST.includes(name));
		expect(unprotected, 'classified pass-world but NOT in GLOBAL_BLACKLIST — a mid-pass swap WILL '
			+ 'clobber this with a stale per-player value (exactly the __kdWorldMuted / KDCustomDefeat '
			+ `clobber class): ${unprotected.join(', ')}`).toEqual([]);
	});

	it('every pass-world KDGameData key is actually protected (in KDGAMEDATA_RESTORE_SKIP_KEYS)', () => {
		const unprotected = Object.entries(SLOT_SWAP_GAMEDATA_KEYS)
			.filter(([, c]: any) => c.verdict === 'pass-world')
			.map(([key]) => key)
			.filter((key) => !KDGAMEDATA_RESTORE_SKIP_KEYS.includes(key));
		expect(unprotected, 'classified pass-world but NOT in KDGAMEDATA_RESTORE_SKIP_KEYS — restorePlayer '
			+ `restores it from whoever's bundle is swapped in: ${unprotected.join(', ')}`).toEqual([]);
	});

	it('every classified name still exists as a real, live global (not stale)', async () => {
		const s = new SwapSession({ requiredPlayers: 1, seed: 'slot-swap-global-audit-liveness' });
		s.join('A');
		await s.ready();
		const names = Object.keys(SLOT_SWAP_GLOBALS);
		const missing = s.world.eval(`(function(){
			var names = ${JSON.stringify(names)};
			var out = [];
			for (var i = 0; i < names.length; i++) { if (eval('typeof ' + names[i]) === 'undefined') out.push(names[i]); }
			return out;
		})()`);
		expect(missing, `classified global(s) no longer exist in the live engine — stale entries: ${missing.join(', ')}`)
			.toEqual([]);
	}, BOOT_TIMEOUT);

	it('every classified KDGameData key still exists on a real, live KDGameData (not stale)', async () => {
		const s = new SwapSession({ requiredPlayers: 1, seed: 'slot-swap-gamedata-liveness' });
		s.join('A');
		await s.ready();
		const keys = Object.keys(SLOT_SWAP_GAMEDATA_KEYS);
		const missing = s.world.eval(`(function(){
			var keys = ${JSON.stringify(keys)};
			var out = [];
			for (var i = 0; i < keys.length; i++) { if (!(keys[i] in KDGameData)) out.push(keys[i]); }
			return out;
		})()`);
		expect(missing, `classified KDGameData key(s) no longer exist on the live KDGameData — stale entries: ${missing.join(', ')}`)
			.toEqual([]);
	}, BOOT_TIMEOUT);
});
