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
		// Capture the stock enemy-AI tick so serverMode can toggle it on/off.
		this.eval('globalThis.__KD_origUpdateEnemies = KinkyDungeonUpdateEnemies;');
		return this;
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
	 * Gate shared-entity (enemy) AI. 'world' instances run it; 'player' instances
	 * suppress it. Implemented by toggling the reassignable KinkyDungeonUpdateEnemies
	 * global (mod-style override, no source edit). This is the minimal flag the
	 * production KD-068 will formalize.
	 */
	setServerMode(mode) {
		this.serverMode = (mode === 'player') ? 'player' : 'world';
		if (this.serverMode === 'player') {
			this.eval('KinkyDungeonUpdateEnemies = function(){ return; };');
		} else {
			this.eval('KinkyDungeonUpdateEnemies = globalThis.__KD_origUpdateEnemies;');
		}
		return this.serverMode;
	}

	/** True if this instance runs shared-entity AI (world role). */
	runsEnemyAI() {
		return this.eval('KinkyDungeonUpdateEnemies !== (function(){return;}) && KinkyDungeonUpdateEnemies === globalThis.__KD_origUpdateEnemies');
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
					AI: 'guard', immobile: true, visionRadius: 0, maxhp: 100, minLevel: 0, weight: -1000,
					movePoints: 1000, attackPoints: 0, attack: '', attackRange: 0,
					evasion: -100, armor: 0, followRange: 100, lowpriority: true,
					terrainTags: {}, floors: KDMapInit([]),
				});
				if (typeof KinkyDungeonRefreshEnemiesCache === 'function') KinkyDungeonRefreshEnemiesCache();
			}
			return true;
		})()`);
	}

	/**
	 * Inject an avatar entity representing another player at (x,y). Returns the
	 * real KD entity id (the engine now sees/targets/collides with it).
	 */
	spawnAvatar(x, y) {
		this._ensureAvatarDef();
		return this.eval(`(function(){
			var def = KinkyDungeonGetEnemyByName('RemotePlayer');
			var ent = { id: KinkyDungeonGetEnemyID(), Enemy: def, x: ${x | 0}, y: ${y | 0}, hp: 100, movePoints: 0, attackPoints: 0 };
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

module.exports = { HeadlessHost, loadSources, REPO_ROOT, BUNDLE_PATH };
