/**
 * tools/mp-server/headless-host.js
 *
 * Headless Node game host (KD-067 PoC scope). Boots the stock out/main.js inside
 * an isolated V8 context (vm) behind the shim layer, and exposes a small API:
 *   init(opts) · step(n) · getState() · serialize() · loadState(save) · eval(code)
 *
 * Isolation: each HeadlessHost owns its own vm.Context, so multiple instances
 * (a world instance + per-player instances) each get a private copy of every KD
 * `let`/`const` global. This is what makes the orchestrator + reconciler possible.
 *
 * Bridge: KD declares its globals as top-level `let` (script scope, not on the
 * global object). We append an `__KDEVAL` function to the SAME script as the
 * bundle so its closure can read/write those bindings — the Node analogue of
 * Playwright's page.evaluate(() => SomeGlobal).
 *
 * Zero edits to Game/src/** or Scripts/** (KD-067 invariant). The serverMode
 * flag (KD-068) is set via a bundle global from the orchestrator, not a source edit.
 */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHIMS_PATH = path.join(__dirname, 'shims.js');
const M4_PATH = path.join(REPO_ROOT, 'Scripts', 'lib', 'webgl', 'resources', 'm4.js');
const LZSTRING_PATH = path.join(REPO_ROOT, 'Scripts', 'lib', 'LZString.js');
const BUNDLE_PATH = path.join(REPO_ROOT, 'out', 'main.js');

/**
 * KDM-160: keys of KD's own save that describe the SHARED WORLD, not a player.
 *
 * `player = KinkyDungeonGenerateSaveData() - WORLD_KEYS` — the swap model keeps one authoritative
 * world and N players, and this is the subtraction that separates them. Deliberately short and
 * SEMANTIC: it changes only when the world model changes, which is far rarer than feature additions.
 * (Enumerating the *player* side instead is what produced the KDM-156 bug class — the player side is
 * large, growing and unknowable; the world side is small and stable.)
 */
const WORLD_KEYS = Object.freeze([
	'KDMapData',              // the map itself: grid, tiles, entities, fog
	'KDWorldMap',             // the world/floor graph
	'KDCurrentWorldSlot',     // which world slot is loaded
	'KinkyDungeonCurrentTick', // the shared lockstep clock
	'seed',                   // world generation seed
]);

/**
 * KDM-160: KDGameData keys that are FLOOR/WORLD scope rather than player scope.
 *
 * KDGameData is 221 keys and mixes both — in single-player the distinction does not exist (one
 * player, one world, one bag), so upstream has no reason to separate them. Everything NOT listed
 * here is treated as per-player.
 *
 * The default is deliberately per-player: a player field wrongly shared is exactly the contamination
 * bug class this epic exists to remove. Measured evidence: 86 of 123 probed primitive keys leaked
 * between players before this list existed (KDM-160 §A4).
 *
 * CRITERION for adding an entry — one of:
 *   (a) it is keyed by ENTITY ID (it describes world entities, not the player), or
 *   (b) it is floor/dungeon generation or population state, or
 *   (c) a failing test proves sharing is required.
 * Do NOT add entries speculatively: every one narrows per-player isolation, which is the property
 * this epic is buying.
 */
const KDGAMEDATA_WORLD_KEYS = Object.freeze([
	// (b) floor population / generation state
	'GuardTimer', 'GuardTimerMax', 'GuardSpawnTimer', 'GuardSpawnTimerMax', 'GuardSpawnTimerMin',
	'JailGuard', 'HunterTimer', 'Hunters',
	'NamesGenerated', 'Regiments', 'RegimentID',
	'KinkyDungeonSpawnJailers', 'KinkyDungeonSpawnJailersMax',
	'ChestsGenerated', 'PersistentNPCCache',
	// (a) NPC/avatar bondage, keyed by ENTITY ID (KDGetNPCRestraints / KDSetNPCRestraints,
	// NPCRestrain.ts:541/550). It describes world ENTITIES — including the peer avatars that PvP
	// ties are applied to — so it is world state under criterion (a), not player state.
	//
	// Honesty note: this entry was first added on the hypothesis that making it per-player caused an
	// e2e tie failure ("A should be bound after selecting the owned material"). That hypothesis was
	// TESTED AND DISPROVED — mp-pvp-tie-clicks and mp-pvp-tie-repeat pass in isolation both WITH and
	// WITHOUT this entry; those failures were full-suite contention flakes. It is kept purely on
	// criterion (a). No test currently pins it, so treat it as a reasoned classification rather than
	// a proven one.
	'NPCRestraints',
]);

/**
 * KDM-161: how many top-level bindings we expect to derive from the bundle.
 * Measured 2026-08-14: 2,254 `let` + 121 `const` + 6 `var` = 2,381 unique names.
 * A materially smaller number means the regex no longer matches upstream's output shape — that MUST
 * be loud, not silently degrade into "this player has almost no state" (same drift contract as
 * BUNDLE_PATCHES site counts in demo-server.js).
 */
const MIN_EXPECTED_GLOBALS = 2000;

/**
 * KDM-161: only globals whose JSON is at most this long are watched as per-player state.
 * Anything larger is a static data table (enemy/restraint/spell defs), i.e. shared world data — and
 * those are exactly what made an unbounded fingerprint pass slow (109 ms). Measured: every real
 * per-player global except KDGameData is under 2 KB, and KDGameData is carried by its own path.
 *
 * ⚠️ DO NOT lower this as a cost optimisation without re-measuring. It was tried: probe9 measured the
 * pass at 22.6 ms (MAX=20000) versus 12.8 ms (MAX=4096) and the 4 KB–20 KB band looked like nothing
 * but definition tables — so 4096 looked free. It is NOT. The threshold governs the RESET half of
 * _restoreGlobals as much as the capture half, and once the codec above made Maps visible, real Maps
 * landed in that band (KinkyDungeonOutfitCache 16 KB, KDFactionRelations 12 KB). Dropping them from
 * the watch set stops them being reset, so a player inherits the previous player's copy. That is the
 * contamination bug class this epic exists to remove — a 10 ms saving is not worth reopening it.
 *
 * The exclusion is not silent either way: _auditOversize() re-checks the excluded set and reports
 * anything that actually mutates.
 */
const BASELINE_MAX_LEN = 20000;

/**
 * KDM-161/KDM-195: how many captures between oversize audit SLICES (_auditOversize).
 *
 * It used to be one UNBOUNDED pass every 200 captures. Measured 2026-08-17: 22 globals / 5.53 MB,
 * one pass 59-90 ms — a synchronous stall of a single-threaded server that is already the bottleneck,
 * every ~3.3 s at the observed ~60 captures/s. The audit is now a time-budgeted round-robin: each
 * invocation resumes at a cursor and hashes names until OVERSIZE_AUDIT_BUDGET_MS is spent.
 *
 * MEASURED after the change (quiet host, 21 globals): a full cycle is 7 slices / ~82 ms, per-slice
 * 6.8, 36.7, 3.5, 4.0, 8.7, 15.6, 6.3 ms — median 6.8, worst 36.7. 30 captures between slices puts a
 * cycle at ~210 captures: the same coverage latency and the same amortised cost as the old 90 ms/200,
 * with the single 90 ms stall replaced by a ~7 ms median one. The worst slice is still ~37 ms because
 * ModelDefs (1878 KB) is ONE name and a time budget cannot split it — see KDM-194.
 *
 * `_auditOversize(true)` still runs a COMPLETE pass, ignoring the budget — that is the diagnostic and
 * test entry point, never the request path.
 */
const OVERSIZE_AUDIT_EVERY = 30;

/**
 * KDM-195: wall-clock budget, inside the vm, for ONE audit slice.
 *
 * The budget is checked AFTER each name, so a slice always hashes at least one — the true worst case
 * is therefore the single largest oversize global, not this number. Measured with this budget: slices
 * of 2-5 names, median ~7 ms, worst ~37 ms (the slice that contains ModelDefs, 1878 KB). Splitting one
 * global into sub-chunks would bound that too, at the cost of per-chunk baseline hashes; not worth it
 * until it shows up in a measurement of the real path — see KDM-194.
 */
const OVERSIZE_AUDIT_BUDGET_MS = 4;

/**
 * KDM-195: the ONE definition of the divergence hash, shared by every vm payload that needs it.
 *
 * It is a source string rather than a function because these payloads run inside the bundle's own
 * `vm.Context` — nothing from this module is in scope there. It was copy-pasted into four payloads
 * (baseline, capture, oversize audit, restore); a hash that drifts between the pass that WRITES a
 * baseline and the pass that COMPARES against it would silently report everything as changed.
 */
const KD_HASH_FN = 'function hash(s){ var x = 5381, i = s.length; while (i) { x = (x*33) ^ s.charCodeAt(--i); } return x>>>0; }';

/**
 * KDM-161: globals that are NOT per-player, by CATEGORY (never per feature — a per-feature entry
 * here would rebuild the whitelist under a new name). Everything not listed is per-player.
 */
const GLOBAL_BLACKLIST = Object.freeze([
	// --- shared world: the dungeon and its inhabitants -----------------------
	'KDMapData', 'KDMapExtraData', 'KDWorldMap', 'KDCurrentWorldSlot',
	'KinkyDungeonCurrentTick', 'KinkyDungeonEnemyID', 'KinkyDungeonSpellID',
	'AIData', 'KDAwareEnemies', 'KDEnemiesTargetingPlayer', 'KDPathfindingCacheFails',
	'KDPathfindingCacheHits', 'KDPathCache', 'KDUpdateEnemyCache',
	// Derived lookup caches over the world's ENTITIES — same category as KDPathCache above, and the
	// same criterion (a) as KDGAMEDATA_WORLD_KEYS' entity-keyed entries: they describe world entities,
	// not a player. They only became visible when KDM-161 taught the capture layer about Map, and they
	// are emphatically NOT per-player: MEASURED, resetting them on swap-in wiped the enemy lookup, so
	// a PvP bump-attack landed once and then stopped doing damage (mp-pvp-realcombat, -bind-reconcile,
	// -defeat-recovery all went red). KDEnemiesCache alone is 400 KB after one turn.
	// The enemy DEFINITION table — the templates every entity's `.Enemy` points at, not any entity's
	// state. Same category as the entity caches above, and KDM-195 settled it with evidence rather
	// than argument: the audit reported it CHANGED on every pass, and the writer turned out to be
	// OURS. `spawnAvatar` pushes a `RemotePlayer_<peer>` def clone into it (measured: 337 → 338 defs)
	// so the peer avatar renders as a real character. That is world content shared by both players —
	// proven, not assumed: the def appears in NO player bundle, and it survives swapping the other
	// player in. Excluded before this only by its 386 KB size, which meant a one-time append warned
	// forever (the audit never re-baselines) while costing 3.9 ms of every audit.
	'KinkyDungeonEnemies',
	'KDEnemiesCache', 'KDEnemyCache', 'KDEnemyEventCache', 'KDIDCache', 'KDEntityFlagCache',
	'KDEntityRestraintMetadata', 'KDThoughtBubbles',
	'KDBuffedStatTypeMemo', 'KDBuffedStatTypeMemoUpdate',
	// --- render / dirty flags: the server has no screen ----------------------
	// KDM-186: KDDamageQueue belongs HERE, and its absence was a real bug. It is a CONSUME-ONCE
	// presentation queue drained by `KinkyDungeonDrawFight` (KinkyDungeonFight.ts:3368) — the draw
	// emits a floater per entry and splices it out. The server has no draw loop, so it never drained
	// it; the generic capture then replicated the stale entries as ordinary state and EVERY snapshot
	// re-delivered them. Measured in UAT: one hit produced a floater per snapshot for as long as
	// snapshots kept arriving (i.e. while the mouse moved), and stopped the moment they did.
	// Presentation-only state is not authoritative state and must not be replicated; what the player
	// needs to be TOLD travels as a sequenced EVENT instead (SwapSession `pendingEvents`).
	'KDDamageQueue',
	'KDDrawUpdate', 'KDVisionUpdate', 'KDUpdateChokes', 'KDAlertCD',
	'lastFloaterRefresh', 'KDParticleid', 'KDCurrentModels', 'KDRefreshCharacter',
	// --- client audio: neither player nor world ------------------------------
	'KDMusicToast', 'KDMusicUpdateTime',
	// --- already managed per-player by swap-session (do NOT double-manage) ---
	'KinkyDungeonMessageLog', 'KinkyDungeonFloaters',
	// --- carried by its OWN path, not by divergence (KDM-161 D7) -------------
	// KDGameData is the one global no mechanical rule can classify: 221 keys mixing per-player
	// (Guilt, ShieldTokens, RevealedFog) with world (GuardSpawnTimer, JailGuard, ChestsGenerated).
	// KDM-160 inverted it — capture whole, restore whole minus KDGAMEDATA_WORLD_KEYS — which is a
	// semantic subtraction, not a whitelist. It is also 27 KB (JourneyMap alone is 21 KB), so the
	// divergence path would exclude it on size anyway. Listed here so that exclusion is a DECISION.
	'KDGameData',
	// --- debug noise ---------------------------------------------------------
	'KDRestraintDebugLog',
]);

