/**
 * KDM-235 — a friend joins a run that is already in progress.
 *
 * Co-op has always been all-or-nothing at boot: `_start` fires when `_joined.length >= required` and
 * `join()` throws for ever after. This is the other half of the owner's use case — *"single play,
 * then the friend decided to join to continue"* — and the mirror of KDM-253's `removePlayer`.
 *
 * ⚠️ THE ORACLE THAT MATTERS IS "NOT A COPY", AND IT IS EASY TO WRITE VACUOUSLY. Mid-run, the global
 * player slot holds whoever last acted, so the obvious implementation hands the newcomer a full clone
 * of that player — and a test comparing the joiner against a DEFAULT character passes anyway,
 * because the host is usually still near defaults too. So the host is made provably distinctive
 * FIRST, and the joiner is then asserted to differ from the host *and* to match the template. Same
 * fingerprint-by-value discipline as KDM-252.
 *
 * Requirement ids refer to the `## Requirements` section of KDM-235; J1/J2 are the owner's placement
 * decision recorded there.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MPClient } from '../helpers/mp-ws-client';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WSBridge } = require('../../tools/mp-server/ws-bridge');

const BOOT_TIMEOUT = 240_000;

/** A value nothing in the game would produce, so an accidental match is implausible. */
const HOST_HP = 37.75;

/**
 * The world itself, by value. Comparing the whole Grid string is the point: "the map looks similar"
 * is what a reroll of the same seed would also give.
 */
function worldFingerprint(s: any) {
	return s.world.eval(`(function(){
		return {
			grid: String(KDMapData.Grid || ''),
			w: KDMapData.GridWidth, h: KDMapData.GridHeight,
			room: (typeof KDGameData !== 'undefined' && KDGameData) ? (KDGameData.RoomType || '') : '',
			level: (typeof KDGameData !== 'undefined' && KDGameData) ? KDGameData.Level : null,
		};
	})()`);
}

/** Where an avatar entity stands, and whether anything else shares its tile. */
function avatarTile(s: any, entityId: number) {
	return s.world.eval(`(function(){
		var e = KDMapData.Entities.find(function(x){ return x.id === ${entityId | 0}; });
		if (!e) return null;
		var others = KDMapData.Entities.filter(function(x){ return x.id !== e.id && x.x === e.x && x.y === e.y; });
		return {
			x: e.x, y: e.y,
			movable: KinkyDungeonMovableTilesEnemy.indexOf(KinkyDungeonMapGet(e.x, e.y)) >= 0,
			sharedWith: others.length,
		};
	})()`);
}

/** Read one player's own captured state by value. */
function bundleHp(s: any, clientId: string) {
	s.world.restorePlayer(s.bundles.get(clientId));
	return s.world.eval('KinkyDungeonPlayerEntity.hp');
}

