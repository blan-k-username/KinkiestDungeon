/**
 * tools/mp-server/kd-perk-choice.js  (KDM-242 A3/A4)
 *
 * THE PERK-ROOM CHOICE, ROUTED — one definition, both runtimes.
 *
 * WHAT IS BROKEN WITHOUT IT. `KinkyDungeonDrawPerkOrb` (KinkyDungeonShrine.ts:916-1038) contains no
 * `KDSendInput` at all. Both of its writes happen inline in the DRAW function:
 *
 *   · the card cursor            `KDMapData.SelectedPerk = i`                            (:980)
 *   · the whole Accept block     perks, restraints, escape method, `choseperk`, and the
 *                                wipe of all three altars                                (:955-975)
 *
 * The co-op client is render-only and forwards only what goes through `KDSendInput`, so neither
 * reached the world. And it is worse than a lost click: MEASURED (KDM-242 POC P2) `KDMapData` is world
 * state the client adopts WHOLESALE (`render-client.js:509`), so the cursor a player sets is
 * overwritten by the next snapshot with the server's value — `-1`, because nothing server-side ever
 * wrote it. The Accept button renders only while `SelectedPerk == i` (:950). **In co-op it was
 * unreachable; the party could not take a perk at all.**
 *
 * THE SHAPE OF THE FIX — SUBSTITUTE THE CALLBACK, DO NOT RE-IMPLEMENT THE BUTTON.
 * The journey wrap's "call `_prev`, then revert the write" does not transfer: Accept has no value to
 * revert, it has effects. And suppressing it by forcing `SelectedPerk = -1` before `_prev` would stop
 * the button from being DRAWN, which would mean re-implementing its placement — the most text-coupled
 * thing this file could possibly do.
 *
 * So instead: `DrawButtonKDEx` is wrapped FOR THE DURATION OF THE `_prev` CALL ONLY, and the callbacks
 * of the two buttons KD names are swapped out —
 *
 *   `perkshrinechoicebg${i}`   → move the PRIVATE cursor, not `KDMapData.SelectedPerk`
 *   `AcceptContractButton${i}` → emit `KDSendInput('KDCoopPerk', { index })`, and nothing else
 *
 * — while `KDMapData.SelectedPerk` is set from the private cursor before `_prev` and restored after,
 * so KD draws the right card highlighted and places its own Accept button. KD keeps owning every
 * pixel, every hit-test and every layout constant; this file owns only what a click MEANS. The
 * coupling is two button names, which is a surface the drift counters below can actually alarm on.
 *
 * WHY THE CURSOR IS PRIVATE. A highlight is a local UI position, not a decision. `KDMapData` is
 * broadcast identically to both players (P2), so a cursor living there is either shared — B could
 * Accept a card A selected — or, as today, erased every frame. It never routes and never travels.
 *
 * WHY IT IS SOURCE TEXT, like `kd-journey-choice.js`, `kd-shop-buy.js` and `kd-peace-dialogue.js`: two
 * consumers that must not drift. The BROWSER is served it as a script (demo-server INJECT) and is
 * where the wrap actually fires; the SERVER evals the identical text, which is where
 * `KDInputTypes.KDCoopPerk` has to exist because that is where a routed input is dispatched. KDM-241
 * P1 measured that `KDInputTypes` is in no player's captured globals and a planted entry survives a
 * full turn, so it is registered ONCE with no re-assert loop — and the spec pins that survival rather
 * than assuming it.
 *
 * TEXT-COUPLED, SO IT COUNTS. `__KDCoopPerkStats.acceptsSuppressed` rises for every Accept callback it
 * had to replace, and the spec drives a real click through KD's own code path with a CONTROL that
 * invokes the UNWRAPPED original and demands it still grants the perk. Silence in that control is the
 * drift alarm (KDM-241 R-b, the plugin rule).
 *
 * Follows WRAP_CONVENTION: sentinel-gate, capture `_prev` in the closure, call `_prev` first (the
 * substitution is installed around it and removed in a `finally`, so nothing outside the perk modal
 * ever sees a wrapped `DrawButtonKDEx`), store `_kdcoop_perk_original`.
 */
'use strict';

