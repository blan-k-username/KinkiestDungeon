/**
 * Node-layer (Vitest) acceptance test: bumping a co-op partner's avatar in PEACE opens KD's own
 * ally dialogue (`GenericAlly`) — the owner's REVISED rule (it is how a bound partner gets untied,
 * `mp-coop-untie.spec.ts`) — but the bump itself still moves nobody: no swap, no step onto the
 * ally, the mover stays put and the dialogue opens in place of a move. Races for one tile, or one
 * player bumping the other while the other steps away, are still decided purely by the round's
 * random order; the loser's bump still opens the dialogue (that is what a bump now does), it simply
 * never moves the loser.
 *
 * Earlier version of this file (superseded): the peace avatar is a real `Player`-faction ally, so a
 * move with `AllowInteract:true` walks into KD's own "talk to an ally" branch
 * (`KinkyDungeonLaunchAttack` → `KDTalkToEnemy` → `KDStartDialog("GenericAlly", ...)`). A guard that
 * blocked `KDStartDialog` outright for a peer avatar also blocked the one legitimate reason to talk
 * to them — removed; see `HeadlessHost.installPeerAllyDialogueGuard`.
 *
 * `GenericAlly` ships many OTHER options that are NPC-only (recruit/dismiss, follow/stay AI
 * commands, shop, leash, feed, an out-of-band attack, the flirt/bondage minigame): those are hidden
 * for a peer avatar specifically, the KD-native way (each option's own `prerequisiteFunction`) —
 * covered by `mp-peer-ally-dialogue-options.spec.ts`.
 *
 * Control: the SAME move against an ordinary friendly NPC (not a peer avatar) must still do whatever
 * stock KD does — proving the guard is scoped to peer avatars, not a blanket dialogue suppression.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { freeNeighbour, placePlayerAt, contestedTarget } from '../helpers/session-tiles';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

function currentDialogOf(s: any, cid: string): string {
	const bundle = s.bundles.get(cid);
	s.world.restorePlayer(bundle);
	return s.world.eval('KDGameData.CurrentDialog || ""') || '';
}

function stepToward(from: { x: number, y: number }, to: { x: number, y: number }) {
	return { x: Math.sign(to.x - from.x), y: Math.sign(to.y - from.y) };
}

/** Same primitive `mp-companion-avatar-immunity.spec.ts` uses to inject a real entity directly. */
function spawnEntityDirect(s: any, x: number, y: number, type: string): { id: number, name: string } {
	const before = s.world.eval('KDMapData.Entities.length');
	const out = s.world.eval(`(function(){
		var Enemy = KinkyDungeonGetEnemyByName(${JSON.stringify(type)});
		if (!Enemy) return null;
		var e = { summoned: true, Enemy: Enemy, id: KinkyDungeonGetEnemyID(),
			x: ${x | 0}, y: ${y | 0}, hp: Enemy.startinghp || Enemy.maxhp,
			movePoints: 0, attackPoints: 0 };
		e = KDAddNewEntity(e);
		KDUpdateEnemyCache = true;
		return { id: e.id, name: e.Enemy && e.Enemy.name };
	})()`);
	const after = s.world.eval('KDMapData.Entities.length');
	if (!out || after !== before + 1) throw new Error(`setup invalid: failed to spawn ${type} at (${x},${y})`);
	return out;
}

/**
 * A real `Player`-faction ally, same recipe `mp-companion-avatar-immunity.spec.ts` uses
 * (`KDAddToParty`) — a freshly-summoned, un-recruited NPC's own faction can be hostile/neutral
 * (talk-to-ally only applies once `KDAllied` is true), so the control needs the actual recruited
 * state, not just the entity type.
 */
