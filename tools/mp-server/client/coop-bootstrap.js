/**
 * tools/mp-server/client/coop-bootstrap.js  (KD-071 — hands-on UAT)
 *
 * Injected by demo-server.js into index.html (after out/main.js + render-client.js).
 * Turns a normal browser tab into a co-op thin client when the URL carries
 * `#coop=<id>` (e.g. http://localhost:8080/#coop=A). With no `#coop`, it does
 * nothing — the page is the normal single-player game.
 *
 * It: waits for the bundle, brings up render structures, marks the tab render-only,
 * opens a same-origin WebSocket to the bridge, applies each server render-state
 * snapshot, and lets KD's DEFAULT controls drive — the routed KDSendInput wrapper
 * (render-client) forwards each turn-consuming action to the server (lockstep — both
 * players must act to advance). Exposes window.__coop for the e2e harness.
 */
(function () {
	'use strict';

	function getCoopId() {
		var m = /(?:[#&?])coop=([A-Za-z0-9_-]+)/.exec(location.hash + '&' + location.search);
		return m ? m[1] : null;
	}

	var id = getCoopId();
	if (!id) return;   // not a co-op tab — leave the normal game alone

	// KD-098 diagnostics: ON by default for the co-op demo (it's a debug harness). Logs to the
	// browser console: every KDSendInput classification (render-client) + every submit() here.
	// Add `&nodebug` to the URL to silence. Watch the console while reproducing PvP attacks.
	window.__KDMP_DEBUG = !/(?:[#&?])nodebug/.test(location.hash + '&' + location.search);

	var coop = window.__coop = {
		id: id, connected: false, started: false, submitted: false,
		lastTick: null, peers: [], status: 'init', route: null,
		// KDM-163: route-ness of each in-flight send, in order (see submit()).
		_sentRoute: [],
		// Test hooks (deterministic). Real play uses KD's default controls → the routed
		// KDSendInput wrapper → submit(). These build the same {kdType,data} actions.
		sendMove: function (dx, dy) {
			submit({ kdType: 'move', data: { dir: { x: dx | 0, y: dy | 0 }, delta: 1, AllowInteract: true } });
		},
		sendAction: function (action) { submit(action); },
	};

	var ws = null;
	var overlay = null;

	function setStatus(text) {
		coop.status = text;
		if (!overlay) {
			overlay = document.createElement('div');
			overlay.id = 'coop-overlay';
			overlay.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99999;background:rgba(0,0,0,0.65);' +
				'color:#fff;font:14px/1.4 monospace;padding:6px 10px;border-radius:6px;pointer-events:none;white-space:pre';
			document.body.appendChild(overlay);
		}
		overlay.textContent = text;
	}

	function ready() {
		return typeof KinkyDungeonStartNewGame === 'function' && typeof window.KDRenderClient === 'object';
	}

	// The bundle preloads character assets first (KinkyDungeonState 'Consent', the
	// "Preloading Character Assets…" screen). Starting a game BEFORE that finishes is
	// clobbered by the loading flow. Wait for KDLoadingFinished, THEN enter co-op.
	function loaded() {
		return typeof KDLoadingFinished !== 'undefined' && KDLoadingFinished === true;
	}

	function boot() {
		if (!ready()) { setTimeout(boot, 100); return; }
		if (!loaded()) { setStatus('Co-op ' + id + ': loading game assets…'); setTimeout(boot, 200); return; }
		// assets ready → bring up the dungeon and go render-only
		forceGameScreen();
		window.KDRenderClient.disableLocalSim();
		// KD's default controls drive: the routed KDSendInput wrapper hands each
		// turn-consuming action to this callback, which forwards it to the server.
		window.KDRenderClient.onInput(function (action) { submit(action); });
		installRouteDriver();
		ensureQuickBind();
		ensureStartItem();
		connect();
	}

	/** Read a hash/query param like `&startitem=HingedCuffs`. */
	function getParam(name) {
		var m = new RegExp('(?:[#&?])' + name + '=([A-Za-z0-9_]+)').exec(location.hash + '&' + location.search);
		return m ? m[1] : null;
	}

	/**
	 * KD-101 UAT: give THIS client a carryable loose-restraint item (Items inventory). The name comes
	 * from the server (snapshot.startItem, driven by KD_START_RESTRAINT) or a URL override
	 * (`#coop=A&startitem=HingedCuffs`). The Items inventory is client-local (snapshots don't sync it),
	 * so it must be added here to be visible; the server bundle has the same item so apply works too.
	 * Stock function, no game-source edit. Idempotent (won't double-add).
	 */
	function addStartItem(spec) {
		// Accepts one name or a comma/space-separated list, matching the server's
		// KDParseStartRestraints (swap-session.js) — e.g. "MasterworkHeels,HighsecShackles".
		if (!spec) return;
		var names = String(spec).split(/[,\s]+/).filter(Boolean);
		if (names.length > 1) { names.forEach(addStartItem); return; }
		var name = names[0];
		try {
			if (!name) return;
			if (typeof KinkyDungeonInventoryAddLoose !== 'function') return;
			if (typeof KinkyDungeonGetRestraintByName === 'function' && !KinkyDungeonGetRestraintByName(name)) return;
			if (typeof KinkyDungeonInventoryGetLoose === 'function' && KinkyDungeonInventoryGetLoose(name)) return; // already carry it
			KinkyDungeonInventoryAddLoose(name);
		} catch (e) { /* best-effort UAT convenience */ }
	}

	/** URL-override path (runs at boot, before the first snapshot). */
	function ensureStartItem() { addStartItem(getParam('startitem')); }

	/**
	 * KD-101: pre-select the player's binding material as the quick-bind item (stock
	 * KinkyDungeonAttemptQuickRestraint). When "Tie Up" casts Bondage with a raw material
	 * selected, the stock cast (KinkyDungeonMagicCode "Bondage") opens the bind submenu
	 * already in the generic view with THAT material's category chosen. Without a selection
	 * the submenu defaults to the first global category (ChainRaw) — which the demo players
	 * don't carry — so every restraint click is gated out by the quantity check and "Tie Up
	 * does nothing". We only select when the player has no selection of their own, and only a
	 * generic raw binding material they actually own — pure stock data/selection, no patch.
	 */
	function ensureQuickBind() {
		try {
			if (typeof KinkyDungeonAttemptQuickRestraint !== 'function') return;
			if (typeof KinkyDungeonTargetingSpellItem !== 'undefined' && KinkyDungeonTargetingSpellItem) return;
			if (typeof KinkyDungeonFilterInventory !== 'function' || typeof KDRestraint !== 'function') return;
			var inv = KinkyDungeonFilterInventory(LooseRestraint, undefined, undefined, undefined, undefined, KDInvFilter, undefined, undefined, true) || [];
			for (var i = 0; i < inv.length; i++) {
				var r = KDRestraint(inv[i].item);
				if (r && r.shrine && r.shrine.indexOf('Raw') >= 0) {
					KinkyDungeonAttemptQuickRestraint(inv[i].name);
					return;
				}
			}
		} catch (e) { /* best-effort demo convenience */ }
	}

	/**
	 * Click-to-move routes (KD's "FastMove") are normally drained by KD's per-frame
	 * loop (KinkyDungeon.ts ~3077) — incompatible with lockstep: under the thin client
	 * each KDSendInput('move') is routed to the server and returns without changing
	 * local MovePoints, so KD splices the WHOLE path within a few frames while the
	 * per-turn submit gate drops all but the first step → the route is "forgotten"
	 * after one tile. Fix: keep KD's real pathfinding (KDFastMoveTo), but capture the
	 * path and advance it ONE step per resolved server turn (driven from each 'state'),
	 * disabling KD's local drainer.
	 */
	function installRouteDriver() {
		coop._stepRoute = stepRoute;   // test hook (deterministic e2e route driving)
		if (typeof KDFastMoveTo !== 'function' || KDFastMoveTo.__coopWrapped) return;
		var _origFast = KDFastMoveTo;
		KDFastMoveTo = function () {
			var r = _origFast.apply(this, arguments);   // computes KinkyDungeonFastMovePath
			var path = (typeof KinkyDungeonFastMovePath !== 'undefined' && KinkyDungeonFastMovePath)
				? KinkyDungeonFastMovePath.slice() : [];
			KinkyDungeonFastMovePath = [];               // stop KD's own per-frame drainer
			coop.route = path.length ? path : null;
			stepRoute();                                 // submit the first step this turn
			return r;
		};
		KDFastMoveTo.__coopWrapped = true;
	}

	/**
	 * Submit the next route step toward the goal — one per lockstep turn (called from
	 * each server 'state'). Terminates on arrival/empty path, on displacement (the
	 * server moved us off the path), or when an enemy appears (KD's fast-move does the
	 * same via KinkyDungeonInDanger).
	 */
	function stepRoute() {
		if (coop.submitted) return;   // already acted this turn — don't consume a route step
		if (!coop.route || !coop.route.length) { coop.route = null; return; }
		if (typeof KinkyDungeonInDanger === 'function' && KinkyDungeonInDanger()) { coop.route = null; return; }
		var p = KinkyDungeonPlayerEntity;
		var next = coop.route[0];
		var dx = next.x - p.x, dy = next.y - p.y;
		if (Math.max(Math.abs(dx), Math.abs(dy)) > 1.5) { coop.route = null; return; }  // displaced/blocked
		coop.route.shift();
		submit({ kdType: 'move', data: { dir: { x: dx, y: dy }, delta: 1, AllowInteract: true } }, true);
	}

	/** Start a game ONCE to bring up dungeon structures, then pin to the Game screen. */
	function forceGameScreen() {
		try {
			KinkyDungeonStartNewGame(false);
		} catch (e) { /* the server snapshot will populate the rest */ }
		pinGameScreen();
	}

	/** Cheap per-frame guard: keep the dungeon on screen (don't regen the map). */
	function pinGameScreen() {
		KinkyDungeonState = 'Game';
		KinkyDungeonDrawState = 'Game';
		// The client doesn't simulate, so vision/fog isn't recomputed after we adopt
		// new state — the map stays dark and entities stay hidden. Flag a vision
		// recompute so the draw lights the map around the (server-set) player position
		// and reveals the shared enemy + the other player's avatar.
		if (typeof KinkyDungeonUpdateLightGrid !== 'undefined') KinkyDungeonUpdateLightGrid = true;
	}

	function connect() {
		var proto = location.protocol === 'https:' ? 'wss' : 'ws';
		ws = new WebSocket(proto + '://' + location.host + '/');
		coop.ws = ws;
		setStatus('Co-op ' + id + ': connecting…');
		ws.onopen = function () {
			coop.connected = true;
			ws.send(JSON.stringify({ type: 'join', clientId: id }));
			setStatus('Co-op ' + id + ': joined, waiting for the other player…');
		};
		ws.onmessage = function (e) {
			var m; try { m = JSON.parse(e.data); } catch (_) { return; }
			if (m.type === 'joined') { coop.peers = m.players || []; }
			else if (m.type === 'state' && m.kind === 'ui') {
				// KDM-163: a UI input of OURS was applied — no turn resolved. Adopt the fresh state so
				// the menu responds (R6), and touch NOTHING that is per-turn. Treating this as a turn
				// is what used to kill click-to-move: with every input routed, KD's draw loop sends
				// `setMoveDirection` each frame, so this branch runs ~60×/s.
				coop.started = true;
				coop._sentRoute.shift();          // this reply consumed one send: it was a UI input
				window.KDRenderClient.apply(m.snapshot);
				pinGameScreen();
			}
			else if (m.type === 'state') {
				coop.started = true;
				coop.submitted = false;
				// A turn resolved. If OUR action in it was a MANUAL one (not a route step), it cancels
				// any in-progress route — the player changed their mind. Deciding this here rather than
				// at send time is the point: at send time the client cannot know whether an input
				// consumes a turn at all, and per-frame UI chatter would cancel every route.
				// An empty queue means this turn was resolved by the PEER while we sent nothing.
				if (coop._sentRoute.length && coop._sentRoute.shift() === false) coop.route = null;
				coop._sentRoute.length = 0;       // per-turn: nothing sent before now is still pending
				coop.lastTick = m.tick;
				if (window.__KDMP_DEBUG && m.serverLog && m.serverLog.length) {
					// KD-098: echo the server's per-turn diagnostics into THIS browser console
					// (so one screenshot has both client + server logs — no Docker terminal needed).
					for (var li = 0; li < m.serverLog.length; li++) {
						try { console.log('[mp-server] ' + m.serverLog[li]); } catch (e) { /* ignore */ }
					}
				}
				window.KDRenderClient.apply(m.snapshot);
				// KD-101 UAT: seed the server-configured carryable restraint item once (the Items inventory
				// is client-local, so it must be added here even though the server bundle already has it).
				if (!coop._startItemAdded && m.snapshot && m.snapshot.startItem) {
					addStartItem(m.snapshot.startItem);
					coop._startItemAdded = true;
				}
				pinGameScreen();   // keep the dungeon on screen (don't let the menu steal it)
				if (coop.route) stepRoute();   // advance a click-to-move route by one tile this turn
				setStatus('Co-op ' + id + '  turn ' + m.tick + '\n[arrows/WASD] move · [space] wait');
			} else if (m.type === 'waiting') {
				// KDM-163: the server has confirmed our input entered LOCKSTEP — that, and not the act
				// of sending, is what means "I have acted this turn".
				coop.submitted = true;
				// a MANUAL action (not a route step) cancels an in-progress route
				if (coop._sentRoute.length && coop._sentRoute.shift() === false) coop.route = null;
				setStatus('Co-op ' + id + ': submitted, waiting for ' + (m.waitingOn || []).join(', ') + '…');
			} else if (m.type === 'await') {
				// a peer has acted and is waiting on US — act so the turn can resolve.
				var g = m.graceMs ? ' (auto-pass in ' + (Math.round(m.graceMs / 100) / 10) + 's)' : '';
				setStatus('Co-op ' + id + ': your move — others ready' + g + '\n[arrows/WASD] move · [space] wait');
			} else if (m.type === 'error') {
				setStatus('Co-op ' + id + ': error — ' + m.error);
			}
		};
		ws.onclose = function () { coop.connected = false; setStatus('Co-op ' + id + ': disconnected'); };
	}

	function submit(action, fromRoute) {
		// A MANUAL action may REPLACE an already-submitted-but-unresolved one (we're still waiting for
		// the peer): the server keeps only the latest pending action and the turn waits for the peer
		// regardless, so e.g. opening "Tie Up" / applying a restraint after you've already moved still
		// works instead of being silently dropped. Route auto-steps still respect the one-per-turn gate.
		var blocked = !ws || ws.readyState !== 1 || !coop.started || (coop.submitted && !!fromRoute);
		if (blocked) {
			if (window.__KDMP_DEBUG) {
				try {
					console.log('[coop ' + id + '] submit BLOCKED', JSON.stringify(action),
						{ wsOpen: !!(ws && ws.readyState === 1), started: coop.started, alreadySubmitted: coop.submitted, fromRoute: !!fromRoute });
				} catch (e) { /* ignore */ }
			}
			return;
		}
		// KDM-163: do NOT decide "I have acted" or "cancel the route" here. Once the client routes every
		// input it cannot tell a turn-consuming action from KD's per-frame `setMoveDirection`, and
		// guessing at send time cancelled every route within one frame.
		//
		// Instead queue this send's route-ness. The bridge replies to each input EXACTLY once and in
		// order — `kind:'ui'` for one applied immediately, `waiting` or a turn-resolving `state` for one
		// that entered lockstep — so shifting the queue on each reply tells us the route-ness of the
		// input the server actually acted on. A single slot was not enough: one frame of mouse chatter
		// after a route step would overwrite it and cancel the route when the turn resolved.
		coop._sentRoute.push(!!fromRoute);
		while (coop._sentRoute.length > 64) coop._sentRoute.shift();   // bounded; a stall must not grow it
		if (window.__KDMP_DEBUG) { try { console.log('[coop ' + id + '] submit ->', JSON.stringify(action)); } catch (e) { /* ignore */ } }
		ws.send(JSON.stringify({ type: 'input', action: action }));
	}

	boot();
})();
