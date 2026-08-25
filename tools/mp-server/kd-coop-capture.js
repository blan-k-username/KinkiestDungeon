/**
 * tools/mp-server/kd-coop-capture.js  (KDM-261)
 *
 * ONE PLAYER'S CAPTURE MUST NOT DRAG THE PARTY INTO THE JAIL MAP.
 *
 * THE PROBLEM. `KinkyDungeonDefeat(PutInJail = true)` generates a jail outpost and calls
 * `KinkyDungeonCreateMap` (`Game/src/prison/KinkyDungeonJail.ts:1725`). There is exactly ONE world in
 * the swap-session model, so `KDMapData` is shared and the partner who was never captured is
 * relocated too — "your friend gets grabbed on floor 3 and you are suddenly standing in a jail you
 * never walked into". KDM-240 made that COHERENT (everybody lands, everybody keeps an avatar,
 * everybody is told) but could not stop it happening: with one map there is nowhere to leave anyone.
 *
 * THE RULE (owner decision, 2026-08-24): **jail only when nobody is free.**
 *
 * WHY THIS IS NOT A GAME MECHANIC IN THE GATEWAY (KDM-159, epic AC1/AC2). Nothing here decides what
 * capture does. `KinkyDungeonDefeat` is a FORK, and both sides are KD's own:
 *
 *   PutInJail = true   ->  KDAddOutpost + KinkyDungeonCreateMap + KDMovePlayer   (:1725)
 *   PutInJail = false  ->  KDDefeatedPlayerTick, blind, bound, LEFT WHERE THEY STAND   (:1627)
 *
 * KD already picks `false` for its own reasons in three places — the target room is the one we are
 * in (:1603), we are already in a prison (:1607), the leash point is not an exit
 * (KinkyDungeonEnemies.ts:5056). This adds a fourth reason, in the same vocabulary and at the same
 * argument. No threshold, no timer, no constant of ours: the whole decision is one boolean the
 * session hands in, and recovery is KD's own struggle plus a partner untying you (KDM-231).
 *
 * SERVER-SIDE ONLY, unlike `kd-peace-dialogue.js`. This draws nothing and answers nothing —
 * `KinkyDungeonDefeat` runs in the authoritative world and only there. There is deliberately no
 * `demo-server.js` route and no browser copy to keep in step.
 *
 * The wrap follows `WRAP_CONVENTION.md`: sentinel-gated so a re-eval cannot double-wrap, `_prev`
 * captured in the closure and always called, `_kdcoop_original` published for diagnosis. Bare
 * re-assignment, never `globalThis.` — `KinkyDungeonDefeat` is a bundle binding.
 */
'use strict';

/**
 * Two globals form the contract with `SwapSession`:
 *
 *   `__kdCoopPartnerFree`   IN  — written by the session immediately before each dispatch. `true`
 *                                 means "somebody OTHER than the player being applied is still up".
 *                                 Absent or false is the single-player answer, so an unmanaged world
 *                                 behaves exactly as stock KD.
 *   `__kdCoopCaptureHeld`   OUT — take-once, read by `_takeCoopFlag` after the dispatch. Says a
 *                                 capture was downgraded, so the session can announce it once.
 */
const KD_COOP_CAPTURE = `
(function(){
	if (typeof KinkyDungeonDefeat !== 'function') return;
	if (KinkyDungeonDefeat._kdcoop_wrapped) return;          // idempotent: loaded once, wrapped once
	var _prev = KinkyDungeonDefeat;

	var wrapped = function (PutInJail, leashEnemy) {
		// Only a JAIL MOVE is ever downgraded. A defeat that was already staying put is untouched,
		// so this can never make a capture harsher than KD intended.
		if (PutInJail && globalThis.__kdCoopPartnerFree === true) {
			PutInJail = false;
			globalThis.__kdCoopCaptureHeld = true;
		}
		return _prev(PutInJail, leashEnemy);
	};
	wrapped._kdcoop_wrapped = true;
	wrapped._kdcoop_original = _prev;
	KinkyDungeonDefeat = wrapped;
})();
`;

module.exports = { KD_COOP_CAPTURE };
