/**
 * Node-layer (Vitest) — KDM-244: leave co-op and continue the run alone (MP → SP).
 *
 * The mirror of KDM-243. There the host brought a world IN; here the host takes it back OUT, as a
 * save the stock game can open. Three layers, same split as the import:
 *
 *   the world   `HeadlessHost.exportSave(excludeIds)` — KD's own generator, driven headless (R2, R5)
 *   the party   `SwapSession.exportRun(hostId)` — the right player, and the world put back (R4, R10)
 *   the wire    the export reaches the HOST and nobody else (R1, R11)
 *
 * ── THE ONE FINDING THIS SPEC EXISTS TO PIN ───────────────────────────────────────────────────────
 * An export that leaves the peer avatars in `KDMapData.Entities` **does not load at all**. It is not
 * untidy — it is unopenable. `KDUnPackEnemies` re-resolves every entity's def BY NAME
 * (`KinkyDungeonGame.ts:734-739`), the `RemotePlayer_<name>` defs are created at runtime and are not
 * in the save, so a fresh world resolves them to `undefined` — and the next reader,
 * `KinkyDungeonVision.ts:158`, has its parentheses in the wrong place:
 *
 *     if (Enemy && Enemy.blockVision || (Enemy.blockVisionWhileStationary && …))
 *
 * `&&` binds tighter than `||`, so an undefined `Enemy` falls through to the second term and is
 * dereferenced. (The sibling at `:353` is parenthesised correctly.) That is an UPSTREAM bug; the
 * strip is our workaround. `R5 strips the avatars` and `R7 the save loads` are therefore the SAME
 * requirement seen twice, and test 6 below pins the failure mode explicitly so a future
 * "simplification" that drops the strip fails loudly instead of shipping unopenable saves.
 *
 * ── WHY THE CONTROLS ARE NOT DECORATION ───────────────────────────────────────────────────────────
 * Every assertion here is an ABSENCE ("no avatar in the save", "the world did not change", "no
 * dangling bondage record") and every absence oracle goes green on a fixture that never had the
 * thing. So each one is paired with a same-shape control taken BEFORE the export, using the
 * identical query. The POC earned this the hard way: its first round went 7/7 on the first attempt,
 * and two of those passes turned out to be unfalsifiable.
 *
 * NOTE: these import the harness under tools/mp-server/** (test/tooling code), never Game/src/**.
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HeadlessHost } = require('../../tools/mp-server/headless-host');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT = 240_000;

/**
 * The world fingerprint R10 is measured on.
 *
 * `enemyId` and `pathable` are in here deliberately, and they are the two fields most likely to be
 * dropped by someone tidying this later. They are exactly what the REJECTED design would have moved:
 * despawning the avatars from the live world and re-spawning them afterwards allocates fresh entity
 * ids (`KinkyDungeonGetEnemyID`), and `KinkyDungeonGenerateSaveData` itself blanks and rebuilds
 * `RandomPathablePoints` (`KinkyDungeon.ts:7002-7005`). A fingerprint without them would call that
 * design read-only.
 */
const FP = `({
	seed: KinkyDungeonSeed, level: MiniGameKinkyDungeonLevel,
	room: KDGameData.RoomType || '', gridHash: KDMapData.Grid.slice(0, 120),
	ents: KDMapData.Entities.length,
	entIds: KDMapData.Entities.map(function (e) {
		return e.id + ':' + (e.Enemy && e.Enemy.name) + '@' + e.x + ',' + e.y;
	}).sort(),
	px: KinkyDungeonPlayerEntity.x, py: KinkyDungeonPlayerEntity.y,
	gold: KinkyDungeonGold, tick: KinkyDungeonCurrentTick,
	enemyId: KinkyDungeonEnemyID,
	pathable: Object.keys(KDMapData.RandomPathablePoints || {}).length
})`;

/** How many peer-avatar entities a world (or a decoded save) is carrying. */
const REMOTE = (ents: any[]) => ents.filter(
	(e: any) => String((e.Enemy && e.Enemy.name) || '').startsWith('RemotePlayer')).length;

/** Decode an exported save string back to the object, using the world's own LZString. */
function decode(world: any, str: string): any {
	world._context.__KD_SAVE_CHK = String(str || '');
	return world.eval('JSON.parse(DecompressB64(String(globalThis.__KD_SAVE_CHK).trim()))');
}

