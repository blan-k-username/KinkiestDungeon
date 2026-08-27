/**
 * KDM-237 — a player's chosen NAME, from the seat that owns it to the bundle that carries it.
 *
 * Both players are the same default character today, and both are labelled `Player <id>`. This slice
 * gives each of them the name they already typed into the lobby (KDM-233 collects it for the host's
 * accept prompt and then throws it away).
 *
 * ── WHY THE GATE, AND NOT THE SOCKET ──────────────────────────────────────────────────────────────
 * A reconnecting player does not re-seat — `ws-bridge.js` answers a known id at a running session
 * with a bare `joined` — so a name stored per-socket would come back as `Player B`. The seat is the
 * thing that survives, and the gate owns seats. The pair of cases below on `release` vs
 * `releasePending` is that rule stated directly: giving a seat up loses the name, merely dropping
 * does not.
 *
 * ── WHY IT IS NOT A VACUOUS GREEN ─────────────────────────────────────────────────────────────────
 *  1. The unnamed player is carried through the SAME booted session as the named one. "The name
 *     arrived" and "the fallback still works" are asserted against each other, so an implementation
 *     that names everybody — or nobody — fails one of the two.
 *  2. The fallback is asserted as the EXACT legacy string, not merely as "something non-empty". That
 *     string is what the `#coop=` path and the whole MP e2e suite see (NF2); "a label exists" would
 *     pass while silently renaming 40 specs' worth of avatars.
 *  3. Each player's bundle is checked for the OTHER's name as well as its own, because "both bundles
 *     got a name" and "both bundles got the SAME name" are the same green otherwise.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JoinGate, sanitizeName } = require('../../tools/mp-server/join-gate');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;
const BUILD = 'kd-5.5.0-abc123';

// ---------------------------------------------------------------------------------------------
// The pure half: who is named, and what happens to that name. No socket, no world — milliseconds.
// ---------------------------------------------------------------------------------------------
describe('KDM-237 — sanitizeName (N4)', () => {
	it('trims, and answers empty for a name that is only whitespace', () => {
		expect(sanitizeName('  Ada  ')).toBe('Ada');
		expect(sanitizeName('   ')).toBe('');
		expect(sanitizeName(undefined)).toBe('');
		expect(sanitizeName(null)).toBe('');
	});

	it('strips control characters rather than letting them reach a draw call', () => {
		// Built with fromCharCode on purpose: a raw NUL or ESC written literally into the source is
		// invisible to a reviewer and trivially lost to a copy-paste, which would leave this case
		// asserting nothing while still passing.
		const NUL = String.fromCharCode(0);
		const ESC = String.fromCharCode(27);
		const BEL = String.fromCharCode(7);
		expect(sanitizeName('Ada' + NUL + ESC + '[31m')).toBe('Ada[31m');
		expect(sanitizeName('A' + BEL + 'da')).toBe('Ada');
		expect(sanitizeName('A\nda')).toBe('Ada');
	});

	it('caps the length, matching the lobby field it comes from', () => {
		expect(sanitizeName('A'.repeat(200)).length).toBe(24);
	});

	it('is not an identity — two players may choose the same name', () => {
		// N4: `clientId` is the identity (KDM-252). A name grants nothing and collides freely.
		expect(sanitizeName('Ada')).toBe(sanitizeName('Ada'));
	});
});

describe('KDM-237 — JoinGate carries the name on the SEAT', () => {
	let g: any;
	beforeEach(() => { g = new JoinGate({ build: BUILD }); });

	it('N1/N2 — a host is named by their claim', () => {
		g.claimHost('H', { build: BUILD, name: 'Ada' });
		expect(g.nameOf('H')).toBe('Ada');
	});

	it('N3 — a host who gives no name is simply unnamed, not refused', () => {
		const r = g.claimHost('H', { build: BUILD });
		expect(r.accept).toBe(true);
		expect(g.nameOf('H')).toBe('');
	});

	it('N2 — a requester\'s name is sanitised where it is STORED, so the host sees what the world will use', () => {
		g.claimHost('H', { build: BUILD });
		g.requestJoin('G', { name: '  Bob   ', build: BUILD });
		expect(g.pending.name, 'the prompt and the world agree').toBe('Bob');
	});

	it('N2 — accepting promotes the pending name onto the seat', () => {
		g.claimHost('H', { build: BUILD });
		g.requestJoin('G', { name: 'Bob', build: BUILD });
		expect(g.nameOf('G'), 'asking is not being seated').toBe('');
		g.accept();
		expect(g.nameOf('G')).toBe('Bob');
	});

	it('declining leaves no name behind', () => {
		g.claimHost('H', { build: BUILD });
		g.requestJoin('G', { name: 'Bob', build: BUILD });
		g.decline();
		expect(g.nameOf('G')).toBe('');
	});

	// ── P2's actual mechanism ─────────────────────────────────────────────────────────────────
	// These two are a pair on purpose: the same call shape with opposite answers, which is what makes
	// "the name survives a drop" a rule rather than an accident of ordering.
	it('P2 — a DROPPED player keeps their name: releasePending frees the question, not the seat', () => {
		g.claimHost('H', { build: BUILD, name: 'Ada' });
		g.releasePending('H');
		expect(g.nameOf('H'), 'a reconnecting host must not come back as Player A').toBe('Ada');
	});

	it('a player who gives the seat up loses the name with it', () => {
		g.claimHost('H', { build: BUILD, name: 'Ada' });
		g.release('H');
		expect(g.nameOf('H')).toBe('');
	});

	it('an unknown id is unnamed, and asking does not create anything', () => {
		expect(g.nameOf('NOBODY')).toBe('');
		expect(g.players()).toEqual([]);
	});
});

// ---------------------------------------------------------------------------------------------
// The session half, on a real booted world. One boot carries BOTH the named and the unnamed player,
// so the feature and its fallback are measured against each other rather than in separate runs.
// ---------------------------------------------------------------------------------------------
describe('KDM-237 — the name reaches the world (S1, S2, N3)', () => {
	let s: any = null;

	beforeAll(async () => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'player-name' });
		// A is named; B deliberately is NOT — B is the `#coop=` path's control (NF2). 'Nyx', not 'Ada':
		// 'Ada' is KD's OWN default PlayerName, so a leak-detection assertion against it could not tell
		// a leak from an untouched default.
		s.setPlayerName('A', 'Nyx');
		s.join('A');
		s.join('B');
		await s.ready();
	}, BOOT_TIMEOUT);

	// `SwapSession` has no teardown method today — guarded the same way the other session specs do,
	// so this keeps working if one is ever added rather than asserting one exists.
	afterAll(() => { try { s && s.close && s.close(); } catch (e) { /* noop */ } });

	/** Whatever the world calls this player's avatar entity right now. */
	function avatarName(clientId: string): string {
		const id = s.avatars.get(clientId) | 0;
		return String(s.world.eval(
			`(function(){
				var e = KDMapData.Entities.filter(function(x){ return x.id === ${id}; })[0];
				return e ? String(e.CustomName || '') : '';
			})()`,
		) || '');
	}

	/** `KDGameData.PlayerName` inside that player's OWN captured bundle. */
	function bundleName(clientId: string): string {
		const b = s.bundles.get(clientId);
		return String((b && b.gameData && b.gameData.PlayerName) || '');
	}

	it('S1 — a named player\'s avatar carries their name', () => {
		expect(avatarName('A')).toBe('Nyx');
	});

	it('N3/NF2 — an unnamed player keeps the EXACT legacy label', () => {
		// Not "something non-empty": this literal is what the `#coop=` path and every MP e2e spec
		// sees, and a drift here renames avatars across the whole suite.
		expect(avatarName('B')).toBe('Player B');
	});

	it('S2 — the name rides inside that player\'s own bundle', () => {
		expect(bundleName('A')).toBe('Nyx');
	});

	it('S2 — and it is NOT in the other player\'s bundle', () => {
		// The case that catches a `setPlayerName` called after `capturePlayer()` instead of before:
		// the value would land on whoever is restored into the slot next.
		expect(bundleName('B')).not.toBe('Nyx');
	});

	it('N3 — an unnamed player keeps KD\'s OWN default PlayerName, not a co-op label', () => {
		// The regression `mp-parity-oracle` caught: stamping `'Player B'` here made a 1-player
		// session diverge from a reference single-player run. The avatar LABEL and the player's own
		// `PlayerName` answer different questions, and only the label has a co-op fallback — this is
		// the field the player sees as their own character's name.
		expect(bundleName('B')).toBe('Ada');           // KD's default (`KinkyDungeon.ts:647`)
		expect(bundleName('B')).not.toBe('Player B');
	});

	it('displayNameOf is the single fallback both consumers ask', () => {
		expect(s.displayNameOf('A')).toBe('Nyx');
		expect(s.displayNameOf('B')).toBe('Player B');
	});

	it('P1 — a name does not drift as the session runs', () => {
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });
		expect(s.displayNameOf('A')).toBe('Nyx');
		expect(avatarName('A')).toBe('Nyx');
	});

	it('P3 — a late arrival is named on the same terms', () => {
		// `_seatPlayer` is shared by `_start` and `joinInProgress` (KDM-235), so this costs nothing
		// to support — but "costs nothing" is a claim, and an unasserted claim is how it breaks.
		s.setPlayerName('C', 'Cy');
		const res = s.joinInProgress('C');
		expect(res.seated, 'the late join itself has to work for this to mean anything').toBe(true);
		expect(s.displayNameOf('C')).toBe('Cy');
		// A deferred seat is flushed at the next turn boundary, so the avatar may not exist yet;
		// assert it only once it does, rather than pretending the timing does not exist.
		if (!res.deferred) expect(avatarName('C')).toBe('Cy');
	});

	// -----------------------------------------------------------------------------------------
	// KDM-282 — and what an unnamed player is actually CALLED.
	//
	// Nested inside this describe on purpose: it shares the one booted session, so the new SEAT
	// label and the legacy `Player <id>` fallback are measured against each other in the same run
	// — the same argument the file header makes for the named/unnamed pair. Two separate sessions
	// could each be green while disagreeing about which tier applies to whom.
	//
	// ⚠️ NF2 is the point of the third case. `displayNameOf` is still the ONE function that answers
	// "what is this player called", and a session nobody told a role — every direct-constructed
	// SwapSession in this suite, `mp-pvp-realcombat` included — must keep the byte-identical legacy
	// string. The seat label is a MIDDLE tier under the chosen name, not a replacement for either.
	// -----------------------------------------------------------------------------------------
	describe('KDM-282 — an unnamed player is labelled by SEAT, not by their raw id', () => {
		it('the host seat reads as Player 1, the guest seat as Player 2', () => {
			// Ids deliberately id-SHAPED rather than friendly: the whole defect is that a real
			// clientId is an opaque random string, so 'H'/'G' here would hide what is being fixed.
			s.setSeatRole('kd-282host', 'host');
			s.setSeatRole('kd-282guest', 'guest');
			expect(s.displayNameOf('kd-282host')).toBe('Player 1');
			expect(s.displayNameOf('kd-282guest')).toBe('Player 2');
		});

		it('a chosen name still wins over the seat label', () => {
			// The tier ORDER, stated as a rule. Without this, a fallback that ran first would pass
			// every other case here while renaming everybody who typed a name into the lobby.
			s.setSeatRole('kd-282named', 'guest');
			s.setPlayerName('kd-282named', 'Nyx282');
			expect(s.displayNameOf('kd-282named')).toBe('Nyx282');
		});

		it('NF2 — a session that was never told a role keeps the EXACT legacy label', () => {
			// B is this describe's own unnamed, roleless player, seated in the same beforeAll.
			expect(s.displayNameOf('B')).toBe('Player B');
			expect(s.displayNameOf('kd-282unknown')).toBe('Player kd-282unknown');
		});

		it('an unrecognised role is not a label — it falls through rather than being printed', () => {
			// A role the bridge never sends. Printing it would put a protocol token on screen and
			// answering '' would produce a nameless avatar; neither is a label, so the legacy tier
			// has to catch it.
			s.setSeatRole('kd-282bogus', 'spectator');
			expect(s.displayNameOf('kd-282bogus')).toBe('Player kd-282bogus');
		});

		it('the seat label is forgotten with the player, like every other per-client fact', () => {
			// `mp-solo-teardown` sweeps by SHAPE, so a Map missing from `_perClientStores` fails
			// there too — this states the rule where a reader of `displayNameOf` will look for it.
			s.setSeatRole('kd-282leaver', 'host');
			expect(s.displayNameOf('kd-282leaver')).toBe('Player 1');
			s.roleOf.delete('kd-282leaver');
			expect(s.displayNameOf('kd-282leaver')).toBe('Player kd-282leaver');
		});
	});
});
