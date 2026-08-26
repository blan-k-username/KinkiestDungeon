/**
 * Node-layer (Vitest) — KDM-275: the run saves itself, so closing the tab does not cost it.
 *
 * [[KDM-244]] built the whole export chain and wired it to two EXPLICIT moments (a context-menu entry
 * and "go on alone"). Neither fires when the host closes the tab, the browser crashes, or — the event
 * that actually destroys a run — the server process stops. This spec covers the trigger that fixes
 * that, and only the trigger: the export mechanism itself is `mp-save-export.spec.ts`'s subject and
 * is not re-tested here.
 *
 * ── WHAT "CORRECT" MEANS HERE, AND WHERE IT COMES FROM ────────────────────────────────────────────
 * Not from us. KD's own settings screen tells the player, in words, what it will do:
 *
 *   Save Codes (KD's DEFAULT)  "Grants a save code every floor you can write down.
 *                               Autosaves only on floor start."     Text_KinkyDungeon.csv:8589
 *   Roguelike                  "No save codes, forced autosaves."   Text_KinkyDungeon.csv:8590
 *
 * `KDPostStairSave` (`KDStairActions.ts:265-275`) is the floor-start half — unconditional, in BOTH
 * modes. The tick timer at `KinkyDungeonDraw.ts:1114-1119` is the Roguelike-only half, gated on
 * `KinkyDungeonStatsChoice.get("saveMode")`. So co-op owes a floor trigger to everyone and a timer
 * to Roguelike hosts, and a co-op host must never be worse off than a single-player one.
 *
 * ── THE FOUR WAYS THIS SPEC COULD GO GREEN WHILE BEING WRONG ──────────────────────────────────────
 * Every one of them is paired with a control, because each is an assertion this repo has been
 * burned by before:
 *
 *  1. "An export was armed after a descent" passes if an export is armed on EVERY turn. → test 1
 *     takes an ordinary turn first and requires NOTHING, and test 3 requires nothing on the turn
 *     AFTER (memory `vacuous_oracle_divergence`).
 *  2. "No timer export in Save Codes mode" is an absence that is ALREADY absent — `saveMode` is
 *     `undefined` in a default session (measured). → paired with test 5, the same shape with the
 *     mode ON, which must fire (memory: pair every absence with a same-shape control).
 *  3. A descent that never moves the party still "descends". `descend()` documents two traps that
 *     make exactly that pass. → every floor test asserts `mapId()` actually CHANGED, and imports the
 *     shared helper rather than hand-rolling a third copy of it.
 *  4. Asserting a flag rather than a count hides a flag that latches. → test 3 pins the one-shot.
 *
 * NOTE: imports the harness under tools/mp-server/** (test/tooling code), never Game/src/**.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { descend, mapId } from './helpers/world';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT = 240_000;

/** Small on purpose: the cadence is a session option, so a spec never waits out KD's real 50. */
const EVERY = 4;

/** Resolve one full lockstep turn and hand back what the session reported. */
function turn(s: any): any {
	s.submit('A', { kind: 'wait' });
	return s.submit('B', { kind: 'wait' });
}

/**
 * A two-player session, host A, guest B — in KD's DEFAULT save mode unless `roguelike` says otherwise.
 *
 * ⚠️ ROGUELIKE IS DECLARED, NOT POKED IN. The first draft of this fixture set the mode by calling
 * `world.applyModes(...)` on the live world after seating, and every timer test failed with the
 * timer never firing. That was the FIXTURE being wrong, and it is worth recording because the trap is
 * invisible: `KinkyDungeonStatsChoice` is captured **per player** (`game-modes.js`'s whole subject),
 * so every swap restores the acting player's copy over the world's — and a value written into the
 * world behind the bundles' backs survives exactly until the next player moves.
 *
 * `setWorldOptions` is the path production uses: the gate carries the host's declaration to the
 * session (`ws-bridge.js` `_carrySeat`), `_start` hands it to `world.init({worldModes})`, and every
 * seat is then built with it. Declaring it here means these tests exercise a host who really did pick
 * Roguelike in their own game, rather than a world state no session can actually be in.
 */
function session(seed: string, roguelike = false): any {
	const s = new SwapSession({ requiredPlayers: 2, seed, pvp: false, exportEveryTurns: EVERY });
	// Before either join: `_start` fires on the SECOND one, and the declaration must be in hand by
	// then or the world is built without it.
	if (roguelike) s.setWorldOptions('A', { modes: ['saveMode'], seed: '' });
	s.join('A');
	s.join('B');
	return s;
}

