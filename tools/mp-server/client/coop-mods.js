/**
 * tools/mp-server/client/coop-mods.js  (KDM-249)
 *
 * THE CLIENT HALF OF "THE GUEST PLAYS WITH THE HOST'S MODS".
 *
 * ── PHASE A: MODS RUN AT ALL ──────────────────────────────────────────────────────────────────────
 * KD executes mods from exactly one place — `KDExecuteModsAndStart()` on the main-menu buttons
 * (`KinkyDungeon.ts:1891`) — plus a per-frame auto-load gated on `KDToggles.AutoLoadMods`, which
 * DEFAULTS TO FALSE (`KinkyDungeonVibe.ts:145`). The co-op client reaches neither: it calls
 * `KinkyDungeonStartNewGame(false)` directly (`coop-bootstrap.js`). So on default settings a co-op
 * player today gets none of their own mods, and never finds out why.
 *
 *   1. THE LATCH, at script-parse time. `KDGetMods` (`KDMods.ts:9`) is KD's own "the auto-loader has
 *      been handled" flag. Setting it before the first frame makes KD's auto-load-and-execute stand
 *      down, so `KDExecuted` stays false and the timing is ours. Injected classic scripts run before
 *      `window.onload`, which is what installs the render ticker (`Scripts/Main.ts:67,93-97`), so
 *      there is no frame between this file and the bundle.
 *   2. THE EXECUTION, at co-op session start — the stock game executes mods when a GAME starts, and
 *      `enterGame()` is the co-op analogue of the Play button.
 *
 * ── PHASE B: THE HOST'S MODS REACH THE GUEST ──────────────────────────────────────────────────────
 *   3. PREPARE. Load this player's own mods (per their setting) and hash each zip, so a DECLARATION
 *      is ready for the `join` handshake.
 *   4. PUBLISH (host only). Upload each zip to the gateway, content-addressed.
 *   5. FETCH (guest only). Read the host's manifest and pull every hash we do not already hold, then
 *      install through the STOCK `KDLoadMod` path so assets, translations and JS all take the route
 *      they take for a locally-picked mod.
 *
 * ── WHAT "MISSING" MEANS, AND WHY THERE IS NO SECOND DIFF HERE ────────────────────────────────────
 * The server's `mod-sync.js` computes a diff for REPORTING — what to show each side, in priority
 * order, with conflicts labelled. This file does not repeat that. It asks a strictly simpler
 * question, "which of the manifest's hashes do I not hold?", against the same content-hash identity,
 * so there is no second RULE that could drift. Deliberately NOT shared as source text the way
 * `kd-codec.js` and `kd-delta.js` are: those exist because a diff and its merge must agree exactly,
 * and there is no such pairing here.
 *
 * ── A BARE ASSIGNMENT, ON PURPOSE ─────────────────────────────────────────────────────────────────
 * `KDGetMods` is a bundle `let`-global and is NOT a property of `globalThis` (repo CLAUDE.md) —
 * `globalThis.KDGetMods = true` would create an unrelated property and latch nothing. This makes the
 * `INJECT` order load-bearing (this tag must come after `out/main.js`), which
 * `tests/unit/mp-mod-inject-order.spec.ts` pins.
 *
 * ── ALWAYS REACHES A TERMINAL STATE (R9) ──────────────────────────────────────────────────────────
 * `KDExecuteMods` swallows every per-file error into a `console.log` (`KDMods.ts:483-490`), so "it
 * worked" and "it half-worked" look identical from here. A latch that is set and then never followed
 * by an execution would leave the player with NO mods — strictly worse than doing nothing. So the
 * sequence settles a status in a `finally`, and a watchdog settles it even if the game's own async
 * never returns. A failed FETCH degrades rather than blocks: the session starts, and what is missing
 * is named.
 */