function recruitedAllyAt(s: any, x: number, y: number, type: string): { id: number, name: string } {
	const spawned = spawnEntityDirect(s, x, y, type);
	const ok = s.world.eval(`(function(){
		var e = KDMapData.Entities.find(function(en){ return en.id === ${spawned.id}; });
		if (!e || typeof KDAddToParty !== 'function') return false;
		return !!KDAddToParty(e);
	})()`);
	if (!ok) throw new Error('setup invalid: KDAddToParty did not accept the summoned ally');
	return spawned;
}

async function newPeaceSession(seed: string) {
	const s = new SwapSession({ requiredPlayers: 2, seed, pvp: false });
	s.join('A');
	s.join('B');
	await s.ready();
	return s;
}

describe('a peer avatar bump in peace opens the ally dialogue but moves nobody', () => {
	let s: any;
	beforeEach(async () => {
		s = await newPeaceSession('peer-talk-guard');
	}, BOOT_TIMEOUT);

	it('a real move (AllowInteract:true) into the partner leaves the mover in place, opens GenericAlly, and does not swap', () => {
		const nb = freeNeighbour(s, 'A');
		expect(nb, 'setup invalid: A has no free neighbour to stand B on').toBeTruthy();
		placePlayerAt(s, 'B', nb!.x, nb!.y);

		const a0 = s.posOf('A'), b0 = s.posOf('B');
		const dir = stepToward(a0, b0);
		expect(dir).not.toEqual({ x: 0, y: 0 });

		s.submit('A', { kdType: 'move', data: { dir, delta: 1, AllowInteract: true } });
		s.submit('B', { kind: 'wait' });

		expect(s.posOf('A'), 'the mover must stay in place — no swap, no step onto the ally').toEqual(a0);
		expect(s.posOf('B'), 'the partner must not be pushed/swapped either').toEqual(b0);
		expect(currentDialogOf(s, 'A'), 'the bump opens the ally dialogue on the mover').toBe('GenericAlly');
		expect(currentDialogOf(s, 'B'), 'and never on the bumped partner').toBe('');
	}, BOOT_TIMEOUT);

	it('control: the same move against an ordinary friendly NPC still does whatever stock KD does', () => {
		const nb = freeNeighbour(s, 'A');
		expect(nb, 'setup invalid').toBeTruthy();
		const npc = recruitedAllyAt(s, nb!.x, nb!.y, 'WitchFlame');
		expect(npc.name.indexOf('RemotePlayer')).toBe(-1); // sanity: this is not a peer avatar

		const a0 = s.posOf('A');
		const dir = stepToward(a0, nb!);

		s.submit('A', { kdType: 'move', data: { dir, delta: 1, AllowInteract: true } });
		s.submit('B', { kind: 'wait' });

		// Proves the probe is not vacuous: an ordinary ally IS talkable, so the guard did not
		// blanket-suppress every dialogue — only peer avatars.
		expect(currentDialogOf(s, 'A'), 'stock KD must still open its own ally dialogue for a real NPC').toBe('GenericAlly');
	}, BOOT_TIMEOUT);
});

