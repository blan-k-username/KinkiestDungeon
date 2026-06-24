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

	// Input classification (KD-085/088). KD funnels every action through KDSendInput;
	// under the thin client we split it three ways:
	//   ROUTED    — turn-consuming gameplay: forward {kdType,data} to the authoritative
	//               server (it replays through KD's REAL dispatcher). NOT run locally.
	//   LOCAL_UI  — menus/choices/toggles that don't advance the shared turn: run LOCALLY
	//               so UI stays responsive (R6).
	//   (other)   — unknown type: SWALLOW (don't run locally, don't send) — no divergence.
	// The KinkyDungeonAdvanceTime guard backstops anything that slips through (R1).
	var ROUTED_INPUTS = {
		// movement / combat
		move: 1, movestairs: 1, doattack: 1, dospecial: 1, doaggro: 1, docapture: 1, swipe: 1,
		tick: 1, crouch: 1, noise: 1, sleep: 1, scan: 1,
		// restraints / struggle
		struggle: 1, struggleCurse: 1, curseUnlock: 1, quickRestraint: 1,
		equip: 1, equipRestraintGeneric: 1, dress: 1,
		// items / weapons
		consumable: 1, drop: 1, switchWeapon: 1, unequipWeapon: 1, offhandswitch: 1,
		// world / locks / interact
		interact: 1, pick: 1, unlock: 1, commandunlock: 1, hack: 1, closeDoor: 1,
		shrineBuy: 1, shrineUse: 1, shrineQuest: 1, shrineDevote: 1, shrinePray: 1, shrineDrink: 1, shrineBottle: 1,
		tabletInteract: 1, foodInteract: 1, chargerInteract: 1, recycleBuild: 1, recycle: 1,
		// self / play
		tryOrgasm: 1, tryPlay: 1, aid: 1, rescue: 1, penance: 1,
		// NPC management
		releaseNPC: 1, removeGuest: 1, ransomNPC: 1, freeNPCRestraint: 1, addNPCRestraint: 1, tightenNPCRestraint: 1,
		// spells (targeted-entity re-resolution handled server-side via __kdEnt tags) — see KD-089
		tryCastSpell: 1, spellCastFromBook: 1, upcast: 1,
	};
	var LOCAL_UI_INPUTS = {
		setMoveDirection: 1, toggleSpell: 1, buffclick: 1, inventoryAction: 1, focusControlToggle: 1,
		upcastcancel: 1, select: 1, selectOnly: 1, cancelParty: 1, onMe: 1, spellChoice: 1, itemChoice: 1,
		spellRemove: 1, spellLearn: 1, perkorb: 1, orb: 1, heart: 1, champion: 1, renamenpc: 1,
		changeAutorelease: 1, autoprune: 1, ghostNegotiate: 1, dialogue: 1, talk: 1, safeword: 1,
	};

	/**
	 * Best-effort JSON-safe clone of an input's data so it can ship over the wire.
	 * Drops circular refs and replaces live entity object refs (e.g. spell `enemy`/
	 * `player`/`bullet`) with a tagged placeholder `{__kdEnt:id}` (or `{__kdEnt:'player'}`
	 * for the player entity). The server re-resolves these to its OWN authoritative
	 * entities before replaying the action (HeadlessHost.applyInput, KD-088).
	 */
	function sanitizeInputData(data) {
		if (data == null || typeof data !== 'object') return data;
		var player = (typeof KinkyDungeonPlayerEntity !== 'undefined') ? KinkyDungeonPlayerEntity : null;
		var seen = [];
		function repl(key, val) {
			if (val && typeof val === 'object') {
				if (val === player) return { __kdEnt: 'player' };
				if (val.Enemy && val.id !== undefined) return { __kdEnt: val.id };
				if (seen.indexOf(val) >= 0) return undefined;          // drop other cycles
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
			bound: 'Apprentice', // presence makes KDCanBind true so the Truss/bind context option appears (KD-098)
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
					if (clientMode) {
						// KD-098 diagnostics: trace turn-consuming inputs + dropped ones. We log only
						// ROUTE (sent to server) and SWALLOW (dropped) — NOT local-ui, which includes
						// per-frame chatter like setMoveDirection (mouse tracking) that would spam the
						// console. Toggle window.__KDMP_DEBUG.
						if (typeof window !== 'undefined' && window.__KDMP_DEBUG && !LOCAL_UI_INPUTS[type]) {
							var decision = ROUTED_INPUTS[type] ? 'ROUTE' : 'SWALLOW';
							try { console.log('[mp-client] KDSendInput', type, '->', decision, (data && data.id != null) ? ('id=' + data.id) : ''); } catch (e) { /* ignore */ }
						}
						if (ROUTED_INPUTS[type]) {
							KDRenderClient.sendInput({ kdType: type, data: sanitizeInputData(data) });
							return '';
						}
						// unknown (non-UI) type → swallow: never simulate locally (no divergence)
						if (!LOCAL_UI_INPUTS[type]) return '';
						// LOCAL_UI types fall through to run locally (menus stay responsive, R6)
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
