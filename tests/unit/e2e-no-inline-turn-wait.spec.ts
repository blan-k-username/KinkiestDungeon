/**
 * Node-layer (Vitest) — the co-op e2e specs wait for a turn through ONE helper (KDM-345).
 *
 * "Read `__coop.lastTick`, send the actions, `waitForFunction` until it moves" was pasted into 26 specs
 * (~48 copies) in four variants: observer A or B, exact (`=== t+1`) or loose, four timeouts, three
 * on-timeout behaviours. The "attack the peer until defeated" loop was pasted into 12. Both now live in
 * `tests/e2e/helpers/coop.ts` (`coopAwaitTick`, `coopWaitTurn`, `coopDefeatPeer`); this spec fails if a
 * spec grows its own copy again.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');

const E2E = path.resolve(__dirname, '../e2e');

/** Specs allowed an inline counter wait, each with the reason it is not a client-side turn bracket. */
const EXEMPT: Record<string, string> = {
	'mp-disconnect-solo.spec.ts': 'the counter is read BEFORE a dialogue answer and reused by a later assertion',
	'mp-join-late.spec.ts': 'the baseline is the SERVER turn (bridge.session.turn), reused by two assertions',
};

const specs = (): string[] => fs.readdirSync(E2E).filter((f: string) => f.endsWith('.spec.ts'));
const read = (f: string): string => fs.readFileSync(path.join(E2E, f), 'utf8');

/** Each `waitForFunction(` call whose arguments read the turn counter — an inline turn wait. */
function inlineTurnWaits(src: string): number {
	let n = 0;
	for (let i = src.indexOf('waitForFunction('); i >= 0; i = src.indexOf('waitForFunction(', i + 1)) {
		const call = src.slice(i, i + 400);
		const end = call.search(/\{\s*timeout/);
		if (/lastTick/.test(end >= 0 ? call.slice(0, end) : call)) n++;
	}
	return n;
}

/** A `for (… isDefeated …)` loop whose body sends `doattack` — an inline defeat loop. */
const inlineDefeatLoops = (src: string): number =>
	(src.match(/for\s*\([^)]*isDefeated[\s\S]{0,400}?doattack/g) || []).length;

describe('co-op e2e turn waits come from the shared helper', () => {
	it('the scanner sees an inline wait and an inline defeat loop (control)', () => {
		expect(inlineTurnWaits(`await A.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, t0, { timeout: 30_000 });`)).toBe(1);
		expect(inlineTurnWaits(`await A.waitForFunction(() => (window as any).__coop.blocked === 'x', undefined, { timeout: 1 });`)).toBe(0);
		expect(inlineDefeatLoops(`for (let i = 0; i < 25 && !session.isDefeated('A'); i++) {
			const peer = await waitForPeerAvatar(B);
			await B.evaluate((p) => (window as any).__coop.sendAction({ kdType: 'doattack', data: {} }), peer);`)).toBe(1);
	});

	it('the scan really covers the co-op specs', () => {
		expect(specs().filter((f) => f.startsWith('mp-')).length).toBeGreaterThan(25);
	});

	it('no spec waits for the turn counter inline', () => {
		const offenders = specs().filter((f) => !EXEMPT[f])
			.map((f) => ({ f, n: inlineTurnWaits(read(f)) })).filter((x) => x.n > 0);
		expect(offenders, 'use coopAwaitTick / coopWaitTurn from tests/e2e/helpers/coop.ts').toEqual([]);
	});

	it('no spec has its own attack-until-defeated loop', () => {
		const offenders = specs().map((f) => ({ f, n: inlineDefeatLoops(read(f)) })).filter((x) => x.n > 0);
		expect(offenders, 'use coopDefeatPeer from tests/e2e/helpers/coop.ts').toEqual([]);
	});

	it('every exemption still names a spec that exists', () => {
		for (const f of Object.keys(EXEMPT)) expect(specs(), f).toContain(f);
	});
});
