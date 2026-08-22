/**
 * KDM-250 — presence (`tools/mp-server/presence.js`), on its own.
 *
 * WHO IS STILL HERE. This is the pure half of "a dropped connection must not freeze the game": the
 * three states a seat can be in, what moves it between them, and the two latches that stop the
 * machine from firing at the wrong moment. No socket, no world, no game global — same call as
 * `join-gate.js` and `peace.js` (KDM-234 A1), so every rule below is checked in milliseconds instead
 * of behind a ~30 s session boot.
 *
 * The rules here are the ones that are easy to get subtly wrong: a `gone` seat that a stale
 * reconnect walks back into, and a modal that fires at the initial handshake because "the peer is
 * not connected" is indistinguishable from "the peer has left" unless something remembers.
 *
 * TIME IS INJECTED. Every method that cares takes an explicit `t`, so these tests are deterministic
 * rather than timer-raced — and so the bridge can feed it the same monotonic `hrtime` clock it
 * already uses for latency (`ws-bridge.js` `now()`; never `Date.now()`, whose wall-clock jump would
 * corrupt every reading).
 *
 * Requirement ids refer to the `## Requirements` section of KDM-250 (EARS text in KDM-234).
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Presence } = require('../../tools/mp-server/presence');

const TIMEOUT = 1000;

describe('KDM-250 — Presence', () => {
	let p: any;
	beforeEach(() => { p = new Presence({ hbTimeoutMs: TIMEOUT }); });

	describe('seats and their one state (U1)', () => {
		it('knows nothing about a client that never sat down', () => {
			expect(p.state('H')).toBe(null);
			expect(p.roleOf('H')).toBe(null);
			expect(p.seats()).toEqual([]);
		});

		it('a seated player is connected, and carries their role', () => {
			p.seat('H', 'host', 0);
			expect(p.state('H')).toBe('connected');
			expect(p.roleOf('H')).toBe('host');
			expect(p.seats()).toEqual(['H']);
		});

		it('re-seating the same id does not duplicate the seat', () => {
			p.seat('H', 'host', 0);
			p.seat('H', 'host', 10);
			expect(p.seats()).toEqual(['H']);
		});
	});

	describe('the heartbeat marks a silent seat missing (E1)', () => {
		beforeEach(() => {
			p.seat('H', 'host', 0);
			p.seat('G', 'guest', 0);
		});

		it('a seat heard from inside the window stays connected', () => {
			p.saw('H', 900);                                // both must be kept alive, or the sweep
			p.saw('G', 900);                                // reports the OTHER seat and masks this one
			expect(p.sweep(1500)).toEqual([]);
			expect(p.state('G')).toBe('connected');
		});

		it('silence longer than the timeout marks it missing, and says which seat', () => {
			p.saw('H', 1200);                               // H keeps answering, G does not
			const lost = p.sweep(1201);
			expect(lost).toEqual(['G']);
			expect(p.state('G')).toBe('missing');
			expect(p.state('H'), 'the live seat is untouched').toBe('connected');
		});

		it('reports a seat ONCE, not on every sweep', () => {
			p.sweep(2000);
			expect(p.sweep(3000), 'already reported').toEqual([]);
			expect(p.state('G')).toBe('missing');
		});

		it('the boundary is exclusive — exactly at the timeout is still alive', () => {
			expect(p.sweep(TIMEOUT)).toEqual([]);
			expect(p.sweep(TIMEOUT + 1)).toEqual(['H', 'G']);
		});
	});

	describe('a closed socket does not wait for the heartbeat (E2)', () => {
		beforeEach(() => { p.seat('H', 'host', 0); p.seat('G', 'guest', 0); });

		it('marks the seat missing at once', () => {
			expect(p.lost('G')).toBe(true);
			expect(p.state('G')).toBe('missing');
		});

		it('is idempotent — a close after an error reports nothing new', () => {
			p.lost('G');
			expect(p.lost('G'), 'already missing').toBe(false);
		});

		it('ignores a client that was never seated', () => {
			expect(p.lost('NOBODY')).toBe(false);
			expect(p.seats()).toEqual(['H', 'G']);
		});
	});

	describe('coming back (E4 groundwork) and never coming back (E6)', () => {
		beforeEach(() => { p.seat('H', 'host', 0); p.seat('G', 'guest', 0); });

		it('a missing seat returns to connected', () => {
			p.lost('G');
			expect(p.back('G', 500)).toBe(true);
			expect(p.state('G')).toBe('connected');
		});

		it('coming back resets the clock, so the next sweep does not re-lose them', () => {
			p.lost('G');
			p.back('G', 5000);
			p.saw('H', 5000);
			expect(p.sweep(5001)).toEqual([]);
		});

		it('`gone` is TERMINAL — a stale reconnect cannot walk back into a removed seat', () => {
			p.lost('G');
			p.remove('G');
			expect(p.state('G')).toBe('gone');
			expect(p.back('G', 9000), 'refused').toBe(false);
			expect(p.state('G'), 'still gone').toBe('gone');
		});

		it('...and a plain re-join is the OTHER door into connected — also barred', () => {
			p.remove('G');
			expect(p.seat('G', 'guest', 9000), 'refused').toBe(false);
			expect(p.state('G')).toBe('gone');
		});

		it('a gone seat is not swept again', () => {
			p.remove('G');
			expect(p.sweep(999999)).toEqual(['H']);
		});
	});

	describe('paused is DERIVED, never stored twice', () => {
		beforeEach(() => { p.seat('H', 'host', 0); p.seat('G', 'guest', 0); });

		it('two connected seats are not paused', () => {
			expect(p.paused).toBe(false);
			expect(p.missing()).toEqual([]);
		});

		it('one missing seat pauses, and names who and in which role', () => {
			p.lost('G');
			expect(p.paused).toBe(true);
			expect(p.missing()).toEqual([{ clientId: 'G', role: 'guest' }]);
		});

		it('a removed seat does not pause — it is resolved, not pending', () => {
			p.lost('G');
			p.remove('G');
			expect(p.paused, 'nobody is being waited for').toBe(false);
			expect(p.missing()).toEqual([]);
		});

		it('the seat coming back un-pauses', () => {
			p.lost('G');
			p.back('G', 100);
			expect(p.paused).toBe(false);
		});
	});

	describe('the never-connected latch (N2)', () => {
		it('a lone host who drops has nobody to tell, and has never been paired', () => {
			p.seat('H', 'host', 0);
			expect(p.everPaired).toBe(false);
			p.lost('H');
			expect(p.everPaired, 'a handshake that never completed is not a disconnect').toBe(false);
		});

		it('the latch closes only when both seats are connected AT THE SAME TIME', () => {
			p.seat('H', 'host', 0);
			expect(p.everPaired).toBe(false);
			p.seat('G', 'guest', 0);
			expect(p.everPaired).toBe(true);
		});

		it('once closed it STAYS closed — that is what makes it a latch', () => {
			p.seat('H', 'host', 0);
			p.seat('G', 'guest', 0);
			p.lost('G');
			p.remove('G');
			expect(p.everPaired).toBe(true);
		});

		/**
		 * The control for the test above. `everPaired` is a boolean that is `false` at construction,
		 * so "it is false here" passes on a Presence that never implements the latch at all — the
		 * vacuous shape this file has to guard against. This pairs a false case with a true one on the
		 * SAME instance, so a stuck-at-either-value implementation fails one of them.
		 */
		it('control — the same instance answers both ways round', () => {
			p.seat('H', 'host', 0);
			const before = p.everPaired;
			p.seat('G', 'guest', 0);
			const after = p.everPaired;
			expect([before, after]).toEqual([false, true]);
		});
	});

	describe('U2 — this module knows nothing about sockets, worlds or the game', () => {
		it('has no require of anything but itself', () => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const src = require('fs').readFileSync(
				require('path').join(__dirname, '../../tools/mp-server/presence.js'), 'utf8');
			const requires = src.match(/require\((['"])(.*?)\1\)/g) || [];
			expect(requires, 'presence must stay pure — no transport, no world').toEqual([]);
		});
	});
});