/**
 * KDM-161: a tagged codec for the values plain JSON silently destroys.
 *
 * `JSON.stringify(new Map())` is `"{}"`. KD uses Maps heavily for per-player state
 * (KinkyDungeonInventory is a Map of Maps; KinkyDungeonFlags, KinkyDungeonStatsChoice), so without
 * this those globals are watched but can NEVER appear diverged from baseline — they were invisible to
 * the generic layer and rode entirely on the hand-written whitelist. This is what unblocks AC1.
 *
 * ⚠️ Applied at the TOP LEVEL ONLY — `v instanceof Map || v instanceof Set`, never to every value.
 * MEASURED (probes/probe9.js): running the encoder over all ~2,300 watched globals costs 320 ms per
 * pass versus 23 ms, because it deep-clones every object before serialising. The cheap version is
 * sound because the only globals holding a Map NESTED inside a plain object are `textProvider`, `PIXI`
 * and `document` — render infrastructure, none of it player state. `kdEnc` itself stays recursive, so
 * Maps inside Maps (the inventory) still work.
 *
 * A consequence worth relying on: a `__kdT` tag can only ever appear at the top level of a captured
 * value, so restore can test for it in O(1) instead of walking every global.
 */
// KDM-162: the codec moved to its own module — the BROWSER thin client needs the same decoder to
// adopt a state bundle, and two hand-kept copies in two runtimes is the drift this epic deletes.
const { KD_CODEC } = require('./kd-codec');

/**
 * KD-088 entity re-resolution + the dispatch call, shared by applyInput and applyInputObserved
 * (KDM-163). The thin client cannot ship live entity object refs, so it sends {__kdEnt:id} (or
 * {__kdEnt:'player'}); these are replaced with THIS world's authoritative entities before dispatch.
 *
 * One copy on purpose: the probed and unprobed paths must dispatch IDENTICALLY, or the classification
 * the probe reports would not describe what the real apply does.
 */
const KD_ENT_RESOLVE = `
	function resolve(o){
		if (!o || typeof o !== 'object') return o;
		if (o.__kdEnt !== undefined) {
			return (o.__kdEnt === 'player') ? KinkyDungeonPlayerEntity
				: (typeof KinkyDungeonFindID === 'function' ? KinkyDungeonFindID(o.__kdEnt) : undefined);
		}
		if (Array.isArray(o)) { for (var i=0;i<o.length;i++) o[i] = resolve(o[i]); return o; }
		for (var k in o) if (Object.prototype.hasOwnProperty.call(o,k)) o[k] = resolve(o[k]);
		return o;
	}
	function __kdDispatch(type){
		var d = resolve(globalThis.__KD_INDATA);
		if (typeof KDSendInput === 'function') return KDSendInput(type, d);
		if (typeof KDProcessInput === 'function') return KDProcessInput(type, d);
		return null;
	}
`;

/** Sandbox/host bindings that must never be captured or reassigned. */
const HOST_RESERVED = new Set([
	'globalThis', 'window', 'self', 'top', 'parent', 'console', 'process', 'require',
	'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
	'TextEncoder', 'TextDecoder', 'structuredClone', 'AbortController', 'AbortSignal',
	'Intl', 'Buffer', 'URL', 'URLSearchParams', 'LZString', 'm4', 'PIXIapp',
]);

/**
 * KDM-161: derive the bundle's top-level binding NAMES from its source.
 *
 * KD declares its globals as top-level `let`/`var` in SCRIPT scope, so they are not properties of
 * globalThis and `Object.keys(globalThis)` cannot see them — a reflective "capture every global" is
 * impossible. The names, however, are derivable: tsc output is unminified with declarations at
 * column 0, so an anchored regex suffices (no JS parser needed).
 *
 * This is text coupling to out/main.js, accepted under the plugin rule as a last resort and mitigated
 * by the drift assertion (`opts.assert`).
 */
function deriveBundleGlobals(src, opts = {}) {
	const text = (src != null) ? src : loadSources().bundle;
	const names = [];
	const seen = new Set();
	const re = /^(?:let|var|const)\s+([A-Za-z_$][\w$]*)/gm;
	let m;
	while ((m = re.exec(text)) !== null) {
		if (!seen.has(m[1])) { seen.add(m[1]); names.push(m[1]); }
	}
	if (opts.assert && names.length < MIN_EXPECTED_GLOBALS) {
		throw new Error(
			`[KDM-161] bundle-global DRIFT: derived ${names.length} top-level names, expected at least ` +
			`${MIN_EXPECTED_GLOBALS}. The declaration shape of out/main.js has changed — per-player state ` +
			`capture would silently lose almost everything. Fix the regex in deriveBundleGlobals().`);
	}
	return names;
}

let _cachedSources = null;
function loadSources() {
	if (_cachedSources) return _cachedSources;
	_cachedSources = {
		shims: fs.readFileSync(SHIMS_PATH, 'utf8'),
		m4: fs.readFileSync(M4_PATH, 'utf8'),
		lzstring: fs.readFileSync(LZSTRING_PATH, 'utf8'),
		bundle: fs.readFileSync(BUNDLE_PATH, 'utf8'),
	};
	return _cachedSources;
}

let _instanceCounter = 0;

class HeadlessHost {
	constructor(opts = {}) {
		this.id = opts.id || `host-${++_instanceCounter}`;
		this.errors = [];
		this._booted = false;
		this._context = null;
		this.serverMode = 'world';        // 'world' runs shared-entity AI; 'player' suppresses it
		// Reconciler-side shadow state: a thin (player) instance's authoritative-
		// from-world view of shared entities. The world instance owns the real
		// enemy in KDMapData.Entities; players reflect it here.
		this.shadowEnemy = null;          // { id, x, y, hp, name }
		this.avatars = {};                // avatarId -> { x, y } (other players' positions)
	}

	/**
	 * Boot the bundle in a fresh isolated context. Idempotent-guarded.
	 * Throws if the bundle fails to evaluate.
	 */
	boot() {
		if (this._booted) return this;
		const src = loadSources();

		// --- sandbox: context globals that are NOT V8 per-context intrinsics ---
		const errors = this.errors;
		const sandbox = {
			console: {
				log: (...a) => {},                 // suppress bundle chatter by default
				info: () => {}, debug: () => {}, warn: () => {},
				error: (...a) => { errors.push(a.map(String).join(' ')); },
			},
			// NOTE: deliberately do NOT inject JS language intrinsics (String, Array,
			// Object, Promise, typed arrays, …). The bundle monkey-patches prototypes
			// (e.g. String.prototype.replaceAt); those patches must land on the
			// context's own intrinsics so they match the context's string/array
			// literals. Injecting host intrinsics breaks that (cross-realm).
			// Only host-provided web/node APIs go in.
			setTimeout, clearTimeout, setInterval, clearInterval,
			queueMicrotask,
			require,                                 // host require (crypto, url …)
			TextEncoder, TextDecoder,
			structuredClone: (typeof structuredClone === 'function') ? structuredClone : (x) => JSON.parse(JSON.stringify(x)),
			AbortController, AbortSignal,
			Intl, Buffer, URL, URLSearchParams,
			__KD_REPO_ROOT: REPO_ROOT,            // used by shim fetch (local file reads)
			process: { env: {}, platform: process.platform, nextTick: (cb) => queueMicrotask(cb) },
		};
		sandbox.globalThis = sandbox;
		sandbox.window = sandbox;
		sandbox.self = sandbox;
		sandbox.top = sandbox;
		sandbox.parent = sandbox;
		this._context = vm.createContext(sandbox, { name: this.id });

		const run = (code, filename) => {
			vm.runInContext(code, this._context, { filename, displayErrors: true });
		};

		// 1) shims — install PIXI/DOM/browser stubs onto the context global.
		run(
			`var __m = { exports: {} };\n` +
			`(function(module, exports){\n${src.shims}\n})(__m, __m.exports);\n` +
			`__m.exports.install();`,
			'shims.js'
		);

		// 2) real m4 (sets globalThis.m4 via this.m4 = …)
		run(src.m4, 'm4.js');

		// 3) real LZString — expose to the context global for the bundle.
		run(src.lzstring + '\n;globalThis.LZString = LZString;', 'LZString.js');

		// 4) the bundle + the eval bridge (same script scope → bridge sees KD lets).
		run(
			src.bundle +
			'\n;globalThis.__KDEVAL = function(__code){ return eval(__code); };',
			'main.js'
		);

		this._booted = true;
		this._neuterRendering();
		this._installServerRoleShim();
		return this;
	}

	/**
	 * Server-authoritative role flag + shared-entity AI suppression — installed as a
	 * RUNTIME monkey-patch (mod-style reassignment, same pattern as _neuterRendering),
	 * NOT a game-source edit (KD-085 restored zero source edits; KD-068's source flag
	 * was reverted). Roles:
	 *   ""       → single-player / offline (default; AI runs normally — byte-identical).
	 *   "world"  → this instance OWNS + simulates the shared entities (full AI).
	 *   "player" → remote-player view; shared-entity AI suppressed (driven by the world).
	 *   "client" → thin render-only browser client (set browser-side, never here).
	 * Set at runtime via setServerMode; the offline game never sets it, so it stays "".
	 */
	_installServerRoleShim() {
		this.eval(`(function(){
			// Create the role global as a globalThis property (the source 'let' was
			// reverted) so later bare reads/assignments (setServerMode) resolve in the
			// bundle's strict realm instead of throwing ReferenceError.
			if (typeof KDServerRole === 'undefined') globalThis.KDServerRole = '';
			if (typeof KinkyDungeonUpdateEnemies === 'function' && !KinkyDungeonUpdateEnemies.__kdRoleShim) {
				var _u = KinkyDungeonUpdateEnemies;
				KinkyDungeonUpdateEnemies = function(){
					// player-role instances do not own shared entities — skip the local AI.
					if (KDServerRole === 'player') return;
					return _u.apply(this, arguments);
				};
				KinkyDungeonUpdateEnemies.__kdRoleShim = true;
			}
		})()`);
	}

	/**
	 * Replace heavy rendering entry points with no-ops. KD functions are
	 * reassignable globals (the mod system relies on this — see KDMods), so this
	 * is a runtime override, NOT a source edit. The headless sim needs game logic,
	 * never pixels. Add names here as boot/init surfaces new render calls.
	 */
	_neuterRendering() {
		const noops = [
			'DrawCharacter', 'DrawCharacterModels', 'DrawModelProcessPoses',
			'KinkyDungeonDressPlayer', 'KDDrawPlayer',
		];
		const stub = noops
			.map((fn) => `if (typeof ${fn} === 'function') ${fn} = function(){ return undefined; };`)
			.join('\n');
		this.eval(stub);
	}

	/** Evaluate code inside the bundle's script scope. Returns the value. */
	eval(code) {
		if (!this._booted) throw new Error(`[${this.id}] not booted`);
		const fn = this._context.__KDEVAL;
		if (typeof fn !== 'function') throw new Error(`[${this.id}] eval bridge missing`);
		return fn(code);
	}

	/** Read the current global turn counter. */
	tick() { return this.eval('KinkyDungeonCurrentTick'); }

	// ----- message log (KD-090: per-player log composition) --------------------

	/** Length of the world message log (KinkyDungeonMessageLog). */
	messageLogLength() {
		return this.eval('(typeof KinkyDungeonMessageLog !== "undefined" && KinkyDungeonMessageLog) ? KinkyDungeonMessageLog.length : 0');
	}

	/** A JSON-safe clone of the world message log. */
	messageLog() {
		return this.eval('(function(){ var L=(typeof KinkyDungeonMessageLog!=="undefined"&&KinkyDungeonMessageLog)?KinkyDungeonMessageLog:[]; try{return JSON.parse(JSON.stringify(L));}catch(e){return [];} })()');
	}

	/** The message-log entries appended at/after index n (the delta since a marker). */
	messagesSince(n) {
		return this.eval(`(function(){ var L=(typeof KinkyDungeonMessageLog!=="undefined"&&KinkyDungeonMessageLog)?KinkyDungeonMessageLog:[]; try{return JSON.parse(JSON.stringify(L.slice(${n | 0})));}catch(e){return [];} })()`);
	}

