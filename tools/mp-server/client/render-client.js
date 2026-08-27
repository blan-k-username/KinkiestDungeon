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
	var _lastRestraintSig = null;   // KD-101: re-dress the player paper-doll only when worn restraints change

	/**
	 * KD's draw loop emits this input EVERY FRAME from the live mouse position — it is a per-frame
	 * STREAM, not a player command. Named once because two places need it: the debug trace excludes
	 * it to stay readable, and `__coopDiag.suppressHover()` gates it so the chatter-ON/chatter-OFF
	 * frame-rate comparison can be taken (KDM-204).
	 */
	var HOVER_TYPE = 'setMoveDirection';

	/*
	 * KDM-163 AC1 — the two hardcoded input lists that used to live here are GONE.
	 *
	 * They were `ROUTED_INPUTS` (~56 keys) and `LOCAL_UI_INPUTS` (~25 keys), and anything on neither
	 * was dropped in SILENCE: a mod's action, or any type upstream added, did nothing at all — no
	 * effect, no error, no log. The game's registry has 85 types, so `defeat`, `lose`, `lock` and
	 * `setrestraintpalette` were being swallowed outright. The lists were also partly WRONG, not just
	 * incomplete: `offhandswitch` and `aid` were listed turn-consuming and neither advances time.
	 *
	 * This client now classifies NOTHING. Every input is routed, and the server asks the GAME what it
	 * is (`SwapSession.apply` + `HeadlessHost.applyInputObserved`): the kind is pre-seeded from static
	 * reachability of `KinkyDungeonAdvanceTime` over the bundle and corrected from real turns, so a UI
	 * type is applied immediately (menus stay responsive, R6) and a turn-consuming one goes through
	 * lockstep (R8/R9). A mod's input type needs no entry anywhere — that is AC2/I5.
	 *
	 * ⚠️ History worth not repeating. This deletion was tried and reverted TWICE on a red
	 * `mp-coop-demo`, and the red was never measured — it was assumed to be caused by the change:
	 *   - CORRECTION 1's red (`afterKick`, click-to-move) WAS real and IS fixed, by pre-seeding: no
	 *     type is unlearned at runtime, so no UI input takes the lockstep default and costs a turn.
	 *   - CORRECTION 2's red (`:108`, the bump-attack) was NOT this change at all. It is an
	 *     intermittent race in the test itself — whenever the peer resolves first in the random turn
	 *     order, the enemy takes an AI step off the tile the test placed it on and A's bump lands on
	 *     an empty tile. Reproduced ~1 run in 3 with these lists still IN PLACE and the seed OFF.
	 *
	 * The speculative alternative — run an input with the advance BLOCKED and roll back if it turned
	 * out to be turn-consuming — was implemented and REJECTED by measurement: probes/probe11 showed
	 * `doattack` damaging the target (hp 1 → -0.575) BEFORE reaching AdvanceTime, which a player-only
	 * rollback does not undo, so the lockstep replay applied the attack twice. Observe, never block.
	 *
	 * The `KinkyDungeonAdvanceTime` guard below remains the backstop (R1).
	 */

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

	/**
	 * KD-100: peers now use per-entity def names (RemotePlayer_<label>) so combat text reads the real
	 * peer name. KDEnemyRank looks the def up by name and crashes on `.tags` if it's missing, and the
	 * JSON-cloned Enemy in the snapshot has a mangled tags Map. So for every peer entity: register a
	 * client def under its exact name (clone of the base, which has a real tags Map) and re-link the
	 * entity to it. Safe + idempotent.
	 */
	function ensureAvatarDefsFor(entities) {
		if (!Array.isArray(entities) || typeof KinkyDungeonGetEnemyByName !== 'function') return;
		ensureAvatarDef();
		var base = KinkyDungeonGetEnemyByName('RemotePlayer');
		if (!base) return;
		var added = false;
		for (var i = 0; i < entities.length; i++) {
			var en = entities[i];
			var nm = en && en.Enemy && en.Enemy.name;
			if (!nm || nm.indexOf('RemotePlayer') !== 0) continue;
			if (!KinkyDungeonGetEnemyByName(nm)) {
				KinkyDungeonEnemies.push(Object.assign({}, base, { name: nm }));
				added = true;
			}
			// register the display-name key client-side too, so the tie submenu / name bar reads the
			// real peer name instead of "[NotFound] NameRemotePlayer_<label>".
			if (typeof addTextKey === 'function') addTextKey('Name' + nm, en.CustomName || nm);
			en.Enemy = KinkyDungeonGetEnemyByName(nm);   // re-link to the real def (real tags Map)
		}
		if (added && typeof KinkyDungeonRefreshEnemiesCache === 'function') KinkyDungeonRefreshEnemiesCache();
	}

	/**
	 * KDM-232: give KD's own name getter back the fallback it already has everywhere else, so a peer
	 * avatar names ITSELF.
	 *
	 * The symptom was the ally dialogue body painting as "(You approach )" — your partner named as
	 * nobody. `KDDrawDialogue` (`KinkyDungeonDialogue.ts:142-146`) treats `CustomName` as a PREDICATE
	 * ("this speaker is named") and then resolves the display name through `KDGetName(id)` **alone**.
	 * Every other name path in the game has a three-step fallback — `KDEnemyName`
	 * (`KinkyDungeonEnemies.ts:2437`) is `CustomName || KDGetName(id) || TextGet("Name" + …)` — and
	 * our avatar satisfies the first and third links of it. `KDGetName` (`:2446`) alone answers `""`
	 * for anything that is neither in `KDGameData.Collection` nor a persistent NPC, and a live
	 * player's avatar is neither. Being "named" ALSO strips the redundant article, which is why the
	 * line lost "the" as well and read "(You approach )" rather than "(You approach the )".
	 *
	 * ── WHY HERE, AND ONLY HERE ───────────────────────────────────────────────────────────────────
	 * The dialogue body is composed at DRAW time, on the client, every frame; the headless server
	 * never draws. And this file is where the peer-name concern already lives —
	 * `ensureAvatarDefsFor` above derives `addTextKey('Name' + nm, en.CustomName || nm)` from exactly
	 * the field this wrap reads, so the same fact stays in one place. It is deliberately NOT in
	 * `coop-bootstrap.js`: the defect is not co-op-specific — any client adopting a snapshot with a
	 * `CustomName` entity hits it, the thin-client path included.
	 *
	 * ── WHY IT IS SAFE TO WRAP A GETTER KD CALLS FROM MANY PLACES ─────────────────────────────────
	 * The wrap can only ever turn `""` into a name: the original is called FIRST and any non-empty
	 * answer is returned untouched, so no Collection or persistent-NPC name changes, and an entity
	 * with no `CustomName` still answers `""`. Both are asserted as controls in
	 * `tests/e2e/mp-peer-name-dialogue.spec.ts` — reordering this to consult `CustomName` first would
	 * silently rename every captured NPC, so it is pinned rather than trusted.
	 *
	 * Bare assignment is correct: `KDGetName` is a top-level function declaration, so unlike the
	 * `let`-globals this file assigns through a direct eval, it is reachable by bare name from a
	 * classic script sharing the game's scope. `KDLookupID` (`:8382`) is KD's own id→entity resolver
	 * and is `KDIDCache`-backed — the cheap choice for something a draw path calls every frame.
	 * `allowPlayer: false` keeps `KDGetName(-1)` answering exactly what it answers today.
	 */
	function installPeerNameFallback() {
		if (typeof KDGetName !== 'function' || KDGetName.__kdClientGuard) return;
		var _origGetName = KDGetName;
		KDGetName = function (id) {
			// eslint-disable-next-line prefer-rest-params
			var name = _origGetName.apply(this, arguments);
			if (name) return name;   // Collection / persistent NPC — the game's own answer, untouched
			try {
				var e = (typeof KDLookupID === 'function') ? KDLookupID(id, false) : null;
				if (e && e.CustomName) return e.CustomName;
			} catch (err) { /* a name lookup must never break a frame */ }
			return name;
		};
		KDGetName.__kdClientGuard = true;
	}

	/**
	 * KDM-162: adopt this player's own STATE BUNDLE — the browser analogue of
	 * HeadlessHost.restorePlayer.
	 *
	 * The browser already runs a full KD instance. It does not need a curated view of the game; it
	 * needs its own state. The server ships the same generic capture the swap model uses (KDM-161),
	 * already stripped of world-scoped KDGameData keys, so there is nothing to classify here and no
	 * field list to keep in step with the host — which is exactly what the old `stats` block was, in
	 * four places and two languages.
	 *
	 * Mechanism: KD's globals are top-level `let`/`var` in SCRIPT scope, so they are not properties of
	 * globalThis and cannot be assigned through it. A DIRECT eval from this classic script resolves a
	 * bare name up the scope chain into that same global lexical environment — the identical trick the
	 * host uses inside the bundle's vm scope.
	 *
	 * ⚠️ COPY, never alias (measured on the host, KDM-161): `b` is the snapshot object and is reused;
	 * handing the game a reference into it means the game mutates the snapshot in place.
	 */
	/**
	 * KDM-163 AC3: input types the AUTHORITATIVE WORLD had no handler for.
	 *
	 * Under option A the client classifies nothing, so it cannot know: it routes every type, and the
	 * server — which owns the real registry, `KDInputTypes` (`KinkyDungeonInput.ts:10`) — reports back
	 * anything it could not dispatch. A non-empty list means the caller sent a type no handler exists
	 * for anywhere, which is a real bug and now visible instead of a silent `return ''`.
	 */
	var _unhandled = [];                 // [{type, count}] — reported BY THE SERVER, see below
	// KDM-268: inputs whose dispatch THREW in the authoritative world. Same source and same rule as
	// _unhandled above: reported BY THE SERVER, exposed rather than only logged, because a console
	// line is not readable by anything that wants to check the client actually heard about it.
	var _failed = [];                    // [{clientId, turn, kdType, error}]
	var _warned = {};

	/*
	 * KDM-163 AC3: the client-side drop RECORDER that used to live here is gone with the lists that
	 * made drops possible. There is no longer a "type on neither list" case to record — every input is
	 * routed, so the only place an input can go unhandled is the authoritative world, and the server
	 * reports that in `snapshot.unknownInputs` (SwapSession.unknownInputReport).
	 */

	/**
	 * KDM-196 — presentation ACCUMULATORS the client owns, keyed by the global they live on.
	 *
	 * Same criterion as the queues, one step further in: `KinkyDungeonPlayerEntity.visual_stamina` /
	 * `visual_mana` are not state, they are where the DRAW loop keeps a bar part-way through its
	 * animation (`KinkyDungeonDraw.ts:1814/1825`, via `KDEaseValue`). A headless server never runs
	 * that loop, so its capture of `KinkyDungeonPlayerEntity` simply has no such field — and
	 * `adoptBundle` replaces the whole object, so every snapshot DELETED the client's value. The draw
	 * then re-seeds it from `…StaminaMax` and eases down again: the SP bar visibly re-drains from full
	 * once per snapshot. The bar only draws while the pointer is in the playable area, which is why
	 * UAT saw it "when I move my mouse".
	 *
	 * So: the server's value wins whenever it HAS one, and the client keeps its own when it does not.
	 * `visual_x`/`visual_y` are deliberately NOT here — the server snaps those to the authoritative
	 * tile on purpose (KD-098), which is a value, not an absence.
	 */
	var CLIENT_OWNED_ENTITY_FIELDS = {
		KinkyDungeonPlayerEntity: ['visual_stamina', 'visual_mana'],
	};

	/*
	 * "ABSENT FROM THE BUNDLE ⇒ BACK TO ITS DEFAULT" — the client half of the swap rule.
	 *
	 * The capture records a watched global only while it DIFFERS from the post-init baseline
	 * (headless-host.js:1862), so a global that returns to its default DROPS OUT of the bundle.
	 * Absence is not "unchanged", it is "back to the default", and the host already reads it that
	 * way (_restoreGlobals, headless-host.js:2039-2048). This side used to assign only the keys that
	 * were PRESENT, so a vanished key kept its old value for the rest of the session.
	 *
	 * Measured in UAT as a crash: after struggling free, `KinkyDungeonStruggleGroups` went back to []
	 * server-side (hence out of the bundle) while the client kept ["ItemHands"];
	 * `KinkyDungeonGetRestraintItem` then returned null for that stale group and KDDrawStruggleGroups
	 * dereferenced it unguarded on hover (KinkyDungeonHUD.ts:3511).
	 *
	 * `_bundleDefaults` holds the pristine post-init value of every global a bundle has ever
	 * mentioned, recorded the FIRST time it is mentioned: before that moment this client has never
	 * written the name, so what it holds is by definition the default. That is why no defaults are
	 * shipped over the wire — the browser runs the same out/main.js and the same init, so it already
	 * has them, and sending ~2300 of them at boot would cost megabytes to say the same thing.
	 * Stored in the CODEC's serialised form, exactly as the host stores `_baselineValues`, so a Map
	 * or Set global comes back as a Map or Set rather than a bare object.
	 *
	 * `_bundleDirty` mirrors the host's other guard: only names believed to hold a non-default value
	 * are considered, so a steady state costs one empty loop rather than ~2300 assignments.
	 */
	var _bundleDefaults = {};
	var _bundleDirty = {};

	var _adoptVal;                       // transfer slot for the direct eval below
	function adoptBundle(b) {
		if (!b) return 0;
		var codec = (typeof window !== 'undefined' && window.KDCodec) ? window.KDCodec : null;
		var dec = (codec && codec.kdDec) ? codec.kdDec : function (v) { return v; };
		var ser = (codec && codec.kdSer) ? codec.kdSer : function (v) { return JSON.stringify(v); };
		var n = 0;

		/**
		 * Assign one global from a captured value. Shared by adoption and by the reset pass below so
		 * the two cannot decode differently — the same reason the host has a single `assign`.
		 * COPY, never alias: `v` belongs to the bundle (or to `_bundleDefaults`), and both outlive
		 * this call; handing the game a reference lets it mutate our stored copy in place.
		 */
		function assignGlobal(name, v) {
			// A __kdT tag only ever sits at the TOP level, so this O(1) test is enough.
			_adoptVal = (v && typeof v === 'object')
				? (v.__kdT ? dec(v) : JSON.parse(JSON.stringify(v)))
				: v;
			// KDM-196: carry over the client-owned animation accumulators the server has no
			// value for, so the wholesale replace below does not restart the bar every snapshot.
			var owned = CLIENT_OWNED_ENTITY_FIELDS[name];
			if (owned && _adoptVal && typeof _adoptVal === 'object') {
				// eslint-disable-next-line no-eval
				var prev = eval(name);
				if (prev && typeof prev === 'object') {
					for (var oi = 0; oi < owned.length; oi++) {
						if (_adoptVal[owned[oi]] === undefined && prev[owned[oi]] !== undefined) {
							_adoptVal[owned[oi]] = prev[owned[oi]];
						}
					}
				}
			}
			// eslint-disable-next-line no-eval
			eval(name + ' = _adoptVal;');
		}

		if (b.gameData && typeof KDGameData !== 'undefined' && KDGameData) {
			for (var gk in b.gameData) {
				if (!Object.prototype.hasOwnProperty.call(b.gameData, gk)) continue;
				if (b.gameData[gk] === undefined) continue;
				try { KDGameData[gk] = dec(b.gameData[gk]); n++; } catch (e) { /* not assignable */ }
			}
		}
		var g = b.globals;
		if (g) {
			for (var name in g) {
				if (!Object.prototype.hasOwnProperty.call(g, name)) continue;
				var v = g[name];
				if (v === undefined) continue;
				try {
					// Record this name's pristine value BEFORE the first write to it — that value is
					// the default a later absence must restore. Unserialisable globals record nothing
					// and are then skipped by the rule, same guard as the host's `defs` check.
					if (!Object.prototype.hasOwnProperty.call(_bundleDefaults, name)) {
						// eslint-disable-next-line no-eval
						var pristine = eval(name);
						var ps = (pristine === undefined) ? undefined : ser(pristine);
						if (ps !== undefined) _bundleDefaults[name] = JSON.parse(ps);
					}
					assignGlobal(name, v);
					_bundleDirty[name] = 1;
					n++;
				} catch (e) { /* const / not a bundle binding — skip, same as the host */ }
			}
		}

		// …and the other half of the rule: anything this bundle stopped carrying goes back.
		var rule = (typeof window !== 'undefined' && window.KDAbsentReset) ? window.KDAbsentReset : null;
		if (rule && rule.kdAbsentResets) {
			var dirtyNames = [];
			for (var dn in _bundleDirty) {
				if (Object.prototype.hasOwnProperty.call(_bundleDirty, dn)) dirtyNames.push(dn);
			}
			var resets = rule.kdAbsentResets(_bundleDefaults, dirtyNames, g);
			for (var ri = 0; ri < resets.length; ri++) {
				try {
					assignGlobal(resets[ri].name, resets[ri].value);
					delete _bundleDirty[resets[ri].name];      // back at its default ⇒ no longer dirty
					n++;
				} catch (e) { /* not assignable — same as adoption */ }
			}
		}
		return n;
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
				// KDM-162: no `stats` block — it was the host's copy of a hand-kept HUD contract. See
				// headless-host.serializeRenderState; per-player state travels in the bundle now.
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
				// KDM-222: the OTHER two inputs to the same light-params lookup `level`/`checkpoint`
				// feed. KinkyDungeonVision reads `KDGetAltType(level)` for `lightParams`, and that
				// function resolves off KDGameData.RoomType / .MapMod (KinkyDungeonGame.ts:4300-4304),
				// not off the level number. Carrying three of the four inputs meant the lightmap was
				// recomputed with the WRONG alt type: measured, adopting the Journey hub
				// (RoomType 'JourneyFloor', shadowColor 0x703) with RoomType left at '' fell back to
				// KinkyDungeonBossFloor(0) and the default 0x00001f, rewriting all 384 ShadowGrid
				// cells and tinting the whole room — 0.054 of the frame, 30x the noise floor, while
				// BrightnessGrid and ColorGrid stayed bit-identical.
				// In production these ride along in the bundle (KDGameData whole, minus
				// KDGAMEDATA_WORLD_KEYS), so this closes the BUNDLE-LESS path — a snapshot alone must
				// still describe which map it is.
				// KDM-263: generic now, from the ONE declared list — served to the browser as
				// window.KDWorldGameDataKeys, GENERATED from KDGAMEDATA_WORLD_KEYS rather than copied
				// beside it. The per-field pair this replaces had to be edited in four mirrored places
				// every time a world key was added, and forgetting one of the four is silent.
				worldGameData: (function () {
					var o = {}, ks = (typeof window !== 'undefined' && window.KDWorldGameDataKeys) || null;
					if (!ks) {
						// LOUD, not silent. Without the list this returns {} and the receiver adopts nothing
						// — which is KDM-222's bug exactly (measured then: the wrong alt type moved 0.054 of
						// the frame), and it looks like a working snapshot right up until the pixels differ.
						// Production serves the list at WORLD_KEYS_ROUTE, ahead of this file.
						try {
							console.error('[mp-client] window.KDWorldGameDataKeys is missing — the WORLD half of '
								+ 'KDGameData will not be serialised. Load /mp/kd-world-keys.js before render-client.js.');
						} catch (e) { /* no console; the caller still gets an empty set */ }
						return o;
					}
					if (typeof KDGameData === 'undefined' || !KDGameData) return o;
					for (var i = 0; i < ks.length; i++) {
						if (KDGameData[ks[i]] !== undefined) o[ks[i]] = clone(KDGameData[ks[i]]);
					}
					return o;
				})(),
			};
		},

		/** Adopt a render-state snapshot onto the render globals. NO simulation. */
		apply: function (s) {
			if (!s) return { ok: false, error: 'no snapshot' };
			ensureAvatarDef();   // so peer avatars (RemotePlayer) re-link to a real def
			installPeerNameFallback();   // KDM-232 — so a peer avatar names itself in the ally dialogue
			// KDM-162: adopt this player's own state FIRST, so the explicit assignments below (which
			// carry snapshot-time render fixups like snapped visual_x/visual_y) still have the last word.
			KDRenderClient.lastBundleFields = adoptBundle(s.bundle);
			// KDM-225: the co-op RELATIONSHIP state (who this player is at war with, and whether they
			// owe an answer to a peace offer). Published as a plain field rather than adopted into a
			// game global: it is the gateway's own state, not KD's, and the context-menu wrap in
			// coop-menu.js reads it every frame. `undefined` is preserved as null so a client talking
			// to an older server can tell "no relationship" from "not supported".
			KDRenderClient.lastCoop = s.coop || null;
			// KDM-163 AC3: surface what the authoritative world could not dispatch. Warned once per
			// type so a mistyped/removed input is loud in the console instead of doing nothing.
			if (Array.isArray(s.unknownInputs)) {
				_unhandled = s.unknownInputs;
				for (var ui = 0; ui < _unhandled.length; ui++) {
					var ut = _unhandled[ui] && _unhandled[ui].type;
					if (ut && !_warned[ut]) {
						_warned[ut] = 1;
						try { console.warn('[mp-client] input "' + ut + '" has NO handler in the game (KDInputTypes) — it did nothing.'); } catch (e) { /* ignore */ }
					}
				}
			}
			// KDM-268: …and the louder sibling — an input whose dispatch THREW in the authoritative
			// world. Warned once per type through the SAME `_warned` map as above, so one bad input
			// type cannot produce two parallel warning streams. A throw is strictly louder than an
			// unhandled type, so it must not be quieter here.
			if (Array.isArray(s.failedInputs)) {
				_failed = s.failedInputs;
				for (var fi = 0; fi < s.failedInputs.length; fi++) {
					var fr = s.failedInputs[fi] || {};
					var fk = 'threw:' + (fr.kdType || '?');
					if (!_warned[fk]) {
						_warned[fk] = 1;
						try { console.warn('[mp-client] input "' + (fr.kdType || '?') + '" THREW in the game and was cut short: ' + fr.error); } catch (e) { /* ignore */ }
					}
				}
			}
			// NOTE: deliberately IGNORE s.camera. The snapshot's camera/grid-size come
			// from the HEADLESS server (no real screen → bogus scale), and adopting them
			// distorts the client's rendering. The browser keeps its OWN window-based
			// KinkyDungeonGridSizeDisplay and recomputes the camera each frame to centre
			// on its player. (Camera stays in the snapshot for the node round-trip test.)
			// KDM-162: the ~12 hand-assigned HUD stats that used to be here are gone, and so is the
			// movement-cost patch-up below them (KDGameData.MovePoints/SlowMoveTurns/SprintTurns and
			// KinkyDungeonSlowLevel). All of it is per-player state that `adoptBundle` above installs
			// from the server's own capture — including KinkyDungeonSlowLevel, which used to be
			// recomputed server-side and shipped as a derived value.
			//
			// The `xN` move reticule (KinkyDungeonDraw.ts:1581) and the "You are slowed!" line now read
			// the same adopted state, so they cannot disagree the way they did.
			// adopt the authoritative KDMapData WHOLESALE (internally consistent — a
			// field-subset splice over the client's local map renders broken). Entities
			// carry their full Enemy defs in the clone, so no def re-link is needed.
			// Vision/light (KDMapExtraData) is recomputed locally (pinGameScreen flags it).
			if (s.map) KDMapData = s.map;
			// KD-100: register/re-link a real def for each peer's unique name so the draw path
			// (KDEnemyRank → .tags) doesn't crash on the renamed/JSON-mangled avatar Enemy.
			if (KDMapData && Array.isArray(KDMapData.Entities)) ensureAvatarDefsFor(KDMapData.Entities);
			// KD-101: the "Tie Up" submenu runs LOCALLY on the attacker and writes the avatar's NPC
				// restraints into KDGameData.NPCRestraints — which the snapshot does NOT reset (it only
				// syncs KDMapData). Over several ties those local slots accumulate and the stock apply
				// (KDGetNPCBindingSlotForItem(...).sgroup, no null guard) crashes on a full slot. Reset each
				// peer avatar's LOCAL bondage every snapshot — the authoritative tie lives on the server and
				// is reflected on the VICTIM's own client via s.restraints below.
				if (KDMapData && Array.isArray(KDMapData.Entities) && typeof KDSetNPCRestraints === 'function') {
					for (var ai = 0; ai < KDMapData.Entities.length; ai++) {
						var av = KDMapData.Entities[ai];
						if (av && av.Enemy && typeof av.Enemy.name === 'string' && av.Enemy.name.indexOf('RemotePlayer') === 0) {
							try { KDSetNPCRestraints(av.id, {}); av.boundLevel = av.boundLevel || 0; } catch (e) { /* ignore */ }
						}
					}
				}
				if (typeof KDUpdateEnemyCache !== 'undefined') KDUpdateEnemyCache = true;
			if (s.player && KinkyDungeonPlayerEntity) {
				for (var k in s.player) { if (k !== 'enemyName' && k !== 'Enemy') KinkyDungeonPlayerEntity[k] = s.player[k]; }
			}
			/*
			 * KDM-162: the DERIVATIONS that used to live here are gone.
			 *
			 * This block used to hand-call `KinkyDungeonRefreshRestraintsCache`, `KinkyDungeonUpdateRestraints`
			 * (→ `KinkyDungeonPlayerTags`) and `KinkyDungeonUpdateStruggleGroups` — a partial reimplementation
			 * of KD's per-turn pass, each call added reactively after a bug (KD-103 arm pose, KDM-156 struggle-
			 * group crash). They are unnecessary now: those globals are per-player state that the bundle
			 * carries, so `adoptBundle` above installs the SERVER's already-correct values.
			 *
			 * Measured before deleting (KDM-162 probe6): across 4949 candidate globals, a client that adopts
			 * the bundle has ZERO wrong player-state fields, and running the derivation subset afterwards
			 * changes nothing. And never call `KinkyDungeonUpdateStats` here — probes 1/4 measured it
			 * regenerating mana cumulatively and executing a real edge/orgasm event that drains Will, none of
			 * which the `KinkyDungeonAdvanceTime` guard catches.
			 *
			 * What REMAINS is render-only and genuinely client-owned: the paper doll. `KDRefreshCharacter` /
			 * `KinkyDungeonDressPlayer` build the model + appearance, which the headless server has no
			 * equivalent of and cannot ship — the same category as the camera and the vision radius.
			 */
			if (Array.isArray(s.restraints) && typeof KinkyDungeonInventory !== 'undefined' && typeof Restraint !== 'undefined') {
					try {
						var rmap = new Map();
						var sig = '';
						for (var ri = 0; ri < s.restraints.length; ri++) {
							var rit = s.restraints[ri];
							if (rit && rit.name) { rmap.set(rit.name, rit); sig += rit.name + '|' + (rit.id || '') + ';'; }
						}
						KinkyDungeonInventory.set(Restraint, rmap);
						// Re-dress only when the worn set actually changed (avoids a per-turn re-dress
						// flicker / cost). Setting KinkyDungeonCheckClothesLoss alone does NOT re-dress:
						// KDRefreshCharacter must be flagged for the player and KinkyDungeonDressPlayer
						// called to strip + re-apply from the worn Map.
						if (sig !== _lastRestraintSig) {
							_lastRestraintSig = sig;
							if (typeof KinkyDungeonCheckClothesLoss !== 'undefined') KinkyDungeonCheckClothesLoss = true;
							if (typeof KDRefreshCharacter !== 'undefined' && typeof KinkyDungeonPlayer !== 'undefined') {
								try { KDRefreshCharacter.set(KinkyDungeonPlayer, true); } catch (e2) { /* ignore */ }
							}
							if (typeof KinkyDungeonDressPlayer === 'function' && typeof KinkyDungeonPlayer !== 'undefined') {
								try { KinkyDungeonDressPlayer(KinkyDungeonPlayer); } catch (e3) { /* ignore */ }
							}
						}
					} catch (e) { /* best-effort render sync */ }
				}
				KinkyDungeonMessageLog = s.messages.log || [];
			/*
			 * KDM-186 — ONE-SHOT EVENTS ARE APPLIED AT MOST ONCE.
			 *
			 * The action message is an EVENT, not state: assigning it makes the game show a floater.
			 * It rides inside the snapshot, which is STATE and re-applied on every delivery — so every
			 * snapshot after a hit re-stamped that hit's visuals. Measured in UAT: the floater queue
			 * grew ONLY while the mouse moved (each move is a state change, hence a snapshot) and
			 * drained to zero the moment snapshots stopped — 0 created/s with 84 still queued.
			 *
			 * The server issues a sequence id per real occurrence; anything already applied is skipped
			 * and the game's own timer is left to decay it. Generic: this side names no event and no
			 * game feature — one comparison against one counter, so any future effect the server puts
			 * on this channel inherits the guarantee.
			 */
			var evSeq = (s.messages && s.messages.actionSeq) || 0;
			if (evSeq > (KDRenderClient._lastEventSeq || 0)) {
				KDRenderClient._lastEventSeq = evSeq;
				if (typeof KinkyDungeonActionMessage !== 'undefined') KinkyDungeonActionMessage = s.messages.action;
				if (typeof KinkyDungeonActionMessageTime !== 'undefined') KinkyDungeonActionMessageTime = s.messages.actionTime;
				if (typeof KinkyDungeonActionMessageColor !== 'undefined') KinkyDungeonActionMessageColor = s.messages.actionColor;
			}
			/*
			 * KDM-186 — ONE-SHOT EVENTS, APPLIED AT MOST ONCE.
			 *
			 * A snapshot is STATE: re-applying it must converge. An EVENT (a damage number, a cast
			 * animation) is not idempotent — replaying it duplicates it. They used to share one wire:
			 * `KDDamageQueue` is a consume-once presentation queue that the DRAW loop drains, the
			 * headless server has no draw loop so it never drained, and the generic capture then
			 * replicated the stale entries so every snapshot re-stamped the same hit. Measured in UAT:
			 * the floater queue grew only while snapshots arrived (i.e. while the mouse moved) and
			 * drained to zero the moment they stopped — 0 created/s with 84 still queued.
			 *
			 * Now presentation state is not replicated at all, and what the player must be told
			 * arrives here with a sequence. This block names no event kind beyond dispatching the
			 * game's own payload, so any effect the server puts on this channel inherits the
			 * exactly-once guarantee with no change on either side.
			 */
			if (Array.isArray(s.events) && s.events.length) {
				for (var ei = 0; ei < s.events.length; ei++) {
					var ev = s.events[ei];
					if (!ev || !(ev.seq > (KDRenderClient._lastEventSeq || 0))) continue;
					KDRenderClient._lastEventSeq = ev.seq;
					try {
						if (ev.kind === 'floater' && ev.floater && typeof KinkyDungeonSendFloater === 'function') {
							var f = ev.floater;
							KinkyDungeonSendFloater({ x: f.x, y: f.y }, f.text, f.color, f.time);
						} else if (ev.kind === 'noise' && typeof KDEventData !== 'undefined' && KDEventData) {
							// KDM-196: the ripple + sound echo, on the same exactly-once channel as the
							// floaters and for the same reason (they used to ride the state wire and were
							// re-drawn once per SNAPSHOT — spam while the mouse moved).
							//
							// `shockwaves` is a one-shot backlog the local draw layer drains, so APPEND.
							if (ev.shockwaves && ev.shockwaves.length) {
								if (!Array.isArray(KDEventData.shockwaves)) KDEventData.shockwaves = [];
								for (var si = 0; si < ev.shockwaves.length; si++) KDEventData.shockwaves.push(ev.shockwaves[si]);
							}
							// `sounddesc` is a per-turn list the draw layer re-reads (it echoes every
							// `shockwavePeriod` ms), so REPLACE — including with an empty list, which is how
							// last turn's echo stops. This client cannot clear it itself: the game clears it
							// in KinkyDungeonAdvanceTime, which `disableLocalSim` guards off.
							if (ev.sounddesc) {
								var now = (typeof CommonTime === 'function') ? CommonTime() : 0;
								for (var di = 0; di < ev.sounddesc.length; di++) {
									// stamp with LOCAL time: the server's is from another clock entirely, and a
									// timestamp in the past re-fires the echo immediately.
									ev.sounddesc[di].lastShockwave = now;
								}
								KDEventData.sounddesc = ev.sounddesc;
							}
						}
					} catch (e) { /* an event must never break the render path */ }
				}
			}
			if (typeof MiniGameKinkyDungeonLevel !== 'undefined') MiniGameKinkyDungeonLevel = s.level;
			if (s.checkpoint && typeof MiniGameKinkyDungeonCheckpoint !== 'undefined') MiniGameKinkyDungeonCheckpoint = s.checkpoint;
			/*
			 * KDM-222/263: adopt the WORLD half of KDGameData — the room the party is in, the map mod,
			 * where it stands on the journey and which route it agreed to take.
			 *
			 * KDM-222 shipped two of these by name because the lightmap needs them: KinkyDungeonVision
			 * reads `KDGetAltType(level)`, which resolves off RoomType/MapMod rather than the level
			 * number, so a snapshot carrying only the level recomputed the lightmap with the wrong alt
			 * type. KDM-263 made the set generic — `_clientBundle` STRIPS every declared world key from
			 * the per-player bundle, so each key the list gains is a key that must arrive here instead,
			 * and the per-field form made that omission silent.
			 *
			 * Iterating what was SENT (not a list held here) keeps an older snapshot working and keeps
			 * the declaration in ONE place, server-side. `!== undefined` is implicit in the same way it
			 * was explicit before: the serializer omits only keys the world itself does not have, and
			 * '' is a REAL RoomType that must come through.
			 *
			 * Runs AFTER adoptBundle, so the world's answer wins over any stale copy the bundle held.
			 */
			if (typeof KDGameData !== 'undefined' && KDGameData && s.worldGameData) {
				for (var wk in s.worldGameData) KDGameData[wk] = s.worldGameData[wk];
			}
			/*
			 * KDM-219: invalidate the derived vision/light cache HERE, where the state it derives
			 * from is replaced — not in the caller.
			 *
			 * `KDMapData` is adopted WHOLESALE above, so the light grid computed for the previous map
			 * is stale by construction after every apply. It used to be the caller's job:
			 * `coop-bootstrap.js pinGameScreen()` sets the flag, and every production call site
			 * already runs it immediately after apply (boot + both `state` branches). So moving it in
			 * here does NOT change how often a recompute happens in production — it only removes the
			 * chance of forgetting, which FAILS SILENTLY: the state is correct, the tick is right,
			 * every assertion on the globals passes, and the screen just keeps showing the old world.
			 * That is exactly how the thin-client spike came to claim adoption it could not see
			 * (KDM-219): it never called pinGameScreen, so its "applied" frame stayed the previous
			 * map's picture. Measured: with this line, applying a snapshot moves the rendered frame
			 * 0.12 (noise floor 0.0015); without it, the frame does not move.
			 *
			 * pinGameScreen keeps its own copy — it also pins KinkyDungeonState/DrawState, and a
			 * redundant `true` here costs one recompute the adopt already required.
			 */
			if (typeof KinkyDungeonUpdateLightGrid !== 'undefined') KinkyDungeonUpdateLightGrid = true;
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
						// KD-098 diagnostics: every input now takes one path, so the trace is just the
						// type. `setMoveDirection` is per-frame mouse chatter, so it is excluded to keep
						// the console readable. Toggle window.__KDMP_DEBUG.
						if (typeof window !== 'undefined' && window.__KDMP_DEBUG && type !== HOVER_TYPE) {
							try { console.log('[mp-client] KDSendInput', type, '-> ROUTE', (data && data.id != null) ? ('id=' + data.id) : ''); } catch (e) { /* ignore */ }
						}
						/*
						 * KDM-204 — DIAGNOSTIC GATE. Off by default; nothing sets it in real play.
						 *
						 * The whole per-frame round-trip (send → server → state reply → apply → light
						 * grid recompute) hangs off this ONE input type. Measuring the frame rate with
						 * it routed and again with it dropped is the only way to tell whether that
						 * round-trip STARVES the draw loop or is merely a passenger while something
						 * else does — the question tests/e2e/mp-input-matrix.spec.ts exists to answer.
						 *
						 * Dropped, never silently: it is counted through the same `noteSkip` channel as
						 * every other skipped input (KDM-163 — no invisible losses), so the rollup shows
						 * exactly what the reading cost.
						 */
						if (type === HOVER_TYPE && typeof window !== 'undefined' && window.__KDMP_SUPPRESS_HOVER) {
							try { window.__coopDiag.noteSkip(type, 'suppressHover'); } catch (e) { /* diag optional */ }
							return '';
						}
						/*
						 * ⚠️ KNOWN COUPLING — the ONE input still run locally (KD-101, owned by KDM-164).
						 *
						 * The Bondage cast opens KD's real "tie" SUBMENU, which is a purely client-side UI
						 * construct: measured (KDM-162 probes/probe10) the headless world returns "Fail"
						 * for this cast and touches no submenu state whatsoever — only text-message
						 * globals. So there is nothing for the server to send back and nothing the state
						 * bundle can carry; it is the same client-owned category as the paper doll, the
						 * camera and the vision radius.
						 *
						 * Routing it therefore loses the submenu ("tie submenu should be open" in
						 * tests/e2e/mp-pvp-tie.spec.ts). The submenu's own apply (`addNPCRestraint`) is
						 * routed normally, so the authoritative tie still happens server-side.
						 *
						 * This is recorded as a known coupling rather than kept quietly, per KDM-163. Its
						 * cause is the synthetic PvP/bondage model, which KDM-164 removes; delete this
						 * branch when that lands.
						 */
						if (type === 'tryCastSpell' && data && data.spellname === 'Bondage') {
							return _origSend.apply(this, arguments);
						}
						// KDM-163 AC1 — DEFAULT = ROUTE. This client classifies nothing and swallows
						// nothing; the server asks the GAME what each input is. See the block comment at
						// the top of this file for the two reds this was reverted on and why neither
						// was this change.
						KDRenderClient.sendInput({ kdType: type, data: sanitizeInputData(data) });
						return '';
					}
					return _origSend.apply(this, arguments);
				};
				KDSendInput.__kdClientGuard = true;
			}
			return clientMode;
		},

		/**
		 * KDM-163 AC3: every input type this client could not handle, with whether the GAME's own
		 * registry knows it. Empty is the healthy state; a non-empty list is a to-do, not a mystery.
		 */
		unhandledInputs: function () {
			return _unhandled.slice();
		},

		/**
		 * KDM-268: every input whose dispatch THREW inside the authoritative world, as the server
		 * reported it. Fourth member of the drop-report family; empty is the healthy state.
		 */
		failedInputs: function () {
			return _failed.slice();
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
