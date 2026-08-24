/**
 * tools/mp-server/kd-shop-buy.js  (KDM-264)
 *
 * BUYING BY IDENTITY, NOT BY INDEX — one definition, both runtimes.
 *
 * MOST of "two players share the hub merchants" already works by construction, and this file does not
 * touch that half. The stock is `KDMapData.ShopItems` — world state, built at `KDMapGen.ts:191-192`
 * and spliced on purchase at `KinkyDungeonShrine.ts:423` — while the purse is `KinkyDungeonGold`, an
 * ordinary small global and therefore per-player. Two purses, one stock, no duplication and no
 * double-sale come for free.
 *
 * WHAT DOES NOT WORK IS THE CURSOR. `KinkyDungeonShopIndex` is a per-player index INTO that shared
 * array, and the buy is a routed input carrying that index:
 * `KDSendInput("shrineBuy", {type, shopIndex})` (`KinkyDungeonShrine.ts:528`,
 * `KinkyDungeonGame.ts:4232`), handled by
 *
 *     "shrineBuy": (data) => { …; KinkyDungeonShopIndex = data.shopIndex; KinkyDungeonPayShrine(…); }
 *
 * (`KinkyDungeonInput.ts:613-620`). So if A buys index 2 while B is pointing at index 3, B's next
 * click buys index 3 of a now-SHORTER array — a different item. Money spent, wrong goods: a lost
 * purchase, and one the player has no way to see coming.
 *
 * ── THE TWO HALVES ────────────────────────────────────────────────────────────────────────────────
 *
 * 1. CLIENT, ON THE WAY OUT. The routed payload is enriched with the NAME (and shop type) the buyer
 *    was actually looking at, read from that client's own `KDMapData.ShopItems` at click time. Only
 *    the client knows this: by the time the server sees the input, the stock may already have moved.
 *
 * 2. SERVER, ON THE WAY IN. `KDInputTypes.shrineBuy` is wrapped: it re-finds that name in the CURRENT
 *    shared stock, re-points `KinkyDungeonShopIndex` at it and delegates to `_prev`, so KD performs
 *    the whole purchase — cost, discount, inventory, splice, reward program — exactly as it always
 *    does. If the item is gone, it REFUSES with a message instead of buying the neighbour (R14).
 *
 * ── WHAT IS DELIBERATELY NOT HERE: THE CURSOR'S DISPLAY (KDM-266) ────────────────────────────────
 * R14 also asks that a selection left open while the stock changes keep DENOTING the same item — that
 * the HIGHLIGHT follow its row. It is not implemented. The purchase resolves correctly either way (a
 * buy is tagged with the row the browser was showing at click time), so what is missing is the display
 * between the other player's purchase and yours, not the goods you get.
 *
 * Two attempts failed, and the notes are here so the third does not start from scratch:
 *
 *   · A wrap around `KDRenderClient.apply` that reads the selected item before `_prev` and looks it up
 *     again after is structurally blind. `coop-bootstrap.js` merges each delta with `kdMerge`, which
 *     MUTATES ITS TARGET IN PLACE (`kd-delta.js:83-94`), and that target's `.map` IS the live
 *     `KDMapData` from a previous apply — so the new stock is already installed before the wrapper is
 *     entered and there is no "before" left to read.
 *   · A variant remembering the id in its own variable did not hold either, with or without
 *     `KinkyDungeonShopIndex` excluded from replication. (It IS a watched per-player global — probed —
 *     so the server's copy overwriting the client's is a real second cause, but removing it was not
 *     sufficient, so at least one more is unaccounted for.)
 *
 * Note that the first round of that diagnosis was itself corrupted by the `__KD` prefix bug described
 * below, so treat the two bullets as leads rather than as a settled cause.
 *
 * ── WHY THE CLIENT HOOK IS ON `KDRenderClient` AND NOT ON `KDSendInput` ───────────────────────────
 * `render-client.js` installs its routing wrapper on `KDSendInput` LATE, inside `disableLocalSim()`,
 * long after this script has loaded — and that wrapper does not call through to whatever it replaced
 * when it routes. A `KDSendInput` wrap installed at load time would therefore be silently bypassed,
 * which is the exact class of failure this file exists to prevent. `KDRenderClient.sendInput` is an
 * object PROPERTY, resolved at call time, so wrapping it cannot be outrun.
 *
 * Exported as SOURCE TEXT for the same reason as `kd-peace-dialogue.js` and `kd-journey-choice.js`:
 * two runtimes, one definition. Each half is guarded on the global it needs, so the server installs
 * only the input wrap and the browser only the tag.
 */
'use strict';

