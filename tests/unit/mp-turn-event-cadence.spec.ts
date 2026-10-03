/**
 * Node-layer (Vitest) — world event dispatch follows the Event's CADENCE, not the number of players.
 *
 * `KinkyDungeonSendBulletEvent` / `KinkyDungeonSendEnemyEvent` are world-keyed by data (every bullet,
 * every map entity), but `KinkyDungeonSendEvent` reaches them from two very different places:
 *   - PERIODIC: `KinkyDungeonAdvanceTime` itself sends a few names unconditionally, once per tick
 *     ("tick", "afterEnemyTick" ×2, "tickAfter"). In co-op every player's apply runs its own
 *     `KinkyDungeonAdvanceTime`, so with N players each enemy's tick handler (auras, regen, missile
 *     casts, effect-tile creation, …) ran N times per round instead of once.
 *   - ONE-SHOT: everything else is sent from inside an action (a hit, a cast, a kill) and must keep
 *     firing for whichever player's apply caused it.
 * The fix gates the two dispatchers by name: a periodic Event is a no-op inside a muted (non-host)
 * apply, exactly like every other once-per-round world system.
 *
 * THE ORACLES. A probe handler is registered under each name and counted per round:
 *   - enemy, periodic — reached through the REAL engine path (AdvanceTime's own sends), so the count
 *     is a direct reading of the bug: 2 per round with 2 players before the fix, 1 after;
 *   - enemy + bullet, one-shot — sent from a per-apply hook in BOTH players' applies; must stay 2.
 *     This is also the anti-vacuity control: if a muted apply could not dispatch at all (a stale
 *     event cache, a missing handler), the one-shot count would drop too;
 *   - bullet, periodic name through the same per-apply hook — 1 (the gate), with the one-shot at 2.
 * Plus the drift guards: the cadence table classifies every live trigger name of both maps, and its
 * periodic set is exactly the names the LIVE `KinkyDungeonAdvanceTime` body sends.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HeadlessHost } = require('../../tools/mp-server/headless-host');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { EVENT_CADENCE, PERIODIC_EVENTS, TURN_CALL_CLASSIFICATION } = require('../../tools/mp-server/turn-classification');

const BOOT_TIMEOUT = 300_000;
const PERIODIC_VIA_ENGINE = ['tick', 'afterEnemyTick', 'tickAfter'];

/**
 * Register a counting probe under every given enemy trigger on `enemyId`, plus a per-apply hook that
 * sends one one-shot enemy Event and one periodic + one one-shot bullet Event (with a stand-in bullet
 * carrying the probe events — `SendBulletEvent` with an explicit bullet dispatches that bullet only).
 */
function installProbes(s: any, enemyId: number) {
	return s.world.eval(`(function(){
		var C = globalThis.__kdmCadence = {};
		function bump(k){ C[k] = (C[k] || 0) + 1; }
		var enemyNames = ${JSON.stringify([...PERIODIC_VIA_ENGINE, 'afterPlayerAttack'])};
		enemyNames.forEach(function(n){
			if (!KDEventMapEnemy[n]) KDEventMapEnemy[n] = {};
			KDEventMapEnemy[n].__kdmCadenceProbe = function(e, enemy, data){ bump('enemy:' + n); };
		});
		// Bullet probes are (re-)registered inside the hook, per call: unlike the enemy map, a bundle
		// restore can hand back a KDEventMapBullet captured before this install.
		function bulletProbes(){
			['tick', 'bulletDestroy'].forEach(function(n){
				if (!KDEventMapBullet[n]) KDEventMapBullet[n] = {};
				KDEventMapBullet[n].__kdmCadenceProbe = function(e, b, data){ bump('bullet:' + n); };
			});
		}
		var en = KDMapData.Entities.find(function(x){ return x.id === ${enemyId}; });
		if (!en) return false;
		en.Enemy = Object.assign({}, en.Enemy, { events: (en.Enemy.events || []).concat(enemyNames.map(function(n){
			return { trigger: n, type: '__kdmCadenceProbe' };
		})) });
		en.modified = true;            // keep the per-entity clone across map pack/unpack
		KDUpdateEnemyCache = true;     // rebuild KDEnemyEventCache with the new triggers
		var fakeBullet = { bullet: { name: 'kdmCadenceProbe', events: [
			{ trigger: 'tick', type: '__kdmCadenceProbe' }, { trigger: 'bulletDestroy', type: '__kdmCadenceProbe' },
		] } };
		if (!globalThis.__kdmItemCheckWrapped) {
			var _prev = KinkyDungeonItemCheck;
			// KinkyDungeonItemCheck: a 'player' call inside KinkyDungeonAdvanceTime — runs in EVERY apply.
			KinkyDungeonItemCheck = function(){
				KinkyDungeonSendEnemyEvent('afterPlayerAttack', {}, undefined);
				bulletProbes();
				KinkyDungeonSendBulletEvent('tick', fakeBullet, {});
				KinkyDungeonSendBulletEvent('bulletDestroy', fakeBullet, {});
				return _prev.apply(this, arguments);
			};
			globalThis.__kdmItemCheckWrapped = true;
		}
		return true;
	})()`);
}

function counts(s: any): Record<string, number> {
	return s.world.eval('JSON.parse(JSON.stringify(globalThis.__kdmCadence))');
}
/** In place: the probes' `bump` closes over the object created at install time. */
function clearCounts(s: any) {
	s.world.eval('(function(){ var C = globalThis.__kdmCadence; for (var k in C) delete C[k]; return true; })()');
}

