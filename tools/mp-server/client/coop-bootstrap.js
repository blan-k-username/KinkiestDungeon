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

	var coop = window.__coop = {
		id: id, connected: false, started: false, submitted: false,
		lastTick: null, peers: [], status: 'init', route: null,
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
		connect();
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
			else if (m.type === 'state') {
				coop.started = true;
				coop.submitted = false;
				coop.lastTick = m.tick;
				window.KDRenderClient.apply(m.snapshot);
				pinGameScreen();   // keep the dungeon on screen (don't let the menu steal it)
				if (coop.route) stepRoute();   // advance a click-to-move route by one tile this turn
				setStatus('Co-op ' + id + '  turn ' + m.tick + '\n[arrows/WASD] move · [space] wait');
			} else if (m.type === 'waiting') {
				setStatus('Co-op ' + id + ': submitted, waiting for ' + (m.waitingOn || []).join(', ') + '…');
			} else if (m.type === 'error') {
				setStatus('Co-op ' + id + ': error — ' + m.error);
			}
		};
		ws.onclose = function () { coop.connected = false; setStatus('Co-op ' + id + ': disconnected'); };
	}

	function submit(action, fromRoute) {
		if (!ws || ws.readyState !== 1 || !coop.started || coop.submitted) return;
		if (!fromRoute) coop.route = null;   // a manual action cancels an in-progress route
		coop.submitted = true;
		ws.send(JSON.stringify({ type: 'input', action: action }));
	}

	boot();
})();