/** Load a save into a FRESH world and report what arrived. */
function loadInto(world: any, str: string, id: string): any {
	const dst = new HeadlessHost({ id });
	dst.boot();
	dst.init({ seed: id + '-deliberately-elsewhere' });
	const pre = dst.eval(FP);
	const res = dst.loadSave(str);
	return {
		pre,
		ok: !!(res && res.ok),
		err: (res && res.err) || null,
		fp: dst.eval(FP),
		remote: dst.eval(`KDMapData.Entities.filter(function(e){
			return e.Enemy && String(e.Enemy.name || '').indexOf('RemotePlayer') === 0; }).length`),
		// LAZY on purpose. Stepping a world whose load FAILED throws out of `KDUnPackEnemy`, and an
		// eager call here would let that throw escape before the caller could assert `ok === false` —
		// turning "the un-stripped save is refused" into an unhandled error in the helper.
		turns: (n: number) => { dst.step(n); return dst.tick(); },
	};
}

/**
 * A two-player session whose HOST is unmistakable.
 *
 * The gold marker is a precondition, not decoration: with host and guest both on the default gold,
 * "the export carried the host" degrades to comparing two equal numbers and stops discriminating.
 */
function coopSession(seed: string): any {
	const s = new SwapSession({ requiredPlayers: 2, seed, pvp: false });
	s.join('A');
	s.join('B');
	s.world.restorePlayer(s.bundles.get('A'));
	s.world.eval('KinkyDungeonGold = 4242');
	const pos = s.world.eval('({ x: KinkyDungeonPlayerEntity.x, y: KinkyDungeonPlayerEntity.y })');
	s.bundles.set('A', s.world.capturePlayer());
	s.world.restorePlayer(s.bundles.get('B'));
	s.world.eval('KinkyDungeonGold = 111');
	s.bundles.set('B', s.world.capturePlayer());
	s.world.parkGlobalPlayer(1, 1);
	if (pos.x === 1 && pos.y === 1) throw new Error('setup: the host is standing ON the park tile');
	return Object.assign(s, { _hostPos: pos });
}

describe('KDM-244 — the world: KD\'s own generator, driven headless', () => {
	let s: any, exported = '', save: any;

	beforeAll(() => {
		s = coopSession('kdm244-world');
		exported = s.exportRun('A').save;
		save = decode(s.world, exported);
	}, BOOT);

	it('CONTROL — the live world really carries one avatar per seat, host included', () => {
		// Without this, every "no avatar in the export" assertion below is unfalsifiable.
		expect([...s.avatars.keys()].sort()).toEqual(['A', 'B']);
		const live = s.world.eval('KDMapData.Entities.map(function(e){ return { Enemy: { name: e.Enemy && e.Enemy.name } }; })');
		expect(REMOTE(live), 'both avatars must be in the world BEFORE the export').toBe(2);
	}, BOOT);

	it('R5 — the exported save carries no peer-avatar entity, and loses nothing else', () => {
		expect(REMOTE(save.KDMapData.Entities)).toBe(0);
		const live = s.world.eval('KDMapData.Entities.length');
		expect(save.KDMapData.Entities.length, 'exactly the two avatars went').toBe(live - 2);
	}, BOOT);

	it('R4 — the export carries the HOST, at the host\'s real position', () => {
		expect(save.gold, 'the host\'s marker, not the guest\'s 111').toBe(4242);
		expect(save.KinkyDungeonPlayerEntity.x).toBe(s._hostPos.x);
		expect(save.KinkyDungeonPlayerEntity.y).toBe(s._hostPos.y);
		// The failure this replaces: between turns the slot holds a ghost parked at (1,1).
		expect([save.KinkyDungeonPlayerEntity.x, save.KinkyDungeonPlayerEntity.y]).not.toEqual([1, 1]);
	}, BOOT);

	it('R6 — floor, room, seed and map geometry are the live session\'s', () => {
		const live = s.world.eval(FP);
		expect(save.level).toBe(live.level);
		expect(save.seed).toBe(live.seed);
		expect(save.KDGameData.RoomType || '').toBe(live.room);
		expect(save.KDMapData.Grid.slice(0, 120)).toBe(live.gridHash);
	}, BOOT);
});

