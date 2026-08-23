/**
 * KDM-249 Phase B — the mod declaration on the join handshake (`tools/mp-server/join-gate.js`).
 *
 * The gate already carries a per-client `build` and refuses a skewed pair before the host is ever
 * prompted (KDM-233 N1). A mod set rides on the same handshake — and the whole point of these tests
 * is that it must behave DIFFERENTLY from `build` in one specific way:
 *
 *   A BUILD MISMATCH CANNOT WORK, SO IT IS REFUSED. A MOD DIFFERENCE ONLY DEGRADES PRESENTATION,
 *   SO IT MUST NOT BE (R4).
 *
 * Two different builds desync and there is nothing to be done about it. Two different mod sets just
 * mean the guest may see missing sprites — and the entire remedy for that is to ship the files, which
 * cannot happen if the join was refused first. Turning a mod difference into a refusal would make
 * this task's feature unreachable, so it gets its own test rather than being left to prose.
 *
 * "HOST IS SOURCE OF TRUTH" (owner, 2026-08-22) is implemented here exactly as it already is for
 * `build`: the host's declaration, adopted on `claimHost`, IS the session's.
 *
 * Requirement ids refer to `## Requirements (decided)` in KDM-249.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JoinGate } = require('../../tools/mp-server/join-gate');

const BUILD = 'kd-5.5.0-abc123';

function mod(modname: string, hash: string, priority = 0) {
	return { name: `${modname.toLowerCase()}.zip`, modname, modbuild: 'x', priority, hash };
}

const HOST_MODS = [mod('Art', 'h-art'), mod('Text', 'h-text')];

describe('KDM-249 — the mod set on the join gate', () => {
	let g: any;
	beforeEach(() => { g = new JoinGate({ build: BUILD }); });

	describe('the host declares the session mod set (R2)', () => {
		it('claimHost adopts the host\'s declaration', () => {
			g.claimHost('H', { build: BUILD, mods: HOST_MODS });
			expect(g.hostMods().map((m: any) => m.hash)).toEqual(['h-art', 'h-text']);
		});

		it('a host that declares nothing leaves the session with an empty set, not undefined', () => {
			// Callers iterate this; an undefined here would be a crash at the far end of the handshake.
			g.claimHost('H', { build: BUILD });
			expect(g.hostMods()).toEqual([]);
		});

		it('a re-claiming host REPLACES the set — they are the source of truth, including when they change', () => {
			g.claimHost('H', { build: BUILD, mods: HOST_MODS });
			g.claimHost('H', { build: BUILD, mods: [mod('Only', 'h-only')] });
			expect(g.hostMods().map((m: any) => m.hash)).toEqual(['h-only']);
		});

		it('the host leaving takes the session mod set with it', () => {
			// Otherwise the next host's guests would be offered the previous host's mods.
			g.claimHost('H', { build: BUILD, mods: HOST_MODS });
			g.release('H');
			expect(g.hostMods()).toEqual([]);
		});
	});

	describe('a mod difference is REPORTED, never refused (R4)', () => {
		beforeEach(() => { g.claimHost('H', { build: BUILD, mods: HOST_MODS }); });

		it('a guest with completely different mods is still parked for the host to answer', () => {
			const r = g.requestJoin('G', { build: BUILD, mods: [mod('Other', 'g-other')] });
			expect(r.pending, 'parked, not refused').toBe(true);
			expect(r.reason, 'and no refusal reason at all').toBeUndefined();
		});

		it('the pending request carries what the guest is missing', () => {
			g.requestJoin('G', { build: BUILD, mods: [mod('Art', 'h-art')] });
			expect(g.pending.modDiff.hostOnly.map((m: any) => m.hash)).toEqual(['h-text']);
		});

		it('a guest that declares NO mods needs all of them — absent is not satisfied', () => {
			g.requestJoin('G', { build: BUILD });
			expect(g.pending.modDiff.hostOnly.map((m: any) => m.hash)).toEqual(['h-art', 'h-text']);
		});

		it('an identical mod set leaves nothing to fetch', () => {
			g.requestJoin('G', { build: BUILD, mods: HOST_MODS.slice() });
			expect(g.pending.modDiff.hostOnly).toEqual([]);
		});

		it('a guest-only mod is reported and is NOT turned into work for the host', () => {
			g.requestJoin('G', { build: BUILD, mods: HOST_MODS.concat([mod('Mine', 'g-mine')]) });
			expect(g.pending.modDiff.guestOnly.map((m: any) => m.hash)).toEqual(['g-mine']);
			expect(g.pending.modDiff.hostOnly).toEqual([]);
		});
	});

	describe('ordering: nothing that cannot work reaches the mod stage', () => {
		it('a build mismatch is still refused, and carries no mod diff', () => {
			// The build check must stay in front: the host should never be asked to approve a pairing
			// that cannot work, and computing a diff for a doomed join is wasted work at best.
			g.claimHost('H', { build: BUILD, mods: HOST_MODS });
			const r = g.requestJoin('G', { build: 'a-different-build', mods: [] });
			expect(r.reason).toBe('build_mismatch');
			expect(g.pending, 'nothing was parked').toBe(null);
		});

		it('a full session is refused before any mod work', () => {
			g.claimHost('H', { build: BUILD, mods: HOST_MODS });
			g.requestJoin('G1', { build: BUILD });
			g.accept();
			const r = g.requestJoin('G2', { build: BUILD });
			expect(r.reason).toBe('session_full');
		});
	});

	describe('the answer consumes the diff along with the question', () => {
		beforeEach(() => { g.claimHost('H', { build: BUILD, mods: HOST_MODS }); });

		it('accept() hands back the diff, so the caller need not have kept it', () => {
			g.requestJoin('G', { build: BUILD });
			const a = g.accept();
			expect(a.admitted).toBe(true);
			expect(a.modDiff.hostOnly.map((m: any) => m.hash)).toEqual(['h-art', 'h-text']);
		});

		it('decline() leaves no mod state behind', () => {
			g.requestJoin('G', { build: BUILD });
			g.decline();
			expect(g.pending).toBe(null);
		});
	});
});
