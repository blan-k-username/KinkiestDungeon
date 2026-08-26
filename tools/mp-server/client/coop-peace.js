/**
 * tools/mp-server/client/coop-peace.js  (KDM-225)
 *
* THE "OFFER PEACE" ENTRY — on the player's OWN context menu (the ANSWER is a dialogue, KDM-230).
 *
 * A classic (non-module) script sharing the bundle's global scope, loaded after render-client.js.
 * It adds one entry to KD's own context menu and sends the gateway's `mp:` actions; it decides
 * nothing. The authority for "are we at war" and "do I owe an answer" is the server, read from
 * `KDRenderClient.lastCoop` (`snap.coop`), which is re-read on every menu build.
 *
 * WHY THE PLAYER'S OWN TILE, AND NOT THE PEER'S. Measured (`tests/unit/mp-peace-menu-gate-probe.spec.ts`):
 * the menu on another entity is gated by `KDTalkToEnemy` (`KinkyDungeonGame.ts:4572`) — an entity you
 * are FIGHTING is not talkable, and neither is a plain hostile Rat, so nothing about the peer avatar
 * is special. The one non-capture state that opens it, `hostile = 0 + ceasefire > 0`, IS peace, so it
 * cannot be the precondition for offering peace. The player branch of the builder
 * (`KDContextMenu.ts:293`, `entity == KDPlayer()`) has no hostility test anywhere on the path — and
 * no vision or adjacency test either, so a truce can be offered while running away.
 *
 * WRAPPING: follows WRAP_CONVENTION.md — sentinel-gated, `_prev` captured in closure and called
 * FIRST, original stored. `KDGetContextActions` is a plain object registry (`.Game`,
 * `.RestraintContext`), so this composes with any other mod that extends the same entry.
 */
