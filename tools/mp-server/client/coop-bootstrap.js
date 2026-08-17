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
				id: id, quiet: d._quiet, inFlight: coop._inFlight, kinds: coop._kindOf, pending: Object.keys(coop._pending),
				started: coop.started, lastTick: coop.lastTick, submitted: coop.submitted,
				pendingSends: d._pending.length, sentRouteQueue: coop._sentRoute.length,
				rollups: d.rollups, recentInputs: d.inputs,
			}, null, 1);
		};
		d.reset = function () { d.rollups.length = 0; d.inputs.length = 0; d._win = freshWindow(); };
		d.quiet = function (v) { d._quiet = v !== false; return d._quiet; };
		d.verbose = function (v) { d._verbose = v !== false; return d._verbose; };
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

	function boot() {
		if (!ready()) { setTimeout(boot, 100); return; }
		if (!loaded()) { setStatus('Co-op ' + id + ': loading game assets…'); setTimeout(boot, 200); return; }
		// assets ready → bring up the dungeon and go render-only
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
			if (m.type === 'state') diag.noteRecv(m.kind === 'ui' ? 'ui' : 'turn', (e.data && e.data.length) || 0);
			else if (m.type === 'ack') diag.noteRecv('ack', (e.data && e.data.length) || 0);
			// KDM-186: an ACK is a reply that carries no state — the server applied our input and this
			// player's own state did not move. It still consumed exactly one send, so the in-order
			// bookkeeping must unwind for it exactly like a 'ui' state reply; it just has nothing to apply.
			if (m.type === 'ack') { coop._sentRoute.shift(); ackOne('ui'); return; }   // applied, no turn ⇒ stream
			if (m.type === 'joined') { coop.peers = m.players || []; }
			else if (m.type === 'state' && m.kind === 'ui') {
				// KDM-163: a UI input of OURS was applied — no turn resolved. Adopt the fresh state so
				// the menu responds (R6), and touch NOTHING that is per-turn. Treating this as a turn
				// is what used to kill click-to-move: with every input routed, KD's draw loop sends
				// `setMoveDirection` each frame, so this branch runs ~60×/s.
				coop.started = true;
				coop._sentRoute.shift();          // this reply consumed one send: it was a UI input
				ackOne('ui');                     // KDM-186: applied without consuming a turn ⇒ presentation
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
				coop._lastSnapshot = m.snapshot;   // KDM-186: kept so a test can re-apply it verbatim
				window.KDRenderClient.apply(m.snapshot);
				// KD-101 UAT: seed the server-configured carryable restraint item once (the Items inventory
				// is client-local, so it must be added here even though the server bundle already has it).
				if (!coop._startItemAdded && m.snapshot && m.snapshot.startItem) {
					addStartItem(m.snapshot.startItem);
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

	boot();
})();