const KD_SHOP_BUY = `
(function(){
	var g = (typeof globalThis !== 'undefined') ? globalThis : this;

	/*
	 * Drift + diagnostics. THE __KD PREFIX IS LOAD-BEARING, not a naming style.
	 *
	 * _candidateGlobals (headless-host.js) unions the bundle's own bindings with
	 * Object.keys(globalThis) and skips only names starting with __KD. So a plain globalThis.X that a
	 * mod creates IS a per-player state candidate: the server captures it, ships it in the bundle, and
	 * the CLIENT's copy is overwritten by the server's on the next snapshot.
	 *
	 * MEASURED, and it cost a long hunt: named KDCoopShopStats, the browser's counters read back as the
	 * SERVER's ({tagged:0, repointed:1}) - the client-side counter it had just incremented was gone and
	 * a server-side counter the browser never touches had appeared. The feature worked; only the
	 * evidence for it was being silently replaced.
	 */
	if (!g.__KDCoopShopStats) g.__KDCoopShopStats = { tagged: 0, repointed: 0, refused: 0 };

	/**
	 * WHICH item is this, as opposed to WHERE it is. Name plus shop type, because 'Rope' the loose
	 * restraint and 'Rope' the basic are different goods, and the shop can carry both.
	 * Two entries that agree on BOTH are interchangeable, so the first match is the right one.
	 */
	function idOf(item) {
		if (!item || item.name == null) return null;
		return String(item.name) + '|' + String(item.shoptype == null ? '' : item.shoptype);
	}
	function indexOfId(items, id) {
		if (!items || !id) return -1;
		for (var i = 0; i < items.length; i++) { if (idOf(items[i]) === id) return i; }
		return -1;
	}

	/* ── 2. SERVER: resolve the purchase by identity ─────────────────────────────────────────────── */
	if (typeof KDInputTypes !== 'undefined' && KDInputTypes && KDInputTypes.shrineBuy
		&& !KDInputTypes.shrineBuy._kdcoop_shop_wrapped) {
		var _prevBuy = KDInputTypes.shrineBuy;
		var wrappedBuy = function (data) {
			var id = data && data.shopItemId;
			// No id: a stock KD client, or an input built somewhere this wrap does not reach. Behave
			// exactly as before rather than refusing something the gateway simply cannot identify.
			if (!id || typeof KDMapData === 'undefined' || !KDMapData || !KDMapData.ShopItems) {
				return _prevBuy.apply(this, arguments);
			}
			var idx = indexOfId(KDMapData.ShopItems, id);
			if (idx < 0) {
				// R14 - SOLD OUT, and said so. The alternative is KD buying whatever now sits at the
				// old index: money spent on goods the player never chose, with no message at all.
				g.__KDCoopShopStats.refused++;
				if (typeof KinkyDungeonSendTextMessage === 'function') {
					KinkyDungeonSendTextMessage(10, (typeof TextGet === 'function')
						? TextGet('KDCoopShopItemGone') : 'That item has already been sold.', '#ff5555', 3);
				}
				return "";
			}
			g.__KDCoopShopStats.repointed++;
			var d = {};
			for (var k in data) d[k] = data[k];
			d.shopIndex = idx;
			return _prevBuy.call(this, d);
		};
		wrappedBuy._kdcoop_shop_wrapped = true;
		wrappedBuy._kdcoop_shop_original = _prevBuy;
		KDInputTypes.shrineBuy = wrappedBuy;
	}

	// The refusal's text key. Registered here, beside the only code that reads it, exactly as the
	// peace dialogue registers its own - a missing key prints "[NotFound] ..." straight at the player.
	if (typeof addTextKey === 'function') {
		addTextKey('KDCoopShopItemGone', 'That item has already been sold.');
	}

	/* ── 1. CLIENT: tag the purchase with the item this browser was showing ─────────────────────── */
	if (typeof g.KDRenderClient === 'object' && g.KDRenderClient) {
		var rc = g.KDRenderClient;

		if (typeof rc.sendInput === 'function' && !rc.sendInput._kdcoop_shop_wrapped) {
			var _prevSend = rc.sendInput;
			var wrappedSend = function (action) {
				if (action && action.kdType === 'shrineBuy' && action.data
					&& typeof KDMapData !== 'undefined' && KDMapData && KDMapData.ShopItems) {
					var id = idOf(KDMapData.ShopItems[action.data.shopIndex]);
					if (id) {
						g.__KDCoopShopStats.tagged++;
						var d = {};
						for (var k in action.data) d[k] = action.data[k];
						d.shopItemId = id;
						action = { kdType: action.kdType, data: d };
					}
				}
				return _prevSend.call(this, action);
			};
			wrappedSend._kdcoop_shop_wrapped = true;
			wrappedSend._kdcoop_shop_original = _prevSend;
			rc.sendInput = wrappedSend;
		}


	}
})();
`;

/** The browser-ready form — identical text, served as a script (demo-server.js INJECT). */
const KD_SHOP_BUY_BROWSER = KD_SHOP_BUY;

module.exports = { KD_SHOP_BUY, KD_SHOP_BUY_BROWSER };
