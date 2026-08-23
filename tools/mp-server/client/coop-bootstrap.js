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
	// KDM-233: WHERE THE SOCKET GOES, and who we say we are.
	//
	// The `#coop=` path is always same-origin and needs none of this. The lobby's Join screen supplies
	// a host ADDRESS instead — that is the whole point of joining by address — so the endpoint can no
	// longer be `location.host` unconditionally (it was, at `connect()` below).
	//
	// With no `#coop=` this module now defines its API and boots NOTHING: everything between here and
	// the bottom is declarations, and the only top-level effects are the debug flag and the boot call
	// at the very end, which is now conditional. A normal single-player page is untouched.
	var endpoint = null;      // 'host:port' — null means same-origin
	var role = null;          // 'host' | 'guest' | null (legacy direct join)
	var playerName = '';      // what the host sees in their accept/decline prompt

	// KD-098 diagnostics: ON by default for the co-op demo (it's a debug harness). Logs to the
	// browser console: every KDSendInput classification (render-client) + every submit() here.
	// Add `&nodebug` to the URL to silence. Watch the console while reproducing PvP attacks.
	window.__KDMP_DEBUG = !/(?:[#&?])nodebug/.test(location.hash + '&' + location.search);

	var coop = window.__coop = {
		id: id, connected: false, started: false, submitted: false, blocked: null,
		lastTick: null, peers: [], status: 'init', route: null,
		// KDM-250: who has dropped, as {clientId, role} — null while everyone is here. Declared up
		// front rather than sprung into existence on the first drop, so "nobody has left" is a value
		// a test can assert on instead of an absent property.
		peerMissing: null,
		// KDM-252: the retry state. `total` is a LATCH — it counts every attempt ever made and is
		// never reset, because `connected === true` is not evidence of a reconnect (it is also what a
		// socket that never dropped looks like). `attempts` is the backoff position and DOES reset on
		// a successful join, so a second, later drop starts its own schedule at 1 s rather than
		// inheriting a 30 s wait from an outage an hour ago.
		reconnect: { attempts: 0, total: 0, nextDelayMs: null },
		// KDM-163: route-ness of each in-flight send, in order (see submit()).
		_sentRoute: [],
		// KDM-186 RULE 1 state: types with an unacknowledged send, the types in flight in ORDER (so a
		// reply frees the right one), and the latest superseded action per type awaiting a free slot.
		// KDM-186 RULE 1 state: unacknowledged sends per type, the types + payload keys in flight in
		// ORDER, and the server's proven no-op verdicts (cleared whenever a turn moves the world).
		// KDM-186 Rule 1 v3: unacknowledged sends per type, the types in flight in ORDER, the newest
		// superseded action per STREAM type awaiting a free slot, and what the SERVER said each type is
		// ('ui' = presentation stream, anything else = command). Learned, never enumerated.
		_inFlight: {}, _sentTypes: [], _pending: {}, _kindOf: {},
		// Test hooks (deterministic). Real play uses KD's default controls → the routed
		// KDSendInput wrapper → submit(). These build the same {kdType,data} actions.
		sendMove: function (dx, dy) {
			submit({ kdType: 'move', data: { dir: { x: dx | 0, y: dy | 0 }, delta: 1, AllowInteract: true } });
		},
		sendAction: function (action) { submit(action); },
	};


	/* ────────────────────────────────────────────────────────────────────────────────────────────
	 * UAT TELEMETRY — `window.__coopDiag` (KDM-186)
	 *
	 * Three UAT symptoms (peer avatar twitching, input not landing, hover lag) all point at ONE
	 * suspect: KD's draw loop calls `KDSendInput('setMoveDirection', …)` every frame from the mouse
	 * position, and since KDM-163 the client routes EVERY input. So each frame becomes a server
	 * round-trip whose reply is a FULL snapshot (`snapshotFor` = restorePlayer + serializeRenderState
	 * + the whole player bundle), which the client applies and then forces a light-grid recompute.
	 *
	 * This block MEASURES that rather than assuming it, and ships two live toggles so one UAT session
	 * can settle it without a rebuild. Everything is additive and costs nothing when quiet.
	 *
	 * In the browser console:
	 *   __coopDiag.dump()            → JSON of the last 120 one-second rollups + recent real inputs
	 *   copy(__coopDiag.dump())      → same, straight onto the clipboard (paste it back to me)
	 *   __coopDiag.quiet(true)          → stop the per-send console.log (itself a suspect: it runs
	 *                                     JSON.stringify + console.log ~60×/s with debug on)
	 *   __coopDiag.suppressHover(true)  → stop routing the per-frame `setMoveDirection`; compare the
	 *                                     frame rate before and after to see whether that round-trip
	 *                                     is what starves the loop (KDM-204). Diagnostic only.
	 *   __coopDiag.reset()           → clear counters
	 * ──────────────────────────────────────────────────────────────────────────────────────────── */
	var diag = window.__coopDiag = (function () {
		var d = {
			enabled: true, _quiet: false, _verbose: false,
			rollups: [], inputs: [],           // ring buffers, bounded below
			_win: null, _pending: [], _lastPos: {},
		};
		function freshWindow() {
			return {
				t: 0, frames: 0, sends: {}, recv: { ui: 0, turn: 0 }, recvBytes: 0,
				applyMs: 0, applyMax: 0, applies: 0, peerMoves: 0, peerReversals: 0, wsBuffered: 0,
				skips: {}, skipTypes: {},
			};
		}
		d._win = freshWindow();

		/** An input was sent — count it and start its round-trip clock. Every type is measured the
		 * same way; the ring is bounded, so a high-rate type costs memory, not a special case. */
		d.noteSend = function (action) {
			var type = (action && action.kdType) || (action && action.kind) || 'unknown';
			d._win.sends[type] = (d._win.sends[type] || 0) + 1;
			d._pending.push({ type: type, t: (window.performance || Date).now() });
			while (d._pending.length > 32) d._pending.shift();
			return type;
		};
		/** A reply arrived. `kind` is 'ui' (no turn) or 'turn' (lockstep resolved). */
		d.noteRecv = function (kind, bytes) {
			d._win.recv[kind] = (d._win.recv[kind] || 0) + 1;
			d._win.recvBytes += bytes || 0;
			var p = d._pending.shift();
			if (p) {
				var ms = (window.performance || Date).now() - p.t;
				d.inputs.push({ type: p.type, kind: kind, ms: Math.round(ms) });
				while (d.inputs.length > 50) d.inputs.shift();
			}
		};
		/** Cost of adopting a snapshot — the thing that runs per frame if hover chatter is routed. */
		d.noteApply = function (ms) {
			d._win.applies++; d._win.applyMs += ms;
			if (ms > d._win.applyMax) d._win.applyMax = ms;
		};
		/**
		 * "Twitching": count how often ANY rendered entity REVERSES direction between snapshots.
		 * Smooth movement rarely reverses; a position fighting between the server snapshot and the local
		 * draw oscillates, so reversals-per-second is what separates the two. Tracked per entity id so a
		 * twitching peer avatar is visible even while the shared enemy walks normally.
		 */
		d.noteEntities = function (list) {
			if (!list || !list.length) return;
			for (var i = 0; i < list.length; i++) {
				var e = list[i]; if (!e || e.id == null || e.x == null) continue;
				var prev = d._lastPos[e.id];
				if (prev) {
					var dx = e.x - prev.x, dy = e.y - prev.y;
					if (dx || dy) {
						d._win.peerMoves++;
						var dir = (dx > 0 ? 1 : dx < 0 ? -1 : 0) + 3 * (dy > 0 ? 1 : dy < 0 ? -1 : 0);
						if (prev.dir && dir === -prev.dir) {
							d._win.peerReversals++;
							d._win.worst = e.id;
						}
						prev.dir = dir;
					}
					prev.x = e.x; prev.y = e.y;
				} else { d._lastPos[e.id] = { x: e.x, y: e.y, dir: 0 }; }
			}
		};

		// 1 Hz rollup. One console line per second — readable while playing, and the ring buffer
		// keeps two minutes of history for `dump()`.
		/**
		 * KDM-186: the on-screen diagnostic HUD (top-RIGHT, so it never covers the co-op status
		 * overlay top-left). Colour-coded because the whole question is "is the frame rate bad?":
		 * green ≥ 30, amber ≥ 10, red below — a glance is enough, no DevTools, no JSON.
		 */
		var hud = null;
		function paintHud(w) {
			if (!hud) {
				hud = document.createElement('div');
				hud.id = 'coop-diag-hud';
				hud.style.cssText = 'position:fixed;right:8px;top:8px;z-index:99999;' +
					'background:rgba(0,0,0,0.72);color:#fff;font:13px/1.5 monospace;padding:6px 10px;' +
					'border-radius:6px;pointer-events:none;white-space:pre;text-align:right';
				document.body.appendChild(hud);
			}
			var col = w.frames >= 30 ? '#6f6' : (w.frames >= 10 ? '#fc6' : '#f66');
			var sendTop = Object.keys(w.sends).sort(function (a, b) { return w.sends[b] - w.sends[a]; })[0];
			hud.innerHTML =
				'<span style="color:' + col + ';font-size:18px">' + w.frames + ' fps</span>\n' +
				'in ' + w.kbPerS + ' KB/s  (ui ' + w.recv.ui + ' / turn ' + w.recv.turn + ')\n' +
				'apply ' + w.applyAvg + 'ms (max ' + w.applyMax + ')\n' +
				'sent ' + (sendTop ? sendTop + '×' + w.sends[sendTop] : '—') + '\n' +
				'floaters ' + ((window.__coopFloaters && window.__coopFloaters.thisSecond) || 0) + '/s  q=' +
				((typeof KinkyDungeonFloaters !== 'undefined' && KinkyDungeonFloaters) ? KinkyDungeonFloaters.length : '?') + '\n' +
				'twitch ' + w.peerReversals + '/' + w.peerMoves + '\n' +
				'sampled ' + (w.skips.superseded || 0) + '/s';
		}

		function roll() {
			var w = d._win; d._win = freshWindow(); d._logCount = {};
			if (window.__coopFloaters) window.__coopFloaters.thisSecond = 0;
			w.t = Math.round((window.performance || Date).now());
			w.applyAvg = w.applies ? Math.round((w.applyMs / w.applies) * 10) / 10 : 0;
			w.applyMax = Math.round(w.applyMax * 10) / 10;
			w.wsBuffered = (coop.ws && coop.ws.bufferedAmount) || 0;
			w.kbPerS = Math.round(w.recvBytes / 1024);
			d.rollups.push(w);
			while (d.rollups.length > 120) d.rollups.shift();
			// KDM-186: put the numbers ON SCREEN. Reading them meant opening DevTools and finding one
			// line among the game's own logging — too much friction for the person doing UAT, and the
			// frame rate is the single number this investigation turns on.
			paintHud(w);
			if (d.enabled && !d._quiet) {
				var top = Object.keys(w.sends).sort(function (a, b) { return w.sends[b] - w.sends[a]; })
					.slice(0, 4).map(function (k) { return k + '×' + w.sends[k]; }).join(' ');
				try {
					console.log('[coop-diag ' + id + '] fps=' + w.frames +
						' send{' + (top || '-') + '}' +
						' recv{ui=' + w.recv.ui + ' turn=' + w.recv.turn + ' ' + w.kbPerS + 'KB}' +
						' apply{n=' + w.applies + ' avg=' + w.applyAvg + 'ms max=' + w.applyMax + 'ms}' +
						' peer{moves=' + w.peerMoves + ' reversals=' + w.peerReversals + '}' +
						(w.wsBuffered ? ' wsBacklog=' + w.wsBuffered : ''));
				} catch (e) { /* ignore */ }
			}
			setTimeout(roll, 1000);
		}
		setTimeout(roll, 1000);

		function frame() { d._win.frames++; requestAnimationFrame(frame); }
		requestAnimationFrame(frame);

		d.dump = function () {
			return JSON.stringify({
				id: id, quiet: d._quiet, noHover: !!d._noHover, inFlight: coop._inFlight, kinds: coop._kindOf, pending: Object.keys(coop._pending),
				started: coop.started, lastTick: coop.lastTick, submitted: coop.submitted,
				pendingSends: d._pending.length, sentRouteQueue: coop._sentRoute.length,
				rollups: d.rollups, recentInputs: d.inputs,
			}, null, 1);
		};
		d.reset = function () { d.rollups.length = 0; d.inputs.length = 0; d._win = freshWindow(); };
		d.quiet = function (v) { d._quiet = v !== false; return d._quiet; };
		d.verbose = function (v) { d._verbose = v !== false; return d._verbose; };
		/**
		 * KDM-204 — stop routing KD's per-frame `setMoveDirection` chatter, so the frame rate can be
		 * read with the per-frame server round-trip ON and then OFF. Toggle only: it changes nothing
		 * else, and turning it back off restores the normal path immediately.
		 *
		 * The gate itself lives in the KDSendInput wrapper (render-client.js), the one place every
		 * input passes through; this is the operator-facing switch for it, and the flag is a plain
		 * window global for the same reason `__KDMP_DEBUG` is — the wrapper must not depend on the
		 * co-op bootstrap having loaded.
		 *
		 * Suppressed frames are counted as skips ('suppressHover' in the rollup), never lost quietly.
		 */
		d.suppressHover = function (v) {
			d._noHover = v !== false;
			window.__KDMP_SUPPRESS_HOVER = d._noHover;
			return d._noHover;
		};
		// Console budget per type per rollup second — keeps a high-rate type from flooding the log
		// without the client knowing which type is high-rate. Generic by construction.
		d._logCount = {};
		// KDM-186: inputs skipped at the wire, by reason. Counted and shown, never silent (KDM-163).
		d.noteSkip = function (type, why) {
			d._win.skips[why] = (d._win.skips[why] || 0) + 1;
			d._win.skipTypes[type] = (d._win.skipTypes[type] || 0) + 1;
		};
		d.logBudget = function (type) {
			d._logCount[type] = (d._logCount[type] || 0) + 1;
			return d._logCount[type] <= 1;
		};
		return d;
	})();
	var ws = null;
	var overlay = null;

	/**
	 * KDM-186: the control hint, DERIVED from the game's live binding table.
	 *
	 * It used to be the hardcoded string "[arrows/WASD] move · [space] wait", and every part of that
	 * was wrong except WASD: KD binds movement to W/A/S/D + Q/E/Z/C (`KinkyDungeonKey`, :162), Wait to
	 * **X** (`KinkyDungeonKeyWait`), and Space to **Skip** — a different action, which is why pressing
	 * it moved the character instead of holding position (it committed a move in the direction the
	 * mouse was hovering). During UAT that cost three wrong hypotheses about the transport before the
	 * label turned out to be the liar.
	 *
	 * Reading `KinkyDungeonKeybindings` also means a player who REBINDS their keys gets a hint that
	 * follows them — a hardcoded "W/A/S/D … X" would pass today's test and start lying again on the
	 * first rebind. Purely additive and guarded: if the table is unavailable, say nothing rather than
	 * guess.
	 */
	function controlHint() {
		try {
			// @ts-ignore bare let-global
			var kb = (typeof KinkyDungeonKeybindings !== 'undefined' && KinkyDungeonKeybindings) || null;
			if (!kb) return '';
			var move = [kb.Up, kb.Left, kb.Down, kb.Right].filter(function (k) { return !!k; }).join('/');
			var parts = [];
			if (move) parts.push('[' + move + '] move');
			if (kb.Wait) parts.push('[' + kb.Wait + '] wait');
			return parts.length ? '\n' + parts.join(' · ') : '';
		} catch (e) { return ''; }
	}

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

	/**
	 * KDM-186: time every snapshot adoption and sample entity positions from it. Wrapping `apply`
	 * once here beats instrumenting its three call sites, and keeps the measurement in one place.
	 */
	/**
	 * KDM-186 — TRACE THE KEY PATH, not the input path.
	 *
	 * Measured 2026-08-16 in a REAL browser (owner's UAT screenshot): the client runs at 60-140 fps
	 * and emits `setMoveDirection` every frame, yet a keypress produces NO input at all. So the loss
	 * is not frame starvation (the earlier 3 fps was a headless artifact) and not the proxy's routing
	 * (which works for synthetic input). It is somewhere in:
	 *
	 *     browser keydown → KD's own window listener → KD's handler → KDSendInput(...)
	 *
	 * This taps each hop so a single keypress says WHERE it died:
	 *   keysSeen        the browser delivered the event to the page at all
	 *   kdListener      KD's own keyDownEvent handler ran
	 *   inputsAfterKey  any KDSendInput within 500 ms of a key (excluding per-frame chatter)
	 *
	 * A key that is seen, reaches KD's handler, and yields no input means the GAME rejected it —
	 * which points at game state (screen/mode), not at the transport.
	 */
	/**
	 * KDM-186 — WHO creates the floating combat text, and how often?
	 *
	 * Four reproduction attempts failed to trigger the owner's pile-up in the harness: it renders at
	 * ~4 fps against a real browser's ~95, so it applies ~20x fewer snapshots and never reaches the
	 * threshold. Rather than keep guessing at the mechanism from a machine that cannot show it, this
	 * measures it in the environment where it actually happens.
	 *
	 * Wraps the game's own `KinkyDungeonSendFloater` (the single push site for every floater) to
	 * count creations per second, keep the last few texts, and capture ONE stack sample so the caller
	 * is identified by name instead of by hypothesis. Cost is a counter per floater; the stack is
	 * taken once per session.
	 */
	function installFloaterTrace() {
		try {
			if (typeof KinkyDungeonSendFloater !== 'function' || KinkyDungeonSendFloater.__kdTraced) return;
			var _send = KinkyDungeonSendFloater;
			var t = window.__coopFloaters = { created: 0, thisSecond: 0, texts: [], stack: null };
			KinkyDungeonSendFloater = function (Entity, Amount) {
				t.created++; t.thisSecond++;
				t.texts.push(String(Amount));
				while (t.texts.length > 12) t.texts.shift();
				// One sample is enough to name the caller; more would be noise.
				if (!t.stack) { try { throw new Error('floater'); } catch (e) { t.stack = String(e.stack || '').split('\n').slice(1, 6).join(' | '); } }
				// Self-report once the queue is clearly piling up, so nobody has to know a console
				// incantation to hand back the evidence — the interesting moment prints itself.
				if (t.created === 30) { try { console.log('[floaters ' + id + '] AUTO-REPORT ' + t.report()); } catch (e2) {} }
				return _send.apply(this, arguments);
			};
			KinkyDungeonSendFloater.__kdTraced = true;
			t.report = function () {
				return JSON.stringify({
					createdTotal: t.created,
					// @ts-ignore bare let-global
					queueNow: (typeof KinkyDungeonFloaters !== 'undefined' && KinkyDungeonFloaters) ? KinkyDungeonFloaters.length : -1,
					recentTexts: t.texts, firstStack: t.stack,
				}, null, 1);
			};
		} catch (e) { /* best effort — never fatal */ }
	}

	function installKeyTrace() {
		if (window.__coopKeyTrace) return;
		var t = window.__coopKeyTrace = { keysSeen: 0, lastKey: null, lastKeyAt: 0, kdListener: 0, inputsAfterKey: [] };
		// Capture phase, on window: runs BEFORE KD's own listener, and cannot be cancelled by it.
		window.addEventListener('keydown', function (e) {
			t.keysSeen++; t.lastKey = e.key || e.code; t.lastKeyAt = Date.now();
			try {
				console.log('[keytrace ' + id + '] keydown ' + t.lastKey +
					' state=' + (typeof KinkyDungeonState !== 'undefined' ? KinkyDungeonState : '?') +
					' drawState=' + (typeof KinkyDungeonDrawState !== 'undefined' ? KinkyDungeonDrawState : '?') +
					' submitted=' + coop.submitted);
			} catch (err) { /* ignore */ }
		}, true);
		// Did KD's OWN handler run? Wrap the game's registered listener in place.
		try {
			if (typeof KinkyDungeonGameKey === 'object' && KinkyDungeonGameKey
				&& typeof KinkyDungeonGameKey.keyDownEvent === 'function'
				&& !KinkyDungeonGameKey.keyDownEvent.__kdTraced) {
				var _kd = KinkyDungeonGameKey.keyDownEvent;
				var wrapped = function () { t.kdListener++; return _kd.apply(this, arguments); };
				wrapped.__kdTraced = true;
				// The listener was registered with the ORIGINAL reference, so re-register the wrapper.
				window.removeEventListener('keydown', _kd);
				window.addEventListener('keydown', wrapped);
				KinkyDungeonGameKey.keyDownEvent = wrapped;
			}
		} catch (err) { /* ignore — the trace is best-effort, never fatal */ }
		t.report = function () {
			return JSON.stringify({
				keysSeen: t.keysSeen, lastKey: t.lastKey, kdListenerRuns: t.kdListener,
				inputsAfterKey: t.inputsAfterKey.slice(-10),
				state: typeof KinkyDungeonState !== 'undefined' ? KinkyDungeonState : null,
				drawState: typeof KinkyDungeonDrawState !== 'undefined' ? KinkyDungeonDrawState : null,
			});
		};
	}

	function installDiagApplyWrap() {
		var rc = window.KDRenderClient;
		if (!rc || !rc.apply || rc.apply.__kdDiagWrapped) return;
		var _apply = rc.apply;
		rc.apply = function (snapshot) {
			var t0 = (window.performance || Date).now();
			try { return _apply.apply(this, arguments); }
			finally {
				diag.noteApply((window.performance || Date).now() - t0);
				try { if (snapshot && snapshot.map) diag.noteEntities(snapshot.map.Entities); } catch (e) { /* ignore */ }
			}
		};
		rc.apply.__kdDiagWrapped = true;
	}

	/** KDM-233: tell the lobby something, if a lobby is on screen. Fields are merged, not replaced. */
	function lobbySay(fields) {
		var L = window.KDMPLobby;
		if (!L) return;
		for (var k in fields) if (Object.prototype.hasOwnProperty.call(fields, k)) L[k] = fields[k];
	}

	function boot() {
		if (!ready()) { setTimeout(boot, 100); return; }
		if (!loaded()) { setStatus('Co-op ' + id + ': loading game assets…'); setTimeout(boot, 200); return; }
		enterGame();
		connect();
	}

	/**
	 * KDM-233: go render-only and hand the controls to the server.
	 *
	 * Split out of `boot()` because the approval flow must NOT do this at connect time: a host waiting
	 * for a friend, or a guest waiting to be let in, is still on the lobby screen. Both enter here only
	 * once the session actually starts. Idempotent — `joined` can arrive more than once (a reattach
	 * re-sends it), and forcing the game screen twice would stamp over a live session.
	 */
	function enterGame() {
		if (coop._entered) return;
		// Assets, not the socket: the bundle preloads character assets and starting a game before that
		// finishes is clobbered by the loading flow. The HANDSHAKE has no such requirement — a host
		// sitting in the lobby may well still be preloading — so this wait lives here and NOT in front
		// of `connect()`, which is where it was first (wrongly) put: the guest's join then never left
		// the page, and the host was never prompted.
		if (!loaded()) {
			if (!coop._enterQueued) { coop._enterQueued = true; setTimeout(function () { coop._enterQueued = false; enterGame(); }, 200); }
			return;
		}
		// KDM-249 Phase A: the stock game executes mods when a GAME STARTS
		// (`KDExecuteModsAndStart`, KinkyDungeon.ts:1891) and this is the co-op Play button — the one
		// place the co-op path bypasses. Same shape as the `loaded()` gate above: kick it off, come
		// back in 200 ms. This cannot spin forever because `coop-mods.js` runs a watchdog that always
		// settles a status, so `done()` is guaranteed to go true whatever the game's loader does.
		if (window.__coopMods && !window.__coopMods.done()) {
			// KDM-249 — a GUEST pulls the host's mods first; a host (and the legacy `#coop=` path) has
			// no host mod set to reconcile against and only executes its own.
			window.__coopMods.ensureExecuted(role === 'guest' ? { fetchFrom: httpBase() } : {});
			if (!coop._modsQueued) {
				coop._modsQueued = true;
				setTimeout(function () { coop._modsQueued = false; enterGame(); }, 200);
			}
			return;
		}
		// assets ready → bring up the dungeon and go render-only
		coop._entered = true;
		forceGameScreen();
		window.KDRenderClient.disableLocalSim();
		// KD's default controls drive: the routed KDSendInput wrapper hands each
		// turn-consuming action to this callback, which forwards it to the server.
		window.KDRenderClient.onInput(function (action) { submit(action); });
		installDiagApplyWrap();
		installKeyTrace();
		installFloaterTrace();
		installRouteDriver();
		ensureQuickBind();
		ensureStartItem();
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

	/**
	 * Keep the dungeon on screen (don't regen the map).
	 *
	 * NOT per-frame, despite what this comment used to claim (KDM-205): the call sites are boot
	 * (`forceGameScreen`) and the two `ws.onmessage` state branches, so an UNPAIRED client runs it
	 * exactly once. The stale wording cost a wrong hypothesis — that the `KinkyDungeonUpdateLightGrid`
	 * flag below was forcing a vision recompute every frame and starving the loop. It is not.
	 */
	function pinGameScreen() {
		KinkyDungeonState = 'Game';
		KinkyDungeonDrawState = 'Game';
		// The client doesn't simulate, so vision/fog isn't recomputed after we adopt
		// new state — the map stays dark and entities stay hidden. Flag a vision
		// recompute so the draw lights the map around the (server-set) player position
		// and reveals the shared enemy + the other player's avatar.
		if (typeof KinkyDungeonUpdateLightGrid !== 'undefined') KinkyDungeonUpdateLightGrid = true;
	}

	/**
	 * KDM-233: the build this client is running, so the server can refuse a skewed pair (N1).
	 *
	 * The guest runs its OWN copy of the bundle and only repoints its socket, so two different builds
	 * would desync. `KDVersionStr` is the bundle's own version string — the same thing the test
	 * helpers read to sanity-check which bundle they loaded. The HOST's value defines the session
	 * (`join-gate.js` adopts it), so nothing has to be configured anywhere.
	 */
	function buildId() {
		try { if (typeof TextGet === 'function') return String(TextGet('KDVersionStr') || ''); } catch (e) { /* noop */ }
		return '';
	}

	/**
	 * KDM-252 A6 — the reconnect schedule: 1 / 2 / 4 / 8 / 16 s, capped at 30 s. `attempt` is 0-based.
	 *
	 * The POLICY is ported from `origin/feature/multiplayer`'s `MPResume.ts` (`KDMPBackoffDelay`);
	 * that branch's transport is not (KDM-233 — its netcode is obsolete). Exponential rather than a
	 * fixed interval because the two outages this must survive want opposite things: a blinked Wi-Fi
	 * wants the FIRST retry to be almost immediate, and a host that is down for ten minutes must not
	 * be hammered once a second for ten minutes.
	 *
	 * There is no attempt LIMIT, and that is deliberate (KDM-234 D7): the wait is bounded by the
	 * survivor's patience, never by a clock of ours. Giving up after N tries would be a reconnect
	 * deadline wearing a different hat.
	 */
	function backoffMs(attempt) {
		var a = (typeof attempt === 'number' && attempt > 0) ? attempt : 0;
		return Math.min(1000 * Math.pow(2, a), 30000);
	}

	/**
	 * KDM-252 — the identity a reconnect is RECOGNISED BY, stable across a page load.
	 *
	 * The `#coop=<id>` path gets this for free: the id is in the URL, so a reload asks for the same
	 * seat by construction. The lobby path generates one, and a value generated fresh on every load
	 * would make every reload look like a stranger asking to join a full session — which is precisely
	 * the failure this slice exists to remove.
	 *
	 * `sessionStorage`, not `localStorage`: the identity belongs to THIS TAB's session. Two tabs on
	 * one machine are two players (that is how the demo is driven), and a shared identity would have
	 * them fighting over one seat.
	 */
	function stableId(forRole) {
		var key = 'kdcoop.clientId';
		var made = (forRole === 'host' ? 'host' : ('guest-' + Math.random().toString(36).slice(2, 8)));
		try {
			var held = window.sessionStorage.getItem(key);
			if (held) return held;
			window.sessionStorage.setItem(key, made);
		} catch (e) { /* storage disabled — fall through with a fresh id, which still works forward */ }
		return made;
	}
	// Exposed so the mechanism is assertable where the storage actually lives (tests/e2e/mp-reconnect).
	coop._stableId = stableId;

	/**
	 * KDM-236 A — the address you last reached a host at.
	 *
	 * `localStorage`, deliberately UNLIKE `stableId`'s `sessionStorage` two functions up. That
	 * identity is per-TAB on purpose (two tabs on one machine are two players — KDM-252); an address
	 * is a property of the MACHINE and has to outlive the tab, or "remembered" means "remembered
	 * until you close the game", which is not what A1 asks for.
	 *
	 * Read by `coop-lobby.js` for the join field's default. The key string lives here only — the
	 * lobby draws screens and never touches storage.
	 */
	var ADDR_KEY = 'kdcoop.lastAddress';

	/** The remembered address, or '' — never throws, so a storage-disabled browser just gets A3. */
	function lastAddress() {
		try { return String(window.localStorage.getItem(ADDR_KEY) || ''); } catch (e) { return ''; }
	}
	window.__coopLastAddress = lastAddress;

	/**
	 * A2 — remember an address only once it has REACHED a host. Called from `ws.onopen`, which is the
	 * only place that fact exists: a browser gives no other signal that the far end was listening.
	 *
	 * Remembering at send time instead would helpfully offer the player their own typo back, every
	 * time, forever. Only a guest with an explicit endpoint has anything to store — a host is
	 * same-origin and its address is `location.host` already.
	 */
	function rememberAddress() {
		if (role !== 'guest' || !endpoint) return;
		try { window.localStorage.setItem(ADDR_KEY, endpoint); } catch (e) { /* storage disabled */ }
	}

	/**
	 * KDM-236 F1 — the deadline on a JOIN attempt.
	 *
	 * A browser asked for a socket to a peer that accepts the TCP connection and then says nothing
	 * fires neither `open` nor `error`: the socket sits in CONNECTING and the join screen sits on
	 * "Connecting…" for as long as the player is willing to look at it. That is the hang requirement 3
	 * forbids, and no layer below can see it — the server we are talking about is, by construction,
	 * one that never answers.
	 *
	 * Armed ONLY for a lobby attempt. A live session that drops is `scheduleReconnect`'s business:
	 * it already retries with backoff and already says when the next attempt is, and putting a
	 * deadline there would turn a recoverable outage into an error screen.
	 */
	var connectTimer = null;
	function clearConnectDeadline() {
		if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
	}
	function armConnectDeadline(sock, where) {
		clearConnectDeadline();
		if (coop.started) return;                      // a reconnect — not ours to time out
		var ms = Number(window.__coopConnectTimeoutMs);
		if (!(ms > 0)) ms = 10000;
		connectTimer = setTimeout(function () {
			connectTimer = null;
			if (ws !== sock || sock.readyState !== 0) return;   // opened, failed, or superseded
			coop._closedForGood = true;                // do not dial a silent door forever
			try { sock.close(); } catch (e) { /* already going */ }
			// F4: the progress line is REPLACED, never left standing as the terminal state.
			lobbySay({ error: 'No answer from ' + where + ' — is the game hosting there?', status: '' });
		}, ms);
	}

	/**
	 * KDM-236 T — leave, and leave nothing behind.
	 *
	 * Every way out of the lobby routes here (`coop-lobby.js` → `leave()`). `_closedForGood` is
	 * latched FIRST: it is what stops `onclose` reaching `scheduleReconnect`, so T3 needs no new flag
	 * of its own. Dropping `ws` to null is the other half — `connect()`'s handlers each check
	 * `ws !== myWs`, so a reply that arrives after we walked away finds no lobby to paint into.
	 */
	window.__coopDisconnect = function () {
		clearConnectDeadline();
		coop._closedForGood = true;
		var sock = ws;
		ws = null;
		coop.ws = null;
		coop.connected = false;
		coop.started = false;
		coop.submitted = false;
		coop.peerMissing = null;
		coop._entered = false;
		coop._snapBase = null;
		coop._snapSeq = 0;
		if (sock) { try { sock.close(); } catch (e) { /* already going */ } }
		return coop;
	};

	/**
	 * KDM-252 — retry the socket after a drop, with backoff. Never a reload: a reload throws away the
	 * loaded bundle and everything the page had, to reach a state the server can restore anyway.
	 *
	 * Only a LIVE session retries. A socket that closes before `started` is a lobby failure — a
	 * mistyped address, a declined request — and there the player must be told and left to try
	 * something different, not have a wrong address dialled forever behind their back.
	 */
	function scheduleReconnect() {
		if (!coop.started || coop._closedForGood) return;
		var wait = backoffMs(coop.reconnect.attempts);
		coop.reconnect.attempts++;
		coop.reconnect.total++;
		coop.reconnect.nextDelayMs = wait;
		setStatus('Co-op ' + id + ': connection lost — reconnecting in '
			+ (Math.round(wait / 100) / 10) + 's…');
		setTimeout(function () {
			if (coop._closedForGood) return;
			connect();
		}, wait);
	}

	/**
	 * KDM-249 — the HOST's http origin, which is where the mod payloads live.
	 *
	 * The same `endpoint || location.host` pair `connect()` uses for the socket: a guest that typed an
	 * address must fetch the mods from THAT machine, not from whichever server happened to serve its
	 * own page. Same-origin is the common case (both players load the host's gateway) and falls out of
	 * this without a special case.
	 */
	function httpBase() {
		return location.protocol + '//' + (endpoint || location.host);
	}

	function connect() {
		var proto = location.protocol === 'https:' ? 'wss' : 'ws';
		var where = endpoint || location.host;
		ws = new WebSocket(proto + '://' + where + '/');
		coop.ws = ws;
		/*
		 * KDM-236 T3 — THIS socket, and no other.
		 *
		 * Every handler below is gated on `ws === myWs`. Two things make that necessary: a player who
		 * left the lobby (`__coopDisconnect` nulls `ws`) can still be sent the answer to the question
		 * they withdrew, and a reconnect replaces `ws` while the dead socket's events are still
		 * queued. In both cases a late `join_pending` / `joined` / `reject` would paint into — or
		 * worse, enter the game from — a lobby that has moved on. One comparison covers both.
		 */
		var myWs = ws;
		armConnectDeadline(myWs, where);
		/*
		 * KDM-252 N4 — a NEW socket holds nothing.
		 *
		 * The server restarts our state sequence and sends a full snapshot (`_resetDelta`), so the
		 * base we were merging onto is dead; keeping it would risk merging the new stream onto the old
		 * one. The in-flight bookkeeping goes with it for the same reason: every send waiting on a
		 * reply is waiting on a socket that no longer exists, and a slot never freed is a type the
		 * client would suppress for the rest of the session (the KDM-186 Rule-1 shape).
		 */
		coop._snapBase = null;
		coop._snapSeq = 0;
		coop._sentTypes.length = 0;
		coop._sentRoute.length = 0;
		coop._inFlight = {};
		coop._pending = {};
		coop.submitted = false;
		setStatus('Co-op ' + id + ': connecting…');
		ws.onopen = function () {
			if (ws !== myWs) return;                    // T3 — a socket we walked away from
			clearConnectDeadline();                     // F1 — it answered; the deadline is spent
			rememberAddress();                          // A2 — and it answered HERE, so this address is good
			coop.connected = true;
			var join = { type: 'join', clientId: id };
			// A role opts into the approval flow; without one this is the legacy direct join and the
			// server behaves exactly as it always did.
			if (role) {
				join.role = role;
				join.name = playerName;
				join.build = buildId();
				// KDM-249 R1 — this client's mod set rides on the handshake beside `build`.
				//
				// If `prepare()` has not finished hashing yet, this is `[]` — and that is SAFE by
				// design rather than a race worth guarding: an absent declaration means "needs
				// everything" at the gate (`mod-sync.js`), so the worst case is the guest being
				// offered mods it already has. The dangerous reading — absent as "nothing to do" —
				// is the one that would leave it silently mod-less, and the gate refuses it.
				try { join.mods = window.__coopMods ? window.__coopMods.declaration() : []; } catch (e) { join.mods = []; }
			}
			ws.send(JSON.stringify(join));
			// KDM-249 R6 — a HOST publishes its zips so a guest can fetch them, then re-states the
			// declaration: `join` above carried whatever had been hashed by the time the socket
			// opened, which misses mods picked from the Mods menu just before hosting.
			//
			// Fire-and-forget: the host's own session needs nothing from the gateway's store, so a
			// failed upload degrades the GUEST's presentation (named by R9) rather than blocking
			// anyone's game.
			if (role === 'host' && window.__coopMods) {
				try {
					window.__coopMods.publish(httpBase()).then(function (rows) {
						if (ws === myWs && ws.readyState === 1) ws.send(JSON.stringify({ type: 'mods_declare', mods: rows }));
					}).catch(function () { /* best-effort */ });
				} catch (e) { /* best-effort */ }
			}
			setStatus('Co-op ' + id + ': joined, waiting for the other player…');
		};
		ws.onerror = function () {
			if (ws !== myWs) return;                    // T3
			clearConnectDeadline();                     // F1 — it failed out loud; nothing left to time out
			// KDM-252: only while we are still trying to GET IN. Once a session is live, a failed
			// retry is not news the player can act on — `scheduleReconnect` already says what is
			// happening and when the next attempt is — and routing it to the lobby would paint an
			// error screen over a game that is merely waiting.
			if (coop.started) return;
			// E6: a wrong address must arrive in WORDS. A browser gets no reason for a failed connect,
			// so this is the only place that can say anything at all — and saying nothing is what makes
			// a mistyped address look like a hang.
			// F4: `status` goes with it — a stale "Connecting…" under an error is its own small lie.
			lobbySay({ error: 'Could not reach ' + where, status: '' });
		};
		/**
		 * KDM-206: resolve a state frame to a FULL snapshot.
		 *
		 * The server sends `snapshot` on the first state and after a resync, and a `delta` thereafter
		 * (measured 38.1 KB -> 115 B). We keep the last full snapshot and merge each delta onto it.
		 *
		 * `seq` is what makes that safe: merging a delta onto a base the client never held would
		 * corrupt state SILENTLY, which is far worse than the bandwidth it saves. On any gap we throw
		 * our copy away and ask for a full snapshot instead of guessing.
		 */
		function resolveState(m) {
			if (m.snapshot) {                       // full: adopt it and re-baseline
				coop._snapBase = m.snapshot;
				coop._snapSeq = m.seq || 0;
				return m.snapshot;
			}
			if (!m.delta) return null;
			var expected = (coop._snapSeq || 0) + 1;
			if (!coop._snapBase || (m.seq && m.seq !== expected)) {
				// Never merge onto an unknown base. Ask for a full one; drop this frame.
				coop._snapBase = null;
				try { ws.send(JSON.stringify({ type: 'resync' })); } catch (_) { /* ignore */ }
				if (window.__KDMP_DEBUG) {
					try { console.log('[coop ' + id + '] state gap: expected ' + expected + ' got ' + m.seq + ' → resync'); } catch (_) {}
				}
				return null;
			}
			coop._snapSeq = m.seq || expected;
			coop._snapBase = window.KDDelta.kdMerge(coop._snapBase, m.delta);
			return coop._snapBase;
		}

		ws.onmessage = function (e) {
			if (ws !== myWs) return;                    // T3 — see `myWs` above
			var m; try { m = JSON.parse(e.data); } catch (_) { return; }
			// ── KDM-250: the heartbeat ─────────────────────────────────────────────────────────
			// Answered FIRST and cheaply: this handler runs on the page's own event loop, so a reply
			// is proof that the loop is still turning — which is the whole point of an
			// application-level ping rather than an RFC6455 opcode the network stack would answer on
			// our behalf even with the renderer wedged (KDM-234 A2). It touches no game state and must
			// never fall through to the input bookkeeping below.
			if (m.type === 'ping') {
				try { ws.send(JSON.stringify({ type: 'pong', t: m.t })); } catch (_e) { /* closing */ }
				return;
			}
			if (m.type === 'peer_missing') {
				// KDM-250 reports the drop; KDM-251 makes the session PAUSE on it. The in-game telling
				// is a server-opened dialogue (S3) — this line is the ambient status, not the message.
				// The wait/solo choice on a GUEST drop is KDM-253 and is not decided here.
				coop.peerMissing = { clientId: m.clientId, role: m.role };
				// A turn we already had in flight will never resolve now, so stop claiming we acted —
				// otherwise the client keeps suppressing input as already-submitted (the KDM-225 shape).
				coop.submitted = false;
				setStatus('Co-op ' + id + ': ' + (m.role === 'host'
					// D5/D6 — the guest is NOT offered a choice: it is the host's process that owns the
					// world, so there is nothing for the guest to continue. Say what is happening and
					// that waiting is fine, rather than leaving a freeze to be guessed at.
					? 'the host (' + m.clientId + ') has disconnected — waiting for them to come back. '
						+ 'Your moves will not be accepted until they do.'
					: 'your partner (' + m.clientId + ') has disconnected — the game is paused.'));
				return;
			}
			// KDM-252: a `push` is a non-turn frame, like a `ui` one — the bucket separates frames that
			// resolved a turn from frames that did not, and a server-started push resolved nothing.
			if (m.type === 'state') diag.noteRecv((m.kind === 'ui' || m.kind === 'push') ? 'ui' : 'turn', (e.data && e.data.length) || 0);
			else if (m.type === 'ack') diag.noteRecv('ack', (e.data && e.data.length) || 0);
			// KDM-186: an ACK is a reply that carries no state — the server applied our input and this
			// player's own state did not move. It still consumed exactly one send, so the in-order
			// bookkeeping must unwind for it exactly like a 'ui' state reply; it just has nothing to apply.
			if (m.type === 'ack') { coop._sentRoute.shift(); ackOne('ui'); return; }   // applied, no turn ⇒ stream
			// ── KDM-233: the approval handshake ────────────────────────────────────────────────
			// These arrive BEFORE the session exists, so none of them touch game state.
			if (m.type === 'awaiting_approval') {
				lobbySay({ status: 'Waiting for the host to let you in…', error: '' });
				return;
			}
			if (m.type === 'join_pending') {
				// Someone is asking to join OUR game. The host answers this — it is the whole gate.
				lobbySay({ view: 'host', pending: { clientId: m.clientId, name: m.name || 'Someone' }, error: '' });
				return;
			}
			if (m.type === 'reject') {
				var why = m.reason === 'declined' ? 'The host declined your request.'
					: m.reason === 'build_mismatch' ? ('Different game versions — host has ' + (m.hostBuild || '?') + ', you have ' + (m.guestBuild || '?') + '.')
					: m.reason === 'session_full' ? 'That game is full.'
					: m.reason === 'busy' ? 'The host is already answering someone else.'
					: m.reason === 'no_host' ? 'Nobody is hosting at that address.'
					: ('Refused: ' + m.reason);
				// KDM-252: a refusal is an ANSWER, not an outage. `seat_gone` is the one that matters
				// here — the survivor has played on without us (KDM-250 E6) — and retrying any of
				// these would dial forever at a door that has been shut in words.
				coop._closedForGood = true;
				lobbySay({ error: why, status: '', pending: null });
				return;
			}
			if (m.type === 'peer_gone') {
				// KDM-253: the other player is not coming back — either we chose to go on without
				// them, or they quit. Either way the waiting is over, so the page must stop saying it
				// is waiting: a correct server and a status line still reading "the game is paused" is
				// indistinguishable, to the player, from the freeze this whole epic exists to remove.
				coop.peerMissing = null;
				coop.blocked = null;
				coop.peers = (coop.peers || []).filter(function (p) { return p !== m.clientId; });
				setStatus('Co-op ' + id + ': ' + (m.reason === 'quit'
					? m.clientId + ' has left the game. '
					: 'carrying on without ' + m.clientId + '. ')
					+ 'The run is yours alone now.');
				return;
			}
			if (m.type === 'peer_back') {
				// KDM-252 E4: the mirror of `peer_missing`. The MODAL is closed server-side and reaches
				// us as the state frame that follows this message; this clears the ambient status the
				// drop left behind, so the player is not left reading "the game is paused" while it runs.
				coop.peerMissing = null;
				coop.blocked = null;
				setStatus('Co-op ' + id + ': ' + (m.role === 'host' ? 'the host' : 'your partner')
					+ ' (' + m.clientId + ') is back — the game has resumed.');
				return;
			}
			if (m.type === 'joined') {
				coop.peers = m.players || [];
				// KDM-252: we are in. The backoff position resets so a LATER drop starts its own
				// schedule at 1 s; `reconnect.total` deliberately does not, so "did this session ever
				// have to reconnect?" stays answerable.
				coop.reconnect.attempts = 0;
				coop.reconnect.nextDelayMs = null;
				// The session is live once BOTH are in — that is the moment the host's game becomes
				// multiplayer, and the moment either side stops being a lobby screen.
				if (m.started) { lobbySay({ pending: null, status: '' }); enterGame(); }
				else if (role === 'host') lobbySay({ view: 'host', status: '' });
			}
			else if (m.type === 'state' && m.kind === 'push') {
				// KDM-252: a state frame the SERVER started — nothing of ours is being answered. Adopt
				// it and touch NO bookkeeping: `_sentRoute` / `_inFlight` track replies to inputs WE
				// sent, and unwinding a slot here would free one that no reply ever filled. Nor is it a
				// turn: `lastTick`, `submitted` and the route are all left exactly as they were.
				var pushSnap = resolveState(m);
				if (pushSnap) window.KDRenderClient.apply(pushSnap);
				pinGameScreen();
			}
			else if (m.type === 'state' && m.kind === 'ui') {
				// KDM-163: a UI input of OURS was applied — no turn resolved. Adopt the fresh state so
				// the menu responds (R6), and touch NOTHING that is per-turn. Treating this as a turn
				// is what used to kill click-to-move: with every input routed, KD's draw loop sends
				// `setMoveDirection` each frame, so this branch runs ~60×/s.
				coop.started = true;
				coop._sentRoute.shift();          // this reply consumed one send: it was a UI input
				ackOne('ui');                     // KDM-186: applied without consuming a turn ⇒ presentation
				// KDM-206: the per-frame path now carries a delta; resolve it against our copy. A null
				// means we asked for a resync — apply nothing rather than render a half-merged state.
				var uiSnap = resolveState(m);
				if (uiSnap) window.KDRenderClient.apply(uiSnap);
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
				// KDM-186: a resolved turn drains the whole in-flight queue too — the bridge has answered
				// everything that preceded it, so no type may stay blocked behind a reply that will never come.
				coop._sentTypes.length = 0; coop._inFlight = {};
				// Flush anything a stream was holding: its slot will never be freed by a reply now.
				for (var _pt in coop._pending) { var _p = coop._pending[_pt]; delete coop._pending[_pt]; rawSend(_pt, _p.action, _p.route); }
				coop.lastTick = m.tick;
				if (window.__KDMP_DEBUG && m.serverLog && m.serverLog.length) {
					// KD-098: echo the server's per-turn diagnostics into THIS browser console
					// (so one screenshot has both client + server logs — no Docker terminal needed).
					for (var li = 0; li < m.serverLog.length; li++) {
						try { console.log('[mp-server] ' + m.serverLog[li]); } catch (e) { /* ignore */ }
					}
				}
				// KDM-206: turn states are delta-encoded too (same composer as the ui path, so the
				// base stays in step). Resolve first, then everything below sees a full snapshot.
				var turnSnap = resolveState(m);
				if (!turnSnap) return;             // resync requested — do not render a partial state
				coop._lastSnapshot = turnSnap;     // KDM-186: kept so a test can re-apply it verbatim
				window.KDRenderClient.apply(turnSnap);
				// KD-101 UAT: seed the server-configured carryable restraint item once (the Items inventory
				// is client-local, so it must be added here even though the server bundle already has it).
				// KDM-206: read from the RESOLVED snapshot — with delta encoding `m.snapshot` is absent
				// on all but the first frame, so keying off it here would silently stop seeding the item.
				if (!coop._startItemAdded && turnSnap.startItem) {
					addStartItem(turnSnap.startItem);
					coop._startItemAdded = true;
				}
				pinGameScreen();   // keep the dungeon on screen (don't let the menu steal it)
				if (coop.route) stepRoute();   // advance a click-to-move route by one tile this turn
				setStatus('Co-op ' + id + '  turn ' + m.tick + controlHint());
			} else if (m.type === 'waiting') {
				// KDM-163: the server has confirmed our input entered LOCKSTEP — that, and not the act
				// of sending, is what means "I have acted this turn".
				coop.submitted = true;
				// a MANUAL action (not a route step) cancels an in-progress route
				if (coop._sentRoute.length && coop._sentRoute.shift() === false) coop.route = null;
				ackOne('turn');                   // KDM-186: it entered lockstep ⇒ a command, never sampled
				setStatus('Co-op ' + id + ': submitted, waiting for ' + (m.waitingOn || []).join(', ') + '…');
			} else if (m.type === 'await') {
				// a peer has acted and is waiting on US — act so the turn can resolve.
				var g = m.graceMs ? ' (auto-pass in ' + (Math.round(m.graceMs / 100) / 10) + 's)' : '';
				setStatus('Co-op ' + id + ': your move — others ready' + g + controlHint());
			} else if (m.type === 'blocked') {
				// KDM-225: the server REFUSED this action — it never entered lockstep. Crucially the
				// opposite of `waiting`: leave `submitted` false so the client keeps accepting input,
				// or the player is locked out of the very action that would unblock them.
				coop.submitted = false;
				coop.blocked = m.reason || 'blocked';
				setStatus('Co-op ' + id + ': ' + (m.reason === 'peace-offer'
					? 'a peace offer is waiting — RIGHT-CLICK YOURSELF to accept or refuse'
					// KDM-251 D6: a refused move must not read as a hang. Name the cause every time,
					// because this is the reason the player will see most often while paused.
					: m.reason === 'peer-missing'
						? 'the game is paused — ' + (coop.peerMissing && coop.peerMissing.role === 'host'
							? 'waiting for the host to reconnect.'
							: 'waiting for your partner to reconnect.')
						: 'action refused (' + m.reason + ')'));
			} else if (m.type === 'error') {
				setStatus('Co-op ' + id + ': error — ' + m.error);
			}
		};
		ws.onclose = function () {
			if (ws !== myWs) return;                    // T3 — a socket we already let go of
			clearConnectDeadline();
			coop.connected = false;
			setStatus('Co-op ' + id + ': disconnected');
			// KDM-252 A6: and then it puts itself back together, rather than leaving the player with a
			// dead tab and a status line. Everything about WHETHER to retry lives in one place.
			scheduleReconnect();
		};
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
		var _dtype = diag.noteSend(action);
		/*
		 * KDM-186 RULE 1 (v3) — STREAMS may be sampled; COMMANDS may not be touched.
		 *
		 * Two kinds of input share this wire and they need opposite handling:
		 *   a STREAM  (KD's draw loop emits the move direction every frame) may be sampled down to the
		 *             round-trip rate, but MUST converge on its last value;
		 *   a COMMAND (an attack) must be delivered exactly once and never replayed late.
		 *
		 * Both earlier versions applied ONE rule to both kinds, and each broke the other kind:
		 *   v1 deferred-and-replayed the superseded input → a double-emitted attack fired late as a
		 *      DUPLICATE (UAT: duplicated damage + cast animation);
		 *   v2 dropped the superseded input → a stream lost its TAIL, so the move reticule froze on
		 *      whichever direction happened to be delivered first (UAT: "the red square is stuck").
		 *      Reproduced: reticule {1,0} while the last direction sent was {-1,1}.
		 *
		 * The kind is not enumerated here — it is LEARNED FROM THE SERVER'S OWN REPLY. An input the
		 * server answers without consuming a turn is presentation (`ui`); one that enters lockstep is
		 * a command. Same principle as the rest of the epic: ask the game, do not classify for it.
		 * Anything not yet observed is treated as a COMMAND, because the safe default is to deliver.
		 */
		if (coop._inFlight[_dtype] && coop._kindOf[_dtype] === 'ui') {
			// A stream: keep only the newest while the slot is busy, then send THAT — never the stale one.
			coop._pending[_dtype] = { action: action, route: !!fromRoute };
			diag.noteSkip(_dtype, 'superseded');
			return;
		}
		rawSend(_dtype, action, fromRoute);
	}

	/** Stable identity of an action's payload — generic JSON, no knowledge of any field. */
	function _payloadKey(action) {
		try { return JSON.stringify(action && action.data); } catch (e) { return String(Math.random()); }
	}

	/** The actual wire send + the in-order bookkeeping every reply unwinds. */
	function rawSend(type, action, fromRoute) {
		coop._inFlight[type] = (coop._inFlight[type] || 0) + 1;
		coop._sentTypes.push(type);
		// KDM-163: queue this send's route-ness. The bridge replies to each input EXACTLY once and in
		// order, so shifting on each reply tells us the route-ness of the input the server acted on.
		coop._sentRoute.push(!!fromRoute);
		while (coop._sentRoute.length > 64) { coop._sentRoute.shift(); coop._sentTypes.shift(); }
		// Rate-limited logging, by observation rather than by name: the first few sends of any type in
		// each second are printed, the rest counted in the HUD. A per-frame type stops flooding the
		// console without the client knowing which type that is. __coopDiag.verbose(true) prints all.
		if (window.__KDMP_DEBUG && !diag._quiet && (diag._verbose || diag.logBudget(type))) {
			try { console.log('[coop ' + id + '] submit ->', JSON.stringify(action)); } catch (e) { /* ignore */ }
		}
		ws.send(JSON.stringify({ type: 'input', action: action }));
	}

	/**
	 * One reply consumed one send (the bridge answers each input exactly once, in order). Free that
	 * type's slot; if the reply was a bare ACK, record that this exact payload provably moves no state
	 * so an identical repeat is skipped at the wire until a turn invalidates the verdict.
	 */
	function ackOne(kind) {
		var t = coop._sentTypes.shift();
		if (!t) return;
		coop._inFlight[t] = Math.max(0, (coop._inFlight[t] || 1) - 1);
		// KDM-186 v3: the server just told us what this type IS. 'ui' means it was applied without
		// consuming a turn — presentation, safe to sample. Anything else is a command: deliver it all.
		if (kind) coop._kindOf[t] = kind;
		// Flush the newest value a stream accumulated while the slot was busy, so it converges on its
		// LAST value rather than freezing on the first one delivered.
		var p = coop._pending[t];
		if (p && !coop._inFlight[t]) { delete coop._pending[t]; rawSend(t, p.action, p.route); }
	}

	/**
	 * KDM-233 — the lobby's way in. `coop-lobby.js` calls this; nothing else does.
	 *
	 *   { role:'host' }                                  claim slot 0 on this machine's server
	 *   { role:'guest', address:'host:port', name:'Ada' } ask that host to let you in
	 *
	 * It does NOT enter the game: that happens on `joined.started`, once the host has said yes.
	 */
	window.__coopConnect = function (opts) {
		opts = opts || {};
		role = opts.role || 'guest';
		playerName = String(opts.name || '');
		endpoint = opts.address ? String(opts.address).replace(/^wss?:\/\//, '').replace(/\/+$/, '') : null;
		// Identity is ours to pick and must be stable for a reconnect to be recognised (S2). It is not
		// a credential — there is nothing to authenticate against (KDM-226, LAN-only).
		// KDM-252: "must be stable" is now ENFORCED rather than merely noted — see `stableId`.
		id = opts.clientId || stableId(role);
		coop.id = id;
		coop._entered = false;
		coop._closedForGood = false;
		// Only `ready()` — see `enterGame()` for why asset loading must not gate the handshake.
		if (!ready()) { setTimeout(function () { window.__coopConnect(opts); }, 150); return coop; }
		connect();
		return coop;
	};

	/** Answer the pending join request. Host only — the server enforces that too. */
	window.__coopAnswerJoin = function (accept) {
		try { coop.ws.send(JSON.stringify({ type: 'join_answer', accept: !!accept })); } catch (e) { /* no socket */ }
		lobbySay({ pending: null, status: accept ? 'Starting…' : '' });
	};

	// The `#coop=<id>` path boots immediately, exactly as before. Without it we have only defined an
	// API, and a normal single-player page is left alone.
	if (id) boot();
})();
