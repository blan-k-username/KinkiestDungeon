/**
 * tools/mp-server/client/render-client.js  (KD-071, epic mp-mvp / KD-066)
 *
 * The BROWSER thin-client core. A real player's browser runs the stock KD bundle
 * but, instead of simulating, it APPLIES the server's render-state snapshot to the
 * render globals each turn and lets the stock renderer draw it. Input is forwarded
 * up to the server; no gameplay simulation runs client-side.
 *
 * This is a classic (non-module) script: it shares the global lexical scope with
 * out/main.js, so it can read/assign the bundle's top-level `let` globals directly
 * (the same property KD's own files rely on). Load it AFTER out/main.js.
 *
 * Snapshot shape === HeadlessHost.serializeRenderState() (render-state v1, KD-067),
 * so a server snapshot applies verbatim. Mirror any field changes in both places.
 *
 * Exposes `window.KDRenderClient`:
 *   serialize()            → a render-state snapshot of the current globals
 *   apply(snap)            → adopt a snapshot onto the render globals (NO sim)
 *   disableLocalSim()      → mark this instance render-only (route input, block local sim)
 *   isLocalSimDisabled()   → whether disableLocalSim() has been applied
 *   onInput(cb) / sendInput(action) → input forwarding plumbing (transport-agnostic)
 */
