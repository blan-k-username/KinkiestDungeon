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
 *   disableLocalSim()      → mark this instance render-only (KDServerRole='client')
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
				map: {
					Grid: M.Grid, GridWidth: M.GridWidth, GridHeight: M.GridHeight,
					Tiles: clone(M.Tiles), TilesSkin: clone(M.TilesSkin), TilesMemory: clone(M.TilesMemory),
					Traffic: clone(M.Traffic), FogGrid: clone(M.FogGrid), FogMemory: clone(M.FogMemory),
					Labels: clone(M.Labels),
					Entities: (M.Entities || []).map(entSnap),
				},
				mapExtra: {
					VisionGrid: clone(X.VisionGrid), BrightnessGrid: clone(X.BrightnessGrid),
					ColorGrid: clone(X.ColorGrid), ShadowGrid: clone(X.ShadowGrid),
				},
				messages: {
					log: clone(KinkyDungeonMessageLog) || [],
					action: (typeof KinkyDungeonActionMessage !== 'undefined') ? KinkyDungeonActionMessage : '',
					actionTime: (typeof KinkyDungeonActionMessageTime !== 'undefined') ? KinkyDungeonActionMessageTime : 0,
					actionColor: (typeof KinkyDungeonActionMessageColor !== 'undefined') ? KinkyDungeonActionMessageColor : '#ffffff',
				},
				restraints: (typeof KinkyDungeonAllRestraint === 'function') ? KinkyDungeonAllRestraint().map(function (r) { return { name: r.name, id: r.id }; }) : [],
				buffs: clone(typeof KinkyDungeonPlayerBuffs !== 'undefined' ? KinkyDungeonPlayerBuffs : {}),
				level: (typeof MiniGameKinkyDungeonLevel !== 'undefined') ? MiniGameKinkyDungeonLevel : 1,
			};
		},

		/** Adopt a render-state snapshot onto the render globals. NO simulation. */
		apply: function (s) {
			if (!s) return { ok: false, error: 'no snapshot' };
			if (typeof KDZoomIndex !== 'undefined') KDZoomIndex = s.camera.zoomIndex;
			if (typeof KinkyDungeonGridSizeDisplay !== 'undefined') KinkyDungeonGridSizeDisplay = s.camera.gridSizeDisplay;
			if (typeof KinkyDungeonGridWidthDisplay !== 'undefined') KinkyDungeonGridWidthDisplay = s.camera.gridWidthDisplay;
			if (typeof KinkyDungeonGridHeightDisplay !== 'undefined') KinkyDungeonGridHeightDisplay = s.camera.gridHeightDisplay;
			if (typeof KinkyDungeonCamX !== 'undefined') KinkyDungeonCamX = s.camera.camX;
			if (typeof KinkyDungeonCamY !== 'undefined') KinkyDungeonCamY = s.camera.camY;
			KinkyDungeonStatWill = s.stats.will; KinkyDungeonStatWillMax = s.stats.willMax;
			KinkyDungeonStatStamina = s.stats.stamina; KinkyDungeonStatStaminaMax = s.stats.staminaMax;
			KinkyDungeonStatMana = s.stats.mana; KinkyDungeonStatManaMax = s.stats.manaMax;
			if (typeof KinkyDungeonStatManaPool !== 'undefined') KinkyDungeonStatManaPool = s.stats.manaPool;
			KinkyDungeonStatDistraction = s.stats.distraction; KinkyDungeonStatDistractionMax = s.stats.distractionMax;
			if (typeof KinkyDungeonStatDistractionLower !== 'undefined') KinkyDungeonStatDistractionLower = s.stats.distractionLower;
			KDMapData.Grid = s.map.Grid; KDMapData.GridWidth = s.map.GridWidth; KDMapData.GridHeight = s.map.GridHeight;
			if (s.map.Tiles != null) KDMapData.Tiles = s.map.Tiles;
			if (s.map.TilesSkin != null) KDMapData.TilesSkin = s.map.TilesSkin;
			if (s.map.TilesMemory != null) KDMapData.TilesMemory = s.map.TilesMemory;
			if (s.map.Traffic != null) KDMapData.Traffic = s.map.Traffic;
			if (s.map.FogGrid != null) KDMapData.FogGrid = s.map.FogGrid;
			if (s.map.FogMemory != null) KDMapData.FogMemory = s.map.FogMemory;
			if (s.map.Labels != null) KDMapData.Labels = s.map.Labels;
			KDMapData.Entities = (s.map.Entities || []).map(function (es) {
				var e = {};
				for (var k in es) { if (k !== 'enemyName') e[k] = es[k]; }
				if (es.enemyName) e.Enemy = KinkyDungeonGetEnemyByName(es.enemyName) || { name: es.enemyName };
				return e;
			});
			if (typeof KDUpdateEnemyCache !== 'undefined') KDUpdateEnemyCache = true;
			if (typeof KDMapExtraData !== 'undefined' && KDMapExtraData) {
				if (s.mapExtra.VisionGrid != null) KDMapExtraData.VisionGrid = s.mapExtra.VisionGrid;
				if (s.mapExtra.BrightnessGrid != null) KDMapExtraData.BrightnessGrid = s.mapExtra.BrightnessGrid;
				if (s.mapExtra.ColorGrid != null) KDMapExtraData.ColorGrid = s.mapExtra.ColorGrid;
				if (s.mapExtra.ShadowGrid != null) KDMapExtraData.ShadowGrid = s.mapExtra.ShadowGrid;
			}
			if (s.player && KinkyDungeonPlayerEntity) {
				for (var k in s.player) { if (k !== 'enemyName' && k !== 'Enemy') KinkyDungeonPlayerEntity[k] = s.player[k]; }
			}
			KinkyDungeonMessageLog = s.messages.log || [];
			if (typeof KinkyDungeonActionMessage !== 'undefined') KinkyDungeonActionMessage = s.messages.action;
			if (typeof KinkyDungeonActionMessageTime !== 'undefined') KinkyDungeonActionMessageTime = s.messages.actionTime;
			if (typeof KinkyDungeonActionMessageColor !== 'undefined') KinkyDungeonActionMessageColor = s.messages.actionColor;
			if (typeof MiniGameKinkyDungeonLevel !== 'undefined') MiniGameKinkyDungeonLevel = s.level;
			return { ok: true, entities: KDMapData.Entities.length };
		},

		/**
		 * Mark this browser instance as render-only: it must not simulate gameplay.
		 * Sets KDServerRole='client' (the reserved KD-068 role) so any in-engine
		 * client guards are active. The client simply never calls KinkyDungeonAdvanceTime.
		 */
		disableLocalSim: function () {
			if (typeof KDServerRole !== 'undefined') KDServerRole = 'client';
			return (typeof KDServerRole !== 'undefined') ? KDServerRole : null;
		},

		/** Register a callback invoked when local input should be sent to the server. */
		onInput: function (cb) { inputCb = cb; },

		/** Forward a player action (e.g. {dx,dy}) to the server via the registered cb. */
		sendInput: function (action) { if (inputCb) inputCb(action); return action; },
	};

	(typeof window !== 'undefined' ? window : globalThis).KDRenderClient = KDRenderClient;
})();
