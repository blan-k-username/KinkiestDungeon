/**
 * KDM-269 — the drop-report family is declared ONCE, and every member reaches the player.
 *
 * There are four ways a real player action produces nothing — no handler (`unknownInputs`, KDM-163),
 * displaced out of the lockstep slot (`replacedInputs`, KDM-163), a peer took the contested tile
 * (`cancelledMoves`, KDM-208), the dispatch threw (`failedInputs`, KDM-268). Each used to be written
 * out by hand in four places: a field in the constructor, a `*Report()` accessor, a `snap.*` line,
 * and a `_dbg` at the call site.
 *
 * THE FAILURE THIS GUARDS. Forgetting the `snap.*` line is **silent**: the recording works, every
 * accessor answers correctly, and nothing at all reaches the browser. That is the exact bug KDM-268
 * existed to fix, so a refactor that makes it easy to reintroduce would be a bad trade.
 *
 * WHY THESE ASSERTIONS ARE DERIVED FROM THE REGISTRY. A test that named the four fields by hand
 * would pass forever for a fifth channel nobody wired up — it would be testing the list it was
 * written against, not the list the session actually has. Every case below iterates
 * `DROP_CHANNELS`, so a new entry is covered the moment it is declared, without anyone remembering
 * to come back here.
 *
 * Requirement ids refer to the `## Requirements (EARS)` section of KDM-269.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession, DROP_CHANNELS } = require('../../tools/mp-server/swap-session');

/** The four the family has today. Named ONCE, as a guard that the registry has not silently shrunk. */
const KNOWN = ['unknownInputs', 'replacedInputs', 'cancelledMoves', 'failedInputs'];

describe('KDM-269 — drop channels are declared once', () => {

	it('the registry is the family, and it has not lost a member (R1)', () => {
		const fields = DROP_CHANNELS.map((c: any) => c.field);
		// Both directions: a member silently dropped from the registry fails the first, and a member
		// added without updating this file fails the second — which is the prompt to think about
		// whether the new one needs anything the others did not.
		for (const k of KNOWN) expect(fields, `${k} is no longer a declared drop channel`).toContain(k);
		expect(fields.length, 'a channel was added — check it needs nothing beyond the registry').toBe(KNOWN.length);
	});

	it('R2/R3 — every channel has its wire field and its accessor, under the exact published names', () => {
		const s = new SwapSession({ requiredPlayers: 1, seed: 'drop-channels' });
		for (const c of DROP_CHANNELS) {
			// R3: the accessor names are irregular (`cancelledMoveReport`, not `cancelledMovesReport`)
			// and are called from ~10 spec files, so they are API and not an implementation detail.
			expect(typeof s[c.report], `${c.field}: accessor ${c.report}() is missing`).toBe('function');
			expect(Array.isArray(s[c.report]()), `${c.report}() must answer an array`).toBe(true);
			// R2: the wire field is the field name itself — four separate additive fields, so an older
			// client is unaffected. If this ever stops holding, it is a client-compat decision.
			expect(typeof c.field, 'the wire field name').toBe('string');
		}
	});

	it('R5 — every declared channel is carried into the snapshot', async () => {
		const s = new SwapSession({ requiredPlayers: 1, seed: 'drop-channels-snap' });
		s.join('A');
		const snap = s.snapshotFor('A');
		for (const c of DROP_CHANNELS) {
			// THE assertion this file exists for. A channel that records perfectly and is never put on
			// `snap` is invisible to the player, and nothing else in the suite would notice.
			expect(snap, `${c.field} is declared but never reaches the snapshot`).toHaveProperty(c.field);
			expect(Array.isArray(snap[c.field]), `snap.${c.field} must be an array`).toBe(true);
		}
	});

	/**
	 * Control for the case above. `toHaveProperty` on a bag of ~40 snapshot keys is exactly the shape
	 * that passes for the wrong reason, so a name the session has never heard of must NOT be present —
	 * otherwise "every channel is carried" would be true of any string at all.
	 */
	it('control — a field that is not a declared channel is absent from the snapshot', () => {
		const s = new SwapSession({ requiredPlayers: 1, seed: 'drop-channels-control' });
		s.join('A');
		expect(s.snapshotFor('A')).not.toHaveProperty('__kdm269_not_a_channel');
	});

	it('R4 — every channel is bounded by maxLog, through the one _recordDrop', () => {
		const s = new SwapSession({ requiredPlayers: 1, seed: 'drop-channels-bound', maxLog: 5 });
		for (const c of DROP_CHANNELS) {
			if (c.field === 'unknownInputs') continue;   // a Map of counts; bounded by the type space
			for (let i = 0; i < 12; i++) s._recordDrop(s[c.field], { clientId: 'A', turn: i });
			expect(s[c.report]().length, `${c.field} is not bounded by maxLog`).toBe(5);
			// Trimmed from the FRONT: the newest drops are the ones worth keeping.
			expect(s[c.report]().pop().turn, `${c.field} kept the wrong end`).toBe(11);
		}
	});

	it('a fresh session starts every channel empty — no leakage between runs', () => {
		const s = new SwapSession({ requiredPlayers: 1, seed: 'drop-channels-fresh' });
		for (const c of DROP_CHANNELS) {
			expect(s[c.report](), `${c.field} did not start empty`).toEqual([]);
		}
	});
});
