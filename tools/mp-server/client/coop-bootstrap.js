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

	// KDM-281 — every string this file puts on the lobby screen comes from the shared table in
	// `client/coop-text.js`, which is injected ahead of this file. The debug overlay `setStatus`
	// paints (a fixed monospace box, not lobby UI) is deliberately NOT in scope and stays English.
	var T = (typeof window !== 'undefined' ? window : globalThis).KDMPText.t;

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
	var role = null;          // 'host' | 'guest' — always set by the time we send a join
	/*
	 * KDM-255 — THIS WINDOW IS THE `#coop=` SHORTCUT, so nobody is watching it.
	 *
	 * `#coop=` used to send a `join` with no role at all, which the bridge seated directly without
	 * ever consulting the gate — a second implementation of joining that existed only because the
	 * tests and the two-window UAT flow stood on it. It is now a shortcut *into* the approval flow:
	 * the window asks for the host seat, and if someone already holds it, comes back as a guest.
	 *
	 * The one thing the shortcut still has to supply is the ANSWER, because the whole point is that
	 * window A is unattended. That auto-answer lives here, in the client, and deliberately not in the
	 * server: a server-side auto-approve flag would be the same duplication in a new coat — a second
	 * admission rule beside the host's. Here it is one page choosing to say yes.
	 */
	var shortcut = false;
	var playerName = '';      // what the host sees in their accept/decline prompt
	// KDM-256 / KDM-279 — the character package this player built in the lobby, or null for KD's
	// default. Carries class, outfit, style AND the perk keys picked on KD's own perk screen: perks
	// travelled as their own `join.perks` field until KDM-279 folded them in, because both fields
	// were one lobby's answer, on one handshake, to "what character is this player playing".
	var playerCharacter = null;
	// KDM-243 R1 — the single-player save this HOST is continuing, or `''` for a new game. Set only
	// by `__coopConnect({role:'host', save})`, i.e. only by the lobby's Continue button.
	var savePayload = '';
	// KDM-259 — the world seed this HOST named in the lobby, or `''` for "the server's own". Set only
	// by `__coopConnect({role:'host', seed})`, i.e. only by the lobby's host buttons; read by
	// `worldSeed()`, which is read only when a HOST builds its `join.world`.
	var seedChoice = '';

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
		// KDM-258: what `KinkyDungeonStartNewGame` threw during `forceGameScreen`, or '' if it did
		// not. Declared up front, like `peerMissing` above and for the same reason: "the game came up
		// cleanly" must be a value a test can assert on, not an absent property. See forceGameScreen.
		_startError: '',
		// KDM-258: how many times a state frame asked to pin the Game screen before the game could be
		// drawn. Counted rather than merely returned-from, so "we refused, and how often" is
		// observable — a silent guard is how the original silent catch hid this for a whole epic.
		_pinDeferred: 0,
		// KDM-239 R7: the screen the SESSION says we are on, or '' for "the dungeon". Declared up
		// front for the same reason as `peerMissing` and `_startError` above — "which screen does the
		// session believe we are on" has to be a value a test can read, not an absent property that
		// only exists once something has gone non-default. `pinGameScreen` reads it; the server sends
		// it only when it is not 'Game', so an absent value keeps every pre-KDM-239 session identical.
		screen: '',
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
			// KDM-249 — a GUEST pulls the host's mods first; a host has no host mod set to reconcile
			// against and only executes its own.
			//
			// KDM-255 — the `#coop=` shortcut is excluded explicitly, and no longer merely by being
			// roleless. Its two windows are the same page off the same origin running the same
			// bundle, so there is nothing to reconcile; a shortcut guest fetching from itself would
			// be work done to reach the state it is already in.
			var pullsMods = role === 'guest' && !shortcut;
			window.__coopMods.ensureExecuted(pullsMods ? { fetchFrom: httpBase() } : {});
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
	 * KDM-239 R3 — the WORLD-level game modes this host has set, read from KD's own globals.
	 *
	 * These are the inputs `KDUpdatePlugSettings` derives `KinkyDungeonStatsChoice` from
	 * (`KinkyDungeon.ts:6114-6127`). We read them rather than reading the derived keys because the
	 * derived Map is also where perks live, and the host's perks are emphatically NOT the world's.
	 *
	 * Only the keys the server classifies as world-level appear here; the per-character ones
	 * (`arousalMode` and the perk-difficulty pair) stay on KDM-238's per-player channel. The server
	 * re-validates against the same list, so this list being wrong degrades to "KD's default"
	 * rather than to a world nobody asked for.
	 */
	function worldModes() {
		var table = (window.KDGameModes && window.KDGameModes.MODE_SOURCE) || {};
		var now = sourceValues();
		var out = [];
		for (var key in table) {
			if (!Object.prototype.hasOwnProperty.call(table, key)) continue;
			var entry = table[key];
			if (now[entry.global] !== undefined && now[entry.global] === entry.value) out.push(key);
		}
		return out;
	}

	/**
	 * The current value of each source global `MODE_SOURCE` refers to.
	 *
	 * ⚠️ READ BY BARE NAME, and that is why this list is written out instead of being driven from the
	 * table. These are bundle-scope `let`s: they are visible to this script by bare name but are NOT
	 * properties of `window`, so `window[entry.global]` — the obvious generic form — reads
	 * `undefined` for every one of them and this function would report that the host chose nothing.
	 *
	 * The part that must not drift (which keys are the world's, and which value produces each) lives
	 * in the shared table. This is only "what are these six globals set to right now".
	 */
	function sourceValues() {
		var v = {};
		try { if (typeof KinkyDungeonRandomMode !== 'undefined') v.KinkyDungeonRandomMode = KinkyDungeonRandomMode; } catch (e) { /* absent */ }
		try { if (typeof KinkyDungeonHardMode !== 'undefined') v.KinkyDungeonHardMode = KinkyDungeonHardMode; } catch (e) { /* absent */ }
		try { if (typeof KinkyDungeonExtremeMode !== 'undefined') v.KinkyDungeonExtremeMode = KinkyDungeonExtremeMode; } catch (e) { /* absent */ }
		try { if (typeof KinkyDungeonSaveMode !== 'undefined') v.KinkyDungeonSaveMode = KinkyDungeonSaveMode; } catch (e) { /* absent */ }
		try { if (typeof KinkyDungeonItemMode !== 'undefined') v.KinkyDungeonItemMode = KinkyDungeonItemMode; } catch (e) { /* absent */ }
		try { if (typeof KinkyDungeonEasyMode !== 'undefined') v.KinkyDungeonEasyMode = KinkyDungeonEasyMode; } catch (e) { /* absent */ }
		try { if (typeof KinkyDungeonPerkProgressionMode !== 'undefined') v.KinkyDungeonPerkProgressionMode = KinkyDungeonPerkProgressionMode; } catch (e) { /* absent */ }
		try { if (typeof KinkyDungeonProgressionMode !== 'undefined') v.KinkyDungeonProgressionMode = KinkyDungeonProgressionMode; } catch (e) { /* absent */ }
		return v;
	}

	/**
	 * KDM-239 R5 / KDM-259 — the seed for this run: what the host TYPED in the lobby, else a URL
	 * override (`#coop=A&seed=foo`), else ''.
	 *
	 * Empty means "use whatever the server was configured with" (`swap-session.js`:
	 * `hostWorld.seed || this.seed`), which is what every session did before either half existed — so
	 * a host that names nothing still changes nothing. ⚠️ Never substitute a default here: this client
	 * does not know what the server was configured with, and inventing one would silently replace it.
	 *
	 * The two sources cannot really contend — the `#coop=` shortcut road never passes through the
	 * lobby, so `seedChoice` is '' there, and a lobby host has no `#coop=` fragment. The order is
	 * still stated rather than left to chance: an explicit act by a player outranks a URL a developer
	 * left in the bar.
	 */
	function worldSeed() { return seedChoice || getParam('seed') || ''; }

	/**
	 * KD-101: pre-select the player's binding material as the quick-bind item (stock
	 * KinkyDungeonAttemptQuickRestraint). When "Tie Up" casts Bondage with a raw material
	 * selected, the stock cast (KinkyDungeonMagicCode "Bondage") opens the bind submenu
	 * already in the generic view with THAT material's category chosen. Without a selection
	 * the submenu defaults to the first global category (ChainRaw) — which the demo players
	 * don't carry — so every restraint click is gated out by the quantity check and "Tie Up
	 * does nothing". We only select when the player has no selection of their own, and only a
	 * generic raw binding material they actually own — pure stock data/selection, no patch.
	 *
	 * ⚠️ KDM-285 — DISARM THE SPELL AFTERWARDS, and never take that line out.
	 *
	 * Stock `KinkyDungeonAttemptQuickRestraint` sets THREE things (KinkyDungeonInventory.ts:4304):
	 * the item, the weapon, and `KinkyDungeonTargetingSpell = KDBondageSpell`. The third one is the
	 * player saying "I am now aiming"; in stock KD the very next click or Escape clears it. This
	 * client does not simulate, so nothing ever did — every co-op session ran from boot to exit in
	 * permanent spell-targeting mode, and KD deliberately hides a long list of HUD while you aim:
	 *
	 *   - the whole message log            KinkyDungeonDraw.ts:1934   ← the symptom that got noticed
	 *   - buff / debuff icons              KinkyDungeonHUD.ts:395
	 *   - the quick resources readout      KinkyDungeonHUD.ts:3927 (KDDrawResourcesQuick)
	 *   - spell key handling               KinkyDungeonHUD.ts:282 (KinkyDungeonHandleSpell)
	 *   - the move helper highlight        KinkyDungeonDraw.ts:1429/1443 (KDToggles.Helper forced off)
	 *   - quick-inventory mouse handling   KinkyDungeonHUD.ts:264
	 *   - plus a targeting reticle and a force-lit mana bar painted every frame (1442-1556, 1822)
	 *
	 * Only the SELECTION is wanted here, so only the selection is kept. Measured, not reasoned:
	 * `mp-coop-log-visible.spec.ts` asserts both halves — nothing armed, and KD drawing its own log —
	 * and it goes red on either one alone.
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
					// Selecting a material is not aiming. See the block comment above.
					KinkyDungeonTargetingSpell = null;
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

	/**
	 * Start a game ONCE to bring up dungeon structures, then pin to the Game screen.
	 *
	 * ⚠️ THIS CATCH USED TO BE SILENT, and that silence hid KDM-258. `KinkyDungeonStartNewGame` is
	 * what reaches `KinkyDungeonInitialize` -> `KDInitCanvas()` (`KinkyDungeonGame.ts:568, :577`),
	 * the ONLY place `KinkyDungeonContext` is ever assigned — it is `null` until then
	 * (`KinkyDungeonGame.ts:95`). If this throws before that point we swallow it, `pinGameScreen()`
	 * pins the screen to `'Game'` regardless, and the next frame runs
	 * `KinkyDungeonContext.fillStyle = …` (`KinkyDungeonDraw.ts:1230`) against null. That throw
	 * escapes `DrawProcess` into the PIXI ticker and the whole render loop stops: the player is left
	 * looking at one frozen frame.
	 *
	 * The draw's own guard is `if (KinkyDungeonCanvas)` — and `KinkyDungeonCanvas` is a
	 * `document.createElement("canvas")` at module scope (`:94`), so it is ALWAYS truthy and never
	 * protects anything. Nothing downstream will catch this for us.
	 *
	 * So: record it and say so. The recovery decision (pin anyway vs. refuse) belongs to the caller,
	 * but a failure this total must never again be invisible.
	 */
	function forceGameScreen() {
		try {
			KinkyDungeonStartNewGame(false);
		} catch (e) {
			coop._startError = String((e && e.message) || e);
			try { console.error('[coop] KinkyDungeonStartNewGame failed — the game may not render:', e); }
			catch (_) { /* console gone */ }
		}
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
		/*
		 * KDM-258 — NEVER PIN A SCREEN THE GAME CANNOT DRAW.
		 *
		 * `KinkyDungeonContext` is the 2D context every map draw writes to. It is `null` until
		 * `KDInitCanvas()` runs (`KinkyDungeonGame.ts:95, :577`), reachable only through
		 * `KinkyDungeonStartNewGame` -> `KinkyDungeonInitialize` (`:568`) — i.e. through
		 * `forceGameScreen()` below. Pinning `'Game'` before that makes the very next frame run
		 * `KinkyDungeonContext.fillStyle = …` (`KinkyDungeonDraw.ts:1230`) against null; the throw
		 * escapes `DrawProcess` into the PIXI ticker and the render loop STOPS FOR GOOD. One frozen
		 * frame, for the rest of the session.
		 *
		 * ⚠️ THE DRAW'S OWN GUARD DOES NOT HELP: it tests `if (KinkyDungeonCanvas)`, and that is a
		 * `document.createElement("canvas")` at module scope (`:94`) — always truthy.
		 *
		 * Why this only ever bit the LOBBY path: `boot()` runs `enterGame()` and only THEN `connect()`,
		 * so on `#coop=` the game is initialised before any state frame exists. The lobby opens its
		 * socket from the Host/Join button and runs `enterGame()` later, on `joined.started` — where it
		 * also defers on assets and on mod execution. A state frame landing in that window pinned a
		 * screen that could not be drawn. The HOST is the usual victim; it connects earliest.
		 *
		 * Refusing is strictly better than pinning: the player keeps looking at a live lobby for a few
		 * hundred milliseconds until `enterGame()` catches up, instead of a dead canvas forever.
		 */
		if (typeof KinkyDungeonContext === 'undefined' || !KinkyDungeonContext) {
			coop._pinDeferred++;
			/*
			 * …and BRING THE GAME UP, because on the lobby path nothing else will.
			 *
			 * `enterGame()` is called from exactly two places: `boot()` (the legacy `#coop=` path) and
			 * the `joined.started` handler. The server sends that `joined` only to the GUEST when the
			 * host accepts (`ws-bridge.js`, the accept branch) — the host is never told, in those
			 * words, that its session has started. So a lobby HOST never ran `enterGame()` at all; it
			 * only ever arrived at the Game screen because this function used to pin it there
			 * unconditionally, with the game uninitialised. Fixing the pin alone would leave the host
			 * sitting in the lobby forever.
			 *
			 * A state frame IS the signal: the server sends none until the session is live. Asking
			 * here keeps the fix client-side, with no new protocol.
			 *
			 * Safe to call repeatedly: `enterGame()` is idempotent on `coop._entered` and re-schedules
			 * itself while it waits for assets or mods. And it cannot recurse — by the time it calls
			 * `forceGameScreen()` -> back into here, `KinkyDungeonStartNewGame` has set the context;
			 * if it threw, `_entered` is already true and the re-entry returns immediately.
			 */
			enterGame();
			return;
		}
		/*
		 * KDM-239 R7 — ADOPT the session's screen; do not stamp one.
		 *
		 * This used to be an unconditional `KinkyDungeonState = 'Game'`, re-applied on every state
		 * frame. That is what made a co-op run a *pinned* game rather than a played one: any screen
		 * the game legitimately entered — the journey map between floors, a death screen — was
		 * stamped back to 'Game' before the player could see it, and no amount of correct
		 * server-side work could ever become visible.
		 *
		 * `coop.screen` is set from the state frame (`_stateFrame`, so it rides the existing delta
		 * wire — never diff a consume-once channel). Absent means 'Game', which keeps every existing
		 * session and the whole `#coop=` e2e suite behaving exactly as before: the server only sends
		 * a screen when it is NOT the dungeon.
		 *
		 * ⚠️ Still an assignment, not a request. The client does not simulate, so it must not decide
		 * on its own that the screen has changed — that decision is the world's, and arrives here.
		 */
		var screen = coop.screen || 'Game';
		KinkyDungeonState = screen;
		KinkyDungeonDrawState = screen;
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
		/*
		 * KDM-280 — ONE generator, and it does not name a seat.
		 *
		 * The host branch used to mint the literal string `'host'`, which broke the invariant this
		 * file's README states outright: an id "must differ between two tabs because two tabs are two
		 * players". Both tabs start with empty storage, so both minted `'host'` — and since
		 * `claimHost` is idempotent for the same id, the second player did not get refused, they
		 * quietly took over the first one's declaration and socket.
		 *
		 * Not `'host-' + random` either: `forRole` is only the role of whoever happens to mint the id
		 * FIRST. This function already returns the HELD value whatever role later asks for it, so a
		 * player who pressed Join and then Host would carry a `guest-` id forever — a role-shaped id
		 * is a label that goes stale on its first use, which is the confusion that produced the bug.
		 *
		 * `forRole` is kept in the signature: `tests/e2e/mp-reconnect.spec.ts` calls `_stableId(role)`
		 * to assert stability, and the argument documents at every call site that a seat was being
		 * asked for even though the answer no longer depends on it.
		 */
		var made = 'kd-' + Math.random().toString(36).slice(2, 8);
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
	 * KDM-272 — whether this player has already been told how co-op differs.
	 *
	 * Here rather than in `coop-lobby.js` for the reason `ADDR_KEY` gives just above: the lobby draws
	 * screens and never touches storage, and one file owning every `kdcoop.` key is what stops a
	 * second, differently-spelled copy of it appearing later.
	 *
	 * `localStorage`, matching the address above and deliberately unlike `stableId`'s
	 * `sessionStorage`: "you have already read this" is a property of the PERSON, and per-tab would
	 * mean the briefing returns every time the game is reopened, which is not "once".
	 *
	 * Both halves swallow their throw, so a storage-disabled browser reads `false` for ever and is
	 * shown the briefing every time — degraded, never broken (KDM-272 AC3).
	 */
	var BRIEFING_KEY = 'kdcoop.briefingSeen';

	/** Has this player seen the co-op briefing? `false` whenever storage cannot answer. */
	function briefingSeen() {
		try { return window.localStorage.getItem(BRIEFING_KEY) === '1'; } catch (e) { return false; }
	}
	window.__coopBriefingSeen = briefingSeen;

	/** Record that they have. Called from the frame that PAINTS it — see `drawAbout`. */
	function markBriefingSeen() {
		try { window.localStorage.setItem(BRIEFING_KEY, '1'); } catch (e) { /* storage disabled */ }
	}
	window.__coopMarkBriefingSeen = markBriefingSeen;

	/**
	 * KDM-247 — where the quick-emoji picker's recents are kept.
	 *
	 * The KEY and the try/catch live here for the reason `ADDR_KEY` gives above: one file owning
	 * every `kdcoop.` key is what stops a second, differently-spelled copy appearing later, and a
	 * file that draws screens never touches storage directly.
	 *
	 * But ONLY the key and the storage call are here. The seed set, the parsing and the MRU order
	 * live in `coop-chat.js` beside the picker that uses them, because this file is ~1900 lines and
	 * no spec in the suite executes it — every existing test of this file reads it as SOURCE TEXT.
	 * Logic placed here would be coverable only by an e2e; behind this two-function seam it is
	 * covered by millisecond unit tests with real controls (`mp-chat-client.spec.ts`).
	 *
	 * `localStorage`, matching `briefingSeen` and deliberately unlike `stableId`'s `sessionStorage`:
	 * "the emoji I use" is a property of the PERSON, and per-tab would mean the list resets every
	 * time the game is reopened.
	 *
	 * Both halves swallow their throw, so a storage-disabled browser reads `null` for ever and the
	 * picker falls back to its seed set every session — degraded, never broken (as KDM-272 AC3).
	 */
	var EMOJI_KEY = 'kdcoop.emojiRecents';
	window.__coopEmojiStore = {
		/** The stored list as an opaque string, or `null`. Parsing is the caller's business. */
		read: function () {
			try { return window.localStorage.getItem(EMOJI_KEY); } catch (e) { return null; }
		},
		write: function (s) {
			try { window.localStorage.setItem(EMOJI_KEY, String(s)); } catch (e) { /* storage disabled */ }
		},
	};

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
			lobbySay({ error: T('KDMPNoAnswer', { WHERE: where }), status: '' });
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

	/**
	 * KDM-255 — every join names the seat it wants. There is no longer a roleless form: the bridge
	 * refuses one, because the gate is the only road in.
	 *
	 * KDM-270 — AND IT IS NOW SENT FROM TWO PLACES, so it is built in one.
	 *
	 * A refusal that carries `retry` leaves the socket open and names another seat to ask for, and
	 * that second ask must send THE SAME declaration as the first — the player is the same person,
	 * with the same name, mods and character. Built inline in `ws.onopen`, it could only be asked
	 * again by opening a new socket (which is what `#coop=` used to do) or by writing the frame out
	 * a second time. This is the third option, and the only one that cannot drift.
	 *
	 * A pure read: it decides nothing and sends nothing.
	 */
	function joinFrame() {
		var join = { type: 'join', clientId: id };
		join.role = role;
		// On the shortcut road these are the honest empty answers for a window nobody
		// configured — `''` and `[]` are exactly what the gate reads as "unnamed" and "seat me
		// on KD's default terms", which is what keeps the legacy `Player <id>` label.
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
		// KDM-256 R1 / KDM-279 — the character this player built: class, outfit, style and the
		// perks they picked on KD's own perk screen, as ONE declaration beside the name and the
		// mods. Sent only when there is one: absence means "seat me as KD's default", which is
		// the `#coop=` road's answer and the one the server already had (R4). Both roles send
		// it — unlike `world`/`save` below, a character is per-seat, and the guest's is the whole
		// point of the feature.
		//
		// There is no dangerous reading of absence here, unlike `mods` above: a player who never
		// opened those screens is seated on KD's default terms (R9), not refused.
		if (playerCharacter) join.character = playerCharacter;
		/*
		 * KDM-239 R3/R5 — a HOST also declares the WORLD: the game-mode toggles that describe
		 * the run, and the seed.
		 *
		 * Host only, and the server drops a guest's copy anyway (join-gate). Both halves are
		 * deliberate: sending it from a guest would be a client asserting something that is
		 * not its to assert, and refusing it only on the client would leave the server
		 * trusting whoever sent it first.
		 *
		 * Read from KD's OWN globals — the same values `KDUpdatePlugSettings` derives its keys
		 * from — so whatever the player set on KD's own screens is what travels. We choose
		 * nothing here; `worldModes()` is a read, not a policy.
		 *
		 * KDM-270 — read at ASK time, not at connect time, which matters now that a second ask can
		 * follow a refusal: a client refused the host seat asks again as a guest, and a guest must
		 * not carry the world it was going to bring.
		 */
		if (role === 'host') join.world = { modes: worldModes(), seed: worldSeed() };
		/*
		 * KDM-243 R1 — and, if this host chose to CONTINUE a run, the save itself.
		 *
		 * In the same `if` as the world above, so "only a host brings a world" is expressed once
		 * on this side too. The value is whatever the player already has in KD's own current save
		 * slot (D1) — this reads it, it never produces one.
		 *
		 * Absent unless `connect({save})` asked for it: pressing Host must keep starting a new
		 * game even for a player who has a save sitting right there (the e2e control).
		 */
		if (role === 'host' && savePayload) join.save = savePayload;
		return join;
	}

	/**
	 * KDM-270 — ask for a seat on the socket we already have.
	 *
	 * Called by `ws.onopen` for the first ask, and by the `reject` handler for the second one a
	 * `retry` invites. There is no third caller and no second implementation: an ask is this
	 * function, whether it follows a fresh socket or a refusal.
	 */
	function ask(seat) {
		role = seat;
		// An invitation is CONSUMED by using it. Cleared here, in the one place an ask happens, so no
		// caller can leave a stale `retry` standing for a seat it has already taken.
		coop._mayAsk = null;
		var mine = ws;
		try { mine.send(JSON.stringify(joinFrame())); } catch (e) { return; }
		// KDM-249 R6 — a HOST publishes its zips so a guest can fetch them, then re-states the
		// declaration: `join` above carried whatever had been hashed by the time the socket
		// opened, which misses mods picked from the Mods menu just before hosting.
		//
		// Fire-and-forget: the host's own session needs nothing from the gateway's store, so a
		// failed upload degrades the GUEST's presentation (named by R9) rather than blocking
		// anyone's game.
		// KDM-255 — `!shortcut` for the same reason the guest-side fetch is skipped above: both
		// `#coop=` windows are the same bundle off the same origin, so there is nothing for the
		// guest to pull and publishing would be an upload to satisfy a fetch that never happens.
		if (role === 'host' && !shortcut && window.__coopMods) {
			try {
				window.__coopMods.publish(httpBase()).then(function (rows) {
					if (ws === mine && ws.readyState === 1) ws.send(JSON.stringify({ type: 'mods_declare', mods: rows }));
				}).catch(function () { /* best-effort */ });
			} catch (e) { /* best-effort */ }
		}
		setStatus('Co-op ' + id + ': joined, waiting for the other player…');
	}

	/**
	 * KDM-270 — may we ask for `seat` on the socket we already hold?
	 *
	 * True only when the server said so (`coop._mayAsk`, set by the last refusal), the socket is
	 * genuinely open, and the address has not changed underneath us. That last clause is not
	 * paranoia: the join view lets the player TYPE an address, and asking on the old socket after
	 * they typed a new one would join a machine they did not choose.
	 */
	function canAsk(seat, address) {
		if (!coop._mayAsk || coop._mayAsk !== seat) return false;
		if (!ws || ws.readyState !== 1) return false;
		// Against `coop._at` — where the LIVE socket actually went — and never against `endpoint`,
		// which `__coopConnect` has already overwritten with the address being asked for by the time
		// this runs. Comparing that to itself would make the whole check say yes always, which is a
		// guard that reads as present and is not there at all.
		return normAddr(address) === coop._at;
	}

	/** The address as `connect()` would use it: no scheme, no trailing slash, own origin when blank. */
	function normAddr(a) {
		var s = a ? String(a).replace(/^wss?:\/\//, '').replace(/\/+$/, '') : '';
		return s || location.host;
	}

	function connect() {
		var proto = location.protocol === 'https:' ? 'wss' : 'ws';
		var where = endpoint || location.host;
		// KDM-270: a NEW socket carries no standing invitation, and `canAsk` compares against where
		// this one actually goes rather than against whatever was last typed.
		coop._mayAsk = null;
		coop._at = where;
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
			ask(role);
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
			lobbySay({ error: T('KDMPCouldNotReach', { WHERE: where }), status: '' });
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
		/**
		 * KDM-239 R7 — the screen the session says we are on, taken from the resolved snapshot.
		 *
		 * Done HERE, in `resolveState`, rather than at the three `pinGameScreen()` call sites: every
		 * state frame passes through this one function, and three copies of the same read is exactly
		 * the drift that lets one branch quietly keep the old behaviour. It also means the value
		 * survives delta encoding for free — `kdMerge` carries `screen` like any other field, so a
		 * frame that does not mention it leaves the last one standing.
		 */
		function adoptScreen(snap) {
			if (snap && typeof snap.screen === 'string') coop.screen = snap.screen;
			return snap;
		}

		function resolveState(m) {
			if (m.snapshot) {                       // full: adopt it and re-baseline
				coop._snapBase = m.snapshot;
				coop._snapSeq = m.seq || 0;
				return adoptScreen(m.snapshot);
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
			return adoptScreen(coop._snapBase);
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
				// KDM-257 R1 — the diff rides this message and used to be dropped here. The guest must be
				// able to SEE what it is about to load before the host answers, and this is the only
				// moment it can: the session does not exist yet.
				lobbySay({ status: T('KDMPWaitingApproval'), error: '', modDiff: m.modDiff || null,
					// KDM-239 R4 — the WORLD rides the same message, for the same reason and at the same
					// moment: this is the last point the guest can still walk away.
					world: m.world || null });
				return;
			}
			if (m.type === 'join_pending') {
				/*
				 * KDM-255 — on the `#coop=` road there is nobody at this window to click Accept, so it
				 * answers for itself. This is the ONLY thing the shortcut adds to the flow; everything
				 * else about the join is the same code the lobby uses.
				 *
				 * Note what is NOT here: no server-side auto-approve, no test-only flag. The gate still
				 * decided who was allowed to ask, and it is still the HOST that answers — this host
				 * simply always says yes, because that is what a two-window UAT session means.
				 */
				if (shortcut) { window.__coopAnswerJoin(true); return; }
				// Someone is asking to join OUR game. The host answers this — it is the whole gate.
				// KDM-257 R2 — same diff, other side: the host is agreeing to SEND these, so say so.
				lobbySay({ view: 'host', pending: { clientId: m.clientId, name: m.name || T('KDMPSomeone') }, error: '', modDiff: m.modDiff || null });
				return;
			}
			if (m.type === 'reject') {
				/*
				 * KDM-270 — A REFUSAL THAT NAMES ANOTHER SEAT IS NOT THE END OF THE CONVERSATION.
				 *
				 * `m.retry` is the seat the server says we may ask for on THIS socket, and its
				 * presence is also why the socket is still open (`ws-bridge._reject`). So the client
				 * matches no reason strings here either: whether to hang up was decided at the gate,
				 * and this end simply reads the answer.
				 *
				 * Remembered before anything else so the lobby's own Join/Host button can use it —
				 * `__coopConnect` consults `_mayAsk` to re-ask instead of dialling again.
				 */
				coop._mayAsk = m.retry || null;
				if (m.retry) {
					/*
					 * KDM-255's SHORTCUT, now on the same road as everyone else: window B asked for
					 * the host seat, was told someone already has it, and comes back as the guest.
					 *
					 * It used to RECONNECT here, because `_reject` ended every socket — a second way
					 * of doing the one thing this branch does. `ask()` is the first way.
					 */
					if (shortcut && m.retry === 'guest') {
						setStatus('Co-op ' + id + ': joining ' + (endpoint || 'this game') + '…');
						ask('guest');
						return;
					}
					/*
					 * A HUMAN is at the lobby, and what to do about a free seat is a UI decision the
					 * server deliberately does not make for us (it reports what is possible; we
					 * decide what to offer).
					 *
					 * `already_hosting` → GO. The player already said they wanted to play with
					 * someone, and the only seat left is the guest's, so taking them to the join view
					 * is doing what they asked rather than something new.
					 *
					 * `no_host` → OFFER. Hosting brings the world, and possibly a save; assuming it
					 * on someone's behalf is a bigger thing than sliding them one seat across. They
					 * are told, they stay where they are, and pressing Host now works on this live
					 * socket.
					 */
					if (m.retry === 'guest') {
						lobbySay({
							view: 'join', pending: null, status: '',
							error: T('KDMPAlreadyHosting'),
						});
					} else {
						lobbySay({ status: '', error: T('KDMPNobodyHosting') });
					}
					return;
				}
				// KDM-281 — the reason CODE picks a key; the sentence lives in `coop-text.js`. Note the
				// build-mismatch line is templated rather than concatenated: which version is named
				// first is a matter of word order, and word order is the translator's business.
				var why = m.reason === 'declined' ? T('KDMPRefusedDeclined')
					: m.reason === 'build_mismatch' ? T('KDMPRefusedBuild',
						{ HOSTBUILD: m.hostBuild || '?', GUESTBUILD: m.guestBuild || '?' })
					: m.reason === 'session_full' ? T('KDMPRefusedFull')
					: m.reason === 'busy' ? T('KDMPRefusedBusy')
					// KDM-270 — `no_host` was here too, and is not any more: it now carries a `retry`
					// and is answered above, with an offer to host instead. Leaving the line would be
					// two different sentences for one refusal, one of which nobody can reach.
					: T('KDMPRefusedOther', { REASON: m.reason });
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
			if (m.type === 'peer_joined') {
				/*
				 * KDM-278 — somebody has joined the run we are already in (`ws-bridge._joinLate`).
				 *
				 * This branch did not exist. The server sent the message, the unit spec asserted it on
				 * the wire, and NO client read it — so `coop.peers`, set once from `joined.players`,
				 * stayed at whoever was seated when we arrived, and a late joiner was missing from
				 * every existing player's roster for the rest of the run. Their avatar showed up
				 * (the state frame that follows carries the world); only the roster was stale.
				 *
				 * `m.players` wholesale, NOT `peers.push(m.clientId)`: the server's list is the one
				 * source of truth for who is seated — the same field, from the same session getter,
				 * that `joined` above adopts. Appending would be a second, drifting derivation of it,
				 * and would double an id if the message were ever re-sent.
				 *
				 * SAY SO, like the other two presence events. `peer_gone` and `peer_back` both write
				 * the status line, and arrival was the only presence change the player was never told
				 * about — a second character appearing beside you with no word for it reads as a bug.
				 * Nothing else is touched: this is not a drop, so there is no `peerMissing` /
				 * `blocked` state to clear, and it is not a turn.
				 */
				coop.peers = m.players || [];
				setStatus('Co-op ' + id + ': ' + m.clientId + ' has joined the run.');
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
				// KDM-255 — `!shortcut` matters: a `#coop=` window has already entered the game
				// (`boot()` calls `enterGame()` before connecting, which is the shortcut's whole
				// character), so painting the lobby's host screen here would cover a live window with a
				// waiting-room it never opened. The lobby host, who IS on that screen, still gets it.
				// KDM-287 — `m.lan` rides in with the host's own `joined`, which is the frame that
				// opens this screen: the address to share and the screen that shows it arrive
				// together, so there is no window in which the host is looking at a stale one. It is
				// carried, not interpreted — what to DO with it is the lobby's decision (`shareLines`),
				// because it is the lobby that knows where the host's own browser is.
				else if (role === 'host' && !shortcut) lobbySay({ view: 'host', status: '', share: m.lan || [] });
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
			} else if (m.type === 'save_export') {
				/*
				 * KDM-244 — the run has come back as a single-player save. See `writeExportedSave`.
				 *
				 * KDM-275 A5 — …and now it arrives unbidden, so WHO ASKED decides what the player is
				 * told. `reason` is `requested` / `solo` for the two explicit moments KDM-244 built, and
				 * `floor` / `timer` for the automatic ones this task added.
				 *
				 * QUIET ON SUCCESS, LOUD ON FAILURE. A line every floor is noise the player learns to
				 * ignore, which is worse than useless — but suppressing the FAILURE too would break the
				 * promise the whole feature rests on, that a silent success and a silent failure are
				 * indistinguishable until you close the tab and find out (KDM-244 A6). The automatic
				 * path is the one nobody is watching, so its failures are the ones that most need
				 * saying.
				 *
				 * The success is still RECORDED (R7/AC4). "Is my run safe, and how recently?" must be
				 * answerable without acting, and without having caught a toast that has since scrolled
				 * away — so the fact lives on `coop`, where the UI reads it, rather than in a message.
				 */
				var w = writeExportedSave(m.save);
				var auto = (m.reason === 'floor' || m.reason === 'timer');
				coop.lastSaveOk = !!w.ok;
				coop.lastSaveAt = (w.ok && typeof Date !== 'undefined') ? Date.now() : coop.lastSaveAt;
				coop.lastSaveWhy = m.reason || '';
				if (!w.ok || !auto) {
					setStatus('Co-op ' + id + ': ' + (w.ok
						? 'run saved — you can continue it in single player.'
						: 'COULD NOT SAVE THE RUN — ' + w.err + ' (your previous save is untouched)'));
				}
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
	 *   { role:'host', save:'<b64>' }                    …continuing that save instead of a new game
	 *   { role:'guest', address:'host:port', name:'Ada' } ask that host to let you in
	 *
	 * It does NOT enter the game: that happens on `joined.started`, once the host has said yes.
	 */
	/**
	 * KDM-244 — write the exported run into KD's own save slot, without ever leaving it broken.
	 *
	 * ⚠️ WHY THIS DOES NOT USE KD'S OWN SAVE PATH. The elegant version pushes the save object onto
	 * `KDSaveQueue` and lets `KinkyDungeonRun` compress and store it (`KinkyDungeon.ts:1520-1538`) —
	 * upstream's code, no storage logic of ours. It is rejected for one line:
	 *
	 *     catch (e) { …; localStorage.setItem('KinkyDungeonSave', ""); saveError = true; }
	 *
	 * On a quota failure KD BLANKS the slot. Since D2 puts the co-op run in that same slot, a failed
	 * export would leave the player with no run at all where a second earlier they had one — exactly
	 * the "worse than none" outcome R9 forbids. So the write is ours and it is guarded: stash, write,
	 * read back, and restore the stash if anything went wrong.
	 *
	 * This is NOT re-implementing the save format (R2). The bytes were produced by KD's own
	 * `KinkyDungeonGenerateSaveData` and KD's own `LZString` on the server; what is owned here is the
	 * storage write, which is the only place D2's single-slot answer can be made safe.
	 *
	 * The read-back check is `KDMPLobby.saveIsUsable` — KD's own seven-field acceptance rule
	 * (`KinkyDungeon.ts:7079-7086`), already written for the import direction. Deliberately reused
	 * rather than copied: a second copy of upstream's rule is a second thing to keep in step, and
	 * this file would be the copy that drifts. `coop-lobby.js` loads AFTER this script, so it is
	 * reached through `window.KDMPLobby` at message time (always after both have loaded) rather than
	 * captured at load time.
	 */
	function writeExportedSave(str) {
		var KEY = 'KinkyDungeonSave';
		if (!str) return { ok: false, err: 'the server sent an empty save' };
		var check = window.KDMPLobby && window.KDMPLobby.saveIsUsable;
		if (typeof check !== 'function') return { ok: false, err: 'save validator unavailable' };
		// Validate BEFORE touching storage: a save that would not load must never displace one that
		// would, and this ordering means the bad case never writes at all.
		if (!check(str)) return { ok: false, err: 'the exported save is not loadable' };
		var stash;
		try { stash = window.localStorage.getItem(KEY); }
		catch (e) { return { ok: false, err: 'storage is unavailable' }; }
		try {
			window.localStorage.setItem(KEY, str);
			// Read BACK, because a quota-limited store can accept a write and truncate it, and because
			// "setItem did not throw" is not the same claim as "the run is on disk".
			if (!check(window.localStorage.getItem(KEY))) throw new Error('stored save did not read back');
			// KD keeps a slot list alongside the Continue key; leaving it stale would show the player
			// an older run in the slot browser than the one Continue actually opens.
			try {
				if (typeof KinkyDungeonDBSave === 'function' && typeof KDSaveSlot !== 'undefined') {
					KinkyDungeonDBSave(KDSaveSlot, str);
				}
			} catch (e) { /* the Continue slot is written; the slot list is a nicety */ }
			return { ok: true, err: null };
		} catch (e) {
			// Put back exactly what was there — including the absence of anything.
			try {
				if (stash === null || stash === undefined) window.localStorage.removeItem(KEY);
				else window.localStorage.setItem(KEY, stash);
			} catch (e2) { /* nothing further we can do; the message below is the honest report */ }
			return { ok: false, err: String((e && e.message) || e) };
		}
	}
	// The e2e drives this directly: the write is the whole risk, and reaching it through a real
	// server round trip would test the transport instead of the guard.
	window.__coopWriteExportedSave = writeExportedSave;

	/**
	 * KDM-244 — is this page the host?
	 *
	 * A function rather than a mirrored `coop.role` field, because `role` is assigned in more than one
	 * place (the join, and the host→guest fallback at the retry) and a copy would have to be updated
	 * at each of them. Reading the closure variable cannot go stale.
	 */
	coop.isHost = function () { return role === 'host'; };

	/** KDM-244 — ask the server for the run as a single-player save (host only; the server re-checks). */
	window.__coopRequestExport = function () {
		try { coop.ws.send(JSON.stringify({ type: 'export_request' })); return true; }
		catch (e) { return false; }
	};

	window.__coopConnect = function (opts) {
		opts = opts || {};
		role = opts.role || 'guest';
		// KDM-255 — the lobby has a HUMAN at it, who answers join requests themselves. The shortcut's
		// auto-answer must never be on here, or a host would silently admit whoever asked.
		shortcut = false;
		playerName = String(opts.name || '');
		// KDM-256 R1 / KDM-279 — and the character, perks included (the lobby merges its two screens
		// in `playerCharacter()`). Cleared on every connect for the reason `savePayload` is: a player
		// who backs out and reconnects must not carry a stale declaration in silently.
		playerCharacter = (opts.character && typeof opts.character === 'object') ? opts.character : null;
		// KDM-243 — the save to continue, if the lobby's Continue button supplied one. Cleared on
		// every connect, so a host who backs out and presses Host instead starts a new game.
		savePayload = (opts.role === 'host' && typeof opts.save === 'string') ? opts.save : '';
		// KDM-259 — and the seed, on exactly the same terms as the save: host-only, and CLEARED on
		// every connect. The clear is the load-bearing half — a player who is refused the host seat
		// comes back as a guest (KDM-270), and a guest must not carry the world it was going to bring.
		seedChoice = (opts.role === 'host' && typeof opts.seed === 'string') ? opts.seed : '';
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
		/*
		 * KDM-270 — if the last refusal invited exactly this ask, make it on the socket we still
		 * have instead of opening a second one.
		 *
		 * Deliberately inside `__coopConnect` rather than beside it: the lobby has ONE way to ask for
		 * a seat (`coop-lobby.js` calls this for both buttons), and a `__coopAsk` global would be a
		 * second entry point whose callers would drift from this one's. The declaration above is
		 * re-read either way, because the player may have changed their name or character on the way
		 * to the view they are asking from.
		 *
		 * The address is compared inside `canAsk` against where the live socket went, NOT against
		 * `endpoint` — which the line above has already replaced with the address being asked for.
		 */
		if (canAsk(role, opts.address)) { ask(role); return coop; }
		connect();
		return coop;
	};

	/** Answer the pending join request. Host only — the server enforces that too. */
	window.__coopAnswerJoin = function (accept) {
		try { coop.ws.send(JSON.stringify({ type: 'join_answer', accept: !!accept })); } catch (e) { /* no socket */ }
		lobbySay({ pending: null, status: accept ? T('KDMPStarting') : '' });
	};

	/*
	 * The `#coop=<id>` path boots immediately, exactly as before. Without it we have only defined an
	 * API, and a normal single-player page is left alone.
	 *
	 * KDM-255 — it now opens by asking for the HOST seat. Whichever window loads first gets it; the
	 * other is refused `already_hosting` and comes back as the guest (see the `reject` handler), which
	 * reproduces the arrival-order semantics the old roleless join had — but through the gate, and
	 * with every one of its rules applying.
	 */
	if (id) { role = 'host'; shortcut = true; boot(); }
})();