async function bootWithProbes(ids: string[], seed: string) {
	const s = new SwapSession({ requiredPlayers: ids.length, seed, pvp: false, enemyType: 'NawashiZombie' });
	for (const id of ids) s.join(id);
	await s.ready();
	expect(s.enemyId, 'setup: the probe enemy exists').not.toBeNull();
	expect(installProbes(s, s.enemyId), 'setup: probes installed on the enemy').toBe(true);
	return s;
}

function round(s: any, ids: string[]) {
	clearCounts(s);
	const t0 = s.turn;
	for (const id of ids) s.submit(id, { kind: 'wait' });
	expect(s.turn, 'the round resolved').toBe(t0 + 1);
	expect(s.failedInputReport(), 'no apply threw').toEqual([]);
	return counts(s);
}

describe('event cadence — the classification table', () => {
	it('classifies every live bullet/enemy trigger name, and nothing that is not one', () => {
		const h = new HeadlessHost({ id: 'cadence-audit' });
		h.boot();
		h.init({ seed: 'cadence-audit' });
		const live = h.eval(`({
			bullet: Object.keys(KDEventMapBullet), enemy: Object.keys(KDEventMapEnemy),
			advanceTime: KinkyDungeonAdvanceTime.toString(),
		})`);
		const liveNames = new Set<string>([...live.bullet, ...live.enemy]);
		expect(liveNames.size, 'anti-vacuity: the maps really have triggers').toBeGreaterThan(20);
		const unclassified = [...liveNames].filter((n) => !EVENT_CADENCE[n]);
		expect(unclassified, 'R1: classify these in turn-classification.js EVENT_CADENCE').toEqual([]);
		const orphans = Object.keys(EVENT_CADENCE).filter((n) => !liveNames.has(n));
		expect(orphans, 'R2: these EVENT_CADENCE names are no longer live triggers').toEqual([]);
		for (const [n, v] of Object.entries(EVENT_CADENCE) as [string, any][]) {
			expect(['periodic', 'oneshot'], `${n} has a cadence verdict`).toContain(v.verdict);
			expect(String(v.why), `${n} cites Game/src`).toMatch(/Game\/src\//);
		}

		// PERIODIC is DEFINED as "sent by KinkyDungeonAdvanceTime itself" — read off the live body, so a
		// new periodic send upstream (or a removed one) turns this red instead of silently doubling.
		const sentByTick = new Set<string>();
		const re = /KinkyDungeonSendEvent\(\s*["']([A-Za-z_]+)["']/g;
		let m: RegExpExecArray | null;
		// eslint-disable-next-line no-cond-assign
		while ((m = re.exec(live.advanceTime))) sentByTick.add(m[1]);
		expect(sentByTick.size, 'anti-vacuity: AdvanceTime sends events').toBeGreaterThan(0);
		const periodicLive = [...sentByTick].filter((n) => liveNames.has(n)).sort();
		expect([...PERIODIC_EVENTS].sort(), 'PERIODIC_EVENTS == the bullet/enemy names AdvanceTime sends')
			.toEqual(periodicLive);
		expect(periodicLive).toEqual([...PERIODIC_VIA_ENGINE].sort());
	}, BOOT_TIMEOUT);

	it('both dispatchers are split (their cadence wrap exists), not mixed', () => {
		expect(TURN_CALL_CLASSIFICATION.KinkyDungeonSendBulletEvent.verdict).toBe('split');
		expect(TURN_CALL_CLASSIFICATION.KinkyDungeonSendEnemyEvent.verdict).toBe('split');
	});
});

describe('event cadence — rounds', () => {
	it('2 players: periodic enemy/bullet events fire ONCE per round, one-shot ones once per player', async () => {
		const ids = ['A', 'B'];
		const s = await bootWithProbes(ids, 'cadence-2p');
		for (let r = 0; r < 2; r++) {
			const c = round(s, ids);
			// Control first: both applies really dispatched (so a "1" below is the gate, not a dead apply).
			expect(c['enemy:afterPlayerAttack'], `round ${r}: one-shot enemy event, once per player`).toBe(2);
			expect(c['bullet:bulletDestroy'], `round ${r}: one-shot bullet event, once per player`).toBe(2);
			expect(c['enemy:tick'], `round ${r}: enemy "tick" once per round`).toBe(1);
			expect(c['enemy:tickAfter'], `round ${r}: enemy "tickAfter" once per round`).toBe(1);
			// AdvanceTime sends afterEnemyTick twice per tick (allied pass, hostile pass).
			expect(c['enemy:afterEnemyTick'], `round ${r}: enemy "afterEnemyTick" twice per round`).toBe(2);
			expect(c['bullet:tick'], `round ${r}: periodic bullet name once per round`).toBe(1);
		}
	}, BOOT_TIMEOUT);

	it('1 player: unchanged — every event fires once per round (single-player parity)', async () => {
		const ids = ['A'];
		const s = await bootWithProbes(ids, 'cadence-1p');
		const c = round(s, ids);
		expect(c).toEqual({
			'enemy:afterPlayerAttack': 1, 'bullet:bulletDestroy': 1, 'bullet:tick': 1,
			'enemy:tick': 1, 'enemy:tickAfter': 1, 'enemy:afterEnemyTick': 2,
		});
	}, BOOT_TIMEOUT);
});