describe('peace races are decided by the random order, never by a move onto the contested tile', () => {
	for (const order of [['A', 'B'], ['B', 'A']]) {
		it(`same tile, order ${order.join('→')}: exactly one player gets it, the loser is untouched`, async () => {
			const s = await newPeaceSession(`peer-talk-guard-same-${order.join('')}`);
			s._shuffle = () => order.slice();

			const target = contestedTarget(s);
			expect(target, 'no walkable tile adjacent to both players — setup invalid').toBeTruthy();
			const a0 = s.posOf('A'), b0 = s.posOf('B');

			s.submit('A', { kdType: 'move', data: { dir: stepToward(a0, target), delta: 1, AllowInteract: true } });
			s.submit('B', { kdType: 'move', data: { dir: stepToward(b0, target), delta: 1, AllowInteract: true } });

			const a1 = s.posOf('A'), b1 = s.posOf('B');
			const on = (p: any) => p.x === target.x && p.y === target.y;
			expect([on(a1), on(b1)].filter(Boolean).length, 'exactly one mover lands on the contested tile').toBe(1);
			const loser = on(a1) ? 'B' : 'A';
			const loserPos = loser === 'A' ? a1 : b1;
			const loserStart = loser === 'A' ? a0 : b0;
			expect(loserPos, 'the loser stalls in place, same as a cancelled move').toEqual(loserStart);
			expect(currentDialogOf(s, 'A'), 'the race must never open a dialogue on either side').toBe('');
			expect(currentDialogOf(s, 'B')).toBe('');
		}, BOOT_TIMEOUT);
	}

	it('B moves away first, then A steps into the tile B just vacated', async () => {
		const s = await newPeaceSession('peer-talk-guard-vacate-BA');
		s._shuffle = () => ['B', 'A'];

		const nb = freeNeighbour(s, 'A');
		expect(nb, 'setup invalid').toBeTruthy();
		placePlayerAt(s, 'B', nb!.x, nb!.y);
		const away = freeNeighbour(s, 'B');
		expect(away, 'setup invalid: B has nowhere to step away to').toBeTruthy();

		const a0 = s.posOf('A'), b0 = s.posOf('B');
		s.submit('A', { kdType: 'move', data: { dir: stepToward(a0, b0), delta: 1, AllowInteract: true } });
		s.submit('B', { kdType: 'move', data: { dir: stepToward(b0, away), delta: 1, AllowInteract: true } });

		expect(s.posOf('B'), 'B moved away first').toEqual({ x: away!.x, y: away!.y });
		expect(s.posOf('A'), 'A then moves into the tile B just vacated').toEqual(b0);
		expect(currentDialogOf(s, 'A')).toBe('');
		expect(currentDialogOf(s, 'B')).toBe('');
	}, BOOT_TIMEOUT);

	it('A bumps first (B still there): A stays and talks to B instead of moving, and B then moves away', async () => {
		const s = await newPeaceSession('peer-talk-guard-vacate-AB');
		s._shuffle = () => ['A', 'B'];

		const nb = freeNeighbour(s, 'A');
		expect(nb, 'setup invalid').toBeTruthy();
		placePlayerAt(s, 'B', nb!.x, nb!.y);
		const away = freeNeighbour(s, 'B');
		expect(away, 'setup invalid: B has nowhere to step away to').toBeTruthy();

		const a0 = s.posOf('A'), b0 = s.posOf('B');
		s.submit('A', { kdType: 'move', data: { dir: stepToward(a0, b0), delta: 1, AllowInteract: true } });
		s.submit('B', { kdType: 'move', data: { dir: stepToward(b0, away), delta: 1, AllowInteract: true } });

		expect(s.posOf('A'), 'A went first, bumped into a tile B still occupied: the move itself does nothing').toEqual(a0);
		expect(s.posOf('B'), 'B still moves away on its own turn').toEqual({ x: away!.x, y: away!.y });
		expect(currentDialogOf(s, 'A'), 'a real bump into the partner opens the ally dialogue').toBe('GenericAlly');
		expect(currentDialogOf(s, 'B')).toBe('');
	}, BOOT_TIMEOUT);
});

describe('PvP is unchanged: a bump is a real attack', () => {
	it('an armed peer bump damages the real victim, not a dialogue', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'peer-talk-guard-pvp', pvp: true });
		s.join('A');
		s.join('B');
		await s.ready();

		const a = s.posOf('A'), b = s.posOf('B');
		const willB0 = s.vitalsFor('B').will;
		s.submit('A', { kdType: 'move', data: { dir: stepToward(a, b), delta: 1, AllowInteract: true } });
		s.submit('B', { kind: 'wait' });

		expect(s.vitalsFor('B').will, 'PvP bump must still be a real attack').toBeLessThan(willB0);
		expect(currentDialogOf(s, 'A'), 'PvP never opens the ally dialogue (an armed peer is never allied)').toBe('');
	}, BOOT_TIMEOUT);
});
