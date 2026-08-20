/**
 * tools/mp-server/client/coop-peace.js  (KDM-225)
 *
 * THE PEACE SUBMENU — on the player's OWN tile.
 *
 * A classic (non-module) script sharing the bundle's global scope, loaded after render-client.js.
 * It adds three entries to KD's own context menu and sends the gateway's `mp:` actions; it decides
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
	var ACCEPT = 'PeaceAccept';
	var DECLINE = 'PeaceDecline';

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
		var coop = coopState();
		if (!coop) return menu;

		if (coop.peaceOffer && coop.peaceOffer.from) {
			var from = String(coop.peaceOffer.from);
			menu.options.push(ACCEPT);
			menu.optionText[ACCEPT] = 'Accept peace with ' + from;
			menu.optionImages[ACCEPT] = 'Talk';
			menu.optionActions[ACCEPT] = function () {
				KDContextMenu = false;
				send({ mp: 'peace.answer', accept: true });
			};

			menu.options.push(DECLINE);
			menu.optionText[DECLINE] = 'Refuse ' + from;
			menu.optionImages[DECLINE] = 'Aggro';
			menu.optionActions[DECLINE] = function () {
				KDContextMenu = false;
				send({ mp: 'peace.answer', accept: false });
			};
			return menu;   // answer first: you cannot counter-offer from a menu you owe an answer on
		}

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

	/**
	 * KDM-225 A6 — when an offer ARRIVES, open the answering menu.
	 *
	 * D2 says the prompt blocks the turn; D8 puts the answer on the player's own tile. Together those
	 * would leave a blocked player with nothing on screen telling them why, because nothing opens a
	 * context menu for them. Opening it on the transition null → set restores the modal behaviour D2
	 * intended, using the surface D8 already provides — no second UI. Edge-triggered, so a player who
	 * closes the menu to look around is not fought with.
	 */
	var _hadOffer = false;
	function pump() {
		install();
		var coop = coopState();
		var has = !!(coop && coop.peaceOffer && coop.peaceOffer.from);
		if (has && !_hadOffer) {
			try {
				var me = KDPlayer();
				if (me) {
					KinkyDungeonTargetX = me.x; KinkyDungeonTargetY = me.y;
					KDContextStage = 'Game';
					KDContextMenu = true;
				}
			} catch (e) { /* pre-boot */ }
		}
		_hadOffer = has;
	}

	// The bundle may not be evaluated yet when this script runs, and `KDGetContextActions` is a
	// bundle-scope `let` — so poll briefly rather than assuming load order. Cheap and bounded.
	var tries = 0;
	var timer = setInterval(function () {
		tries++;
		if (install() || tries > 200) clearInterval(timer);
	}, 100);
	setInterval(pump, 200);

	if (typeof window !== 'undefined') {
		window.KDCoopPeace = { install: install, decorate: decorate, pump: pump };
	}
})();
