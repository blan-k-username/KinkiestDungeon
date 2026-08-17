/**
 * Node-layer (Vitest): the OTHER consume-once presentation queues are delivered once, not replicated.
 *
 * KDM-196, the sibling of the KDDamageQueue fix (KDM-186). UAT: *"when I move my mouse very often over
 * Player A (on Player B's screen), I see spam of sound echo animation"* — spam that scales with the
 * SNAPSHOT RATE rather than with game events, which is the signature of one-shot presentation output
 * being replicated as ordinary state.
 *
 * MEASURED root cause (diagnostic, before this fix): `KDEventData` is a WATCHED global, and its
 * `shockwaves` / `sounddesc` members are consume-once presentation queues. They are pushed by the
 * enemy-noise path (`KinkyDungeonEnemies.ts:9607`) and drained by the DRAW layer
 * (`KinkyDungeonEvents.ts` → `afterDrawFrame`/`shockwave`, which clears the array after emitting).
 * The headless server has no draw loop, so it never drained them: six real turns left six undrained
 * shockwaves in the capture, and every snapshot re-shipped all six.
 *
 *     [diag] KDEventData = {"sounddesc":[],"shockwaves":[{...},{...},{...},{...},{...},{...}]}
 *
 * Fix, exactly as for KDDamageQueue: the presentation queues never cross the wire as STATE, and what
 * the player must be shown crosses as a SEQUENCED EVENT applied at most once.
 *
 * ⚠️ The anti-deletion assertions below are load-bearing (AC3): "no duplicates" must not be achievable
 * by presenting nothing. REPRO 3 v1 of KDM-186 fell into exactly that trap.
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

/** Both players take a real turn; A walks so the world ticks and enemies make noise. */
function walkTurn(s: any, dx: number, dy: number) {
	s.submit('A', { kind: 'move', dx, dy });
	s.submit('B', { kind: 'wait' });
}

/** A noise event that actually carries a ripple / echo to draw (an empty one only CLEARS). */
const isShock = (e: any) => !!e && e.kind === 'noise'
	&& (((e.shockwaves || []).length + (e.sounddesc || []).length) > 0);

describe('KDM-196: consume-once presentation queues', () => {
	let s: any;
	let firstEvents: any[] = [];

	beforeAll(() => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'diag-196b' });
		s.join('A');
		s.join('B');
		// Six real turns — the exact sequence the diagnostic measured six undrained shockwaves for.
		for (let i = 0; i < 6; i++) walkTurn(s, 1, 0);
		firstEvents = (s.snapshotFor('A').events || []).filter(isShock);
	}, BOOT_TIMEOUT);

	it('ANTI-DELETION: the ripples still reach the client, as sequenced events', () => {
		// If this ever goes to zero the "no duplicates" assertions below become vacuous: the bug would
		// have been "fixed" by never showing the animation at all.
		expect(firstEvents.length).toBeGreaterThan(0);
		for (const e of firstEvents) expect(e.seq).toBeGreaterThan(0);
	}, BOOT_TIMEOUT);

	it('the wire bundle never carries KDEventData presentation queues as state', () => {
		for (let i = 0; i < 3; i++) {
			const g = s.snapshotFor('A').bundle.globals || {};
			const ed = g.KDEventData;
			if (!ed) continue;
			expect(ed.shockwaves, 'shockwaves must not travel as replicated state').toBeUndefined();
			expect(ed.sounddesc, 'sounddesc must not travel as replicated state').toBeUndefined();
		}
	}, BOOT_TIMEOUT);

	it('re-snapshotting WITHOUT a turn delivers no repeat (the mouse-move spam)', () => {
		// Three snapshots with no game event in between — what a moving mouse produces.
		const a = (s.snapshotFor('A').events || []).filter(isShock);
		const b = (s.snapshotFor('A').events || []).filter(isShock);
		const c = (s.snapshotFor('A').events || []).filter(isShock);
		expect(a.length + b.length + c.length).toBe(0);
	}, BOOT_TIMEOUT);

	it('a NEW turn still produces new ripples, with fresh sequence ids', () => {
		const seen = Math.max(0, ...firstEvents.map((e: any) => e.seq));
		let fresh: any[] = [];
		for (let i = 0; i < 6 && !fresh.length; i++) {
			walkTurn(s, i % 2 ? -1 : 1, 0);
			fresh = (s.snapshotFor('A').events || []).filter(isShock);
		}
		expect(fresh.length, 'later turns must still be able to produce ripples').toBeGreaterThan(0);
		for (const e of fresh) expect(e.seq).toBeGreaterThan(seen);
	}, BOOT_TIMEOUT);
});