	/**
	 * Push a combat-feedback line through KD's REAL message API (KD-098). Reuses
	 * `KinkyDungeonSendTextMessage` so the entry has the same shape/styling as any in-game
	 * message (and sets the floating `KinkyDungeonActionMessage`), then returns the produced
	 * log entry so the caller can route it to the right player's personal log. NOT a fake
	 * string injection — the game's own messaging code runs. Used for PvP hit feedback, which
	 * the silent `KinkyDungeonDealDamage` path never emits on its own.
	 */
	sendFeedback(text, color, priority) {
		return this.eval(`(function(){
			var before = (typeof KinkyDungeonMessageLog!=="undefined"&&KinkyDungeonMessageLog)?KinkyDungeonMessageLog.length:0;
			if (typeof KinkyDungeonSendTextMessage === 'function') {
				KinkyDungeonSendTextMessage(${priority | 0} || 10, ${JSON.stringify(String(text))}, ${JSON.stringify(String(color || '#ff5555'))}, 2);
			}
			var L = (typeof KinkyDungeonMessageLog!=="undefined"&&KinkyDungeonMessageLog)?KinkyDungeonMessageLog:[];
			var added = L.slice(before);
			try { return JSON.parse(JSON.stringify({ entries: added, action: ${JSON.stringify(String(text))} })); } catch(e) { return { entries: [], action: '' }; }
		})()`);
	}

	/** A spell's AOE footprint + damage as data (KD-096 friendly-fire): {aoe,power,type}. */
	getSpellInfo(name) {
		return this.eval(`(function(){
			var sp = (typeof KinkyDungeonFindSpell === 'function') ? KinkyDungeonFindSpell(${JSON.stringify(name)}, true) : null;
			if (!sp) return null;
			return {
				aoe: (typeof sp.aoe === 'number') ? sp.aoe : ((typeof sp.size === 'number') ? sp.size : 0),
				power: (typeof sp.power === 'number') ? sp.power : 0,
				type: (typeof sp.damage === 'string') ? sp.damage : 'pain',
			};
		})()`);
	}

	/** The current dungeon floor (MiniGameKinkyDungeonLevel). A change is a party-wide event. */
	getLevel() {
		return this.eval('(typeof MiniGameKinkyDungeonLevel !== "undefined") ? MiniGameKinkyDungeonLevel : 0');
	}

	/**
	 * The swapped-in player's movement slow-level, RE-DERIVED from their worn restraints
	 * (KD-093 self-heal proof): runs the real `KinkyDungeonCalculateSlowLevel` (reads
	 * `KinkyDungeonAllRestraint()`) then returns `KinkyDungeonSlowLevel`. >0 ⇒ bound/slowed.
	 */
	playerSlowLevel() {
		return this.eval('(function(){ if (typeof KinkyDungeonCalculateSlowLevel === "function") KinkyDungeonCalculateSlowLevel(0); return (typeof KinkyDungeonSlowLevel !== "undefined") ? KinkyDungeonSlowLevel : 0; })()');
	}

	/**
	 * Compute the CURRENTLY swapped-in player's outgoing weapon attack as data (KD-092 PvP):
	 * runs the real `KinkyDungeonGetPlayerWeaponDamage` so perks/bondage penalties apply, and
	 * returns a plain {damage,type,bind,bindType} that can be applied to another player's bundle.
	 */
	computePlayerAttack() {
		return this.eval(`(function(){
			var w = (typeof KinkyDungeonGetPlayerWeaponDamage === 'function') ? KinkyDungeonGetPlayerWeaponDamage(true) : null;
			if (!w && typeof KinkyDungeonPlayerDamage !== 'undefined') w = KinkyDungeonPlayerDamage;
			return {
				damage: (w && typeof w.damage === 'number') ? w.damage : 1,
				type: (w && w.type) ? w.type : 'unarmed',
				bind: (w && typeof w.bind === 'number') ? w.bind : 0,
				bindType: (w && w.bindType) ? w.bindType : 'Leather',
			};
		})()`);
	}

	/**
	 * Initialise a game on a hardcoded scenario. Mirrors the bundle's own
	 * new-game path used by the Playwright fixtures.
	 * @param {object} opts { level=1, seed }
	 */
	init(opts = {}) {
		// Browser does this via window.onload → KinkyDungeonLoad → KDReloadMainData,
		// which creates the BC player character (KinkyDungeonPlayer). Headless must
		// trigger it explicitly first.
		this.eval('typeof KDReloadMainData === "function" && KDReloadMainData(true)');
		this.eval("MiniGameKinkyDungeonCheckpoint = 'grv'");
		// Optional fixed seed → identical map generation across instances (shared
		// map for the PoC). Set after KDReloadMainData (which randomizes) and before
		// the map is generated inside StartNewGame.
		if (opts.seed != null) this.eval(`KDsetSeed(${JSON.stringify(String(opts.seed))})`);
		// KinkyDungeonStartNewGame is the real new-game entry: it calls
		// KinkyDungeonInitialize AND KinkyDungeonCreateMap (which fills the dungeon
		// Grid). The Playwright fixtures call the bare Initialize (empty map — fine
		// for faction/save tests), but the sim PoC needs a real generated map.
		this.eval('KinkyDungeonStartNewGame(false)');
		this.eval('typeof KinkyDungeonInitReputation === "function" && KinkyDungeonInitReputation()');
		this.eval('typeof KDInitPerks === "function" && KDInitPerks()');
		this.eval('typeof KDSyncLocalPlayerSlot === "function" && KDSyncLocalPlayerSlot()');
		this.setServerMode(this.serverMode);
		// KDM-161: record the post-init fingerprint. Anything that diverges from it later is mutable,
		// hence a per-player state candidate — this is what lets an unknown feature or mod be captured
		// without anyone adding it to a list. Must happen AFTER the data tables are loaded and BEFORE
		// any gameplay, so "differs from baseline" means "gameplay touched it".
		this._captureBaseline();
		return this;
	}

	/** Advance n turns of game time. */
	step(n = 1) {
		for (let i = 0; i < n; i++) this.eval('KinkyDungeonAdvanceTime(1)');
		return this.tick();
	}

	// ----- serverMode (KD-068 PoC scope) ---------------------------------------

	/**
	 * Gate shared-entity (enemy) AI via the real KD-068 source flag `KDServerRole`.
	 * 'world' instances run the AI; 'player' instances suppress it (the in-engine
	 * guard at the top of KinkyDungeonUpdateEnemies returns early when role==='player').
	 * This replaces the PoC's mod-style function-reassignment with the production flag.
	 */
	setServerMode(mode) {
		this.serverMode = (mode === 'player') ? 'player' : 'world';
		this.eval(`KDServerRole = ${JSON.stringify(this.serverMode)};`);
		return this.serverMode;
	}

	/** Current server role as the engine sees it. */
	getServerRole() {
		return this.eval('typeof KDServerRole !== "undefined" ? KDServerRole : null');
	}

	/** True if this instance runs shared-entity AI (world role; flag not 'player'). */
	runsEnemyAI() {
		return this.eval('typeof KDServerRole !== "undefined" && KDServerRole !== "player"');
	}

	// ----- scenario / gameplay helpers -----------------------------------------

	/** Find the most-open movable tile (deterministic given the map). */
	findOpenTile() {
		return this.eval(`(function(){
			var W=KDMapData.GridWidth,H=KDMapData.GridHeight,mv=KinkyDungeonMovableTilesEnemy;
			function ok(x,y){return mv.indexOf(KinkyDungeonMapGet(x,y))>=0;}
			var best=null,bestc=-1;
			for(var y=1;y<H-1;y++)for(var x=1;x<W-1;x++){
				if(!ok(x,y))continue;
				var c=0;for(var dx=-2;dx<=2;dx++)for(var dy=-2;dy<=2;dy++)if(ok(x+dx,y+dy))c++;
				if(c>bestc){bestc=c;best={x:x,y:y};}
			}
			return best;
		})()`);
	}

	/** Is (x,y) a movable tile for the player/enemy? */
	isMovable(x, y) {
		return this.eval(`KinkyDungeonMovableTilesEnemy.indexOf(KinkyDungeonMapGet(${x|0}, ${y|0})) >= 0`);
	}

	/** Place this instance's own player avatar. */
	placePlayer(x, y) {
		this.eval(`(function(){
			KinkyDungeonPlayerEntity.x=${x|0}; KinkyDungeonPlayerEntity.y=${y|0};
			KinkyDungeonTargetX=${x|0}; KinkyDungeonTargetY=${y|0};
		})()`);
		return this.getPlayerPos();
	}

	getPlayerPos() {
		return this.eval('({ x: KinkyDungeonPlayerEntity.x, y: KinkyDungeonPlayerEntity.y, hp: KinkyDungeonPlayerEntity.hp })');
	}

	/**
	 * Apply a movement delta to this player's avatar. Clamps to a movable tile
	 * (stays put if blocked). Deterministic — used as a player's submitted action.
	 */
	applyMove(dx, dy) {
		return this.eval(`(function(){
			var nx=KinkyDungeonPlayerEntity.x+${dx|0}, ny=KinkyDungeonPlayerEntity.y+${dy|0};
			if (KinkyDungeonMovableTilesEnemy.indexOf(KinkyDungeonMapGet(nx,ny))>=0) {
				KinkyDungeonPlayerEntity.x=nx; KinkyDungeonPlayerEntity.y=ny;
				KinkyDungeonTargetX=nx; KinkyDungeonTargetY=ny;
			}
			return { x: KinkyDungeonPlayerEntity.x, y: KinkyDungeonPlayerEntity.y };
		})()`);
	}

	/** Summon a real enemy (world instance). Returns its snapshot. */
	summonEnemy(x, y, type = 'Rat', opts = {}) {
		const rad = opts.rad || 4;
		return this.eval(`(function(){
			var before=KDMapData.Entities.length;
			KinkyDungeonSummonEnemy(${x|0}, ${y|0}, ${JSON.stringify(type)}, 1, ${rad|0}, false, undefined, false, true, "Beast", true, 1, true, true, undefined, true);
			var e=KDMapData.Entities[KDMapData.Entities.length-1];
			return e ? { id:e.id, x:e.x, y:e.y, hp:e.hp, name:e.Enemy&&e.Enemy.name } : null;
		})()`);
	}

	/** Snapshot the real enemy (world instance) by index. */
	getRealEnemy(index = 0) {
		return this.eval(`(function(){ var e=KDMapData.Entities[${index|0}]; return e ? { id:e.id, x:e.x, y:e.y, hp:e.hp, name:e.Enemy&&e.Enemy.name } : null; })()`);
	}

	/** Point the world enemy's pathing target at (x,y) — used to chase an avatar. */
	setEnemyTarget(x, y) {
		this.eval(`(function(){ KinkyDungeonTargetX=${x|0}; KinkyDungeonTargetY=${y|0};
			if (KDMapData.Entities[0]) { KDMapData.Entities[0].gx=${x|0}; KDMapData.Entities[0].gy=${y|0}; KDMapData.Entities[0].aware=true; } })()`);
	}

	// ----- reconciler surface (player instance) --------------------------------

	/** Reconciler push: world enemy state → this thin instance's view. */
	injectEnemyState(snapshot) {
		this.shadowEnemy = snapshot ? { ...snapshot } : null;
		return this.shadowEnemy;
	}

	/** This instance's authoritative enemy view (real for world, shadow for player). */
	getEnemyView() {
		if (this.serverMode === 'world') return this.getRealEnemy(0);
		return this.shadowEnemy;
	}

	/** Reconciler push: another player's avatar position → this instance's view. */
	upsertAvatar(avatarId, x, y) {
		this.avatars[avatarId] = { x: x | 0, y: y | 0 };
		return this.avatars[avatarId];
	}

	getAvatar(avatarId) {
		return this.avatars[avatarId] || null;
	}

	// ----- features: PvP + server-side mods (KD-080) ---------------------------

	/**
	 * Load a mod's code into this instance — the same path the production loader
	 * uses (`eval(res)` at KDMods.ts:483) and the test mod-injector
	 * (tests/helpers/mod-injector.ts). Runs in the bundle's scope via the bridge,
	 * so the mod can push to KD globals (e.g. KinkyDungeonEnemies). No source edit.
	 */
	loadMod(code) {
		this.eval(code);
		// KDM-161: a mod introduces NEW globals, and its freshly-initialised values are the world's new
		// per-player DEFAULTS. Without re-baselining, those names have no default to reset to, so a
		// player who never touched the mod's state would inherit the previous player's value — the mod
		// would silently be shared instead of per-player. Re-baselining is also what puts the mod's
		// globals into the candidate set in the first place.
		//
		// Ordering note: SwapSession loads mods at _start, right after init and before any player has
		// diverged, so the captured values are true defaults. A mod loaded MID-session re-baselines
		// against whoever is currently swapped in; that is an accepted edge case, not the normal path.
		if (this._baseline) this._captureBaseline();
		return { ok: true };
	}

	/** Look up an enemy definition by name (used to verify a mod took effect). */
	getEnemyByName(name) {
		return this.eval(`(function(){
			var e = (typeof KinkyDungeonGetEnemyByName === 'function') ? KinkyDungeonGetEnemyByName(${JSON.stringify(name)}) : null;
			return e ? { name: e.name } : null;
		})()`);
	}