describe('KDM-235 — seating a latecomer into a live run', () => {
	let s: any = null;
	let before: any;
	let enemyBefore: number | null;
	let turnBefore: number;

	beforeAll(async () => {
		// requiredPlayers: 1 — the session starts with the host ALONE, which is the situation this
		// feature exists for. It is also the state KDM-253 leaves behind after "continue solo".
		s = new SwapSession({ requiredPlayers: 1, seed: 'join-late', pvp: false });
		s.join('A');
		await s.ready();

		// The run is genuinely in progress: a turn has resolved and the host is no longer at defaults.
		s.submit('A', { kind: 'wait' });
		s.world.restorePlayer(s.bundles.get('A'));
		s.world.eval(`KinkyDungeonPlayerEntity.hp = ${HOST_HP};`);
		s.bundles.set('A', s.world.capturePlayer());
		// ⚠️ and the world is left as a live session leaves it: the LAST-ACTING player still in the
		// global slot. This is the exact state that makes a naive `capturePlayer()` clone the host.
		s.world.restorePlayer(s.bundles.get('A'));

		before = worldFingerprint(s);
		enemyBefore = s.enemyId;
		turnBefore = s.turn;
	}, BOOT_TIMEOUT);

	afterAll(() => { try { s && s.close && s.close(); } catch (e) { /* noop */ } });

	it('control — the run really is in progress and the host really is distinctive', () => {
		// Without this, every assertion below is satisfied by a session that never started.
		expect(s.started).toBe(true);
		expect(turnBefore, 'a turn has resolved').toBeGreaterThan(0);
		expect(before.grid.length, 'the map fingerprint can actually see a map').toBeGreaterThan(0);
		expect(bundleHp(s, 'A'), 'the host is provably not at defaults').toBe(HOST_HP);
	}, BOOT_TIMEOUT);

	it('R1 — a never-seen player is seated into the running session', () => {
		const res = s.joinInProgress('B');
		expect(res.seated, 'the join is accepted').toBe(true);
		expect(s.players, 'and they hold a seat').toEqual(['A', 'B']);
		expect(s.started, 'the session was not restarted').toBe(true);
		expect(s.turn, 'and the turn counter did not reset').toBe(turnBefore);
	}, BOOT_TIMEOUT);

	it('R4 — the world is NOT rerolled: same map, same floor, same shared enemy', () => {
		expect(worldFingerprint(s)).toEqual(before);
		expect(s.enemyId, 'the enemy already in the dungeon is the same one').toBe(enemyBefore);
	}, BOOT_TIMEOUT);

	it('R6 — the joiner is NOT a copy of whoever last acted', () => {
		const joiner = bundleHp(s, 'B');
		expect(joiner, 'a clone of the host would carry the host\'s distinctive value').not.toBe(HOST_HP);
		expect(bundleHp(s, 'A'), 'and the host still has their own state').toBe(HOST_HP);
	}, BOOT_TIMEOUT);

	it('J1/J2 — placed on a legal, unoccupied tile next to the host', () => {
		const avA = s.avatars.get('A');
		const avB = s.avatars.get('B');
		expect(avB, 'R2 — the joiner has an avatar in the shared world').toBeTruthy();
		const a = avatarTile(s, avA);
		const b = avatarTile(s, avB);
		expect(b, 'the joiner\'s avatar is really in the world').toBeTruthy();
		expect(b.movable, 'not inside a wall').toBe(true);
		expect(b.sharedWith, 'not stacked on the enemy or on the host').toBe(0);
		const chebyshev = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
		expect(chebyshev, `adjacent to the host, not at a map-wide spawn (host ${a.x},${a.y} joiner ${b.x},${b.y})`)
			.toBeLessThanOrEqual(1);
	}, BOOT_TIMEOUT);

	it('R2 — and the joiner sees the host', () => {
		const snap = s.snapshotFor('B');
		const ids = (snap.map && snap.map.Entities || []).map((e: any) => e.id);
		expect(ids, 'the host\'s avatar is in the joiner\'s world').toContain(s.avatars.get('A'));
		expect(ids, 'and the joiner does not see their own avatar as an entity')
			.not.toContain(s.avatars.get('B'));
	}, BOOT_TIMEOUT);

	it('A6 — lockstep now waits for both, and a turn needs both submits', () => {
		expect(s.required, 'the seat count rose with the join').toBe(2);
		expect(s.waitingOn().sort()).toEqual(['A', 'B']);
		const t0 = s.turn;
		expect(s.submit('A', { kind: 'wait' }).advanced, 'one submit is no longer enough').toBe(false);
		expect(s.turn).toBe(t0);
		expect(s.submit('B', { kind: 'wait' }).advanced, 'both submits resolve it').toBe(true);
		expect(s.turn).toBe(t0 + 1);
	}, BOOT_TIMEOUT);

	it('a duplicate or unknown-shaped join is refused, not half-applied', () => {
		expect(s.joinInProgress('B').seated, 'already seated').toBe(false);
		expect(s.joinInProgress('').seated, 'no id').toBe(false);
		expect(s.players, 'and nothing changed').toEqual(['A', 'B']);
	}, BOOT_TIMEOUT);
});

describe('KDM-235 J2 — the tile next door is taken', () => {
	let s: any = null;

	beforeAll(async () => {
		s = new SwapSession({ requiredPlayers: 1, seed: 'join-late-blocked', pvp: false });
		s.join('A');
		await s.ready();
	}, BOOT_TIMEOUT);

	afterAll(() => { try { s && s.close && s.close(); } catch (e) { /* noop */ } });

	/**
	 * ⚠️ THIS CASE EXISTS BECAUSE THE PLAIN "not stacked on anything" ASSERTION IS VACUOUS.
	 *
	 * Measured: a mutant that deleted the occupancy check from `findFreeTileNear` passed the whole
	 * spec, because the nearest terrain-legal tile to the host happened to be empty anyway — so the
	 * assertion never had a chance to fail. The rule is only observable when the nearest tile is
	 * genuinely taken, which is what this sets up.
	 */
	it('the joiner steps past an occupied tile instead of standing on it', () => {
		const hostAv = s.avatars.get('A');
		const host = s.world.entityPos(hostAv);
		const wanted = s.world.findFreeTileNear(host.x, host.y);
		expect(wanted, 'precondition: there is a free tile next to the host').toBeTruthy();

		// Park a real entity exactly there, so the tile is legal terrain but occupied.
		const blocker = s.world.spawnAvatar(wanted.x, wanted.y, 'Blocker');
		expect(s.world.entityPos(blocker.entityId), 'the blocker really is on that tile')
			.toEqual({ x: wanted.x, y: wanted.y });

		expect(s.joinInProgress('B').seated).toBe(true);
		const b = avatarTile(s, s.avatars.get('B'));
		expect(b.sharedWith, 'the joiner did not stack on the blocker').toBe(0);
		expect({ x: b.x, y: b.y }, 'and specifically not on the tile that was taken')
			.not.toEqual({ x: wanted.x, y: wanted.y });
		expect(b.movable, 'still a legal tile').toBe(true);
		// Still as close as it can be — one ring further out at worst.
		const d = Math.max(Math.abs(host.x - b.x), Math.abs(host.y - b.y));
		expect(d, 'still placed near the host, not sent across the map').toBeLessThanOrEqual(2);
	}, BOOT_TIMEOUT);
});

