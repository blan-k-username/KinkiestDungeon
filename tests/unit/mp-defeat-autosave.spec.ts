/**
 * KDM-267 — a capture must not be killed by KD's own autosave.
 *
 * THE BUG. The LAST statement of `KinkyDungeonDefeat` is `KinkyDungeonSaveGame()`
 * (`Game/src/prison/KinkyDungeonJail.ts:1894`), which deep-copies
 * `KinkyDungeonGenerateSaveData()` — and that reads `KDCurrentModels.get(KinkyDungeonPlayer).Poses`
 * off a paper doll `_neuterRendering` deliberately never builds. Measured stack:
 *
 *   KinkyDungeonDefeat -> KinkyDungeonSaveGame -> KinkyDungeonGenerateSaveData
 *     TypeError: Cannot read properties of undefined (reading 'Poses')
 *
 * The exact twin of the stair autosave KDM-240 stubbed, and NOT an upstream bug — it is the direct
 * consequence of a rendering neuter this layer chose.
 *
 * ⚠️ WHAT THE DAMAGE ACTUALLY IS — corrected by measurement, not assumed. The throw does NOT escape
 * `submit`: `applyInputObserved` wraps the dispatch in its own try/catch (`headless-host.js:3064`)
 * and records the message as `obs.error`. So the session survives and the turn still resolves.
 *
 * What is lost is the acting player's own action. `KDRunDefeatForEnemy` is the last statement of
 * `KinkyDungeonAdvanceTime` (`KinkyDungeonEnemies.ts:5040`), so the throw aborts the input's dispatch
 * from there on and `result` comes back null. And on the TURN path nothing ever looks at that error:
 * `swap-session.js:1125` reads it only inside `_learnInputKind`, as a "do not learn from this one"
 * signal. Nothing logs it, nothing tells the player. A capture therefore truncated the captured
 * player's turn and reported success — precisely the silent-drop class KDM-163 exists to prevent.
 *
 * The oracle below is `error === null` from a real dispatch, because that is the thing that was
 * broken. The session-level assertions are kept as the user-facing shape of it, not as the proof.
 *
 * ⚠️ AND WHY THIS SPEC PASSES `catchThrow: false`. KDM-261's spec arms the same capture with `true`,
 * because it asks which BRANCH of `KinkyDungeonDefeat` ran and needs a contained throw to answer.
 * A test that swallows the throw itself can never see this bug — KDM-261's suite was green
 * throughout while the defect was live. The argument is mandatory in the shared helper for exactly
 * that reason.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HeadlessHost } = require('../../tools/mp-server/headless-host');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
import { armCapture, captureRan } from './helpers/world';

const BOOT_TIMEOUT = 300_000;

describe('KDM-267 — KD\'s own autosave must not kill the turn', () => {
	describe('in a real session', () => {
		let s: any;
		beforeEach(async () => {
			s = new SwapSession({ requiredPlayers: 2, seed: 'defeat-autosave', pvp: false });
			s.join('A'); s.join('B');
			await s.ready();
		}, BOOT_TIMEOUT);

		function turn() { s.submit('A', { kind: 'wait' }); s.submit('B', { kind: 'wait' }); }

		/**
		 * R1/R2 — the whole point. The capture is armed UNGUARDED, so if `KinkyDungeonSaveGame`
		 * throws it escapes into the session exactly as it does in production.
		 */
		it('a capture completes and the turn finishes', () => {
			const turn0 = s.turn;
			armCapture(s, 'A', false);
			expect(() => turn()).not.toThrow();
			// 'entered' means the defeat started and the throw escaped — the precise failure. 'never
			// ran' means the hook never fired and this test proved nothing.
			expect(captureRan(s)).toBe('ok');
			expect(s.turn).toBeGreaterThan(turn0);              // the turn actually completed
			for (const cid of ['A', 'B']) {
				expect(s.bundles.get(cid), `${cid} kept a bundle`).toBeTruthy();
				expect(s.posOf(cid), `${cid} kept an avatar`).toBeTruthy();
			}
		}, BOOT_TIMEOUT);

		/**
		 * The turn AFTER a capture must still work — a throw that left the world mid-apply would
		 * show up here even if the first turn happened to look fine.
		 */
		it('the session keeps taking turns afterwards', () => {
			armCapture(s, 'A', false);
			try { turn(); } catch (e) { /* turn 1 is KDM-267's own failure; this test is about turn 2 */ }
			expect(captureRan(s), 'the capture must have fired, or this test proves nothing').not.toBe('never ran');
			const turn1 = s.turn;
			expect(() => turn()).not.toThrow();
			expect(s.turn).toBeGreaterThan(turn1);
		}, BOOT_TIMEOUT);
	});

	describe('the save instrument', () => {
		let h: any;
		beforeEach(async () => {
			h = new HeadlessHost({ id: 'kdm267-save' });
			h.boot();
			await h.init({ seed: 'defeat-autosave' });
		}, BOOT_TIMEOUT);

		/**
		 * R2, at the layer where the damage is actually observable — the dispatch's own error slot.
		 *
		 * This is the assertion that was RED: the capture aborted the input from `KinkyDungeonAdvanceTime`
		 * onwards, `applyInputObserved` caught it into `obs.error`, and on the turn path nothing ever
		 * reads that field except `_learnInputKind`. So the player's action was truncated and the
		 * session reported a normal turn.
		 *
		 * `tick` is the type a `{kind:'wait'}` action maps to (`swap-session.js:2377`), i.e. the same
		 * dispatch a real turn takes. The `__armed` check makes the test non-vacuous: an input that
		 * never reached `KinkyDungeonAdvanceTime` would leave it true and fail here rather than
		 * sailing past a null error that means nothing.
		 */
		it('a capture inside a dispatch is not recorded as a failed action', () => {
			h.eval(`(function(){
				var _prev = KinkyDungeonAdvanceTime;
				KinkyDungeonAdvanceTime = function () {
					var r = _prev.apply(this, arguments);
					if (globalThis.__kdArmed) { globalThis.__kdArmed = false; KinkyDungeonDefeat(true, undefined); }
					return r;
				};
				globalThis.__kdArmed = true;
			})()`);
			const out = h.applyInputObserved('tick', { delta: 1 }) || {};
			expect(h.eval('globalThis.__kdArmed'), 'the capture must have fired').toBe(false);
			expect(out.error, 'the capture aborted the player\'s own input').toBeNull();
		}, BOOT_TIMEOUT);

		/**
		 * R3 — the reason KDM-240 gave for leaving `KinkyDungeonSaveGame` alone was that `saveOf()`
		 * needs it. It does not: `saveOf` calls `KinkyDungeonGenerateSaveData` directly
		 * (`headless-host.js:2905`). This pins that, so the stub can never quietly break the parity
		 * and non-interference oracles that ride on it.
		 */
		it('saveOf() still returns a real save', () => {
			const save = h.saveOf();
			expect(save && typeof save).toBe('object');
			expect(Object.keys(save).length).toBeGreaterThan(20);
		}, BOOT_TIMEOUT);

		/**
		 * `KDSaveQueue` is drained by the browser's async save loop (`KinkyDungeon.ts:1520`), which
		 * never runs here — so every autosave used to add a >20 KB entry nothing would ever consume.
		 * It is already GLOBAL_BLACKLISTed for that reason (`mp-consume-once-queues`); not calling
		 * the save at all is what actually stops the accumulation.
		 */
		it('does not accumulate an unconsumable save queue', () => {
			h.eval('(function(){ if (typeof KinkyDungeonSaveGame === "function") KinkyDungeonSaveGame(); })()');
			expect(h.eval('KDSaveQueue.length')).toBe(0);
		}, BOOT_TIMEOUT);
	});
});
