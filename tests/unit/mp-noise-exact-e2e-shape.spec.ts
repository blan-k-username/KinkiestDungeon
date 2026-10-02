/**
 * Node-layer (Vitest) — reproduces the e2e `mp-presentation-once.spec.ts` scenario EXACTLY at the
 * SwapSession layer (no browsers, no WS, no host contention): the session's real fixed seed
 * (`demo-server.js`'s `'coop-demo-seed'`), the default party spawn (ADJACENT, like `bootCoopPair`),
 * the shared enemy repositioned via `tilesAtRange(s, 'A', 6, 10)` exactly as the e2e spec does, both
 * players submitting 'wait' each round, checking `snapshotFor('A').events` for a noise event — up to
 * 24 rounds, matching the e2e spec's own retry budget.
 *
 * This is what actually found the real bug: every one of the 45 free candidate tiles in that ring
 * around A ties EXACTLY in Chebyshev distance with B too (A and B start one tile apart), so a fix
 * that keeps the sticky target on any tie (or near-tie) reduces to "whichever human the FIRST round's
 * tie-break happened to favour, forever" — the original permanent-lock bug, just hidden behind a
 * distance comparison that is always a tie in practice. See `headless-host.js`'s `__kdSlotChoose` for
 * the actual fix (gate stickiness on `enemy.aware`, not on distance) and
 * `mp-noise-sticky-lock-repro.spec.ts` for the isolated diagnostic.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
import { tilesAtRange } from '../helpers/session-tiles';

const BOOT_TIMEOUT = 240_000;

const isShock = (e: any) => !!e && e.kind === 'noise'
	&& (((e.shockwaves || []).length + (e.sounddesc || []).length) > 0);

describe('exact e2e-shape repro: noise reaches A over many rounds with the real turn-order shuffle', () => {
	it('delivers at least one ripple to A within 24 rounds, cycling an unseen enemy near A', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'coop-demo-seed', enemyType: 'Rat', pvp: false });
		s.join('A'); s.join('B');
		await s.ready();
		expect(s.enemyId).not.toBeNull();

		const spots = tilesAtRange(s, 'A', 6, 10);
		expect(spots.length, 'precondition: somewhere to put an unseen enemy').toBeGreaterThan(0);

		// Document the geometry this scenario actually exercises: with the default (adjacent) spawn,
		// every candidate tile ties in distance with B too, so this test only means something if the
		// fix handles ties correctly, not merely "when A happens to be strictly nearest".
		const posA0 = s.posOf('A'); const posB0 = s.posOf('B');
		const cheb = (p: any, q: any) => Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y));
		const tied = spots.filter((sp: any) => cheb(sp, posA0) === cheb(sp, posB0));
		expect(tied.length, 'setup: this scenario is dominated by exact ties with B (the real bug shape)')
			.toBe(spots.length);

		let delivered = 0;
		for (let i = 0; i < 24 && delivered === 0; i++) {
			const spot = spots[(i * 7) % spots.length];
			s.world.moveAvatar(s.enemyId, spot.x, spot.y);
			s.submit('A', { kind: 'wait' });
			s.submit('B', { kind: 'wait' });
			delivered += (s.snapshotFor('A').events || []).filter(isShock).length;
		}
		expect(delivered, 'real snapshots must still queue ripples for A within 24 rounds').toBeGreaterThan(0);
	}, BOOT_TIMEOUT);
});
