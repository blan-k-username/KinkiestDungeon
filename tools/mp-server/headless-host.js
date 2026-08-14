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
		}; })()`);
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
			var ENT_FIELDS = ['id','x','y','visual_x','visual_y','offX','offY','scaleX','scaleY','flip','hp','visual_hp','boundLevel','distraction','revealed','player','CustomSprite','CustomName','CustomNameColor','style','outfit','outfitBound'];
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
				stats: {
					will: KinkyDungeonStatWill, willMax: KinkyDungeonStatWillMax,
					stamina: KinkyDungeonStatStamina, staminaMax: KinkyDungeonStatStaminaMax,
					mana: KinkyDungeonStatMana, manaMax: KinkyDungeonStatManaMax,
					manaPool: (typeof KinkyDungeonStatManaPool !== 'undefined') ? KinkyDungeonStatManaPool : 0,
					distraction: KinkyDungeonStatDistraction, distractionMax: KinkyDungeonStatDistractionMax,
					distractionLower: (typeof KinkyDungeonStatDistractionLower !== 'undefined') ? KinkyDungeonStatDistractionLower : 0,
					// Movement-cost state. The client DRAWS the "xN" move reticule itself
					// (KinkyDungeonDraw.ts:1581) from KDGameData.MovePoints and the tile cost derived
					// from KinkyDungeonSlowLevel. Anything the client renders has to be in this
					// contract; while these were missing it drew its own untouched defaults and
					// always said x1 — contradicting the "You are slowed!" line beside it.
					// Recomputed, not read ambient: KinkyDungeonSlowLevel is a world global holding
					// whoever was last in the player slot, and this snapshot must describe THIS player.
					slowLevel: (function(){
						if (typeof KinkyDungeonCalculateSlowLevel === 'function') KinkyDungeonCalculateSlowLevel(0);
						return (typeof KinkyDungeonSlowLevel !== 'undefined') ? KinkyDungeonSlowLevel : 0;
					})(),
					movePoints: (typeof KDGameData !== 'undefined' && KDGameData) ? KDGameData.MovePoints : null,
					slowMoveTurns: (typeof KDGameData !== 'undefined' && KDGameData) ? KDGameData.SlowMoveTurns : null,
					sprintTurns: (typeof KDGameData !== 'undefined' && KDGameData) ? KDGameData.SprintTurns : null,
				},
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
			// HUD stats
			KinkyDungeonStatWill = s.stats.will; KinkyDungeonStatWillMax = s.stats.willMax;
			KinkyDungeonStatStamina = s.stats.stamina; KinkyDungeonStatStaminaMax = s.stats.staminaMax;
			KinkyDungeonStatMana = s.stats.mana; KinkyDungeonStatManaMax = s.stats.manaMax;
			if (typeof KinkyDungeonStatManaPool !== 'undefined') KinkyDungeonStatManaPool = s.stats.manaPool;
			KinkyDungeonStatDistraction = s.stats.distraction; KinkyDungeonStatDistractionMax = s.stats.distractionMax;
			if (typeof KinkyDungeonStatDistractionLower !== 'undefined') KinkyDungeonStatDistractionLower = s.stats.distractionLower;
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
	 * Capture the CURRENT player's state bundle (everything that defines a player,
	 * EXCLUDING the shared world map + render-derived poses/appearance). Mirrors the
	 * player portion of KinkyDungeonGenerateSaveData. Used by the swap model: one
	 * authoritative world, players swapped in/out per turn. JSON-safe.
	 */
	capturePlayer() {
		return this.eval(`(function(){
			function clone(o){ try{ return o===undefined?undefined:JSON.parse(JSON.stringify(o)); }catch(e){ return null; } }
			function m2o(m){ var o={}; if(m&&m.forEach) m.forEach(function(v,k){ o[k]=(v&&v.forEach)?m2o(v):clone(v); }); return o; }
			return {
				v: 1,
				player: clone(KinkyDungeonPlayerEntity),
				stats: {
					stamina: KinkyDungeonStatStamina, staminaMax: KinkyDungeonStatStaminaMax,
					mana: KinkyDungeonStatMana, manaMax: KinkyDungeonStatManaMax, manaPool: KinkyDungeonStatManaPool,
					will: KinkyDungeonStatWill, willMax: KinkyDungeonStatWillMax,
					distraction: KinkyDungeonStatDistraction, distractionMax: KinkyDungeonStatDistractionMax, distractionLower: KinkyDungeonStatDistractionLower,
				},
				buffs: clone(KinkyDungeonPlayerBuffs),
				inventory: m2o(KinkyDungeonInventory),
				flags: (typeof KinkyDungeonFlags !== 'undefined' && KinkyDungeonFlags.forEach) ? Array.from(KinkyDungeonFlags) : [],
				perks: (typeof KinkyDungeonStatsChoice !== 'undefined' && KinkyDungeonStatsChoice.forEach) ? Array.from(KinkyDungeonStatsChoice) : [],
				gold: (typeof KinkyDungeonGold !== 'undefined') ? KinkyDungeonGold : 0,
				points: (typeof KinkyDungeonSpellPoints !== 'undefined') ? KinkyDungeonSpellPoints : 0,
				weapon: (typeof KinkyDungeonPlayerWeapon !== 'undefined') ? KinkyDungeonPlayerWeapon : undefined,
				spellChoices: (typeof KinkyDungeonSpellChoices !== 'undefined') ? clone(KinkyDungeonSpellChoices) : undefined,
				// KD-091: non-self-healing per-player state (the restraint-DERIVED locks self-heal
				// from inventory each turn, so they're omitted on purpose — these do NOT).
				spells: (typeof KinkyDungeonSpells !== 'undefined') ? clone(KinkyDungeonSpells) : undefined,
				statusCounters: {
					bind: (typeof KinkyDungeonStatBind !== 'undefined') ? KinkyDungeonStatBind : undefined,
					freeze: (typeof KinkyDungeonStatFreeze !== 'undefined') ? KinkyDungeonStatFreeze : undefined,
					sleepiness: (typeof KinkyDungeonSleepiness !== 'undefined') ? KinkyDungeonSleepiness : undefined,
				},
				// KDM-160: capture KDGameData WHOLE — no key list.
				//
				// This used to name 12 keys by hand. KDGameData has 221, so the other 209 stayed on
				// the shared world and belonged to whoever was swapped in last: 76 of 108 probed
				// primitive fields leaked between players (proven by mp-noninterference.spec.ts),
				// including ShieldTokens/DodgeTokens/BlockTokens, Crouch, Guilt, CurseLevel,
				// CollectedOrbs, TimesJailed — plus never-restored objects like RevealedFog/
				// RevealedTiles (per-player VISION), Party, NPCRestraints and PlayerName/PlayerPronoun
				// (both players shared one name).
				//
				// Extending the list to 209 entries was rejected: it is the anti-pattern this work
				// exists to remove, and it would still be wrong the moment upstream adds field 222.
				// The world-scoped minority is excluded on RESTORE instead (KDGAMEDATA_WORLD_KEYS) —
				// one short semantic list in place of a long unknowable one.
				gameData: (typeof KDGameData !== 'undefined') ? clone(KDGameData) : undefined,
			};
		})()`);
	}

	/** Restore a player-state bundle into the world's player globals (swap-in). */
	restorePlayer(bundle) {
		this._context.__KD_PB = bundle;
		return this.eval(`(function(){
			var b = globalThis.__KD_PB; if (!b) return false;
			if (b.player) KinkyDungeonPlayerEntity = JSON.parse(JSON.stringify(b.player));
			var s = b.stats || {};
			KinkyDungeonStatStamina = s.stamina; KinkyDungeonStatStaminaMax = s.staminaMax;
			KinkyDungeonStatMana = s.mana; KinkyDungeonStatManaMax = s.manaMax; KinkyDungeonStatManaPool = s.manaPool;
			KinkyDungeonStatWill = s.will; KinkyDungeonStatWillMax = s.willMax;
			KinkyDungeonStatDistraction = s.distraction; KinkyDungeonStatDistractionMax = s.distractionMax; KinkyDungeonStatDistractionLower = s.distractionLower;
			KinkyDungeonPlayerBuffs = b.buffs ? JSON.parse(JSON.stringify(b.buffs)) : {};
			var inv = new Map(); var io = b.inventory || {};
			for (var t in io) { var sub = new Map(); var st = io[t]; for (var n in st) sub.set(n, JSON.parse(JSON.stringify(st[n]))); inv.set(t, sub); }
			KinkyDungeonInventory = inv;
			if (b.flags && typeof KinkyDungeonFlags !== 'undefined') KinkyDungeonFlags = new Map(b.flags);
			if (b.perks && typeof KinkyDungeonStatsChoice !== 'undefined') KinkyDungeonStatsChoice = new Map(b.perks);
			if (typeof KinkyDungeonGold !== 'undefined') KinkyDungeonGold = b.gold;
			if (typeof KinkyDungeonSpellPoints !== 'undefined') KinkyDungeonSpellPoints = b.points;
			if (b.weapon !== undefined && typeof KinkyDungeonPlayerWeapon !== 'undefined') KinkyDungeonPlayerWeapon = b.weapon;
			if (b.spellChoices !== undefined && typeof KinkyDungeonSpellChoices !== 'undefined') KinkyDungeonSpellChoices = JSON.parse(JSON.stringify(b.spellChoices));
			// KD-091: restore the non-self-healing per-player state.
			if (b.spells !== undefined && typeof KinkyDungeonSpells !== 'undefined') KinkyDungeonSpells = JSON.parse(JSON.stringify(b.spells));
			var sc = b.statusCounters || {};
			if (sc.bind !== undefined && typeof KinkyDungeonStatBind !== 'undefined') KinkyDungeonStatBind = sc.bind;
			if (sc.freeze !== undefined && typeof KinkyDungeonStatFreeze !== 'undefined') KinkyDungeonStatFreeze = sc.freeze;
			if (sc.sleepiness !== undefined && typeof KinkyDungeonSleepiness !== 'undefined') KinkyDungeonSleepiness = sc.sleepiness;
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
			// Re-resolve client entity placeholders (KD-088): the thin client can't ship
			// live entity object refs, so it sends {__kdEnt:id} (or {__kdEnt:'player'}).
			// Replace them with THIS world's authoritative entities before dispatch.
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
			var d = resolve(globalThis.__KD_INDATA);
			if (typeof KDSendInput === 'function') return KDSendInput(${JSON.stringify(type)}, d);
			if (typeof KDProcessInput === 'function') return KDProcessInput(${JSON.stringify(type)}, d);
			return null;
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
};