describe('KDM-275 — the floor trigger fires for every host, in every save mode', () => {
	let s: any;
	beforeAll(() => { s = session('kdm275-floor'); }, BOOT);

	it('CONTROL — an ordinary turn arms no export', () => {
		// Without this, every "a descent armed an export" assertion below is unfalsifiable: it would
		// pass just as well for an implementation that armed one on every single turn.
		expect(turn(s).exportDue, 'nothing happened, so nothing is owed').toBeFalsy();
	}, BOOT);

	it('R5 — a real map change arms a floor export, in KD\'s DEFAULT save mode', () => {
		// The precondition the whole test rests on: this session is in Save Codes mode, the mode KD
		// ships. If the implementation only ever exported for Roguelike hosts, this is the test that
		// must fail.
		expect(s.world.eval('KinkyDungeonStatsChoice.get("saveMode")'),
			'the fixture must be in KD\'s DEFAULT mode, or this proves nothing about it').toBeFalsy();

		const before = mapId(s);
		expect(descend(s, 'A')).toBe('ok');
		const after = mapId(s);
		// Trap 3: `descend` can return 'ok' without moving anybody. Then "no export" would be correct
		// and "an export" would be a bug — either way the assertion below would mean nothing.
		expect(after, 'the party must really be on a different map').not.toBe(before);

		expect(turn(s).exportDue).toBe('floor');
	}, BOOT);

	it('R5b — the flag is one-shot: the very next turn arms nothing', () => {
		// A latched flag would export on every turn for the rest of the session and still pass test 2.
		expect(turn(s).exportDue, 'consumed where it was read, not left standing').toBeFalsy();
	}, BOOT);
});

describe('KDM-275 — the timer is Roguelike-only, and that is measured both ways', () => {
	it('CONTROL (R5a) — Save Codes mode: no timer export, however long the party plays', () => {
		const s = session('kdm275-timer-off');
		expect(s.world.eval('KinkyDungeonStatsChoice.get("saveMode")')).toBeFalsy();
		const armed: any[] = [];
		for (let i = 0; i < EVERY * 3; i++) { const r = turn(s); if (r.exportDue) armed.push(r.exportDue); }
		// Asserts the COUNT over a known number of turns, not "the last turn was quiet" — a timer that
		// fired once at turn 5 and never again would pass the weaker form.
		expect(armed, 'KD does not autosave on a timer in this mode, so neither do we').toEqual([]);
	}, BOOT);

	it('R5a — Roguelike mode: the timer arms exactly once per interval', () => {
		const s = session('kdm275-timer-on', true);
		expect(s.world.eval('KinkyDungeonStatsChoice.get("saveMode")'),
			'the control above is only meaningful if this really differs').toBe(true);

		const armed: any[] = [];
		for (let i = 0; i < EVERY * 3; i++) { const r = turn(s); if (r.exportDue) armed.push(r.exportDue); }
		expect(armed).toEqual(['timer', 'timer', 'timer']);
	}, BOOT);

	it('R5b — a floor transition resets the timer instead of doubling up with it', () => {
		const s = session('kdm275-timer-reset', true);
		// One turn short of the interval, so the timer is primed and would fire on the next turn.
		for (let i = 0; i < EVERY - 1; i++) expect(turn(s).exportDue).toBeFalsy();

		const before = mapId(s);
		expect(descend(s, 'A')).toBe('ok');
		expect(mapId(s), 'the party must really be on a different map').not.toBe(before);

		// The transition wins, and it also puts the clock back to zero…
		expect(turn(s).exportDue).toBe('floor');
		// …so the turn that WOULD have been the timer's is quiet.
		expect(turn(s).exportDue, 'a transition resets the counter; it does not race it').toBeFalsy();
	}, BOOT);
});

/**
 * KDM-275 R6/R7 — the two halves agree about what an AUTOMATIC export is called.
 *
 * `reason` is text-coupled across a boundary no import can cross: the session emits it
 * (`swap-session.js`), and `client/coop-bootstrap.js` is a browser script that cannot `require` a
 * shared constant. That is exactly the class of silent drift [[KDM-274]] was filed for, and the
 * failure is quiet in the worst direction — rename `'floor'` server-side and the client stops
 * recognising it as automatic, so every host gets a status line on every floor. Nothing else in the
 * suite would notice: the wire test still passes, the trigger still fires, the run still saves.
 *
 * So this asserts the coupling itself, on the real files. It is the same instrument
 * `mp-peace-hub-reset` uses to keep the hub-room list at one definition.
 */
describe('KDM-275 — the client recognises every reason the server can send', () => {
	it('each automatic reason the session emits is named in the client handler', async () => {
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const read = (p: string) => readFileSync(resolve(__dirname, '../../tools/mp-server/' + p), 'utf8');

		// What the session can actually arm, taken from the source rather than restated here — a list
		// maintained in the test is a third copy that can drift from both of the other two.
		const emitted = [...read('swap-session.js').matchAll(/this\._exportDue = '([a-z]+)'/g)].map((m) => m[1]);
		// CONTROL: if the scrape found nothing, every assertion below is vacuously true.
		expect(emitted.sort(), 'the scrape must actually see the session\'s reasons').toEqual(['floor', 'timer']);

		const client = read('client/coop-bootstrap.js');
		for (const r of emitted) {
			expect(client, `client/coop-bootstrap.js must treat '${r}' as an automatic export`)
				.toContain(`m.reason === '${r}'`);
		}
	});
});
