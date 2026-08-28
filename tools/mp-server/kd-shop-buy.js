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
 * ── 3. CLIENT, BETWEEN FRAMES: THE CURSOR'S DISPLAY (KDM-266) ────────────────────────────────────
 * R14's other half — a selection left open while the stock changes keeps DENOTING the same item.
 * Section 3 below, and its own header explains the ordering it rests on. It took three attempts, and
 * the two that failed were both right about the feature and wrong about WHERE to read the identity:
 *
 *   · A wrap around `KDRenderClient.apply` alone is blind on the DELTA path. `coop-bootstrap.js`
 *     merges each delta with `kdMerge`, which MUTATES ITS TARGET IN PLACE (`kd-delta.js:83-94`), and
 *     that target's `.map` IS the live `KDMapData` — so the new stock is already installed before the
 *     wrapper is entered. What that attempt missed is that this is true of the delta path ONLY: a full
 *     snapshot never reaches the merge, so `apply` is exactly the right place for it. Hence two hooks.
 *   · Excluding `KinkyDungeonShopIndex` from replication was NECESSARY (it is a watched per-player
 *     global, and both the adopt and the absent-rule overwrite the viewer's own cursor) but never
 *     sufficient on its own, because the re-point half was still blind. Neither half works alone —
 *     which is why removing the exclusion reds `mp-shop-identity.spec.ts` and so does disabling the
 *     hooks. The exclusion lives in `CLIENT_OWNED_GLOBALS` (render-client.js), NOT in
 *     `GLOBAL_BLACKLIST`: that list is per-CATEGORY and this global genuinely is per-player.
 *
 * The first round of that diagnosis was corrupted by the `__KD` prefix bug described below, which is
 * why every counter here still carries the prefix.
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
	if (!g.__KDCoopShopStats) g.__KDCoopShopStats = { tagged: 0, repointed: 0, refused: 0, followed: 0, sold: 0 };

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
		// KDM-266 — the DISPLAY sibling of the refusal above. Not "your click was rejected" but "the
		// thing you were looking at is no longer on the shelf", said to a player who never clicked.
		addTextKey('KDCoopShopItemSold', 'The item you were looking at has been sold.');
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
						// KDM-266: remembered so the cursor half below can tell "the partner sold it"
						// from "you bought it". Without this the buyer is told their OWN purchase has
						// been sold, every time they clear the last of a line.
						_ownBuyId = id;
						_soldNotice = null;                   // acting on the shop spends the notice
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

		/* ── 3. CLIENT: the CURSOR'S DISPLAY — KDM-266 ────────────────────────────────────────────
		 *
		 * The half above makes sure you BUY what you were shown. This one makes sure you are still
		 * being shown it. B points at row 2, A buys row 0, the stock shrinks, and row 2 is now a
		 * different potion — one turn of looking at a lie.
		 *
		 * WHY TWO HOOKS AND NOT ONE. The obvious wrap — read the selection before
		 * \`KDRenderClient.apply\`, look it up again after — is structurally blind on the DELTA path,
		 * and that is what sank the first attempt at this. \`coop-bootstrap.js:1333\` merges with
		 * \`kdMerge\`, which MUTATES ITS TARGET IN PLACE (kd-delta.js), and the target's \`.map\` IS the
		 * live \`KDMapData\` (adopted wholesale at render-client.js:544). The new stock is therefore
		 * already installed before \`apply\` is entered; there is no "before" left to read.
		 *
		 * But that is true of the delta path ONLY. A full snapshot never reaches the merge
		 * (\`coop-bootstrap.js:1327\` returns it untouched), so at \`apply\` entry \`KDMapData\` is still
		 * the old object. Hence: capture at \`kdMerge\` entry for deltas, at \`apply\` entry for
		 * snapshots, and re-point after \`apply\`. Both targets are object PROPERTIES resolved at call
		 * time — the same un-outrunnable-wrap argument this file already makes for \`sendInput\` —
		 * and \`kdMerge\`'s own recursion calls its local declaration, not the property, so the wrap
		 * sees the top-level call and nothing else.
		 *
		 * WHAT MAKES THE DOUBLE HOOK SAFE is \`note()\`'s single condition: the identity is re-derived
		 * only when the cursor INDEX has moved, which only the player does. After a delta the index
		 * is whatever we last wrote, so the apply-entry call is a no-op and cannot re-read the
		 * identity off the already-mutated array. No per-frame poll, and no race between a click and
		 * an arriving frame.
		 *
		 * SECOND CAUSE, fixed elsewhere: \`KinkyDungeonShopIndex\` was also being REPLICATED — adopted
		 * from the bundle when the server carried it, and reset to 0 by the absent-rule once it had.
		 * It is excluded client-side by \`CLIENT_OWNED_GLOBALS\` (render-client.js). Neither half works
		 * alone: without the exclusion the cursor is overwritten right after being re-pointed.
		 */
		var _selIdx = -1;        // where this browser last saw the cursor…
		var _selId = null;       // …and WHICH item was under it there
		var _ownBuyId = null;    // an item THIS browser has just bought (so it is not "sold" news)
		var _soldNotice = null;  // the line to keep re-asserting (see ensureNotice)
		var _soldRepeats = 0;

		function shopItems() {
			return (typeof KDMapData !== 'undefined' && KDMapData && KDMapData.ShopItems)
				? KDMapData.ShopItems : null;
		}

		/** Adopt the player's current selection — and ONLY when they were the one who moved it. */
		function note() {
			var items = shopItems();
			if (!items) { _selIdx = -1; _selId = null; return; }
			if (KinkyDungeonShopIndex === _selIdx) return;
			_selIdx = KinkyDungeonShopIndex;
			_selId = idOf(items[_selIdx]);
			_soldNotice = null;                               // a fresh pick — the old notice is spent
		}

		/**
		 * Keep the sold notice visible across the wholesale log replace.
		 *
		 * KinkyDungeonMessageLog is a SERVER-REPLICATED channel: every apply overwrites it wholesale
		 * with the server's copy (render-client.js:641), so a line this
		 * browser pushes on its own is gone on the next frame — measured, as an empty log in
		 * mp-shop-identity.spec.ts. The refusal message KDM-264 sends does not have this problem
		 * because it is emitted SERVER-side and replicated like any other line; this notice cannot be,
		 * because only the client knows where its own cursor was pointing.
		 *
		 * So it is re-asserted after each adopt, in the shape KDM-196 already uses for client-owned
		 * state carried across a wholesale replace — pushed only when it is not already the newest
		 * line, so the log never accumulates copies of it.
		 *
		 * BOUNDED, and stated rather than discovered: it stops re-asserting after a fixed number of
		 * adopted frames, and the moment the player moves the cursor or buys. Without a bound the line
		 * would sit at the tail of that player's log for the rest of the session, jumping ahead of
		 * every newer server line — the cost of living on a channel we do not own.
		 */
		function ensureNotice() {
			if (!_soldNotice) return;
			if (_soldRepeats <= 0) { _soldNotice = null; return; }
			if (typeof KinkyDungeonMessageLog === 'undefined' || !KinkyDungeonMessageLog) return;
			var last = KinkyDungeonMessageLog[KinkyDungeonMessageLog.length - 1];
			if (last && last.text === _soldNotice) return;
			_soldRepeats--;
			if (typeof KinkyDungeonSendTextMessage === 'function') {
				KinkyDungeonSendTextMessage(10, _soldNotice, '#ff5555', 3);
			}
		}

		/** …and put it back under that item once the new stock is in. */
		function refollow() {
			var items = shopItems();
			if (!items || !_selId) return;
			if (idOf(items[_selIdx]) === _selId) return;      // nothing moved under the cursor

			var i = indexOfId(items, _selId);
			if (i >= 0) {
				KinkyDungeonShopIndex = i;
				_selIdx = i;
				g.__KDCoopShopStats.followed++;
				return;
			}

			// GONE. The cursor must still land on a REAL row: KinkyDungeonShrine.ts:560/563/566/586/588
			// dereference ShopItems[KinkyDungeonShopIndex].name unguarded on every drawn frame, and
			// the one guard (:521) tests "greater than" where it means "greater or equal", with an
			// empty body besides. "Select nothing" is a
			// crash, not a blank selection — see UPSTREAM_ISSUES.md.
			var own = (_selId === _ownBuyId);
			_ownBuyId = null;
			var idx = own ? (_selIdx > 0 ? _selIdx - 1 : _selIdx) : _selIdx;  // KD's own rule, :424
			if (idx > items.length - 1) idx = items.length - 1;
			if (idx < 0) idx = 0;
			KinkyDungeonShopIndex = idx;
			_selIdx = idx;
			// Adopting the new row's identity here is also what makes the notice fire ONCE: a shelf
			// that keeps shrinking is then following a DIFFERENT item, not re-reporting this one.
			_selId = idOf(items[idx]);

			if (own) return;                                   // you know what you just bought
			g.__KDCoopShopStats.sold++;
			_soldNotice = (typeof TextGet === 'function')
				? TextGet('KDCoopShopItemSold')
				: 'The item you were looking at has been sold.';
			_soldRepeats = 20;
		}

		if (typeof rc.apply === 'function' && !rc.apply._kdcoop_shop_wrapped) {
			var _prevApply = rc.apply;
			var wrappedApply = function () {
				note();                                        // the SNAPSHOT path's "before"
				var r = _prevApply.apply(this, arguments);
				refollow();
				ensureNotice();                                // after the log has been replaced
				return r;
			};
			wrappedApply._kdcoop_shop_wrapped = true;
			wrappedApply._kdcoop_shop_original = _prevApply;
			rc.apply = wrappedApply;
		}

		if (g.KDDelta && typeof g.KDDelta.kdMerge === 'function' && !g.KDDelta.kdMerge._kdcoop_shop_wrapped) {
			var _prevMerge = g.KDDelta.kdMerge;
			var wrappedMerge = function () {
				note();                                        // the DELTA path's "before"
				return _prevMerge.apply(this, arguments);
			};
			wrappedMerge._kdcoop_shop_wrapped = true;
			wrappedMerge._kdcoop_shop_original = _prevMerge;
			g.KDDelta.kdMerge = wrappedMerge;
		}
	}
})();
`;

/** The browser-ready form — identical text, served as a script (demo-server.js INJECT). */
const KD_SHOP_BUY_BROWSER = KD_SHOP_BUY;

module.exports = { KD_SHOP_BUY, KD_SHOP_BUY_BROWSER };
