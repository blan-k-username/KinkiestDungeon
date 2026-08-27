/**
 * KDM-238 — each player picks their OWN perks, and gets them.
 *
 * Today both players are perk-identical by construction: `init()` runs `KinkyDungeonStartNewGame` +
 * `KDInitPerks()` once in the world slot (`headless-host.js:607-613`), `_start` captures
 * `_newPlayerTemplate` from that one character (`swap-session.js:331`), and every seat is a restore
 * of it. Neither player ever chose anything, and the one deliberate touch — `_setClassicHeels` —
 * carries a comment saying the MP layer must not choose a player's perks.
 *
 * ── THE MECHANISM UNDER TEST ──────────────────────────────────────────────────────────────────────
 * A perk is not a flag. `KDInitPerks()` (`KinkyDungeonPerks.ts:711`) executes real start-effects:
 * `Submissive` adds a BasicCollar and a BasicLeash, `Studious` adds a spell point, `Unchained` adds
 * a RedKey. So "apply this player's perks" means re-running KD's own `KDInitPerks()` **inside** the
 * `_seatPlayer` window — between `restorePlayer(template)` and `capturePlayer()`, the same slot
 * `setPlayerName` occupies and for the same reason ("ORDER IS THE WHOLE MECHANISM",
 * `swap-session.js:1218`). Applied outside it, one player's starting rope lands on whoever is
 * swapped in next.
 *
 * ── WHY IT IS NOT A VACUOUS GREEN ─────────────────────────────────────────────────────────────────
 *  1. 'The other player is untouched' was this file's central pair, and KDM-271 RETIRED it: a start
 *     perk turned out to be the PARTY's, because several perks rewrite the shared world and are read
 *     from whichever bundle is swapped in (KDM-242 F9/F10). The assertions that used to read
 *     `not.toContain` now read `toContain` and say so at each site. What keeps them non-vacuous is a
 *     perk NOBODY declared, asserted absent — see `mp-party-start-perks.spec.ts`, which owns the
 *     union rule and its controls.
 *  2. The assertion is on the START-EFFECT (a BasicCollar on the body), not merely on the flag in
 *     the map. Writing the map without running `KDInitPerks` would pass a flag-only check while
 *     giving the player nothing, which is the actual bug this feature exists to avoid.
 *  3. Validity is asserted through KD's OWN table: a garbage key is dropped because
 *     `KinkyDungeonStatsPresets` does not have it, not because this layer keeps a list — and the
 *     source guard below fails if a perk name is ever written into `tools/mp-server/**`.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JoinGate, sanitizePerks, PERKS_MAX } = require('../../tools/mp-server/join-gate');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;
const BUILD = 'kd-5.5.0-abc123';

// ---------------------------------------------------------------------------------------------
// The pure half: what a client is allowed to declare. No socket, no world — milliseconds.
// ---------------------------------------------------------------------------------------------
describe('KDM-238 — sanitizePerks (R8)', () => {
	it('answers an empty list for anything that is not a list of strings', () => {
		expect(sanitizePerks(undefined)).toEqual([]);
		expect(sanitizePerks(null)).toEqual([]);
		expect(sanitizePerks('Submissive')).toEqual([]);        // a bare string is not a declaration
		expect(sanitizePerks({ Submissive: true })).toEqual([]);
		expect(sanitizePerks([1, {}, null, undefined])).toEqual([]);
	});

	it('trims, and strips control characters rather than letting them reach an eval', () => {
		// Built with fromCharCode on purpose — a literal NUL is invisible in review and trivially
		// lost to a copy-paste, which would leave this case asserting nothing while still passing.
		const NUL = String.fromCharCode(0);
		const ESC = String.fromCharCode(27);
		expect(sanitizePerks(['  Submissive  '])).toEqual(['Submissive']);
		expect(sanitizePerks(['Sub' + NUL + ESC + 'missive'])).toEqual(['Submissive']);
	});

	it('drops duplicates — a declaration is a set, and KDInitPerks must not run a perk twice', () => {
		expect(sanitizePerks(['Studious', 'Studious'])).toEqual(['Studious']);
	});

	it('caps the COUNT, so a malformed message cannot wedge the session', () => {
		const many = Array.from({ length: PERKS_MAX + 50 }, (_, i) => 'P' + i);
		expect(sanitizePerks(many).length).toBe(PERKS_MAX);
	});

	it('caps each KEY, for the same reason', () => {
		expect(sanitizePerks(['A'.repeat(500)])[0].length).toBeLessThanOrEqual(64);
	});

	it('drops MagicHands — it is KDInitPerks\' own sentinel, not a player choice (R11)', () => {
		// `KDInitPerks` sets it before its loop and deletes it after unless the player already had it
		// (`KinkyDungeonPerks.ts:712-715, :729-730`). Carried as a chosen perk it would survive that
		// delete and silently change what the start scenarios do.
		expect(sanitizePerks(['MagicHands'])).toEqual([]);
		expect(sanitizePerks(['Submissive', 'MagicHands'])).toEqual(['Submissive']);
	});

	it('does NOT judge whether a perk exists — that is KD\'s table to answer, not ours (R2)', () => {
		// The gate cannot validate names without a perk list, and a perk list in tools/mp-server/**
		// is what epic AC2 forbids. An unknown key passes the gate and is dropped by `applyPerks`,
		// which asks `KinkyDungeonStatsPresets`. Asserted so nobody "fixes" this into a whitelist.
		expect(sanitizePerks(['NoSuchPerkAtAll'])).toEqual(['NoSuchPerkAtAll']);
	});
});

describe('KDM-238 — JoinGate carries the declaration on the SEAT (R3)', () => {
	let g: any;
	beforeEach(() => { g = new JoinGate({ build: BUILD }); });

	it('a host declares their own perks with their claim', () => {
		g.claimHost('H', { build: BUILD, character: { perks: ['Submissive'] } });
		expect(g.perksOf('H')).toEqual(['Submissive']);
	});

	it('a host who declares nothing simply has none, and is not refused', () => {
		const r = g.claimHost('H', { build: BUILD });
		expect(r.accept).toBe(true);
		expect(g.perksOf('H')).toEqual([]);
	});

	it('asking is not being seated — the declaration is promoted only on accept', () => {
		g.claimHost('H', { build: BUILD });
		g.requestJoin('G', { name: 'Bob', build: BUILD, character: { perks: ['Studious'] } });
		expect(g.perksOf('G'), 'a pending requester holds no seat, so holds no perks').toEqual([]);
		g.accept();
		expect(g.perksOf('G')).toEqual(['Studious']);
	});

	it('declining leaves no declaration behind', () => {
		g.claimHost('H', { build: BUILD });
		g.requestJoin('G', { build: BUILD, character: { perks: ['Studious'] } });
		g.decline();
		expect(g.perksOf('G')).toEqual([]);
	});

	// The `release` / `releasePending` pair, exactly as the NAME follows it (KDM-237 P2). A dropped
	// player still owns their seat and must come back as themselves — including their perks, or a
	// reconnect would hand them a differently-built character.
	it('a DROPPED player keeps their perks: releasePending frees the question, not the seat', () => {
		g.claimHost('H', { build: BUILD, character: { perks: ['Submissive'] } });
		g.releasePending('H');
		expect(g.perksOf('H')).toEqual(['Submissive']);
	});

	it('a player who gives the seat up loses the declaration with it', () => {
		g.claimHost('H', { build: BUILD, character: { perks: ['Submissive'] } });
		g.release('H');
		expect(g.perksOf('H')).toEqual([]);
	});

	it('perksOf hands back a COPY — a caller cannot edit what the session believes', () => {
		g.claimHost('H', { build: BUILD, character: { perks: ['Submissive'] } });
		g.perksOf('H').push('Studious');
		expect(g.perksOf('H')).toEqual(['Submissive']);
	});

	it('an unknown id has no perks, and asking does not create anything', () => {
		expect(g.perksOf('NOBODY')).toEqual([]);
		expect(g.players()).toEqual([]);
	});
});

// ---------------------------------------------------------------------------------------------
// R2 / R10 as a SOURCE guard: one mechanism, and no perk names of our own.
// ---------------------------------------------------------------------------------------------
describe('KDM-238 — the MP layer names no perk and sets none by hand (R2, R10)', () => {
	const MP_DIR = path.resolve(__dirname, '../../tools/mp-server');

	/** Strip comments and template literals so PROSE about a deleted call cannot trip the guard. */
	function codeOnly(src: string): string {
		return src
			.replace(/\/\*[\s\S]*?\*\//g, ' ')
			.replace(/(^|[^:])\/\/.*$/gm, '$1 ');
	}

	/** `KinkyDungeonStatsChoice.set("SomePerk", …)` — a perk chosen in our source. */
	const LITERAL_SET = /KinkyDungeonStatsChoice\s*\.\s*set\s*\(\s*['"]/;

	it('SELF-CHECK: the detector still recognises the call KDM-238 deletes', () => {
		// A green from a regex that has quietly stopped matching is worthless, and this one greps
		// source. Prove it against the real line being removed (`swap-session.js:1619`).
		expect(LITERAL_SET.test(codeOnly('\t\t\t\tKinkyDungeonStatsChoice.set("ClassicHeels", true);'))).toBe(true);
		expect(LITERAL_SET.test(codeOnly('KinkyDungeonStatsChoice.set(key, true);')), 'set from a VARIABLE is the allowed shape').toBe(false);
	});

	it('no source file sets a perk by literal name', () => {
		const offenders = fs.readdirSync(MP_DIR)
			.filter((f: string) => f.endsWith('.js'))
			.filter((f: string) => LITERAL_SET.test(codeOnly(fs.readFileSync(path.join(MP_DIR, f), 'utf8'))));
		expect(offenders, 'a perk name here is the MP layer choosing for the player (KDM-164)').toEqual([]);
	});

	it('R10 — `_setClassicHeels` is gone; there is exactly one way to put a perk on a player', () => {
		const src = fs.readFileSync(path.join(MP_DIR, 'swap-session.js'), 'utf8');
		expect(codeOnly(src)).not.toMatch(/_setClassicHeels/);
	});
});

// ---------------------------------------------------------------------------------------------
// The session half, on ONE real booted world carrying both the perked and the unperked player.
// ---------------------------------------------------------------------------------------------
describe('KDM-238 — the choice reaches the world, and only its owner (R4, R5, R6, R8)', () => {
	let s: any = null;

	beforeAll(async () => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'perk-choice' });
		// A declares; B declares NOTHING — B is the `#coop=` path (R9). Since KDM-271 that no longer
		// means B has no perks: it means B chose none, and plays the party's set.

		// `Submissive` on purpose: its start-effect is two visible restraints, so the assertion can be
		// about what is on the body rather than about a flag in a map.
		// The garbage key rides along to prove KD's own table is what rejects it (R8).
		s.setCharacter('A', { perks: ['Submissive', 'NoSuchPerkAtAll'] });
		s.join('A');
		s.join('B');
		await s.ready();
	}, BOOT_TIMEOUT);

	afterAll(() => { try { s && s.close && s.close(); } catch (e) { /* noop */ } });

	/** The perk keys actually switched on inside that player's OWN captured bundle. */
	function perksIn(clientId: string): string[] {
		s.world.restorePlayer(s.bundles.get(clientId));
		return (s.world.eval(`(function(){
			if (typeof KinkyDungeonStatsChoice === 'undefined' || !KinkyDungeonStatsChoice) return [];
			return Array.from(KinkyDungeonStatsChoice.keys())
				.filter(function(k){ return KinkyDungeonStatsChoice.get(k); });
		})()`) || []) as string[];
	}

	/** The restraint names worn by that player, from KD's own accessor. */
	function restraintsIn(clientId: string): string[] {
		s.world.restorePlayer(s.bundles.get(clientId));
		return (s.world.eval(`(function(){
			if (typeof KinkyDungeonAllRestraint !== 'function') return [];
			return KinkyDungeonAllRestraint().map(function(r){ return String(r && r.name || ''); });
		})()`) || []) as string[];
	}

	it('R4 — the perk a player chose is in that player\'s own bundle', () => {
		expect(perksIn('A')).toContain('Submissive');
	});

	it('KDM-271 — and in the PARTNER\'s too: a start perk is the party\'s', () => {
		// SUPERSEDED, deliberately. This assertion used to be `not.toContain` — R6, "the perk is NOT
		// in the other player's bundle". F10 of KDM-242 showed that rule is the shipped defect:
		// `Stealthy`, `Pristine`, `Fortify_Barricade` and friends are read from whichever bundle is
		// swapped in when the floor is generated, so a perk one seat holds and another does not makes
		// the map depend on swap order. KDM-271 unions the declarations across the party.
		// The property R6 actually protected — `applyPerks` running INSIDE the seating window rather
		// than after `capturePlayer()` — is still covered: it is what makes `perksIn` non-empty at all,
		// and `mp-party-start-perks.spec.ts` pins the union with an undeclared control key.
		expect(perksIn('B')).toContain('Submissive');
	});

	it('R5 — the perk\'s START-EFFECT landed, not just the flag', () => {
		// `Submissive` adds a BasicCollar and a BasicLeash (`KinkyDungeonPerks.ts:737-740`). Writing
		// the map without running KDInitPerks would pass the flag assertion above and give the player
		// nothing — this is the assertion that separates the two.
		expect(restraintsIn('A')).toEqual(expect.arrayContaining(['BasicCollar', 'BasicLeash']));
	});

	it('KDM-271 — and the partner is wearing it too, because a seat is built from the party set', () => {
		// Also superseded (was `not.toContain('BasicCollar')`). A seat is a fresh character built from
		// KD's own template, so `applyPerks` runs `KDInitPerks()` over the whole party set.
		expect(restraintsIn('B')).toContain('BasicCollar');
	});

	it('R8 — an unknown perk key is dropped by KD\'s own table, not applied', () => {
		expect(perksIn('A')).not.toContain('NoSuchPerkAtAll');
	});

	it('R9 — a player who declared nothing is still seated on KD\'s default terms', () => {
		// What survives KDM-271: B DECLARED nothing, and the session still says so. What the party
		// plays with is a separate question, answered by `partyPerks()`.
		expect(s.perksOf('B')).toEqual([]);
		expect(perksIn('B'), 'and a perk NOBODY declared is on nobody').not.toContain('Pacifist');
	});

	it('P1 — a perk does not drift as the session runs', () => {
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });
		expect(perksIn('A')).toContain('Submissive');
		expect(perksIn('B')).toContain('Submissive');
	});

	it('P3 — a LATE arrival is perked on the same terms', () => {
		// `_seatPlayer` is shared by `_start` and `joinInProgress` (KDM-235), so this costs nothing to
		// support — but "costs nothing" is a claim, and an unasserted claim is how it breaks.
		s.setCharacter('C', { perks: ['Studious'] });
		const res = s.joinInProgress('C');
		expect(res.seated, 'the late join itself has to work for this to mean anything').toBe(true);
		expect(perksIn('C')).toContain('Studious');
		// KDM-271 (was `not.toContain`): the late arrival widens the PARTY's set, so it does reach the
		// seats already taken — see `mp-party-start-perks.spec.ts` for what that grant is and is not.
		expect(perksIn('A'), 'and the party caught up with it').toContain('Studious');
	});
});
