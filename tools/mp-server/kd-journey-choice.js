/**
 * tools/mp-server/kd-journey-choice.js  (KDM-263)
 *
 * THE JOURNEY-MAP CHOICE, ROUTED — one definition, both runtimes.
 *
 * WHAT IS BROKEN WITHOUT IT. `KDRenderJourneyMap` (KDJourney.ts:388-395 and :434-452) writes
 * `KDGameData.JourneyTarget` INLINE, from `MouseClicked`/`mouseDown` and from
 * `KinkyDungeonKeybindingCurrentKey` — inside the DRAW function, never through `KDSendInput`. The
 * co-op client is render-only and forwards only what goes through `KDSendInput`, so a click moved the
 * CLIENT's target and nothing else; the server's stayed null. KD's own `KDCancelFilters.JourneyChoice`
 * (KinkyDungeonTiles.ts:13-21) then refused the stairs forever and re-opened the map, which since
 * KDM-239 R7 both players actually see. A two-player party could not leave a PerkRoom at all.
 *
 * THE SHAPE OF THE FIX. `_prev` FIRST — KD keeps owning what a legal slot is, what a connection is and
 * which key picks which branch; none of that is re-implemented here. Then, if the call changed
 * `JourneyTarget`, the local write is REVERTED and the choice is emitted as a routed input
 * (`KDSendInput('KDCoopJourney', {x, y})`). The client becomes structurally incapable of committing a
 * route: the only value it ever displays is the one the world sent it. That is R9 — a selection that
 * only mutates client state is treated as not having happened.
 *
 * A null write is reverted but NOT routed. KD nulls the target for two reasons — the clicked slot was
 * not connected, and the Cancel button — and neither is a proposal. R8: KD's own `JourneyChoice`
 * cancellation stays the ONE refusal path; this file does not invent a second.
 *
 * WHY IT IS SOURCE TEXT, like `kd-peace-dialogue.js` and `kd-codec.js`: it has TWO consumers that must
 * not drift. The BROWSER is served it as a script (demo-server INJECT) and is where the wrap actually
 * fires; the SERVER evals the identical text, which is where `KDInputTypes.KDCoopJourney` has to exist
 * because that is where a routed input is dispatched. Measured in KDM-241 (P1): `KDInputTypes` is in
 * no player's captured globals and a planted entry survives a full turn, so it is registered ONCE and
 * needs no re-assert loop — `mp-journey-agreement.spec.ts` pins that survival rather than assuming it.
 *
 * TEXT-COUPLED TO A DRAW FUNCTION. If upstream moves the journey click out of `KDRenderJourneyMap`,
 * this wrap silently stops routing and the feature quietly reverts to the bug it fixes. So it COUNTS:
 * `__KDCoopJourneyStats.observed` rises for every write it had to revert, and the spec drives a real one
 * through KD's own code path with a CONTROL that calls the unwrapped original and demands it writes.
 * Silence there is the drift alarm.
 *
 * Follows WRAP_CONVENTION: sentinel-gate, capture `_prev` in the closure, call `_prev` first, store
 * `_kdcoop_journey_original`.
 */
'use strict';

const KD_JOURNEY_CHOICE = `
(function(){
	var g = (typeof globalThis !== 'undefined') ? globalThis : this;

	// Drift + diagnostics. THE __KD PREFIX IS LOAD-BEARING, not a naming style: _candidateGlobals
	// (headless-host.js) unions the bundle's own bindings with Object.keys(globalThis) and skips only
	// names starting with __KD, so a plain globalThis.X a mod creates IS a per-player state candidate -
	// captured, shipped in the bundle, and the CLIENT's copy overwritten by the server's. Measured in
	// KDM-264, where the browser's counters read back as the server's.
	if (!g.__KDCoopJourneyStats) g.__KDCoopJourneyStats = { calls: 0, observed: 0, routed: 0, last: null };

	/*
	 * THE ROUTED INPUT. Registered here rather than in the session because a routed input must be
	 * dispatchable by the game's own dispatcher (KinkyDungeonInput.ts:1659 - KDInputTypes[type](data)),
	 * and because the client's KDSendInput wrapper forwards whatever type it is handed.
	 *
	 * It DECIDES NOTHING. Arbitration between two players is the gateway's, so this hands the choice to
	 * a hook the SERVER installs (KDCoopJourneyPropose). On the client that hook does not exist and the
	 * call is a guarded no-op - the client's copy exists so the two runtimes hold ONE definition, not
	 * so the client can commit anything.
	 *
	 * Returns "" - it spends no time. The session seeds inputKind KDCoopJourney = 'ui' to match, so
	 * proposing a route does not cost the party the turn it is waiting to take.
	 */
	if (typeof KDInputTypes !== 'undefined' && KDInputTypes && !KDInputTypes.KDCoopJourney) {
		KDInputTypes.KDCoopJourney = function (data) {
			if (data && typeof data.x === 'number' && typeof data.y === 'number'
				&& typeof g.KDCoopJourneyPropose === 'function') {
				g.KDCoopJourneyPropose({ x: data.x, y: data.y });
			}
			return "";
		};
	}

	if (typeof KDRenderJourneyMap === 'function' && !KDRenderJourneyMap._kdcoop_journey_wrapped) {
		var _prev = KDRenderJourneyMap;

		/** Same slot? Compared by coordinates, because KD assigns a fresh object on every write. */
		var same = function (a, b) {
			if (!a || !b) return !a && !b;
			return a.x === b.x && a.y === b.y;
		};

		var wrapped = function () {
			var before = (typeof KDGameData !== 'undefined' && KDGameData) ? KDGameData.JourneyTarget : undefined;
			g.__KDCoopJourneyStats.calls++;
			var out = _prev.apply(this, arguments);
			if (typeof KDGameData === 'undefined' || !KDGameData) return out;
			var after = KDGameData.JourneyTarget;
			if (same(before, after)) return out;

			// A write happened. Revert it FIRST, unconditionally: whatever KD decided locally, the only
			// target this client ever displays is the one the world sent it.
			KDGameData.JourneyTarget = before;
			g.__KDCoopJourneyStats.observed++;
			// ...and route it, but only when it NAMES a slot. A null is KD refusing an unconnected slot,
			// or the Cancel button - neither is a proposal (R8).
			if (after && typeof after.x === 'number' && typeof after.y === 'number') {
				g.__KDCoopJourneyStats.routed++;
				g.__KDCoopJourneyStats.last = { x: after.x, y: after.y };
				if (typeof KDSendInput === 'function') KDSendInput('KDCoopJourney', { x: after.x, y: after.y });
			}
			return out;
		};
		wrapped._kdcoop_journey_wrapped = true;
		wrapped._kdcoop_journey_original = _prev;
		// Bare assignment: KDRenderJourneyMap is a bundle top-level binding, not a property of
		// globalThis - assigning globalThis.KDRenderJourneyMap would create a shadow nobody calls.
		KDRenderJourneyMap = wrapped;
	}
})();
`;

/** The browser-ready form — identical text, served as a script (demo-server.js INJECT). */
const KD_JOURNEY_CHOICE_BROWSER = KD_JOURNEY_CHOICE;

module.exports = { KD_JOURNEY_CHOICE, KD_JOURNEY_CHOICE_BROWSER };