	/**
	 * The PvP observation surface. Player `hp` is cosmetic; real effects land on
	 * the stat globals (Will/Stamina/Distraction) and the restraint list.
	 */
	getVitals() {
		return this.eval(`(function(){ return {
			hp: KinkyDungeonPlayerEntity ? KinkyDungeonPlayerEntity.hp : null,
			stamina: (typeof KinkyDungeonStatStamina !== 'undefined') ? KinkyDungeonStatStamina : null,
			will: (typeof KinkyDungeonStatWill !== 'undefined') ? KinkyDungeonStatWill : null,
			willMax: (typeof KinkyDungeonStatWillMax !== 'undefined') ? KinkyDungeonStatWillMax : null,
			distraction: (typeof KinkyDungeonStatDistraction !== 'undefined') ? KinkyDungeonStatDistraction : null,
			restraints: (typeof KinkyDungeonAllRestraint === 'function') ? KinkyDungeonAllRestraint().length : null,
			// KDM-199: the peer state a STAND-IN avatar must mirror, so KD own gate can read it.
			// All three are the GAME computing them for the swapped-in player; none is a rule of ours.
			disabled: (typeof KDPlayerIsDisabled === "function") ? !!KDPlayerIsDisabled() : null,
			stunTurns: (typeof KinkyDungeonFlags !== "undefined" && KinkyDungeonFlags && KinkyDungeonFlags.get)
				? (KinkyDungeonFlags.get("playerStun") || 0) : 0,
			// Real worn bondage, summed from the GAME per-item power. No scale invented here.
			bondage: (function(){ try {
				var all = (typeof KinkyDungeonAllRestraint === "function") ? KinkyDungeonAllRestraint() : [];
				var t = 0;
				for (var i = 0; i < all.length; i++) {
					var r = (typeof KDRestraint === "function") ? KDRestraint(all[i]) : null;
					t += (r && r.power) || 0;
				}
				return t;
			} catch (e) { return 0; } })(),
		}; })()`);
	}

	/**
	 * KDM-164: record every hit the game lands on a peer AVATAR, with the damage info the game itself
	 * produced — `{damage, type}` — so the victim can take it through KD's own player pipeline instead
	 * of us converting avatar hp into Will by hand.
	 *
	 * Measured (KDM-164 POC): the real chain is
	 * `KinkyDungeonMove → KDDoAttack → KinkyDungeonAttackEnemy → KinkyDungeonDamageEnemy → KDDamageEnemy`,
	 * the damageInfo arrives intact WITH its type, and the call is NOT inside `KinkyDungeonEnemyLoop`
	 * (so this wrap is not re-entrant with KD's enemy iteration).
	 *
	 * ⚠️ The tally lives ON THE WRAPPER FUNCTION, not in a global. `restorePlayer` resets globals to
	 * their post-init baseline on every swap, which would silently empty a global tally and make a live
	 * wrap look as if it had never fired.
	 */
	installPeerDamageRecorder() {
		return this.eval(`(function(){
			if (KinkyDungeonDamageEnemy.__kdPeerRec) return { ok: true, already: true };
			var _dmg = KinkyDungeonDamageEnemy;
			KinkyDungeonDamageEnemy = function (E, D) {
				var nm = (E && E.Enemy && E.Enemy.name) || '';
				if (D && E && E.id != null && nm.indexOf('RemotePlayer') === 0) {
					var w = KinkyDungeonDamageEnemy;
					if (!w.__hits) w.__hits = {};
					if (!w.__hits[E.id]) w.__hits[E.id] = [];
					w.__hits[E.id].push({ damage: Number(D.damage) || 0, type: D.type || 'pain' });
				}
				return _dmg.apply(this, arguments);
			};
			KinkyDungeonDamageEnemy.__kdPeerRec = 1;
			KinkyDungeonDamageEnemy.__hits = {};
			return { ok: true };
		})()`);
	}

	/** KDM-164: take (and clear) the hits recorded against one peer avatar this turn. */
	/**
	 * KDM-186 — take the game's own presentation output for the player currently swapped in.
	 *
	 * `KDDamageQueue` is how KD tells its DRAW layer "show this damage": `KinkyDungeonDrawFight`
	 * emits a floater per entry and splices it out. Headless there is no draw loop, so the queue only
	 * ever grows — which is why it must not be captured as state (it would be re-delivered forever,
	 * the UAT pile-up) and why the server has to drain it explicitly or leak.
	 *
	 * Clearing as it reads is the same take-once contract as `takePeerHits`: an entry can be charged
	 * exactly once, so no later read can resurrect it. The values are the GAME's own — text, colour
	 * and position — never numbers this layer invents.
	 */
	takeDamageFloaters() {
		return this.eval(`(function(){
			if (typeof KDDamageQueue === 'undefined' || !Array.isArray(KDDamageQueue)) return [];
			var out = [];
			for (var i = 0; i < KDDamageQueue.length; i++) {
				var d = KDDamageQueue[i];
				if (!d || !d.floater) continue;
				var e = d.Entity || {};
				out.push({
					text: String(d.floater), color: d.Color || '#ffffff',
					x: e.x, y: e.y, time: d.Time || 1,
				});
			}
			KDDamageQueue.length = 0;
			return out;
		})()`);
	}

	/**
	 * KDM-196 — drain the game's NOISE presentation queues; the sibling of takeDamageFloaters above.
	 *
	 * `KDEventData.shockwaves` and `KDEventData.sounddesc` are consume-once presentation output: the
	 * enemy-noise path pushes them (`KinkyDungeonEnemies.ts:9607`) and the DRAW layer drains them
	 * (`KinkyDungeonEvents.ts` → `afterDrawFrame`/`shockwave`, which clears the array after emitting).
	 * A headless world has no draw loop, so nothing ever drained them: MEASURED, six real turns left
	 * six undrained shockwaves in the capture and every snapshot re-shipped all six — the "spam of
	 * sound echo animation while the mouse moves" from UAT, and exactly the KDDamageQueue shape.
	 *
	 * So the server drains them HERE instead, at the same point in the turn as the damage floaters,
	 * and they travel as sequenced events rather than as replicated state.
	 *
	 * `sounddesc` is per-turn by design (`KinkyDungeonAdvanceTime` resets it at delta > 0), so it is
	 * taken WHOLE and replaces the client's list; `shockwaves` is a one-shot backlog and is appended.
	 */
	takeNoisePresentation() {
		return this.eval(`(function(){
			if (typeof KDEventData === 'undefined' || !KDEventData) return { shockwaves: [], sounddesc: [] };
			var sw = Array.isArray(KDEventData.shockwaves) ? KDEventData.shockwaves : [];
			var sd = Array.isArray(KDEventData.sounddesc) ? KDEventData.sounddesc : [];
			var out = {
				shockwaves: JSON.parse(JSON.stringify(sw)),
				sounddesc: JSON.parse(JSON.stringify(sd)),
			};
			KDEventData.shockwaves = [];
			KDEventData.sounddesc = [];
			return out;
		})()`) || { shockwaves: [], sounddesc: [] };
	}

	takePeerHits(entityId) {
		return this.eval(`(function(){
			var w = KinkyDungeonDamageEnemy, k = ${entityId | 0};
			if (!w || !w.__hits || !w.__hits[k]) return [];
			var out = w.__hits[k]; delete w.__hits[k]; return out;
		})()`) || [];
	}

	/** Deal damage to THIS instance's player (a PvP hit landing on this instance). */
	dealDamage(amount, type = 'pain') {
		this.eval(`KinkyDungeonDealDamage({ damage: ${Number(amount) || 0}, type: ${JSON.stringify(type)} })`);
		return this.getVitals();
	}

	/** Add a named restraint to THIS instance's player. Returns {added, count}. */
	addRestraint(name) {
		return this.eval(`(function(){
			var def = KinkyDungeonGetRestraintByName(${JSON.stringify(name)});
			if (!def) return { added: 0, count: KinkyDungeonAllRestraint().length, error: 'no restraint def: ' + ${JSON.stringify(name)} };
			var added = KinkyDungeonAddRestraint(def, 0, true);
			return { added: added, count: KinkyDungeonAllRestraint().length };
		})()`);
	}

	/** KD-101 UAT: add a CARRYABLE loose-restraint item (Items inventory), not a worn one. */
	addLooseRestraint(name, quantity = 1) {
		return this.eval(`(function(){
			var def = KinkyDungeonGetRestraintByName(${JSON.stringify(name)});
			if (!def) return { added: false, error: 'no restraint def: ' + ${JSON.stringify(name)} };
			if (typeof KinkyDungeonInventoryAddLoose !== 'function') return { added: false, error: 'no KinkyDungeonInventoryAddLoose' };
			KinkyDungeonInventoryAddLoose(${JSON.stringify(name)}, undefined, undefined, ${quantity | 0 || 1});
			var item = (typeof KinkyDungeonInventoryGetLoose === 'function') ? KinkyDungeonInventoryGetLoose(${JSON.stringify(name)}) : null;
			return { added: !!item, name: ${JSON.stringify(name)} };
		})()`);
	}

	// ----- real in-game integration: players-as-entities (KD-082) ---------------

	/**
	 * Ensure the `RemotePlayer` enemy-def exists (pushed mod-style, once) — an
	 * ally-faction, inert avatar definition used to represent another player as a
	 * real KD entity. faction 'Player' = ally; noAttack falsy so a hostile enemy
	 * still treats it as a valid target; immobile + visionRadius 0 so it never
	 * acts on its own (the reconciler drives its position).
	 */
	_ensureAvatarDef() {
		this.eval(`(function(){
			if (!KinkyDungeonGetEnemyByName('RemotePlayer')) {
				KinkyDungeonEnemies.push({
					name: 'RemotePlayer', faction: 'Player', tags: KDMapInit(['peaceful']),
					bound: 'Apprentice', // sprite name; presence makes KDCanBind true so the Truss/bind option appears (KD-098)
					AI: 'guard', immobile: true, visionRadius: 0, maxhp: 100, minLevel: 0, weight: -1000,
					movePoints: 1000, attackPoints: 0, attack: '', attackRange: 0,
					evasion: -100, armor: 0, followRange: 100, lowpriority: true,
					// style → the client renders the avatar as a full character (NPC path,
					// KDQuickGenNPC + DrawCharacter) so the other player is VISIBLE, not just
					// an HP bar. Server never draws (rendering neutered) so this is client-only.
					style: 'BlueHair',
					terrainTags: {}, floors: KDMapInit([]),
				});
				if (typeof KinkyDungeonRefreshEnemiesCache === 'function') KinkyDungeonRefreshEnemiesCache();
			}
			// KD-100: register the def's display-name key so real combat text reads a real name
			// ("Your attack hits the Rival …") instead of "[NotFound] NameRemotePlayer".
			if (typeof addTextKey === 'function') addTextKey('NameRemotePlayer', 'Rival');
			return true;
		})()`);
	}

	/**
	 * Inject an avatar entity representing another player at (x,y). Returns the
	 * real KD entity id (the engine now sees/targets/collides with it).
	 */
	spawnAvatar(x, y, name) {
		this._ensureAvatarDef();
		const label = name || 'Player';
		// KD-100: combat text reads TextGet("Name"+Enemy.Enemy.name) — the def name, NOT CustomName —
		// so give each avatar its OWN def clone with a unique name + registered name key, so a hit reads
		// the real peer ("Your attack hits Player A …") instead of the shared "the Rival".
		const defName = 'RemotePlayer_' + String(label).replace(/[^A-Za-z0-9]/g, '');
		return this.eval(`(function(){
			var base = KinkyDungeonGetEnemyByName('RemotePlayer');
			var defName = ${JSON.stringify(defName)};
			var def = KinkyDungeonGetEnemyByName(defName);
			if (!def) {
				def = Object.assign({}, base, { name: defName });
				KinkyDungeonEnemies.push(def);
				if (typeof KinkyDungeonRefreshEnemiesCache === 'function') KinkyDungeonRefreshEnemiesCache();
			}
			if (typeof addTextKey === 'function') addTextKey('Name' + defName, ${JSON.stringify(label)});
			// CustomName + style on the entity → client renders it as a full character
			// (the NPC sprite path), so the other player is visible (not just an HP bar).
			var ent = { id: KinkyDungeonGetEnemyID(), Enemy: def, x: ${x | 0}, y: ${y | 0}, hp: 100,
				movePoints: 0, attackPoints: 0,
				// CustomName needs CustomNameColor — the HP/name draw calls string2hex on
				// it (KinkyDungeonEnemies.ts:2356); undefined crashes the whole render.
				CustomName: ${JSON.stringify(label)}, CustomNameColor: '#88bbff', style: 'BlueHair' };
			KDAddNewEntity(ent);
			KDUpdateEnemyCache = true;
			return { entityId: ent.id, x: ent.x, y: ent.y };
		})()`);
	}