(function () {
	'use strict';

	function clone(o) { try { return (o === undefined) ? undefined : JSON.parse(JSON.stringify(o)); } catch (e) { return null; } }

	var ENT_FIELDS = ['id', 'x', 'y', 'visual_x', 'visual_y', 'offX', 'offY', 'scaleX', 'scaleY', 'flip', 'hp', 'visual_hp', 'boundLevel', 'distraction', 'revealed', 'player', 'CustomSprite', 'CustomName', 'CustomNameColor', 'style', 'outfit', 'outfitBound'];

	function entSnap(e) {
		var o = {};
		for (var i = 0; i < ENT_FIELDS.length; i++) { var k = ENT_FIELDS[i]; if (e[k] !== undefined) o[k] = e[k]; }
		o.enemyName = (e.Enemy && e.Enemy.name) || undefined;
		var b = clone(e.buffs); if (b) o.buffs = b;
		return o;
	}

	var inputCb = null;
	var clientMode = false;   // closure flag — NOT the game-source KDServerRole (reverted, KD-085)

	// Turn-consuming gameplay inputs are ROUTED to the server (the authoritative world
	// runs them through KD's REAL dispatcher). Everything else (menu/choice/toggle:
	// spellChoice, itemChoice, select, dialogue, toggleSpell, setMoveDirection, …) keeps
	// running LOCALLY so local-only UI stays responsive (R6). The KinkyDungeonAdvanceTime
	// guard backstops any un-classified type from advancing the local turn (R1).
	var ROUTED_INPUTS = {
		move: 1, movestairs: 1, doattack: 1, dospecial: 1, doaggro: 1,
		tick: 1, struggle: 1, interact: 1,
	};

	/**
	 * Best-effort JSON-safe clone of an input's data: drops circular refs and maps
	 * entity refs (objects carrying an `id`/`Enemy`) down to `{id}` (or `{x,y}` if no
	 * id) so the wire payload stays small + serializable. Targeted actions/spells carry
	 * live entity object refs that JSON can't ship verbatim.
	 */
	function sanitizeInputData(data) {
		if (data == null || typeof data !== 'object') return data;
		var seen = [];
		function repl(key, val) {
			if (val && typeof val === 'object') {
				if (seen.indexOf(val) >= 0) return undefined;          // drop cycles
				if (val.Enemy || (val.id !== undefined && val.hp !== undefined)) {
					return (val.id !== undefined) ? { id: val.id } : { x: val.x, y: val.y };
				}
				seen.push(val);
			}
			return val;
		}
		try { return JSON.parse(JSON.stringify(data, repl)); } catch (e) { return {}; }
	}

	/**
	 * Ensure the `RemotePlayer` avatar enemy-def exists in THIS browser. The server
	 * represents each other player as a `RemotePlayer` ally entity; the snapshot only
	 * carries `enemyName`, and apply() re-links the def by name. The stock browser
	 * bundle has no such def → the draw path (KDEnemyRank reads `.tags`) crashes. Push
	 * the same minimal def the headless host uses (mod-style, once).
	 */
	function ensureAvatarDef() {
		if (typeof KinkyDungeonEnemies === 'undefined' || typeof KinkyDungeonGetEnemyByName !== 'function') return;
		if (KinkyDungeonGetEnemyByName('RemotePlayer')) return;
		KinkyDungeonEnemies.push({
			name: 'RemotePlayer', faction: 'Player', tags: KDMapInit(['peaceful']),
			AI: 'guard', immobile: true, visionRadius: 0, maxhp: 100, minLevel: 0, weight: -1000,
			movePoints: 1000, attackPoints: 0, attack: '', attackRange: 0,
			evasion: -100, armor: 0, followRange: 100, lowpriority: true,
			style: 'BlueHair', // render the peer as a full character (NPC sprite path)
			terrainTags: {}, floors: KDMapInit([]),
		});
		if (typeof KinkyDungeonRefreshEnemiesCache === 'function') KinkyDungeonRefreshEnemiesCache();
	}

	var KDRenderClient = {
		/** Snapshot the current render globals (render-state v1). Mirrors the host. */
		serialize: function () {
			var M = KDMapData;
			var X = (typeof KDMapExtraData !== 'undefined' && KDMapExtraData) ? KDMapExtraData : {};
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
				},
				// full authoritative map (adopted wholesale on apply) — see headless-host
				map: clone(KDMapData),
				messages: {
					log: clone(KinkyDungeonMessageLog) || [],
					action: (typeof KinkyDungeonActionMessage !== 'undefined') ? KinkyDungeonActionMessage : '',
					actionTime: (typeof KinkyDungeonActionMessageTime !== 'undefined') ? KinkyDungeonActionMessageTime : 0,
					actionColor: (typeof KinkyDungeonActionMessageColor !== 'undefined') ? KinkyDungeonActionMessageColor : '#ffffff',
				},
				restraints: (typeof KinkyDungeonAllRestraint === 'function') ? KinkyDungeonAllRestraint().map(function (r) { return { name: r.name, id: r.id }; }) : [],
				buffs: clone(typeof KinkyDungeonPlayerBuffs !== 'undefined' ? KinkyDungeonPlayerBuffs : {}),
				level: (typeof MiniGameKinkyDungeonLevel !== 'undefined') ? MiniGameKinkyDungeonLevel : 1,
				checkpoint: (typeof MiniGameKinkyDungeonCheckpoint !== 'undefined') ? MiniGameKinkyDungeonCheckpoint : 'grv',
			};
		},

		/** Adopt a render-state snapshot onto the render globals. NO simulation. */
		apply: function (s) {
			if (!s) return { ok: false, error: 'no snapshot' };
			ensureAvatarDef();   // so peer avatars (RemotePlayer) re-link to a real def
			// NOTE: deliberately IGNORE s.camera. The snapshot's camera/grid-size come
			// from the HEADLESS server (no real screen → bogus scale), and adopting them
			// distorts the client's rendering. The browser keeps its OWN window-based
			// KinkyDungeonGridSizeDisplay and recomputes the camera each frame to centre
			// on its player. (Camera stays in the snapshot for the node round-trip test.)
			KinkyDungeonStatWill = s.stats.will; KinkyDungeonStatWillMax = s.stats.willMax;
			KinkyDungeonStatStamina = s.stats.stamina; KinkyDungeonStatStaminaMax = s.stats.staminaMax;
			KinkyDungeonStatMana = s.stats.mana; KinkyDungeonStatManaMax = s.stats.manaMax;
			if (typeof KinkyDungeonStatManaPool !== 'undefined') KinkyDungeonStatManaPool = s.stats.manaPool;
			KinkyDungeonStatDistraction = s.stats.distraction; KinkyDungeonStatDistractionMax = s.stats.distractionMax;
			if (typeof KinkyDungeonStatDistractionLower !== 'undefined') KinkyDungeonStatDistractionLower = s.stats.distractionLower;
			// adopt the authoritative KDMapData WHOLESALE (internally consistent — a
			// field-subset splice over the client's local map renders broken). Entities
			// carry their full Enemy defs in the clone, so no def re-link is needed.
			// Vision/light (KDMapExtraData) is recomputed locally (pinGameScreen flags it).
			if (s.map) KDMapData = s.map;
			if (typeof KDUpdateEnemyCache !== 'undefined') KDUpdateEnemyCache = true;
			if (s.player && KinkyDungeonPlayerEntity) {
				for (var k in s.player) { if (k !== 'enemyName' && k !== 'Enemy') KinkyDungeonPlayerEntity[k] = s.player[k]; }
			}
			KinkyDungeonMessageLog = s.messages.log || [];
			if (typeof KinkyDungeonActionMessage !== 'undefined') KinkyDungeonActionMessage = s.messages.action;
			if (typeof KinkyDungeonActionMessageTime !== 'undefined') KinkyDungeonActionMessageTime = s.messages.actionTime;
			if (typeof KinkyDungeonActionMessageColor !== 'undefined') KinkyDungeonActionMessageColor = s.messages.actionColor;
			if (typeof MiniGameKinkyDungeonLevel !== 'undefined') MiniGameKinkyDungeonLevel = s.level;
			if (s.checkpoint && typeof MiniGameKinkyDungeonCheckpoint !== 'undefined') MiniGameKinkyDungeonCheckpoint = s.checkpoint;
			return { ok: true, entities: KDMapData.Entities.length };
		},

		/**
		 * Mark this browser instance as render-only: it must not simulate gameplay.
		 * Uses a closure flag (NOT the game-source KDServerRole — that source edit was
		 * reverted in KD-085; the client is pure monkey-patch). The server is
		 * authoritative; the client never resolves an action or advances a turn locally.
		 */
		disableLocalSim: function () {
			clientMode = true;
			// Belt-and-suspenders (R1): block ALL local turn advance — nothing the player
			// does may advance the turn locally, so an un-routed gameplay input can't drift
			// this client into its "own world".
			if (typeof KinkyDungeonAdvanceTime === 'function' && !KinkyDungeonAdvanceTime.__kdClientGuard) {
				var _origAdvance = KinkyDungeonAdvanceTime;
				KinkyDungeonAdvanceTime = function (delta) {
					if (clientMode && (delta | 0) > 0) return; // no local turn advance
					return _origAdvance.apply(this, arguments);
				};
				KinkyDungeonAdvanceTime.__kdClientGuard = true;
			}
			if (typeof KDSendInput === 'function' && !KDSendInput.__kdClientGuard) {
				var _origSend = KDSendInput;
				// ROUTE the real dispatcher (KD-085): KD's own key/click handlers call
				// KDSendInput(type,data) for the default controls — for turn-consuming
				// gameplay we forward {kdType,data} to the server (authoritative) and DON'T
				// run it locally. Local-only UI (menus/choices) still dispatches locally (R6).
				KDSendInput = function (type, data) {
					if (clientMode && ROUTED_INPUTS[type]) {
						KDRenderClient.sendInput({ kdType: type, data: sanitizeInputData(data) });
						return '';
					}
					return _origSend.apply(this, arguments);
				};
				KDSendInput.__kdClientGuard = true;
			}
			return clientMode;
		},

		/** True once disableLocalSim() has marked this browser render-only (KD-085). */
		isLocalSimDisabled: function () { return clientMode; },

		/** Register a callback invoked when local input should be sent to the server. */
		onInput: function (cb) { inputCb = cb; },

		/** Forward a player action (e.g. {dx,dy}) to the server via the registered cb. */
		sendInput: function (action) { if (inputCb) inputCb(action); return action; },
	};

	(typeof window !== 'undefined' ? window : globalThis).KDRenderClient = KDRenderClient;
})();