(function () {
	'use strict';

	/** How long to wait for the whole prepare/fetch/execute sequence before declaring it degraded. */
	var WATCHDOG_MS = 30000;

	var state = {
		/** 'pending' then 'executed' | 'nothing-to-do' | 'degraded' | 'off' */
		status: 'pending',
		latched: false,
		/** Zips in `KDMods` at execution time. */
		count: 0,
		/** This client's own declaration, as sent on `join`. */
		declaration: [],
		/** Host mods pulled in for this session. */
		fetched: [],
		/** Host mods we could NOT get — what R9 requires be named rather than left mysterious. */
		missing: [],
		error: '',
	};

	var settleReady;
	var ready = new Promise(function (r) { settleReady = r; });

	window.__coopMods = {
		status: function () { return state.status; },
		state: function () { return JSON.parse(JSON.stringify(state)); },
		ready: ready,
		/** True once the attempt has finished, however it finished. Never blocks the session. */
		done: function () { return state.status !== 'pending'; },
		/** This client's mod set, for the `join` handshake. Empty until `prepare()` has resolved. */
		declaration: function () { return state.declaration.slice(); },
		prepare: prepare,
		publish: publish,
		ensureExecuted: ensureExecuted,
	};

	// 1. the latch ------------------------------------------------------------------------------
	try {
		// Bare, NOT via globalThis — see the header. A throw here means the bundle is not in scope,
		// which is a broken page rather than a mod problem; we stand down rather than guess.
		KDGetMods = true;
		state.latched = true;
	} catch (e) {
		state.error = 'latch failed: ' + (e && e.message || e);
	}
	if (!state.latched) { settle('off'); return; }

	function settle(status) {
		if (state.status !== 'pending') return;   // first answer wins; the watchdog may lose the race
		state.status = status;
		try { settleReady(state); } catch (e) { /* nothing to do */ }
	}

	function note(msg) { if (!state.error) state.error = msg; }

	// helpers -----------------------------------------------------------------------------------

	/** Content hash of a zip. Identity is the BYTES: two players may hold one mod under two names. */
	function hashFile(file) {
		return file.arrayBuffer()
			.then(function (buf) { return crypto.subtle.digest('SHA-256', buf); })
			.then(function (digest) {
				var b = new Uint8Array(digest), out = '';
				for (var i = 0; i < b.length; i++) out += ('0' + b[i].toString(16)).slice(-2);
				return 'sha256:' + out;
			});
	}

	/** The zips this client holds, in KD's own execution order (priority DESC, KDMods.ts:311). */
	function ownZips() {
		var order = [];
		try { order = (KDModLoadOrder || []).slice(); } catch (e) { order = []; }
		if (!order.length) {
			// Nothing has built a load order yet; fall back to whatever is installed.
			try {
				order = Object.keys(KDMods || {}).map(function (n) { return { mod: KDMods[n], name: n }; });
			} catch (e) { order = []; }
		}
		return order.filter(function (ent) { return ent && ent.mod; });
	}

	// 3. prepare: local mods, then this client's declaration -------------------------------------

	var localLoaded = null;

	/**
	 * The IndexedDB read, done at most once — it is the slow part and its answer does not change.
	 *
	 * Gated on the player's own `AutoLoadMods` setting: that toggle is their answer to "load my mods
	 * for me", and co-op is not a reason to overrule it. What co-op DOES change is that whatever ends
	 * up in `KDMods` actually RUNS, which is the bypass this file exists for and is not a setting
	 * anyone opted out of.
	 */
	function loadLocalOnce() {
		if (localLoaded) return localLoaded;
		localLoaded = Promise.resolve()
			.then(function () {
				var auto = false;
				try { auto = !!(typeof KDToggles !== 'undefined' && KDToggles && KDToggles.AutoLoadMods); } catch (e) { /* off */ }
				if (!auto || typeof KDGetModsLoad !== 'function') return null;
				return KDGetModsLoad(false);   // populate KDMods from IndexedDB; do NOT execute yet
			})
			.catch(function (e) { note('local mod load failed: ' + (e && e.message || e)); });
		return localLoaded;
	}

	/**
	 * Re-describe whatever is in `KDMods` RIGHT NOW, and answer the fresh declaration.
	 *
	 * Deliberately NOT memoised, unlike the load above: a player may pick mods from the Mods menu
	 * after the page has loaded and before they host. A one-shot declaration computed at load would
	 * miss exactly those — and for a HOST that is not harmless staleness, because the session's mod
	 * set IS the host's declaration, so an out-of-date one silently means "this session has no mods".
	 */
	function prepare() {
		return loadLocalOnce()
			.then(function () {
				return Promise.all(ownZips().map(function (ent) {
					return hashFile(ent.mod).then(function (hash) {
						var info = {};
						try { info = (KDModInfo && KDModInfo[ent.name]) || {}; } catch (e) { info = {}; }
						return {
							name: ent.name,
							modname: info.modname || ent.name,
							modbuild: info.modbuild || '',
							priority: info.priority || 0,
							hash: hash,
						};
					});
				}));
			})
			.then(function (rows) { state.declaration = rows || []; })
			.catch(function (e) { note('could not describe local mods: ' + (e && e.message || e)); })
			.then(function () { return state.declaration.slice(); });
	}

	// 4. publish (host) -------------------------------------------------------------------------

	/**
	 * Upload this client's zips so a guest can fetch them, and answer the declaration that was
	 * uploaded. Content-addressed, so re-publishing is idempotent and a retry costs nothing.
	 *
	 * Best-effort: a failed upload is recorded but never blocks the host's own session, which needs
	 * nothing from the gateway's store.
	 */
	function publish(base) {
		return prepare().then(function (rows) {
			var byName = {};
			rows.forEach(function (r) { byName[r.name] = r.hash; });
			return Promise.all(ownZips().map(function (ent) {
				var hash = byName[ent.name];
				if (!hash) return null;
				return fetch(base + '/mp/mods/' + encodeURIComponent(hash), { method: 'POST', body: ent.mod })
					.catch(function (e) { note('could not publish ' + ent.name + ': ' + (e && e.message || e)); });
			})).then(function () { return rows; });
		});
	}

	// 5. fetch (guest) --------------------------------------------------------------------------

	function fetchHostMods(base) {
		var held = {};
		state.declaration.forEach(function (r) { held[r.hash] = true; });

		return fetch(base + '/mp/mods/manifest')
			.then(function (r) { return r.json(); })
			.then(function (m) {
				// "Which of the manifest's hashes do I not hold?" is the whole question. The manifest
				// arrives already normalised and in priority order from the gateway, so nothing here
				// re-sorts or re-labels it.
				var want = (m && m.mods || []).filter(function (row) { return row && row.hash && !held[row.hash]; });
				if (!want.length) return [];
				return Promise.all(want.map(function (row) {
					return fetch(base + '/mp/mods/' + encodeURIComponent(row.hash))
						.then(function (res) {
							if (!res.ok) throw new Error('HTTP ' + res.status);
							return res.blob();
						})
						.then(function (blob) {
							state.fetched.push(row.modname || row.name);
							return new File([blob], row.name || ((row.modname || 'mod') + '.zip'), { type: 'application/zip' });
						})
						.catch(function (e) {
							// R9 — a mod we could not get is NAMED, and the session goes on without it.
							state.missing.push(row.modname || row.name || row.hash);
							note('could not fetch ' + (row.modname || row.hash) + ': ' + (e && e.message || e));
							return null;
						});
				}));
			})
			.then(function (files) {
				var got = (files || []).filter(Boolean);
				if (!got.length) return null;
				// The STOCK install path (KDMods.ts:238), so assets and translations take the same
				// route as a locally-picked mod. Note it does NOT persist: `batchSaveMods` belongs to
				// the file picker alone, which is what keeps R8 true by construction.
				return KDLoadMod(got);
			});
	}

	// 2. execute --------------------------------------------------------------------------------

	var started = false;

	/**
	 * Prepare, optionally fetch the host's mods, then execute — once. Idempotent: the first call owns
	 * the attempt and every later one gets the same promise, so a retrying caller cannot start twice.
	 *
	 * `opts.fetchFrom` is the HOST's http origin. Absent for a host, and for the legacy `#coop=` path,
	 * where there is no host mod set to reconcile against.
	 */
	function ensureExecuted(opts) {
		if (started) return ready;
		started = true;

		// The watchdog settles the STATUS without waiting for the work to return. Ordered this way on
		// purpose: if KD's own `while (KDLoading) await sleep(100)` never resolves, awaiting it here
		// would mean the status never settles either, and the session would hang on a mod load.
		setTimeout(function () {
			if (state.status === 'pending') {
				note('timed out waiting for the game mod loader');
				settle('degraded');
			}
		}, WATCHDOG_MS);

		var from = opts && opts.fetchFrom;
		prepare()
			.then(function () { return from ? fetchHostMods(from) : null; })
			.catch(function (e) { note('mod sync failed: ' + (e && e.message || e)); })
			.then(function () {
				try { state.count = Object.keys(KDMods || {}).length; } catch (e) { state.count = 0; }
				if (typeof KDExecuteMods !== 'function') return null;
				// `KDExecuteMods` no-ops on an EMPTY load order without setting `KDExecuted`
				// (`KDMods.ts:351`), so calling it with nothing installed is free and leaves the latch
				// open for a later attempt. That is why there is no count check here.
				return KDExecuteMods();
			})
			.catch(function (e) { note('mod execution failed: ' + (e && e.message || e)); })
			.then(function () {
				if (state.error) return settle('degraded');
				settle(state.count > 0 ? 'executed' : 'nothing-to-do');
			});

		return ready;
	}

	// Describe the local mod set as soon as the bundle is up, so a declaration is ready whenever the
	// lobby sends `join`. Execution stays where it belongs, at session start.
	window.addEventListener('load', function () { prepare(); });
})();