	/** Move an injected avatar entity (by entity id) and refresh the entity cache. */
	moveAvatar(entityId, x, y) {
		return this.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.id === ${entityId | 0}; });
			if (!e) return null;
			e.x = ${x | 0}; e.y = ${y | 0}; e.visual_x = ${x | 0}; e.visual_y = ${y | 0};
			KDUpdateEnemyCache = true;
			return { entityId: e.id, x: e.x, y: e.y };
		})()`);
	}

	/**
	 * KDM-208: for the NEXT apply, veto KD's stock bump-to-attack against the listed entity ids.
	 *
	 * `KinkyDungeonMove` promotes a move into an occupied tile to an attack (KinkyDungeonGame.ts:2977)
	 * — correct stock behaviour, and what makes deliberate PvP work through the real pipeline. It is
	 * wrong for exactly one case: the peer was NOT on that tile when the mover acted, and only arrived
	 * because the turn's random application order put them first. The caller decides which avatars are
	 * in that state (it is the only layer that knows where everyone stood at turn start); this method
	 * is the mechanism, and it is deliberately narrow — it fires ONLY on the move-bump, so ranged
	 * attacks, spells and AOE against the same peer are untouched.
	 *
	 * Vetoed = the move does not happen either: no attack, no step, no `KinkyDungeonAdvanceTime`. That
	 * is what "the move is cancelled" means, and it is the same outcome the R9 doc comment in
	 * `swap-session.js` always claimed collision already produced.
	 *
	 * The wrapper is installed once (sentinel `__kdBumpVeto`) and reads a per-apply Set, so an empty
	 * list disables it completely.
	 */
	setBumpVeto(entityIds) {
		const ids = (Array.isArray(entityIds) ? entityIds : [])
			.filter((n) => n != null).map((n) => n | 0);
		return this.eval(`(function(){
			globalThis.__KD_BUMP_VETO = new Set(${JSON.stringify(ids)});
			if (typeof KinkyDungeonMove === 'function' && !KinkyDungeonMove.__kdBumpVeto) {
				var _move = KinkyDungeonMove;
				KinkyDungeonMove = function(moveDirection, delta, AllowInteract){
					var veto = globalThis.__KD_BUMP_VETO;
					if (veto && veto.size && moveDirection && KinkyDungeonPlayerEntity
						&& typeof KinkyDungeonEnemyAt === 'function') {
						var tx = KinkyDungeonPlayerEntity.x + (moveDirection.x | 0);
						var ty = KinkyDungeonPlayerEntity.y + (moveDirection.y | 0);
						var e = KinkyDungeonEnemyAt(tx, ty);
						if (e && veto.has(e.id)) {
							globalThis.__KD_BUMP_VETO_HITS = (globalThis.__KD_BUMP_VETO_HITS || 0) + 1;
							return false;   // "nomove": no attack, no step, no time
						}
					}
					return _move.apply(this, arguments);
				};
				KinkyDungeonMove.__kdBumpVeto = true;
			}
			return globalThis.__KD_BUMP_VETO.size;
		})()`);
	}

	/** KDM-208: take-once count of bump-attacks vetoed since the last read (never a silent drop). */
	takeBumpVetoes() {
		return this.eval(`(function(){
			var n = globalThis.__KD_BUMP_VETO_HITS || 0;
			globalThis.__KD_BUMP_VETO_HITS = 0;
			return n;
		})()`);
	}

	/** List entities in this instance (proves injected avatars are real). */
	listEntities() {
		return this.eval(`KDMapData.Entities.map(function(e){
			return { id: e.id, x: e.x, y: e.y, hp: e.hp, name: e.Enemy && e.Enemy.name, faction: KDGetFaction(e) };
		})`);
	}

	/** What the engine reports is present at (x,y) — avatar/enemy/player. */
	entityAt(x, y) {
		return this.eval(`(function(){
			var e = KinkyDungeonEntityAt(${x | 0}, ${y | 0});
			return e ? { id: e.id, name: e.Enemy && e.Enemy.name, player: !!e.player, x: e.x, y: e.y } : null;
		})()`);
	}

	/**
	 * KD-100: await the async text provider so real combat messages resolve to real text instead of
	 * "[NotFound] …". `textProvider.readyAll()` returns a cross-realm promise; awaiting it in Node
	 * pumps the loop until the boot-time CSV loads finish. Idempotent; safe to call repeatedly.
	 */
	async ready() {
		try {
			const p = this.eval('(typeof textProvider !== "undefined" && textProvider && textProvider.readyAll) ? textProvider.readyAll() : null');
			if (p && typeof p.then === 'function') await p;
		} catch (e) { /* best-effort */ }
		return true;
	}

	/**
	 * KD-100: make an injected avatar a REAL hostile enemy so the attacker's stock attack pipeline
	 * (KinkyDungeonMove bump → KDDoAttack/KDDamageEnemy, real defeat/capture) targets it. hp tracks the
	 * peer's Will (maxhp = WillMax) so KD's real low-hp helpless/capture thresholds fire near Will 0.
	 */
	setAvatarEnemy(entityId, hp, maxhp, stun) {
		return this.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.id === ${entityId | 0}; });
			if (!e) return null;
			e.Enemy.maxhp = ${Number(maxhp) || 10};
			e.hp = Math.max(0, ${Number(hp) || 0});
			e.faction = 'Enemy'; e.hostile = 9999; e.ce = undefined; e.player = undefined;
			// KD-101: stun marks the avatar "disabled" (KinkyDungeonIsStunned) so the game's real
			// KDCanApplyBondage gate lets a SUBDUED peer be tied — the avatar's hp is a per-turn damage
			// gauge (always full) and can't express the victim's subdued state, so we set it explicitly.
			e.stun = Math.max(0, ${Number(stun) || 0});
			KDUpdateEnemyCache = true;
			return { id: e.id, hp: e.hp, maxhp: e.Enemy.maxhp, stun: e.stun, faction: (typeof KDGetFaction==='function')?KDGetFaction(e):e.faction };
		})()`);
	}

	/** KD-100/101: read an entity's combat + bondage state for reconciliation back to a player bundle.
	 *  npcRestraints = the restraint NAMES tied onto the avatar this turn (KD-101 real "tie"). */
	getEntityCombat(entityId) {
		return this.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.id === ${entityId | 0}; });
			if (!e) return null;
			var names = [];
			if (typeof KDGetNPCRestraints === 'function') {
				var r = KDGetNPCRestraints(${entityId | 0}) || {};
				for (var k in r) { if (r[k] && r[k].name) names.push(r[k].name); }
			}
			return { id: e.id, hp: e.hp, maxhp: e.Enemy && e.Enemy.maxhp, boundLevel: e.boundLevel || 0,
				captured: (typeof KDHelpless === 'function') ? !!KDHelpless(e) : (e.hp <= 0.52),
				npcRestraints: names };
		})()`);
	}

	/** KD-101: clear an avatar's per-turn bondage gauge (NPC restraints + boundLevel) before the turn,
	 *  so _reconcilePeers reads only the bondage applied THIS turn (mirrors the hp damage gauge). */
	/**
	 * KDM-199: mirror a peer PLAYER real worn bondage onto their stand-in avatar.
	 *
	 * Uses specialBoundLevel — the GAME own ITEM-FREE bondage channel (what KDTieUpEnemy writes, e.g.
	 * specialBoundLevel.Rope). KDResyncBondage sums it back into boundLevel, so the value survives the
	 * engine recomputing it; a bare boundLevel write does NOT (KDResyncBondage zeroes it when
	 * specialBoundLevel is unset). Measured: 1 to 1, 5 to 5, 60 to 60, 80 to 80.
	 *
	 * Item-free is the point: no KDSetNPCRestraints entries are created, so the KD-101 binding-slot
	 * overflow that crashes the stock submenu cannot come back.
	 */
	/**
	 * KDM-200: mark a DEFEATED peer avatar as exposed for this turn.
	 *
	 * This is the epic ONE declared co-op rule, and it is deliberately the SMALLEST possible one: it
	 * sets the game own per-turn exposure flag and then lets KD own gate decide. It does NOT override
	 * KDCanApplyBondage, does not fake a stun, and does not invent a bondage level — the branch that
	 * fires is the stock one, target.vulnerable && target.hp <= 0.5 * maxhp, and the hp half comes from
	 * the peer REAL Will (KDM-199 arming).
	 *
	 * Why co-op needs it at all: KD subdues an NPC through stun/freeze or accumulated bondage, both of
	 * which arrive via weapons and spells an NPC fight supplies. Between two PLAYERS the product
	 * requirement is that beating an opponent down is itself enough to tie them — measured otherwise
	 * impossible without dictating the loadout. Declared here, in one place, rather than hidden.
	 *
	 * No duration is invented: the flag is set for THIS turn and re-armed every turn the peer is still
	 * defeated, so it expires the moment they are not.
	 */
	setAvatarVulnerable(entityId, on) {
		return this.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.id === ${entityId | 0}; });
			if (!e) return null;
			e.vulnerable = ${on ? 1 : 0};
			return { vulnerable: e.vulnerable };
		})()`);
	}

	setAvatarBondage(entityId, amount) {
		const amt = Number(amount) || 0;
		return this.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.id === ${entityId | 0}; });
			if (!e) return null;
			if (${amt} > 0) e.specialBoundLevel = { MPPeer: ${amt} };
			else e.specialBoundLevel = undefined;
			if (typeof KDResyncBondage === "function") KDResyncBondage(e);
			return { boundLevel: e.boundLevel || 0 };
		})()`);
	}

	clearAvatarBondage(entityId) {
		return this.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.id === ${entityId | 0}; });
			if (e) { e.boundLevel = 0; }
			if (typeof KDSetNPCRestraints === 'function') KDSetNPCRestraints(${entityId | 0}, {});
			return true;
		})()`);
	}

	/** KD-100: write the swapped-in player's Will (the reconcile target), clamped to [0, WillMax]. */
	setWill(will) {
		return this.eval(`(function(){
			var mx = (typeof KinkyDungeonStatWillMax !== 'undefined') ? KinkyDungeonStatWillMax : 10;
			KinkyDungeonStatWill = Math.max(0, Math.min(mx, ${Number(will) || 0}));
			return KinkyDungeonStatWill;
		})()`);
	}

	/** Park THIS instance's global player off-field (so the world enemy targets avatars). */
	parkGlobalPlayer(x = 1, y = 1) {
		this.eval(`(function(){
			KinkyDungeonPlayerEntity.x = ${x | 0}; KinkyDungeonPlayerEntity.y = ${y | 0};
			KinkyDungeonTargetX = ${x | 0}; KinkyDungeonTargetY = ${y | 0}; KDUpdateEnemyCache = true;
		})()`);
		return this.getPlayerPos();
	}

	/**
	 * Report which entity the world enemy is currently targeting + its pose, so
	 * the reconciler can route the attack to the right player (authority read).
	 */
	worldEnemyTarget(index = 0) {
		return this.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.Enemy && !en.Enemy.noAttack && KDGetFaction(en) !== 'Player'; });
			if (!e) return null;
			return { enemyId: e.id, target: e.target, tx: e.tx, ty: e.ty, ex: e.x, ey: e.y, aware: !!e.aware, hp: e.hp, name: e.Enemy && e.Enemy.name };
		})()`);
	}

	/**
	 * Apply an enemy's attack outcome to THIS instance's global player via the
	 * engine's real damage/restraint functions (the routed hit lands here).
	 */
	applyEnemyHit(profile = {}) {
		const dmg = Number(profile.damage) || 0;
		const type = profile.type || 'pain';
		const restraint = profile.restraint || null;
		return this.eval(`(function(){
			if (${dmg} > 0) KinkyDungeonDealDamage({ damage: ${dmg}, type: ${JSON.stringify(type)} });
			if (${JSON.stringify(restraint)}) {
				var def = KinkyDungeonGetRestraintByName(${JSON.stringify(restraint)});
				if (def) KinkyDungeonAddRestraint(def, 0, true);
			}
			return {
				will: KinkyDungeonStatWill, stamina: KinkyDungeonStatStamina,
				distraction: KinkyDungeonStatDistraction, restraints: KinkyDungeonAllRestraint().length,
			};
		})()`);
	}

	/** Distance (Chebyshev) between two entities by id, in this instance. */
	entityDistance(idA, idB) {
		return this.eval(`(function(){
			var a = KDMapData.Entities.find(function(e){return e.id===${idA | 0};});
			var b = KDMapData.Entities.find(function(e){return e.id===${idB | 0};});
			if (!a || !b) return null;
			return Math.max(Math.abs(a.x-b.x), Math.abs(a.y-b.y));
		})()`);
	}

	/** The ~20-global per-player independence snapshot (KD-082 gap #4). */
	getParams() {
		return this.eval(`(function(){
			return {
				stamina: KinkyDungeonStatStamina, staminaMax: KinkyDungeonStatStaminaMax,
				mana: KinkyDungeonStatMana, manaMax: KinkyDungeonStatManaMax,
				will: KinkyDungeonStatWill, willMax: KinkyDungeonStatWillMax,
				distraction: KinkyDungeonStatDistraction, distractionMax: KinkyDungeonStatDistractionMax,
				x: KinkyDungeonPlayerEntity.x, y: KinkyDungeonPlayerEntity.y, hp: KinkyDungeonPlayerEntity.hp,
				level: (typeof MiniGameKinkyDungeonLevel !== 'undefined') ? MiniGameKinkyDungeonLevel : null,
				gold: (typeof KinkyDungeonGold !== 'undefined') ? KinkyDungeonGold : null,
				restraints: KinkyDungeonAllRestraint().length,
				inventoryKeys: (typeof KinkyDungeonInventory !== 'undefined' && KinkyDungeonInventory) ? Array.from(KinkyDungeonInventory.keys()).length : null,
				perks: (typeof KinkyDungeonStatsChoice !== 'undefined' && KinkyDungeonStatsChoice) ? Array.from(KinkyDungeonStatsChoice.keys()).filter(function(k){return KinkyDungeonStatsChoice.get(k);}).length : null,
				movePoints: (typeof KDGameData !== 'undefined' && KDGameData) ? KDGameData.MovePoints : null,
				tick: KinkyDungeonCurrentTick,
				seed: (typeof KinkyDungeonSeed !== 'undefined') ? KinkyDungeonSeed : null,
			};
		})()`);
	}

	// ----- headless-safe render-state snapshot (KD-067) ------------------------

	/**
	 * Serialize a JSON-safe RENDER-STATE snapshot — the minimal set of globals the
	 * stock per-frame render path reads, so a thin client (KD-071) can render it
	 * without simulating. Built DIRECTLY from live globals, NOT from
	 * KinkyDungeonGenerateSaveData() — that throws headless because it reads
	 * render-derived model Poses (KinkyDungeon.ts:6840). This serializer never
	 * touches model/pose data; it carries game state, not pixels.
	 *
	 * Shape is `version`-stamped for protocol evolution (shared with KD-070/071).
	 * Per-entity `Enemy` defs are reduced to `enemyName` and re-linked on apply
	 * (the client already has the shared defs) — see applyRenderState.
	 */
	serializeRenderState() {
		return this.eval(`(function(){
			function clone(o){ try { return (o === undefined) ? undefined : JSON.parse(JSON.stringify(o)); } catch(e){ return null; } }
			// KDM-200: these are the fields KD OWN predicates read to decide whether a target is
			// subdued — KinkyDungeonIsStunned reads stun/freeze, KDCanApplyBondage reads vulnerable and
			// hp, KDBoundEffects reads boundLevel (and KDResyncBondage rebuilds it from
			// specialBoundLevel). Omitting them meant the CLIENT — where the tie submenu actually
			// evaluates the gate — never saw the state the server had computed, so no server-side fix
			// could ever take effect. The old code hid this by stamping ent.stun onto the snapshot AFTER
			// serialisation, bypassing this list; with the stamping gone the omission became visible.
			var ENT_FIELDS = ['id','x','y','visual_x','visual_y','offX','offY','scaleX','scaleY','flip','hp','visual_hp','boundLevel','specialBoundLevel','stun','freeze','vulnerable','distraction','revealed','player','CustomSprite','CustomName','CustomNameColor','style','outfit','outfitBound'];
			function entSnap(e){
				var o = {};
				for (var i=0;i<ENT_FIELDS.length;i++){ var k=ENT_FIELDS[i]; if (e[k] !== undefined) o[k] = e[k]; }
				o.enemyName = (e.Enemy && e.Enemy.name) || undefined;
				var b = clone(e.buffs); if (b) o.buffs = b;
				return o;
			}
			var P = (typeof KinkyDungeonPlayerEntity !== 'undefined') ? KinkyDungeonPlayerEntity : null;
			return {
				version: 1,
				tick: KinkyDungeonCurrentTick,
				camera: {
					zoomIndex: (typeof KDZoomIndex !== 'undefined') ? KDZoomIndex : 0,
					gridSizeDisplay: (typeof KinkyDungeonGridSizeDisplay !== 'undefined') ? KinkyDungeonGridSizeDisplay : 0,
					gridWidthDisplay: (typeof KinkyDungeonGridWidthDisplay !== 'undefined') ? KinkyDungeonGridWidthDisplay : 0,
					gridHeightDisplay: (typeof KinkyDungeonGridHeightDisplay !== 'undefined') ? KinkyDungeonGridHeightDisplay : 0,
					camX: (typeof KinkyDungeonCamX !== 'undefined') ? KinkyDungeonCamX : 0,
					camY: (typeof KinkyDungeonCamY !== 'undefined') ? KinkyDungeonCamY : 0,
				},
				player: P ? entSnap(P) : null,
				// KDM-162: the curated stats block is GONE. It named ~12 HUD fields by hand, in TWO
				// languages (here and client/render-client.js), and shipped slowLevel — a value it
				// RECOMPUTED and then sent, i.e. derived state crossing the network, which is exactly
				// what goes stale. Every one of those fields is per-player state the generic bundle
				// already carries (snapshotFor attaches it), so adding a HUD value upstream now needs
				// no change here at all. Measured: KDM-162 probe6 + tests/e2e/mp-render-completeness.
				// Full authoritative KDMapData (JSON-clones cleanly headless, ~10KB). The
				// client adopts it WHOLESALE — a field-subset splice leaves a half-local/
				// half-server map that renders broken. Entities carry their full Enemy
				// defs in the clone, so no def re-link is needed client-side. Vision/light
				// (KDMapExtraData) is NOT sent — the client recomputes it locally.
				map: clone(KDMapData),
				messages: {
					log: clone(KinkyDungeonMessageLog) || [],
					action: (typeof KinkyDungeonActionMessage !== 'undefined') ? KinkyDungeonActionMessage : '',
					actionTime: (typeof KinkyDungeonActionMessageTime !== 'undefined') ? KinkyDungeonActionMessageTime : 0,
					actionColor: (typeof KinkyDungeonActionMessageColor !== 'undefined') ? KinkyDungeonActionMessageColor : '#ffffff',
				},
				// KD-101: ship the FULL worn-restraint items (not just name/id) so the client can rebuild
				// the player's worn-restraint Map — a peer-applied tie must render on the victim's screen.
				restraints: (typeof KinkyDungeonAllRestraint === 'function') ? KinkyDungeonAllRestraint().map(function(r){ return clone(r) || { name: r.name, id: r.id }; }).filter(function(r){ return r && r.name; }) : [],
				buffs: clone(typeof KinkyDungeonPlayerBuffs !== 'undefined' ? KinkyDungeonPlayerBuffs : {}),
				level: (typeof MiniGameKinkyDungeonLevel !== 'undefined') ? MiniGameKinkyDungeonLevel : 1,
				checkpoint: (typeof MiniGameKinkyDungeonCheckpoint !== 'undefined') ? MiniGameKinkyDungeonCheckpoint : 'grv',
			};
		})()`);
	}

	/**
	 * Adopt a render-state snapshot (from serializeRenderState) onto THIS instance —
	 * the thin-client / reconciler apply path. Assigns the render globals and
	 * re-links each entity's Enemy def by name. Does NOT simulate. Returns a small
	 * summary for assertions.
	 */
	applyRenderState(snap) {
		// KDM-162: per-player state arrives as the generic bundle, adopted through the SAME path the
		// swap model uses. This is what removed the curated `stats` block from both apply sites: there
		// is no longer a per-field contract here to keep in step with the serializer.
		if (snap && snap.bundle) this.restorePlayer(snap.bundle);
		this._context.__KD_RENDER_IN = snap;
		return this.eval(`(function(){
			var s = globalThis.__KD_RENDER_IN;
			if (!s) return { ok: false, error: 'no snapshot' };
			// camera / viewport
			if (typeof KDZoomIndex !== 'undefined') KDZoomIndex = s.camera.zoomIndex;
			if (typeof KinkyDungeonGridSizeDisplay !== 'undefined') KinkyDungeonGridSizeDisplay = s.camera.gridSizeDisplay;
			if (typeof KinkyDungeonGridWidthDisplay !== 'undefined') KinkyDungeonGridWidthDisplay = s.camera.gridWidthDisplay;
			if (typeof KinkyDungeonGridHeightDisplay !== 'undefined') KinkyDungeonGridHeightDisplay = s.camera.gridHeightDisplay;
			if (typeof KinkyDungeonCamX !== 'undefined') KinkyDungeonCamX = s.camera.camX;
			if (typeof KinkyDungeonCamY !== 'undefined') KinkyDungeonCamY = s.camera.camY;
			// KDM-162: the hand-assigned HUD stats are gone — per-player state arrives in the bundle,
			// which restorePlayer() has already applied before this eval runs (see below).
			// adopt the authoritative KDMapData WHOLESALE (internally consistent).
			if (s.map) KDMapData = s.map;
			if (typeof KDUpdateEnemyCache !== 'undefined') KDUpdateEnemyCache = true;
			// player avatar (this instance's own global player object)
			if (s.player && KinkyDungeonPlayerEntity) {
				for (var k in s.player) { if (k !== 'enemyName' && k !== 'Enemy') KinkyDungeonPlayerEntity[k] = s.player[k]; }
			}
			// messages / floor
			KinkyDungeonMessageLog = s.messages.log || [];
			if (typeof KinkyDungeonActionMessage !== 'undefined') KinkyDungeonActionMessage = s.messages.action;
			if (typeof KinkyDungeonActionMessageTime !== 'undefined') KinkyDungeonActionMessageTime = s.messages.actionTime;
			if (typeof KinkyDungeonActionMessageColor !== 'undefined') KinkyDungeonActionMessageColor = s.messages.actionColor;
			if (typeof MiniGameKinkyDungeonLevel !== 'undefined') MiniGameKinkyDungeonLevel = s.level;
			if (s.checkpoint && typeof MiniGameKinkyDungeonCheckpoint !== 'undefined') MiniGameKinkyDungeonCheckpoint = s.checkpoint;
			return { ok: true, entities: KDMapData.Entities.length, grid: KDMapData.Grid.length };
		})()`);
	}

	/**
	 * Adopt the WORLD's authoritative MAP (tiles + vision/lighting) onto THIS player
	 * instance — KD-070 reconciler push. Map-ONLY by design: it does NOT touch this
	 * instance's player/stats NOR its entity list. Shared entities (the world's
	 * enemies + the other players' avatars) are managed separately as PROPER engine
	 * entities (injectSharedEnemy / spawnAvatar+moveAvatar) so they stay well-formed
	 * for the per-turn CheckHP/unpack pass — replacing Entities with re-linked plain
	 * objects breaks that pass. Takes a snapshot from world.serializeRenderState().
	 */
	applyWorldMap(snap) {
		this._context.__KD_WORLD_IN = snap;
		return this.eval(`(function(){
			var s = globalThis.__KD_WORLD_IN; if (!s) return { ok:false, error:'no snapshot' };
			// authoritative map (adopt; the world OWNS it — players do not regen it)
			KDMapData.Grid = s.map.Grid; KDMapData.GridWidth = s.map.GridWidth; KDMapData.GridHeight = s.map.GridHeight;
			if (s.map.Tiles != null) KDMapData.Tiles = s.map.Tiles;
			if (s.map.TilesSkin != null) KDMapData.TilesSkin = s.map.TilesSkin;
			if (s.map.TilesMemory != null) KDMapData.TilesMemory = s.map.TilesMemory;
			if (s.map.Traffic != null) KDMapData.Traffic = s.map.Traffic;
			if (s.map.FogGrid != null) KDMapData.FogGrid = s.map.FogGrid;
			if (s.map.FogMemory != null) KDMapData.FogMemory = s.map.FogMemory;
			if (s.map.Labels != null) KDMapData.Labels = s.map.Labels;
			if (s.mapExtra && typeof KDMapExtraData !== 'undefined' && KDMapExtraData) {
				if (s.mapExtra.VisionGrid != null) KDMapExtraData.VisionGrid = s.mapExtra.VisionGrid;
				if (s.mapExtra.BrightnessGrid != null) KDMapExtraData.BrightnessGrid = s.mapExtra.BrightnessGrid;
				if (s.mapExtra.ColorGrid != null) KDMapExtraData.ColorGrid = s.mapExtra.ColorGrid;
				if (s.mapExtra.ShadowGrid != null) KDMapExtraData.ShadowGrid = s.mapExtra.ShadowGrid;
			}
			return { ok:true, grid: KDMapData.Grid.length };
		})()`);
	}

	/**
	 * Inject the world's shared enemy as a PROPER, well-formed entity in THIS player
	 * instance (KD-070) so it renders + survives the per-turn CheckHP pass. Uses the
	 * real enemy def (KinkyDungeonGetEnemyByName) via the engine's KDAddNewEntity —
	 * the same proven path as spawnAvatar. AI is suppressed here (role 'player'); the
	 * reconciler keeps its position in sync with the world via moveAvatar(by id).
	 * Returns the entity id (track it to reposition each turn).
	 */
	injectSharedEnemy(name, x, y, hp) {
		return this.eval(`(function(){
			var def = KinkyDungeonGetEnemyByName(${JSON.stringify(name)});
			if (!def) return null;
			var ent = { id: KinkyDungeonGetEnemyID(), Enemy: def, x: ${x | 0}, y: ${y | 0},
				hp: ${Number(hp) || (def.maxhp || 1)}, movePoints: 0, attackPoints: 0 };
			KDAddNewEntity(ent);
			KDUpdateEnemyCache = true;
			return { entityId: ent.id, x: ent.x, y: ent.y, name: def.name };
		})()`);
	}

	/**
	 * Read a world enemy's REAL attack descriptor from its def (KD-070 adjudication):
	 * power/dmgType/attack/range come from the actual enemy data, not a fixed profile.
	 * The reconciler routes this to the targeted player's instance via applyEnemyHit.
	 * `isBind` flags bind/rope/lock attacks (so a restraint is applied, not just damage).
	 */
	getEnemyAttackProfile(entityId) {
		return this.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.id === ${entityId | 0}; });
			if (!e || !e.Enemy) return null;
			var En = e.Enemy;
			var atk = String(En.attack || '');
			return {
				attack: atk,
				power: En.power || 0,
				damage: En.power || 0,
				type: En.dmgType || 'pain',
				range: En.attackRange || 1,
				width: En.attackWidth || 1,
				isBind: /Bind|Lock|Rope|Engulf|Chain/.test(atk),
			};
		})()`);
	}

	// ----- action routing (KD-085) --------------------------------------------

	/** The acting player's current weapon attack profile (from their instance). */
	getAttackProfile() {
		return this.eval(`(function(){
			var w = (typeof KinkyDungeonPlayerDamage !== 'undefined') ? KinkyDungeonPlayerDamage : null;
			return {
				damage: (w && typeof w.damage === 'number') ? w.damage : 1,
				type: (w && w.type) ? w.type : 'unarmed',
			};
		})()`);
	}

	/**
	 * Apply a damage profile to a WORLD enemy by id via the engine's real
	 * KinkyDungeonDamageEnemy (KD-085 routed attack). Returns {hp, dealt, name} or null.
	 * Run on the world instance (authoritative). The reconciler then re-broadcasts.
	 */
	damageEnemy(enemyId, profile = {}) {
		const dmg = Number(profile.damage) || 0;
		const type = profile.type || 'unarmed';
		return this.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.id === ${enemyId | 0}; });
			if (!e || !e.Enemy) return null;
			var dealt = KinkyDungeonDamageEnemy(e, { damage: ${dmg}, type: ${JSON.stringify(type)} }, false, true);
			KDUpdateEnemyCache = true;
			return { hp: e.hp, dealt: dealt, name: e.Enemy && e.Enemy.name };
		})()`);
	}

	/** The world enemy entity adjacent to (x,y) (Chebyshev ≤ range), or null. */
	enemyAdjacentTo(x, y, range = 1) {
		return this.eval(`(function(){
			var best = null, bd = 1e9;
			for (var i=0;i<KDMapData.Entities.length;i++){
				var e = KDMapData.Entities[i];
				if (!e.Enemy || KDGetFaction(e) === 'Player') continue;
				var d = Math.max(Math.abs(e.x-${x|0}), Math.abs(e.y-${y|0}));
				if (d <= ${range|0} && d < bd) { bd = d; best = e; }
			}
			return best ? { id: best.id, x: best.x, y: best.y, hp: best.hp, name: best.Enemy && best.Enemy.name } : null;
		})()`);
	}

	/**
	 * KDM-160: give KinkyDungeonPlayer a ModelContainer so KD's own save serializer can run headless.
	 *
	 * KinkyDungeonGenerateSaveData reads `KDCurrentModels.get(KinkyDungeonPlayer).Poses`
	 * (main.js:18026) WITHOUT a null guard — unlike its four sibling call sites (:1435, :9467, :9472,
	 * :16524) which all use `?.`. KDCurrentModels is populated only inside DrawCharacterModels
	 * (:170138), which _neuterRendering() no-ops on purpose: building models headless would drag the
	 * whole PIXI model rig into the server.
	 *
	 * So the container is seeded from the game's OWN class and pose generator — no fabricated data,
	 * and identical in every instance, so it cancels out in any cross-instance diff. Lazy + idempotent:
	 * boot() must stay byte-identical for the existing specs.
	 */
	_seedHeadlessModel() {
		return this.eval(`(function(){
			if (typeof KDCurrentModels === 'undefined' || typeof KinkyDungeonPlayer === 'undefined') return 'no-globals';
			if (KDCurrentModels.get(KinkyDungeonPlayer)) return 'already';
			KDCurrentModels.set(KinkyDungeonPlayer,
				new ModelContainer(KinkyDungeonPlayer, new Map(), new Map(), new Map(), KDGeneratePoseArray()));
			return 'seeded';
		})()`);
	}

	// ----- KDM-161: generic per-player globals (no hand-written whitelist) -----

	/** Candidate names: bundle bindings ∪ mod-declared globalThis keys, minus blacklists. */
	_candidateGlobals() {
		const modKeys = this.eval('Object.keys(globalThis)') || [];
		const all = deriveBundleGlobals().concat(modKeys);
		const out = [];
		const seen = new Set();
		for (const n of all) {
			if (seen.has(n) || HOST_RESERVED.has(n) || GLOBAL_BLACKLIST.includes(n)) continue;
			if (n.startsWith('__KD')) continue;             // our own bridge/transfer slots
			seen.add(n);
			out.push(n);
		}
		return out;
	}

	/**
	 * Record the post-init fingerprint. Everything that later DIFFERS from this baseline is mutable,
	 * and therefore a per-player state candidate — which is how a feature or mod we have never heard
	 * of gets captured without anyone naming it.
	 *
	 * Taken at the END of init() on purpose: static data tables are already loaded, and no gameplay
	 * has happened, so "differs from baseline" means "gameplay touched it".
	 */
	_captureBaseline() {
		this._globalNames = this._candidateGlobals();
		// One pass produces all three things: the WATCH list (globals that could plausibly be player
		// state — serialisable and small), their hashes, and their post-init VALUES.
		//
		// The values are the per-player DEFAULTS, and they are what makes "absent from a bundle"
		// meaningful: without them, restoring a player who never touched a global leaves the PREVIOUS
		// player's value in the world — precisely the contamination this slice removes.
		//
		// Pre-filtering here is also what makes per-capture divergence checks affordable: the big
		// static data tables are excluded once, not re-serialised on every swap.
		const snap = this.eval(`(function(){
			${KD_CODEC}
			var names = ${JSON.stringify(this._globalNames)}, MAX = ${BASELINE_MAX_LEN};
			${KD_HASH_FN}
			var watch = [], h = {}, vals = {}, over = {};
			for (var i = 0; i < names.length; i++) {
				var n = names[i], v;
				try { v = eval(n); } catch (e) { continue; }
				if (v === undefined || typeof v === 'function') continue;
				try {
					var s = kdSer(v);
					if (s === undefined) continue;                     // unserialisable (PIXI/canvas)
					if (s.length > MAX) { over[n] = hash(s); continue; } // a static data table — see _auditOversize
					watch.push(n); h[n] = hash(s); vals[n] = JSON.parse(s);
				} catch (e) { /* cyclic / PIXI object — not player state */ }
			}
			return { watch: watch, h: h, vals: vals, over: over };
		})()`);
		this._watchNames = snap.watch;
		this._baseline = snap.h;
		this._baselineValues = snap.vals;
		this._oversize = snap.over;
		this._capturesSinceAudit = 0;
		// KDM-195: the audit is a round robin over _oversize, so a new baseline restarts the cycle.
		this._oversizeCursor = 0;
		this._lastAuditNames = null;
		this._oversizeChanged = [];
		return this._baseline;
	}

	/**
	 * Capture every watched global that has DIVERGED from the post-init baseline.
	 *
	 * Detection and extraction are fused into ONE pass: the baseline hashes go in, only the changed
	 * name→value pairs come back. Two earlier designs were tried and rejected by measurement:
	 *
	 *  - "classify once at boot" — unsound. Nothing has diverged at boot, so the set is empty forever.
	 *  - "re-discover every K captures" — unsound AND buggy. A capture must reflect what changed BY
	 *    THAT MOMENT; deferring it silently drops the most recent changes (proven: a mod's global was
	 *    never captured, so the peer inherited it).
	 *
	 * So divergence is computed on every capture. It is affordable because `_watchNames` is pre-filtered
	 * at baseline to the globals that could plausibly be player state — serialisable and small. The big
	 * static tables (enemy/restraint/spell defs) are skipped: they are shared world data by definition,
	 * and they are exactly what made an unbounded pass slow.
	 */
	_captureGlobals() {
		if (!this._baseline) this._captureBaseline();
		this._context.__KD_BASE_H = this._baseline;
		const out = this.eval(`(function(){
			${KD_CODEC}
			var names = ${JSON.stringify(this._watchNames)}, base = globalThis.__KD_BASE_H, out = {};
			${KD_HASH_FN}
			for (var i = 0; i < names.length; i++) {
				var n = names[i], v;
				try { v = eval(n); } catch (e) { continue; }
				if (v === undefined || typeof v === 'function') continue;
				try {
					var s = kdSer(v);
					if (s === undefined || s.length > ${BASELINE_MAX_LEN}) continue;
					if (hash(s) !== base[n]) out[n] = JSON.parse(s);   // diverged ⇒ this player's state
				} catch (e) { /* cyclic / PIXI — not player state */ }
			}
			return out;
		})()`);
		this._auditOversize();
		return out;
	}

	/**
	 * KDM-161/KDM-195: the size threshold must fail LOUDLY, not silently — affordably, and once per drift.
	 *
	 * Globals whose serialised form exceeds BASELINE_MAX_LEN are excluded from the watch set as static
	 * data tables (measured: every one of them is an enemy/restraint/spell/model definition table, and
	 * they are what made an unbounded pass slow). That reasoning is a classification, not a proof — so
	 * this re-hashes them periodically and reports any that actually changed. A silently-dropped
	 * per-player global is precisely the bug class this epic exists to remove; the same drift contract
	 * as the BUNDLE_PATCHES site counts in demo-server.js.
	 *
	 * KDM-195 fixed two ways that contract was being paid for badly, without weakening it:
	 *
	 *  - **Cost.** The pass was unbounded: 22 globals / 5.53 MB / 59-90 ms, synchronously, on the
	 *    request path of a single-threaded server. It is now a time-budgeted ROUND ROBIN — resume at
	 *    `_oversizeCursor`, spend at most OVERSIZE_AUDIT_BUDGET_MS, stop; the whole set is still
	 *    covered, just across several invocations. `force` restores the complete pass for diagnostics.
	 *  - **Signal.** The reported hash was never updated, so ONE append (ours — see the
	 *    `KinkyDungeonEnemies` blacklist entry) re-warned on every audit for the life of the process.
	 *    A reported name is now re-baselined, so each DISTINCT drift warns exactly once. A global that
	 *    really is per-player oscillates as players swap and therefore keeps warning, which is the case
	 *    the contract exists for. `_oversizeChanged` accumulates every name ever reported.
	 */
	_auditOversize(force = false) {
		if (!this._oversize) return null;
		if (!force && ++this._capturesSinceAudit < OVERSIZE_AUDIT_EVERY) return null;
		this._capturesSinceAudit = 0;

		const all = Object.keys(this._oversize);
		if (!all.length) { this._lastAuditNames = []; return []; }
		let start = this._oversizeCursor || 0;
		if (start >= all.length) start = 0;
		const order = force ? all : all.slice(start).concat(all.slice(0, start));

		this._context.__KD_OVER_H = this._oversize;
		const res = this.eval(`(function(){
			${KD_CODEC}
			var names = ${JSON.stringify(order)}, base = globalThis.__KD_OVER_H;
			var budget = ${force ? 0 : OVERSIZE_AUDIT_BUDGET_MS};
			${KD_HASH_FN}
			var t0 = Date.now(), done = [], changed = {};
			for (var i = 0; i < names.length; i++) {
				var n = names[i];
				done.push(n);
				var v; try { v = eval(n); } catch (e) { continue; }
				try {
					var s = kdSer(v);
					if (s !== undefined) { var h = hash(s); if (h !== base[n]) changed[n] = h; }
				} catch (e) { /* cyclic / PIXI — not player state */ }
				if (budget > 0 && (Date.now() - t0) >= budget) break;
			}
			return { done: done, changed: changed };
		})()`);

		this._lastAuditNames = res.done;
		this._oversizeCursor = force ? 0 : (start + res.done.length) % all.length;

		const changed = Object.keys(res.changed);
		if (changed.length) {
			// Re-baseline what is about to be reported: the alarm has been raised, and repeating it for
			// the same unchanged value is noise, not signal. Genuinely per-player state keeps changing,
			// so it keeps warning.
			for (const n of changed) this._oversize[n] = res.changed[n];
			const seen = new Set(this._oversizeChanged || []);
			changed.forEach((n) => seen.add(n));
			this._oversizeChanged = [...seen];
			// eslint-disable-next-line no-console
			console.warn(`[KDM-161] OVERSIZE GLOBAL CHANGED: ${changed.join(', ')} — excluded from ` +
				`per-player capture as a static data table (> ${BASELINE_MAX_LEN} bytes) but it MUTATED. ` +
				'Either it is shared world data (fine, blacklist it explicitly) or it is per-player state ' +
				'the swap is now losing. Do not ignore this.');
		}
		return changed;
	}

	/**
	 * Restore captured per-player globals by bare assignment (reaches script-scope `let`s).
	 *
	 * Crucially this also RESETS every mutable global the bundle does NOT carry back to its post-init
	 * default. Assignment alone is not enough: the world keeps whatever the previously swapped-in
	 * player left there, so a player who never touched a global would inherit their opponent's value.
	 * That is the whole contamination bug class, and "absent ⇒ default" is what closes it.
	 */
	_restoreGlobals(globals) {
		if (!globals) return false;
		if (!this._baseline) this._captureBaseline();
		this._context.__KD_GLOBALS = globals;
		this._context.__KD_BASE_H = this._baseline;
		this._context.__KD_BASE_V = this._baselineValues;
		return this.eval(`(function(){
			${KD_CODEC}
			var g = globalThis.__KD_GLOBALS, base = globalThis.__KD_BASE_H, defs = globalThis.__KD_BASE_V;
			var names = ${JSON.stringify(this._watchNames)};
			if (!g) return false;
			${KD_HASH_FN}
			// Bare assignment inside this direct eval targets the bundle's own binding — the same
			// mechanism the mod system and _neuterRendering rely on.
			// A __kdT tag can only sit at the TOP level (kdEnc is applied only to top-level Map/Set), so
			// this O(1) test is enough — untagged values keep the plain, cheap path.
			// ⚠️ COPY, never alias. \`g\` is the player's stored bundle and \`defs\` the stored post-init
			// defaults; both live on the host and outlive this call. Assigning one of their objects
			// directly hands the game a reference it then MUTATES IN PLACE — the bundle and the baseline
			// defaults silently become whatever the world did next, and two players can end up sharing
			// one object. MEASURED: this collapsed a peer's KinkyDungeonPlayerEntity onto the baseline
			// default, parking them at the map origin for the rest of the session (a bump-attack landed
			// once, then the victim was somewhere else forever). The old hand-written restore happened to
			// mask it by overwriting the entity with a fresh JSON clone on every swap; nothing masks it now.
			// kdDec already builds fresh values, so only the untagged path needs the clone.
			function assign(n, val){
				try {
					var out = val;
					if (val && typeof val === 'object') out = val.__kdT ? kdDec(val) : JSON.parse(JSON.stringify(val));
					globalThis.__KD_V = out;
					eval(n + ' = globalThis.__KD_V;');
				} catch (e) { /* not assignable */ }
			}
			var n, i;
			for (n in g) assign(n, g[n]);
			// Anything this player does NOT carry must go back to its post-init DEFAULT, not stay at
			// whatever the previous player left. Only touch globals that are currently dirty — resetting
			// all ~2300 watched names on every swap would be pure waste.
			for (i = 0; i < names.length; i++) {
				n = names[i];
				if (Object.prototype.hasOwnProperty.call(g, n)) continue;
				if (!Object.prototype.hasOwnProperty.call(defs, n)) continue;
				var v;
				try { v = eval(n); } catch (e) { continue; }
				if (v === undefined || typeof v === 'function') continue;
				try {
					var s = kdSer(v);
					if (s === undefined || s.length > ${BASELINE_MAX_LEN}) continue;
					if (hash(s) !== base[n]) assign(n, defs[n]);   // dirty from another player ⇒ reset
				} catch (e) { /* skip */ }
			}
			return true;
		})()`);
	}

	/**
	 * KDM-160: this player's state as KD's OWN save format, minus the shared world (WORLD_KEYS).
	 *
	 * The measuring instrument for the epic's invariants: an upstream-maintained, versioned, complete
	 * definition of what a player IS (56 top-level keys) — as opposed to the hand-picked subset
	 * capturePlayer carries. Use it to answer "did the swap lose anything?" (parity) and "did one
	 * player contaminate another?" (non-interference).
	 *
	 * READ-ONLY: measured to leave tick, player position, entity count and KinkyDungeonEnemyID
	 * untouched, and to return identical results on consecutive calls (~1 ms). GenerateSaveData does
	 * rebuild KDMapData.RandomPathablePoints via KinkyDungeonGenNavMap, but that is a deterministic
	 * derived cache and the rebuild is inert.
	 *
	 * NOTE: reads whatever player is currently in the player slot — call restorePlayer(bundle) first
	 * when you want a specific player's save.
	 */
	saveOf() {
		this._seedHeadlessModel();
		const save = this.eval(`(function(){
			var s = KinkyDungeonGenerateSaveData();
			return JSON.parse(JSON.stringify(s));
		})()`);
		for (const k of WORLD_KEYS) delete save[k];
		return save;
	}

	// ----- per-player state swap (KD-085 uniform action model) -----------------

	/**
	 * Capture the CURRENT player's state bundle (everything that defines a player, EXCLUDING the
	 * shared world). Used by the swap model: one authoritative world, players swapped in/out per turn.
	 * JSON-safe, so it can go over the wire unchanged.
	 *
	 * KDM-161 AC1: there is NO hand-written list of player globals here any more. It used to name ~20
	 * of them plus a 12-key KDGameData sub-list, and that list could only ever be as complete as our
	 * knowledge of a 280-file moving target — every KDM-156 bug was a hole in it. Both halves are now
	 * inversions:
	 *
	 *   globals  — everything that DIVERGED from the post-init baseline, minus a category blacklist
	 *              (world / render / audio). New state, including a mod's, is carried without being named.
	 *   gameData — KDGameData whole, minus KDGAMEDATA_WORLD_KEYS on restore (KDM-160). Its own path
	 *              because no mechanical rule can split per-player Guilt from world GuardSpawnTimer,
	 *              and because at 27 KB it is over the divergence path's size threshold. This is the
	 *              epic's one declared, bounded exception — not a whitelist reintroduced.
	 */
	capturePlayer() {
		return {
			v: 1,
			gameData: this.eval(
				'(typeof KDGameData !== "undefined") ? JSON.parse(JSON.stringify(KDGameData)) : undefined'),
			globals: this._captureGlobals(),
		};
	}

	/**
	 * Restore a player-state bundle into the world's player globals (swap-in).
	 *
	 * KDM-161 AC1: the ~20 hand-written assignments that used to live here are gone. What remains is
	 * the two inversions plus one recompute — see capturePlayer for why each is not a whitelist.
	 * Generic globals go first so the derived recompute at the end still has the last word.
	 */
	restorePlayer(bundle) {
		if (bundle && bundle.globals) this._restoreGlobals(bundle.globals);
		this._context.__KD_PB = bundle;
		return this.eval(`(function(){
			var b = globalThis.__KD_PB; if (!b) return false;
			// KDM-160: restore every captured KDGameData key EXCEPT the world-scoped ones.
			// Inverted from a 12-key allow-list; see capturePlayer and KDGAMEDATA_WORLD_KEYS.
			if (b.gameData && typeof KDGameData !== 'undefined') {
				var __world = ${JSON.stringify(KDGAMEDATA_WORLD_KEYS)};
				for (var gk in b.gameData) {
					if (b.gameData[gk] === undefined) continue;
					if (__world.indexOf(gk) >= 0) continue;   // shared floor/world state — leave the world's
					KDGameData[gk] = b.gameData[gk];
				}
			}
			// Re-derive the swapped-in player's slow from THEIR restraints. KinkyDungeonSlowLevel is a
			// world global that KinkyDungeonCalculateSlowLevel writes for whoever is currently in the
			// player slot; without this it survives the swap and the next player inherits a stranger's
			// hobble ("You are slowed!" on the unbound partner). Derived state, so recompute rather
			// than carry it in the bundle — it can never go stale that way.
			if (typeof KinkyDungeonCalculateSlowLevel === 'function') KinkyDungeonCalculateSlowLevel(0);
			if (typeof KDUpdateEnemyCache !== 'undefined') KDUpdateEnemyCache = true;
			return true;
		})()`);
	}

	/**
	 * Run a player input through KD's REAL dispatcher (the swap model's uniform action
	 * path). `type`/`data` are KD's own input types (move/doattack/struggle/…). The
	 * acting player must be swapped in first (restorePlayer). Returns the dispatcher result.
	 */
	applyInput(type, data) {
		this._context.__KD_INDATA = (data === undefined) ? {} : data;
		return this.eval(`(function(){
			${KD_ENT_RESOLVE}
			return __kdDispatch(${JSON.stringify(type)});
		})()`);
	}

	/**
	 * KDM-163 (option A): run an input for real and REPORT whether it advanced the shared turn.
	 *
	 * This is what lets the server route every input without a whitelist — the game itself says
	 * whether an input is turn-consuming, by calling KinkyDungeonAdvanceTime. The caller caches that
	 * per type (SwapSession), so a mod's input needs no list anywhere.
	 *
	 * ⚠️ It OBSERVES; it must never BLOCK. A blocking "probe, then roll back if it turned out to be
	 * turn-consuming" version was implemented and REJECTED by measurement:
	 *   - probes/probe9 tested move/tick/crouch/setMoveDirection/toggleSpell/inventoryAction/select and
	 *     found a player-bundle rollback sufficient — but every one of those is player-local;
	 *   - probes/probe11 then tested `doattack`, which damages ANOTHER ENTITY before reaching
	 *     AdvanceTime: the probe took the Rat from hp 1 to -0.575 and the player-only rollback did NOT
	 *     undo it, so the lockstep replay would have applied the attack a SECOND time.
	 * Undoing that properly needs a whole-world rollback (KDMapData + live Enemy defs), which is both
	 * expensive and exactly the kind of thing that breaks the per-turn pass. Observing costs nothing
	 * and is exactly-once by construction.
	 *
	 * `unknownType` reports that the game's own registry has no handler at all, which is how an input
	 * stops being silently dropped (AC3) without anyone maintaining a list of valid types.
	 */
	applyInputObserved(type, data) {
		this._context.__KD_INDATA = (data === undefined) ? {} : data;
		return this.eval(`(function(){
			${KD_ENT_RESOLVE}
			var known = (typeof KDInputTypes !== 'undefined' && KDInputTypes) ? !!KDInputTypes[${JSON.stringify(type)}] : false;
			var advanced = 0, res = null, err = null;
			var orig = KinkyDungeonAdvanceTime;
			// OBSERVE, never block. Blocking was tried and rejected — see the doc comment above.
			KinkyDungeonAdvanceTime = function(delta){
				if ((delta|0) > 0) advanced += 1;
				return orig.apply(this, arguments);
			};
			try { res = __kdDispatch(${JSON.stringify(type)}); }
			catch (e) { err = String((e && e.message) || e); }
			finally { KinkyDungeonAdvanceTime = orig; }
			return { advanced: advanced, result: (typeof res === 'string') ? res : null, error: err, unknownType: !known };
		})()`);
	}

	/** Serialize full game state via the bundle's own save path. */
	serialize() {
		return this.eval('KinkyDungeonGenerateSaveData()');
	}

	/** Load a previously-serialized save. */
	loadState(save) {
		this._context.__KD_SAVE_IN = save;
		return this.eval('KinkyDungeonLoadGameDataObject ? KinkyDungeonLoadGameDataObject(globalThis.__KD_SAVE_IN) : KinkyDungeonLoadGame(globalThis.__KD_SAVE_IN)');
	}

	/** A small JSON-safe snapshot for assertions/reconciliation. */
	getState() {
		return this.eval(`(function(){
			return {
				tick: KinkyDungeonCurrentTick,
				player: KinkyDungeonPlayerEntity ? {
					x: KinkyDungeonPlayerEntity.x,
					y: KinkyDungeonPlayerEntity.y,
					hp: KinkyDungeonPlayerEntity.hp,
				} : null,
				enemyCount: (typeof KinkyDungeonEntities !== 'undefined' && KinkyDungeonEntities) ? KinkyDungeonEntities.length : 0,
			};
		})()`);
	}
}

module.exports = {
	HeadlessHost, loadSources, REPO_ROOT, BUNDLE_PATH,
	WORLD_KEYS, KDGAMEDATA_WORLD_KEYS,
	deriveBundleGlobals, GLOBAL_BLACKLIST, MIN_EXPECTED_GLOBALS, HOST_RESERVED,
	BASELINE_MAX_LEN, OVERSIZE_AUDIT_EVERY, OVERSIZE_AUDIT_BUDGET_MS,
};