describe('KDM-244 — the export LOADS, and an un-stripped one does not', () => {
	let s: any, exported = '';

	beforeAll(() => {
		s = coopSession('kdm244-load');
		exported = s.exportRun('A').save;
	}, BOOT);

	it('R7 — the exported save loads into a fresh world, against a pre-load control', () => {
		const live = s.world.eval(FP);
		const r = loadInto(s.world, exported, 'kdm244-load-dst');

		// CONTROL FIRST — without it, "dst matches src" passes for a load that did nothing at all.
		expect(r.pre.seed).not.toBe(live.seed);
		expect(r.pre.gridHash).not.toBe(live.gridHash);
		expect(r.pre.gold).not.toBe(4242);

		expect(r.err, 'the loader must not throw on an exported world').toBe(null);
		expect(r.ok).toBe(true);
		expect(r.fp.seed).toBe(live.seed);
		expect(r.fp.gridHash).toBe(live.gridHash);
		expect(r.fp.gold).toBe(4242);
		expect(r.fp.px).toBe(s._hostPos.x);
		expect(r.fp.py).toBe(s._hostPos.y);
		expect(r.remote, 'no co-op residue survives into the loaded run').toBe(0);
		expect(r.fp.ents).toBe(live.ents - 2);
	}, BOOT);

	it('R7 — the loaded run then takes real turns', () => {
		const r = loadInto(s.world, exported, 'kdm244-load-turns');
		expect(r.ok).toBe(true);
		expect(r.turns(3)).toBeGreaterThan(r.fp.tick);
	}, BOOT);

	it('THE STRIP IS LOAD-BEARING — the same save WITHOUT it refuses to load', () => {
		/*
		 * The regression guard for the POC's central finding. If someone later decides the strip is
		 * cosmetic and removes it, this test is what tells them the export became unopenable — a
		 * failure the user would otherwise meet as "my save is corrupted", long after the change.
		 *
		 * Built by re-adding the avatars to the EXPORTED save rather than by exporting differently,
		 * so it isolates exactly one variable.
		 */
		const stripped = decode(s.world, exported);
		const liveEnts = s.world.eval(`KDMapData.Entities.filter(function(e){
			return e.Enemy && String(e.Enemy.name || '').indexOf('RemotePlayer') === 0;
		}).map(function(e){ return JSON.parse(JSON.stringify(e)); })`);
		expect(liveEnts.length, 'CONTROL — there must be avatars to put back').toBe(2);
		stripped.KDMapData.Entities = stripped.KDMapData.Entities.concat(liveEnts);

		s.world._context.__KD_SAVE_OUT = JSON.stringify(stripped);
		const unstripped = s.world.eval('LZString.compressToBase64(String(globalThis.__KD_SAVE_OUT))');

		const r = loadInto(s.world, unstripped, 'kdm244-load-unstripped');
		expect(r.ok, 'an un-stripped export is UNOPENABLE, not merely untidy').toBe(false);
		// Named, so the next reader learns the mechanism from the failure and not from archaeology.
		// Both readers of an unresolved `Enemy` are accepted: `KinkyDungeonVision.ts:158` (the
		// precedence bug) throws during the load itself, and `KDUnPackEnemy` throws on the first turn
		// afterwards. Which one arrives first depends on how far the loader got — the finding is that
		// the run is broken either way, so pinning one line number would make this test brittle about
		// something it is not testing.
		expect(String(r.err)).toMatch(/blockVisionWhileStationary|Cannot read properties of undefined/);
		// …and it stays broken: the first real turn throws too.
		expect(() => r.turns(1)).toThrow();
	}, BOOT);
});

describe('KDM-244 — A2a: a stripped avatar takes its bondage record with it', () => {
	let s: any, save: any, tiedId = 0;

	beforeAll(() => {
		s = coopSession('kdm244-ties');
		/*
		 * R-g — TIE SOMEBODY FIRST. `KDGameData.NPCRestraints` is keyed by entity id and IS in the
		 * save, but it is empty in an untied session, so an untied fixture would assert an absence
		 * that was already absent.
		 *
		 * ⚠️ NOT via `world.setAvatarBondage`, which is the obvious call and creates NOTHING here:
		 * it sets a bind LEVEL with no items precisely so the avatar's binding slots do not fill up
		 * (`headless-host.js:2201`), and it goes on to CLEAR the record with
		 * `KDSetNPCRestraints(id, {})`. The first draft of this fixture used it, and the control below
		 * caught it — which is the whole reason the control is there.
		 */
		tiedId = s.avatars.get('B');
		s.world._context.__KD_TIE_ID = tiedId;
		s.world.eval(`(function(){
			KDSetNPCRestraints(globalThis.__KD_TIE_ID, { Rope: 2 });
			return KDGetNPCRestraints(globalThis.__KD_TIE_ID);
		})()`);
		save = decode(s.world, s.exportRun('A').save);
	}, BOOT);

	it('CONTROL — the live world really does hold a bondage record for the peer avatar', () => {
		const live = s.world.eval('JSON.parse(JSON.stringify(KDGameData.NPCRestraints || {}))');
		expect(Object.keys(live), 'the fixture must actually have tied someone')
			.toContain(String(tiedId));
	}, BOOT);

	it('A2a — the exported save carries no bondage record for a removed avatar', () => {
		const rec = (save.KDGameData && save.KDGameData.NPCRestraints) || {};
		expect(Object.keys(rec)).not.toContain(String(tiedId));
		// …and the avatar itself is gone, so the record would have been dangling.
		expect(save.KDMapData.Entities.some((e: any) => e.id === tiedId)).toBe(false);
	}, BOOT);
});