const KD_PERK_CHOICE = `
(function(){
	var g = (typeof globalThis !== 'undefined') ? globalThis : this;

	// Drift + diagnostics. THE __KD PREFIX IS LOAD-BEARING, not a naming style: _candidateGlobals
	// (headless-host.js) unions the bundle's own bindings with Object.keys(globalThis) and skips only
	// names starting with __KD, so a plain globalThis.X a mod creates IS a per-player state candidate —
	// captured, shipped in the bundle, and the CLIENT's copy overwritten by the server's. Measured in
	// KDM-264, where the browser's counters read back as the server's.
	if (!g.__KDCoopPerkStats) g.__KDCoopPerkStats = { calls: 0, acceptsSuppressed: 0, cursorMoves: 0, routed: 0, last: null };
	// The PRIVATE card cursor. -1 is KD's own "nothing selected" (KinkyDungeonGame.ts:292).
	if (typeof g.__KDCoopPerkCursor !== 'number') g.__KDCoopPerkCursor = -1;

	/*
	 * THE ROUTED INPUT. Registered here rather than in the session because a routed input must be
	 * dispatchable by the game's own dispatcher (KinkyDungeonInput.ts:1659 — KDInputTypes[type](data)),
	 * and because the client's KDSendInput wrapper forwards whatever type it is handed.
	 *
	 * It DECIDES NOTHING. Arbitration between two players is the gateway's, so this hands the choice to
	 * a hook the SERVER installs (KDCoopPerkPropose). On the client that hook does not exist and the
	 * call is a guarded no-op — the client's copy exists so the two runtimes hold ONE definition, not
	 * so the client can commit anything.
	 *
	 * Returns "" — it spends no time. The session seeds inputKind KDCoopPerk = 'ui' to match, so
	 * proposing a perk does not cost the party the turn it is waiting to take.
	 */
	if (typeof KDInputTypes !== 'undefined' && KDInputTypes && !KDInputTypes.KDCoopPerk) {
		KDInputTypes.KDCoopPerk = function (data) {
			if (data && typeof data.index === 'number' && typeof g.KDCoopPerkPropose === 'function') {
				g.KDCoopPerkPropose({ index: data.index });
			}
			return "";
		};
	}

	/** The two buttons whose MEANING we own. KD still owns where they are and how they look. */
	function substituteCallback(name, cb) {
		var m = /^AcceptContractButton(\\d+)$/.exec(String(name));
		if (m) {
			var acceptIndex = parseInt(m[1], 10);
			g.__KDCoopPerkStats.acceptsSuppressed++;
			return function () {
				g.__KDCoopPerkStats.routed++;
				g.__KDCoopPerkStats.last = { kind: 'accept', index: acceptIndex };
				if (typeof KDSendInput === 'function') KDSendInput('KDCoopPerk', { index: acceptIndex });
			};
		}
		var c = /^perkshrinechoicebg(\\d+)$/.exec(String(name));
		if (c) {
			var cardIndex = parseInt(c[1], 10);
			return function () {
				g.__KDCoopPerkStats.cursorMoves++;
				g.__KDCoopPerkStats.last = { kind: 'select', index: cardIndex };
				g.__KDCoopPerkCursor = cardIndex;
			};
		}
		return cb;
	}

	if (typeof KinkyDungeonDrawPerkOrb === 'function' && !KinkyDungeonDrawPerkOrb._kdcoop_perk_wrapped) {
		var _prev = KinkyDungeonDrawPerkOrb;

		KinkyDungeonDrawPerkOrb = function () {
			g.__KDCoopPerkStats.calls++;

			// KD decides whether to draw an Accept button by comparing KDMapData.SelectedPerk to the
			// card index (:950), so the private cursor has to be visible to it for the duration of the
			// draw — and only for that. Restored in the finally below, so the shared, broadcast field is
			// never left carrying one player's highlight.
			var hadMap = (typeof KDMapData !== 'undefined' && KDMapData);
			var savedSelected = hadMap ? KDMapData.SelectedPerk : undefined;
			var savedDraw = (typeof DrawButtonKDEx === 'function') ? DrawButtonKDEx : null;

			try {
				if (hadMap) KDMapData.SelectedPerk = g.__KDCoopPerkCursor;
				if (savedDraw) {
					DrawButtonKDEx = function (name, cb) {
						var args = Array.prototype.slice.call(arguments);
						args[1] = substituteCallback(name, cb);
						return savedDraw.apply(this, args);
					};
				}
				return _prev.apply(this, arguments);
			} finally {
				if (savedDraw) DrawButtonKDEx = savedDraw;
				if (hadMap) KDMapData.SelectedPerk = savedSelected;
			}
		};

		KinkyDungeonDrawPerkOrb._kdcoop_perk_wrapped = true;
		KinkyDungeonDrawPerkOrb._kdcoop_perk_original = _prev;
	}
})();
`;

/**
 * The BROWSER is served the identical text — the same one-definition rule kd-journey-choice.js
 * follows. Aliased rather than re-derived so the two can never come apart.
 */
const KD_PERK_CHOICE_BROWSER = KD_PERK_CHOICE;

module.exports = { KD_PERK_CHOICE, KD_PERK_CHOICE_BROWSER };