describe('KDM-235 R5 — an open turn is not disturbed', () => {
	let s: any = null;

	beforeAll(async () => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'join-late-barrier', pvp: false });
		s.join('A');
		s.join('B');
		await s.ready();
	}, BOOT_TIMEOUT);

	afterAll(() => { try { s && s.close && s.close(); } catch (e) { /* noop */ } });

	it('a join arriving mid-turn waits for the boundary, and the turn resolves normally', () => {
		// Open the barrier: A has acted, B has not. This is the window a socket message lands in.
		expect(s.submit('A', { kind: 'wait' }).advanced).toBe(false);
		const t0 = s.turn;

		const res = s.joinInProgress('C');
		expect(res.seated, 'accepted…').toBe(true);
		expect(res.deferred, '…but not seated yet — a turn is open').toBe(true);
		expect(s.players, 'C is NOT in the barrier for a turn they never saw').toEqual(['A', 'B']);
		expect(s.waitingOn(), 'and the open turn still waits only on B').toEqual(['B']);

		// The turn resolves on its ORIGINAL participants…
		expect(s.submit('B', { kind: 'wait' }).advanced, 'the pending turn was not stalled by the join').toBe(true);
		expect(s.turn).toBe(t0 + 1);

		// …and the seat appears at the boundary.
		expect(s.players, 'seated at the turn boundary').toEqual(['A', 'B', 'C']);
		expect(s.avatars.get('C'), 'with an avatar').toBeTruthy();
		expect(s.waitingOn().sort(), 'and from the next turn, everyone acts').toEqual(['A', 'B', 'C']);
	}, BOOT_TIMEOUT);
});

describe('KDM-235 R3 — over the wire, the joiner gets the LIVE world in full', () => {
	let bridge: any = null;
	let A: MPClient;
	let B: MPClient;

	beforeAll(async () => {
		bridge = new WSBridge({ requiredPlayers: 1, seed: 'join-late-wire', hbIntervalMs: 0 });
		const port = await bridge.listen(0);
		A = await MPClient.connect(port);
		A.send({ type: 'join', clientId: 'A', role: 'host' });   // KDM-255: the gate is the road in
		await A.next((m) => m.type === 'joined');
		await A.next((m) => m.type === 'state');
		// A turn resolves before anyone else arrives, so "the live world" is distinguishable from
		// "a freshly booted one".
		A.send({ type: 'input', action: { kind: 'wait' } });
		await A.next((m) => m.type === 'state' && m.kind == null, 60_000);
	}, BOOT_TIMEOUT);

	afterAll(() => {
		A?.close(); B?.close();
		try { bridge && bridge.close(); } catch (e) { /* noop */ }
	});

	it('the first frame is a FULL snapshot of the run in progress', async () => {
		const turnAt = bridge.session.turn;
		expect(turnAt, 'precondition: the run is past turn 0').toBeGreaterThan(0);

		B = await MPClient.connect(bridge.port);
		// KDM-255 — joining LATE still goes through the gate: the friend who turned up mid-run is
		// asking to be let in exactly like any other guest, and A answers.
		B.send({ type: 'join', clientId: 'B', role: 'guest' });
		await A.next((m) => m.type === 'join_pending' && m.clientId === 'B');
		A.send({ type: 'join_answer', accept: true });
		const joined = await B.next((m) => m.type === 'joined');
		expect(joined.started, 'they join a session that is already running').toBe(true);

		const first = await B.next((m) => m.type === 'state', 60_000);
		// `MPClient` re-exposes a merged delta as `m.snapshot`, so `delta` is the discriminator.
		expect(first.delta, 'a newcomer holds no base to diff against').toBeUndefined();
		expect(first.snapshot, 'so it must be a full snapshot').toBeTruthy();
		expect(first.tick, 'and it is the LIVE world, not a fresh dungeon').toBe(turnAt);
		expect(first.snapshot.player, 'with their own character in it').toBeTruthy();
	}, BOOT_TIMEOUT);

	it('and the player already there is told, without asking', async () => {
		const hello = await A.next((m: any) => m.type === 'peer_joined', 5_000);
		expect(hello.clientId).toBe('B');
		/*
		 * KDM-278 — `players` is the field the CLIENT rebuilds its roster from, so it is part of the
		 * contract and not decoration. `coop-bootstrap.js` adopts this list wholesale rather than
		 * appending `clientId` to what it already had, precisely so there is one source of truth for
		 * who is seated; a payload carrying only the arrival would push it back to deriving its own.
		 *
		 * The roster ITSELF is browser state and is asserted where it lives — `tests/e2e/
		 * mp-join-late.spec.ts`, across a real two-browser join. This message had a node-layer test
		 * and no reader for exactly as long as it took someone to notice the wire is not the roster.
		 */
		expect(hello.players, 'carries the full seating, which is what the roster is rebuilt from')
			.toEqual(['A', 'B']);
	}, BOOT_TIMEOUT);
});