(function () {
	'use strict';

	var OFFER = 'Peace';
	/** KDM-244 — the host's "take this run back to single player" entry. */
	var SAVE_RUN = 'CoopSaveRun';

	function coopState() {
		var rc = (typeof window !== 'undefined') ? window.KDRenderClient : null;
		return (rc && rc.lastCoop) || null;
	}

	function send(action) {
		try {
			if (window.__coop && typeof window.__coop.sendAction === 'function') {
				window.__coop.sendAction(action);
			}
		} catch (e) { /* not in a co-op session */ }
	}

	/** Is the context menu currently aimed at the player's own tile? */
	function targetingSelf() {
		try {
			var me = KDPlayer();
			return !!me && KinkyDungeonTargetX === me.x && KinkyDungeonTargetY === me.y;
		} catch (e) { return false; }
	}

	/**
	 * Add our entries to a built menu.
	 *
	 * `optionText` is set explicitly for each one. Without it the draw layer falls back to
	 * `TextGet("KDContextMenu_" + key)`, which has no entry for a key the game never heard of — the
	 * player would read "[NotFound] KDContextMenu_Peace". Same reason `optionImages` reuses icons the
	 * game already ships rather than naming files that do not exist.
	 */
	function decorate(menu) {
		if (!menu || !Array.isArray(menu.options)) return menu;
		if (!targetingSelf()) return menu;

		/*
		 * KDM-244 — "save this run", the HOST's way to take the world back to single player.
		 *
		 * ⚠️ ADDED BEFORE THE PEACE GUARDS, DELIBERATELY. It was first written at the bottom of this
		 * function and never appeared: everything below is gated on `coopState()`, which is the
		 * SERVER's peace/war block (`snap.coop`) and is absent in a session where nobody has ever been
		 * at war — i.e. in every ordinary co-op game. Exporting your run has nothing to do with peace,
		 * so it must not inherit peace's preconditions. Caught by the e2e's reachability check, which
		 * is the only layer that can see a menu entry that is never painted.
		 *
		 * ⚠️ WHY IT LIVES IN THE PEACE FILE AT ALL. `KDGetContextActions.Game` is ONE global and this
		 * project allows it ONE wrap — the rule this file's header states, and the duplication KDM-229
		 * was raised for. A `coop-export.js` adding a second wrapper of the same function is exactly
		 * that mistake, so the entry goes where the wrap already is. This file is now the CO-OP
		 * CONTEXT MENU rather than the peace menu; renaming it (with its INJECT entry and its specs)
		 * is filed as tech debt rather than smuggled into this task.
		 *
		 * Host-only in the UI (R1); the server re-checks in `_sendExport`, because a client can lie.
		 * This gate is a courtesy that stops a guest being shown a button that would only refuse.
		 */
		var isHost = false;
		try { isHost = !!(window.__coop && window.__coop.isHost && window.__coop.isHost()); }
		catch (e) { isHost = false; }
		if (isHost) {
			menu.options.push(SAVE_RUN);
			menu.optionText[SAVE_RUN] = 'Save this run for single player';
			menu.optionImages[SAVE_RUN] = 'Talk';
			menu.optionActions[SAVE_RUN] = function () {
				KDContextMenu = false;
				try { window.__coopRequestExport(); } catch (e) { /* not connected */ }
			};
		}

		var coop = coopState();
		if (!coop) return menu;

		// KDM-230: ANSWERING is no longer here. An offer arrives as KD's own modal dialogue, opened
		// server-side on this player's bundle, with Accept / Refuse as its options — a submenu entry
		// was the wrong place for a question you must answer (owner, UAT). Nothing is offered while
		// one is open: you answer first.
		if (coop.peaceOffer && coop.peaceOffer.from) return menu;

		// `canOffer` is the SERVER's answer to R1/R2/R3 (at war, and nobody is mid-question). The
		// client does not re-derive it from `war` — one source of truth for one rule.
		var can = coop.canOffer || [];
		if (can.length > 0) {
			menu.options.push(OFFER);
			menu.optionText[OFFER] = 'Offer peace to ' + can.join(', ');
			menu.optionImages[OFFER] = 'Talk';
			menu.optionActions[OFFER] = function () {
				KDContextMenu = false;
				send({ mp: 'peace.offer' });
			};
		}

		return menu;
	}

	function install() {
		if (typeof KDGetContextActions === 'undefined' || !KDGetContextActions
			|| typeof KDGetContextActions.Game !== 'function') return false;
		if (KDGetContextActions.Game._kdcoop_peace_wrapped) return true;
		var _prev = KDGetContextActions.Game;
		var wrapped = function (draw, mouseX, mouseY, data) {
			var menu = _prev.apply(this, arguments);
			try { return decorate(menu); } catch (e) { return menu; }
		};
		wrapped._kdcoop_peace_wrapped = 1;
		wrapped._kdcoop_peace_original = _prev;
		KDGetContextActions.Game = wrapped;
		return true;
	}

	/*
	 * KDM-229: INSTALLED SYNCHRONOUSLY. This used to be two `setInterval`s — a 100 ms poll waiting
	 * for `KDGetContextActions` to appear, and a 1 s re-check of the wrap. Both were unnecessary,
	 * and both are gone.
	 *
	 * WHY THE POLL WAS NOT NEEDED. `index.html` loads the compiled bundle as a plain synchronous
	 * `<script src="./out/main.js">`, and `demo-server.js` injects this file immediately before
	 * `</body>` (its `INJECT` list). A classic script's top-level `let` is initialised during that
	 * synchronous evaluation and lives in the global LEXICAL environment — so by the time this line
	 * runs, `KDGetContextActions` (`Game/src/base/game/KDContextMenu.ts`) exists and is out of its
	 * TDZ. The poll bought nothing but a 100 ms window with no Peace entry.
	 *
	 * WHY THE RE-CHECK WAS NOT NEEDED. `KDGetContextActions` is assigned in exactly one place, the
	 * bundle's own declaration; nothing reassigns `.Game` afterwards, and `install()` short-circuits
	 * on its sentinel. After the first call the timer could never do anything again.
	 *
	 * If this ever DOES return false, the honest failure is a missing menu entry — not a timer
	 * quietly retrying a load order that is supposed to be guaranteed. Pinned by
	 * `tests/unit/mp-peace-install.spec.ts`, which fails if a timer comes back.
	 */
	install();

	if (typeof window !== 'undefined') {
		window.KDCoopPeace = { install: install, decorate: decorate };
	}
})();