describe('KDM-244 — R10: exporting does not disturb the live session', () => {
	let s: any;

	beforeAll(() => { s = coopSession('kdm244-readonly'); }, BOOT);

	it('CONTROL — the GUEST is in the player slot before the export', () => {
		// The POC's round-1 oracle could not fail because the host was already in the slot. Putting
		// the guest there is what makes "the world was put back" a real claim.
		expect(s.world.eval('KinkyDungeonGold')).toBe(111);
	}, BOOT);

	it('R10 — the world is unchanged, value for value, and the slot occupant is restored', () => {
		const before = s.world.eval(FP);
		const res = s.exportRun('A');
		expect(res.ok).toBe(true);
		const after = s.world.eval(FP);
		expect(after).toEqual(before);
		// …including WHO is in the slot: the guest was there, and must be there still.
		expect(s.world.eval('KinkyDungeonGold')).toBe(111);
	}, BOOT);

	it('R10/D3 — the export is non-terminal: the session still resolves turns', () => {
		s.exportRun('A');
		expect(s.submit('A', { kind: 'wait' })).toBeTruthy();
		expect(s.started).toBe(true);
		expect(s._joined).toContain('B');
	}, BOOT);

	it('A3a — the session tracks who is in the player slot, rather than guessing', () => {
		// The restore in exportRun needs a previous occupant to name. If this is undefined the
		// restore is a no-op that happens to look right because the fixture ordering favours it.
		s.world.restorePlayer(s.bundles.get('B'));
		s._restorePlayer('B');
		expect(s._slotOccupant).toBe('B');
		s._restorePlayer('A');
		expect(s._slotOccupant).toBe('A');
	}, BOOT);
});

describe('KDM-244 — R1/R11: the world is the host\'s, and only the host\'s', () => {
	let s: any;

	beforeAll(() => { s = coopSession('kdm244-hostonly'); }, BOOT);

	it('R11 — a guest cannot export the run', () => {
		const res = s.exportRun('B');
		expect(res.ok).toBe(false);
		expect(String(res.err || res.reason)).toMatch(/host/i);
		expect(res.save, 'a refusal must not hand back a world anyway').toBeFalsy();
	}, BOOT);

	it('R11 — nor can an id the session has never seen', () => {
		const res = s.exportRun('never-joined');
		expect(res.ok).toBe(false);
		expect(res.save).toBeFalsy();
	}, BOOT);

	it('R1 — the host can', () => {
		const res = s.exportRun('A');
		expect(res.ok).toBe(true);
		expect(typeof res.save).toBe('string');
		expect(res.save.length).toBeGreaterThan(1000);
	}, BOOT);
});

describe('KDM-244 — R13: a session that never exports is unchanged', () => {
	it('R13 — the regression guard for the whole existing MP suite', () => {
		/*
		 * Every co-op e2e runs on this path. The claim is narrow on purpose: constructing and playing
		 * a session must not acquire any export-shaped side effect just because the capability now
		 * exists. Compared against a fingerprint, not against "it did not throw".
		 */
		const s = new SwapSession({ requiredPlayers: 2, seed: 'kdm244-untouched', pvp: false });
		s.join('A');
		s.join('B');
		const before = s.world.eval(FP);
		expect(s.submit('A', { kind: 'wait' })).toBeTruthy();
		expect(s.submit('B', { kind: 'wait' })).toBeTruthy();
		// The avatars are still there — nothing stripped them as a side effect of the feature.
		const live = s.world.eval('KDMapData.Entities.map(function(e){ return { Enemy: { name: e.Enemy && e.Enemy.name } }; })');
		expect(REMOTE(live)).toBe(2);
		expect(s.world.eval(FP).seed).toBe(before.seed);
	}, BOOT);
});
