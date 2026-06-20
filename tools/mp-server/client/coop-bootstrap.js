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
 * snapshot, and forwards arrow/WASD keys as one move per turn (lockstep — both
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
		lastTick: null, peers: [], status: 'init',
		sendMove: function (dx, dy) { submit(actionForDir(dx | 0, dy | 0)); },
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
		connect();
		installInput();
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
				setStatus('Co-op ' + id + '  turn ' + m.tick + '\n[arrows/WASD] move · [space] wait');
			} else if (m.type === 'waiting') {
				setStatus('Co-op ' + id + ': submitted, waiting for ' + (m.waitingOn || []).join(', ') + '…');
			} else if (m.type === 'error') {
				setStatus('Co-op ' + id + ': error — ' + m.error);
			}
		};
		ws.onclose = function () { coop.connected = false; setStatus('Co-op ' + id + ': disconnected'); };
	}

	function submit(action) {
		if (!ws || ws.readyState !== 1 || !coop.started || coop.submitted) return;
		coop.submitted = true;
		ws.send(JSON.stringify({ type: 'input', action: action }));
	}

	/** A directional key → a structured action: bump an adjacent enemy = attack; else move. */
	function actionForDir(dx, dy) {
		if (dx === 0 && dy === 0) return { kind: 'wait' };
		try {
			var p = KinkyDungeonPlayerEntity;
			var nx = p.x + dx, ny = p.y + dy;
			var enemy = (KDMapData.Entities || []).find(function (e) {
				return e.x === nx && e.y === ny && e.Enemy && KDGetFaction(e) !== 'Player';
			});
			if (enemy) return { kind: 'attack', tx: nx, ty: ny };
		} catch (e) { /* fall through to move */ }
		return { kind: 'move', dx: dx, dy: dy };
	}

	coop.sendAction = function (action) { submit(action); };

	var MOVES = {
		ArrowLeft: [-1, 0], a: [-1, 0], A: [-1, 0],
		ArrowRight: [1, 0], d: [1, 0], D: [1, 0],
		ArrowUp: [0, -1], w: [0, -1], W: [0, -1],
		ArrowDown: [0, 1], s: [0, 1], S: [0, 1],
		' ': [0, 0], '.': [0, 0],
	};

	function installInput() {
		// Capture-phase on window → intercept BEFORE the bundle's own key handler,
		// so no local turn/simulation runs; the server is authoritative. Arrows/WASD =
		// move-or-bump-attack; space/'.' = wait. (Other gameplay keys are swallowed by
		// the KDSendInput guard in render-client; local-only menus still work.)
		window.addEventListener('keydown', function (ev) {
			var mv = MOVES[ev.key];
			if (!mv) return;
			ev.preventDefault();
			ev.stopImmediatePropagation();
			submit(actionForDir(mv[0], mv[1]));
		}, true);
	}

	boot();
})();
