/**
 * tools/mp-server/client/render-client.js
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
 * Snapshot shape === HeadlessHost.serializeRenderState() (render-state v1),
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

	var ENT_FIELDS = ['id', 'x', 'y', 'visual_x', 'visual_y', 'offX', 'offY', 'scaleX', 'scaleY', 'flip', 'hp', 'visual_hp', 'boundLevel', 'distraction', 'revealed', 'player', 'CustomSprite', 'CustomName', 'CustomNameColor', 'style', 'outfit', 'outfitBound', 'appearance'];

	function entSnap(e) {
		var o = {};
		for (var i = 0; i < ENT_FIELDS.length; i++) { var k = ENT_FIELDS[i]; if (e[k] !== undefined) o[k] = e[k]; }
		o.enemyName = (e.Enemy && e.Enemy.name) || undefined;
		var b = clone(e.buffs); if (b) o.buffs = b;
		return o;
	}

	var inputCb = null;
	var clientMode = false;   // closure flag — NOT the game-source KDServerRole (reverted)
	var _lastRestraintSig = null;   // re-dress the player paper-doll only when worn restraints change

	/**
	 * KD's draw loop emits this input EVERY FRAME from the live mouse position — it is a per-frame
	 * STREAM, not a player command. Named once because two places need it: the debug trace excludes
	 * it to stay readable, and `__coopDiag.suppressHover()` gates it so the chatter-ON/chatter-OFF
	 * frame-rate comparison can be taken.
	 */
	var HOVER_TYPE = 'setMoveDirection';

	/*
	 * The two hardcoded input lists that used to live here are GONE.
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
	 * entities before replaying the action (HeadlessHost.applyInput).
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
	 * Is this entity another PLAYER's avatar (a `RemotePlayer` / `RemotePlayer_<label>` def)?
	 * The one definition: `ensureAvatarDefs`, the snapshot restraint reset and the route driver's
	 * danger check (coop-bootstrap.js) all ask this, and used to spell it out inline.
	 */
	function isPeerAvatar(en) {
		var nm = en && en.Enemy && en.Enemy.name;
		return typeof nm === 'string' && nm.indexOf('RemotePlayer') === 0;
	}

	/**
	 * A struggle group with no worn item must not reach KD's HUD.
	 *
	 * `KinkyDungeonStruggleGroups` is a CACHE of the worn set (KD's `KinkyDungeonUpdateStruggleGroups`
	 * keeps only groups whose `KinkyDungeonGetRestraintItem(group)` is truthy), and this client adopts
	 * the cache and the worn set from the server separately. When they disagree, KD's HUD dereferences
	 * the missing item unguarded and the renderer dies every frame (owner UAT 2026-09-30:
	 * `KDGetItemPreview` ← `KDDrawStruggleGroups`, reading 'type' of null; the earlier cousin at
	 * KinkyDungeonHUD.ts:3511 is UPSTREAM_ISSUES.md #3).
	 *
	 * How the two fell out of step in that session is not known yet, so this does two things: it drops
	 * exactly the entries KD's own rebuild would drop (no other derivation), and it reports
	 * each one loudly with the worn set, so the next occurrence names its cause instead of crashing.
	 */
	function pruneStaleStruggleGroups() {
		if (typeof KinkyDungeonStruggleGroups === 'undefined' || !Array.isArray(KinkyDungeonStruggleGroups)
			|| typeof KinkyDungeonGetRestraintItem !== 'function') return;
		var kept = [], stale = [];
		for (var i = 0; i < KinkyDungeonStruggleGroups.length; i++) {
			var sg = KinkyDungeonStruggleGroups[i];
			if (sg && sg.group && KinkyDungeonGetRestraintItem(sg.group)) kept.push(sg);
			else stale.push(sg && sg.group);
		}
		if (!stale.length) return;
		KinkyDungeonStruggleGroups = kept;
		KDRenderClient.staleStruggleGroups = (KDRenderClient.staleStruggleGroups || 0) + stale.length;
		try {
			var worn = [];
			KinkyDungeonAllRestraint().forEach(function (it) { if (it && it.name) worn.push(it.name); });
			console.warn('[coop] dropped stale struggle group(s) with no worn item: ' + stale.join(',')
				+ ' — worn: ' + (worn.join(',') || '(none)') + '. Please report this line.');
		} catch (e) { /* the report must never be what crashes */ }
	}

	/**
	 * A co-op partner's avatar is a talk target client-side too — the sibling of
	 * `HeadlessHost.installPeerAllyDialogueGuard` (see its doc comment for the full "why": the
	 * dialogue itself stays reachable, since it is how a partner gets untied, but most of its OTHER
	 * options are NPC-only and hidden the same way, by wrapping each one's `prerequisiteFunction`).
	 * This browser draws its own dialogue buttons from its own bundle's `KDDialogue`, so it needs the
	 * identical wrap to offer the same options the server would act on.
	 *
	 * DRY note: this duplicates `HeadlessHost.installPeerAllyDialogueGuard` verbatim, same as
	 * `RemotePlayer`'s def and `KDParseStartRestraints` already do between these two files — a
	 * second instance of the same tracked debt, not fixed here.
	 */
	function installPeerAllyDialogueGuard() {
		if (typeof KDDialogue === 'undefined' || !KDDialogue.GenericAlly || !KDDialogue.GenericAlly.options) return;
		var opts = KDDialogue.GenericAlly.options;
		var hide = ['Leash', 'ReleaseLeash', 'Shop', 'ShopBuy', 'Attack', 'AttackPlay',
			'AttackUnaware', 'Food', 'JoinParty', 'Flirt', 'LetMePass', 'StopFollowingMe',
			'FollowMe', 'DontStayHere', 'StayHere', 'Aggressive', 'Defensive', 'HelpMe',
			'HelpMeCommandWord', 'HelpMeKey', 'DontHelpMe', 'RemoveParty'];
		function isPeerAvatarTarget() {
			var enemy = (typeof KinkyDungeonFindID === 'function') ? KinkyDungeonFindID(KDGameData.CurrentDialogMsgID) : null;
			var nm = (enemy && enemy.Enemy && enemy.Enemy.name) || '';
			return nm.indexOf('RemotePlayer') === 0;
		}
		function wrapEntry(entry) {
			var _prereq = entry.prerequisiteFunction;
			entry.prerequisiteFunction = function (gagged, player) {
				if (isPeerAvatarTarget()) return false;
				return _prereq ? _prereq(gagged, player) : true;
			};
			entry.__kdPeerAllyGuard = 1;
		}
		for (var i = 0; i < hide.length; i++) {
			var entry = opts[hide[i]];
			if (!entry || entry.__kdPeerAllyGuard) continue;
			wrapEntry(entry);
		}
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
		installPeerAllyDialogueGuard();
		if (KinkyDungeonGetEnemyByName('RemotePlayer')) return;
		KinkyDungeonEnemies.push({
			name: 'RemotePlayer', faction: 'Player', tags: KDMapInit(['peaceful']),
			bound: 'Apprentice', // presence makes KDCanBind true so the Truss/bind context option appears
			AI: 'guard', immobile: true, visionRadius: 0, maxhp: 100, minLevel: 0, weight: -1000,
			movePoints: 1000, attackPoints: 0, attack: '', attackRange: 0,
			evasion: -100, armor: 0, followRange: 100, lowpriority: true,
			style: 'BlueHair', // render the peer as a full character (NPC sprite path)
			terrainTags: {}, floors: KDMapInit([]),
		});
		if (typeof KinkyDungeonRefreshEnemiesCache === 'function') KinkyDungeonRefreshEnemiesCache();
	}

	/**
	 * Peers now use per-entity def names (RemotePlayer_<label>) so combat text reads the real
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
			if (!isPeerAvatar(en)) continue;
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

	// Last `appearance` string successfully applied, per entity id — so a peer who has not
	// changed how they look is not re-dressed every snapshot, and so a peer whose NPC model does
	// not exist YET (KDQuickGenNPC builds it lazily, on its first DRAW) is retried on a later one
	// instead of being silently skipped forever.
	var _appliedAppearance = {};

	// The declared `appearance` blob for every generated NPC we have ever restored one onto, keyed
	// by the NPC OBJECT itself (`installPeerDressGuard`'s wrap is handed the character object, not
	// an entity id, by every caller — including KD's own). A `WeakMap` so a despawned avatar's NPC
	// can be collected normally instead of leaking for the life of the page.
	var _peerAppearanceByNPC = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;

	/**
	 * Put the declared look's items onto `Character`, WITHOUT touching anything KD's own dress/bind
	 * step put there that the declared look never claimed — a worn restraint above all.
	 *
	 * ── WHY NOT A WHOLESALE `CharacterAppearanceRestore(..., false, true)` ────────────────────────
	 * That call is `Character.Appearance = declared` — every item not in the declared array is gone,
	 * restraints included. Measured (`mp-peer-restraint-and-appearance.spec.ts`): tying a restraint
	 * onto an avatar with `KDSetNPCRestraint` (the exact call KD's own "Tie Up" submenu makes) arms
	 * `KDRefreshCharacter` for that NPC, which makes `KinkyDungeonDressPlayer`'s gated rebuild lay the
	 * restraint onto `Character.Appearance` via `KDApplyItem` — and a wholesale restore on ANY later
	 * call (even one `KDRefreshCharacter` did not arm, which per-frame draw calls mostly are) discards
	 * it again, because nothing about "declared nothing for this slot" is distinguishable from
	 * "KD put something here that was never ours to overwrite" in a flat array replace.
	 *
	 * This keeps an existing item only when it is KD's OWN signal for "a worn item/restraint slot, not
	 * a look slot": a `Group` starting with `"Item"`, or `model.Restraint` — the exact pair
	 * `KinkyDungeonDressPlayer`'s OWN rebuild uses to decide the same question
	 * (`!model.Group?.startsWith("Item") && !model.Restraint`, `KinkyDungeonEnemies.ts`). Everything
	 * else (hair, body, face, eyes, earrings, base clothing) is fully replaced by the declared set, so
	 * a random generated item in one of THOSE groups is removed even when the declared look has
	 * nothing in that exact group (an avatar is identity-complete from the declared array alone; it is
	 * never a patchwork of "whatever wasn't a worn item").
	 */
	function mergeDeclaredLook(Character, declaredItems) {
		var current = Character.Appearance || [];
		var kept = [];
		for (var j = 0; j < current.length; j++) {
			var cm = current[j] && current[j].Model;
			var cg = cm && cm.Group;
			if (cm && (cm.Restraint || (cg && cg.indexOf('Item') === 0))) kept.push(current[j]);
		}
		Character.Appearance = kept.concat(declaredItems);
		if (typeof KDRefreshSelectedModel === 'function') KDRefreshSelectedModel(Character);
	}

	/**
	 * Decompress + resolve a declared `appearance` wire string into the shape `mergeDeclaredLook`
	 * needs (real `Model` objects, not name strings) — the same resolution
	 * `CharacterAppearanceRestore` does internally (`AppearanceItemParse`), exposed here because that
	 * function's own wholesale assignment is exactly what `mergeDeclaredLook` replaces.
	 */
	function applyDeclaredLook(Character, declaredWire) {
		if (typeof AppearanceItemParse !== 'function' || typeof DecompressB64 !== 'function') return;
		var backup = DecompressB64(declaredWire);
		var declaredItems = AppearanceItemParse(backup);
		if (Array.isArray(declaredItems)) mergeDeclaredLook(Character, declaredItems);
	}

	/**
	 * Re-assert a peer avatar's declared look immediately BEFORE KD's OWN dress pass runs for it —
	 * never after, and the ordering is load-bearing, not cosmetic. See the long note below.
	 *
	 * ── WHY THIS EXISTS: KD KEEPS RE-DRESSING THE AVATAR FROM ITS OWN DEFAULT ─────────────────────
	 * `KinkyDungeonDressPlayer` is what the real per-frame NPC sprite-draw calls for a visible avatar
	 * (`KinkyDungeonEnemies.ts`, the `KDToggles.ShowPatronNPCSprites` branch, right after
	 * `KDQuickGenNPC`) — every real frame, for as long as the avatar is on screen. For a generated NPC
	 * it derives its clothing from `KDCharacterDress.get(Character) || "Bandit"` (our avatar never
	 * sets one) — a fixed, wrong default, independent of whatever `applyPeerAppearances` wrote a
	 * moment earlier. A one-shot restore therefore loses to the very next real draw frame; a co-op
	 * session draws forever, so the peer avatar reverts to KD's default costume almost immediately
	 * (measured: a two-browser session shows the declared clothing for one apply, then KD's own
	 * default from the next real frame on).
	 *
	 * ── WHY BEFORE `_prev`, AND WHY A MERGE NOT A REPLACE (two regressions, both caught before ship) ──
	 * V1 called `_prev` first and restored (wholesale) after: "KD's dress pass runs in full, then we
	 * put the declared look back". Backwards for a restraint tied THIS frame — `_prev` had just laid
	 * it on, and the wholesale restore threw it straight off again, every frame, forever.
	 *
	 * V2 moved the (still wholesale) restore BEFORE `_prev`, reasoning `_prev`'s own gated rebuild
	 * would re-apply any worn restraint on top. True only on the frame `KDRefreshCharacter` happens to
	 * be armed — a one-shot flag KD's own `KDSetNPCRestraints` sets and the gated rebuild consumes.
	 * The NEXT frame, the flag is no longer armed, `_prev` does nothing, and the wholesale restore
	 * (which runs on EVERY call, armed or not) had already overwritten `Character.Appearance` back to
	 * the declared array with no restraint in it — so a bound peer was drawn bound for exactly one
	 * frame and untied from the next one on. Both measured by
	 * `mp-peer-restraint-and-appearance.spec.ts`, which drives a real `KDSetNPCRestraint` +
	 * `KinkyDungeonDressPlayer` call and checks the result, not the mechanism's description.
	 *
	 * V3 (this one) replaces the wholesale restore with `applyDeclaredLook`'s group-based MERGE: it
	 * never removes an item outside the groups the declared look itself covers, so a restraint already
	 * sitting in `Character.Appearance` (from an earlier armed frame, or about to be added by `_prev`
	 * on this one) is never a candidate for removal, on ANY frame, armed or not.
	 */
	function installPeerDressGuard() {
		if (typeof KinkyDungeonDressPlayer !== 'function' || KinkyDungeonDressPlayer.__kdPeerDressGuard) return;
		var _prev = KinkyDungeonDressPlayer;
		KinkyDungeonDressPlayer = function (Character) {
			try {
				var declared = (_peerAppearanceByNPC && Character) ? _peerAppearanceByNPC.get(Character) : null;
				if (declared) applyDeclaredLook(Character, declared);
			} catch (e) { /* a redress must never break a frame */ }
			// eslint-disable-next-line prefer-rest-params
			return _prev.apply(this, arguments);
		};
		KinkyDungeonDressPlayer.__kdPeerDressGuard = true;
	}

	// The last declared `appearance` blob per ENTITY ID — unlike `_peerAppearanceByNPC` (keyed by the
	// generated NPC object, which `installPeerGenGuard` below can replace), this key never changes
	// for the lifetime of an avatar, so it is what lets the gen-guard re-establish the NPC mapping
	// for a freshly (re)generated object it has never seen before.
	var _declaredByEntityId = {};

	/**
	 * Re-assert a peer avatar's declared look immediately after KD (re)generates its NPC model.
	 *
	 * ── WHY THIS EXISTS, NEXT TO `installPeerDressGuard` ──────────────────────────────────────────
	 * `installPeerDressGuard` corrects drift on the NPC OBJECT it already knows about. Measured on a
	 * real two-browser session (not reproducible in a single-page harness, where nothing ever
	 * regenerates the NPC): an eye/earring filter could still drift even with that guard installed,
	 * because `KDQuickGenNPC` (`KinkyDungeonEnemies.ts`) can hand back a DIFFERENT NPC OBJECT for the
	 * same entity id than the one `applyPeerAppearances` last restored — its own generation branch
	 * only fires `if (!KDNPCChar.get(id))`, but whatever causes that condition to go true again (a
	 * sprite/NPC-cache invalidation this project does not own or re-implement) produces an object
	 * `_peerAppearanceByNPC` has never seen, so `installPeerDressGuard`'s lookup misses it until the
	 * NEXT `applyPeerAppearances` (server-snapshot rate, not every frame) repopulates the map. This
	 * closes that window at the SOURCE: the moment a (re)generation happens, re-key immediately from
	 * the entity id — which never changes — rather than waiting for the next snapshot.
	 */
	function installPeerGenGuard() {
		if (typeof KDQuickGenNPC !== 'function' || KDQuickGenNPC.__kdPeerGenGuard) return;
		var _prev = KDQuickGenNPC;
		KDQuickGenNPC = function (enemy) {
			// eslint-disable-next-line prefer-rest-params
			var result = _prev.apply(this, arguments);
			try {
				var declared = enemy ? _declaredByEntityId[enemy.id] : null;
				var npc = (declared && typeof KDNPCChar !== 'undefined') ? KDNPCChar.get(enemy.id) : null;
				if (npc) {
					if (_peerAppearanceByNPC) _peerAppearanceByNPC.set(npc, declared);
					applyDeclaredLook(npc, declared);
				}
			} catch (e) { /* a redress must never break a frame */ }
			return result;
		};
		KDQuickGenNPC.__kdPeerGenGuard = true;
	}

	/**
	 * Make a peer's avatar look like the peer, not like the random preset `KDQuickGenNPC` would
	 * otherwise hand it.
	 *
	 * ── WHY THIS EXISTS: A PEER'S AVATAR MUST WEAR THE PEER'S OWN LOOK ────────────────────────────
	 * `enemy.style` only ever seeds `KDQuickGenNPC`'s RANDOM choice of hairstyle/bodystyle/facestyle
	 * out of a small preset table (`KinkyDungeonEnemies.ts` ~:11378-11391) — it was never a way to
	 * carry a player's own look. So every avatar was generated from a coin flip over a handful of
	 * presets, unrelated to how its owner actually looks on their own screen — the report this task
	 * fixes ("the peer … does not match how that peer looks to themselves").
	 *
	 * `appearance` (`HeadlessHost.spawnAvatar`, carried as an entity field like `style`/`outfit`) is
	 * the player's own serialised `Appearance`, in the SAME format KD's own wardrobe already uses
	 * to restore a Collection NPC's `customOutfit` (`KinkyDungeonCollection.ts` ~:514-547): decompress
	 * with `DecompressB64`, feed straight to `CharacterAppearanceRestore`. KD-native both ends; this
	 * file invents no format of its own.
	 *
	 * ── WHY CLIENT-SIDE, AND WHY LAZY ─────────────────────────────────────────────────────────────
	 * The headless server never draws (rendering neutered), so `KDQuickGenNPC` never runs there and
	 * `KDNPCChar` never gets an entry for an avatar — there is nothing server-side to apply this to.
	 * On a real browser the NPC model is built the first time the entity is actually DRAWN, so
	 * `KDNPCChar.get(id)` can be empty for a frame or two after the avatar first appears; this is
	 * called every `apply()` and simply retries (via `_appliedAppearance` NOT being set for that id)
	 * until the model exists.
	 */
	function applyPeerAppearances(entities) {
		if (!Array.isArray(entities) || typeof AppearanceItemParse !== 'function'
			|| typeof DecompressB64 !== 'function' || typeof KDNPCChar === 'undefined') return;
		installPeerDressGuard();
		installPeerGenGuard();
		for (var i = 0; i < entities.length; i++) {
			var en = entities[i];
			if (!en || !en.appearance || !isPeerAvatar(en)) continue;
			// Kept current for EVERY avatar that ever declared a look, by entity id — the one key that
			// survives `KDQuickGenNPC` handing back a different NPC object (`installPeerGenGuard`).
			_declaredByEntityId[en.id] = en.appearance;
			var npc = KDNPCChar.get(en.id);
			if (!npc) continue;   // not drawn yet; retry next apply()
			// Kept current on EVERY avatar that ever declared a look, even once `_appliedAppearance`
			// below stops re-restoring below — `installPeerDressGuard`'s wrap needs this mapping alive
			// for as long as the avatar exists, or a later real draw frame's own dress pass would win
			// back with nothing here to correct it.
			if (_peerAppearanceByNPC) _peerAppearanceByNPC.set(npc, en.appearance);
			if (_appliedAppearance[en.id] === en.appearance) continue;   // already matches — no re-dress
			try {
				applyDeclaredLook(npc, en.appearance);
				if (typeof CharacterRefresh === 'function') CharacterRefresh(npc);
				if (typeof KDInitProtectedGroups === 'function') KDInitProtectedGroups(npc);
				/*
				 * Deliberately NOT `KDRefreshCharacter.set(npc, true)`, unlike the Collection
				 * wardrobe-revert flow this is otherwise copied from. That flag is a one-shot
				 * "please redress me" request `KinkyDungeonDressPlayer` consumes on its NEXT call —
				 * which also recomputes a faction/palette-driven recolour across hair/body/face,
				 * not merely clothing. Leaving the flag alone means hair/body/face is never
				 * disturbed after this restore; `installPeerDressGuard` above handles clothing
				 * (KD's own per-frame redress keeps re-deriving it from a default regardless of
				 * this flag, so the wrap — not the flag — is what has to correct it).
				 */
				_appliedAppearance[en.id] = en.appearance;
			} catch (e) { /* a malformed/old-build blob must not break a frame */ }
		}
	}

	/**
	 * Give KD's own name getter back the fallback it already has everywhere else, so a peer
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
	 * Adopt this player's own STATE BUNDLE — the browser analogue of
	 * HeadlessHost.restorePlayer.
	 *
	 * The browser already runs a full KD instance. It does not need a curated view of the game; it
	 * needs its own state. The server ships the same generic capture the swap model uses,
	 * already stripped of world-scoped KDGameData keys, so there is nothing to classify here and no
	 * field list to keep in step with the host — which is exactly what the old `stats` block was, in
	 * four places and two languages.
	 *
	 * Mechanism: KD's globals are top-level `let`/`var` in SCRIPT scope, so they are not properties of
	 * globalThis and cannot be assigned through it. A DIRECT eval from this classic script resolves a
	 * bare name up the scope chain into that same global lexical environment — the identical trick the
	 * host uses inside the bundle's vm scope.
	 *
	 * ⚠️ COPY, never alias (measured on the host): `b` is the snapshot object and is reused;
	 * handing the game a reference into it means the game mutates the snapshot in place.
	 */
	/**
	 * Input types the AUTHORITATIVE WORLD had no handler for.
	 *
	 * Under option A the client classifies nothing, so it cannot know: it routes every type, and the
	 * server — which owns the real registry, `KDInputTypes` (`KinkyDungeonInput.ts:10`) — reports back
	 * anything it could not dispatch. A non-empty list means the caller sent a type no handler exists
	 * for anywhere, which is a real bug and now visible instead of a silent `return ''`.
	 */
	var _unhandled = [];                 // [{type, count}] — reported BY THE SERVER, see below
	// Inputs whose dispatch THREW in the authoritative world. Same source and same rule as
	// _unhandled above: reported BY THE SERVER, exposed rather than only logged, because a console
	// line is not readable by anything that wants to check the client actually heard about it.
	var _failed = [];                    // [{clientId, turn, kdType, error}]
	var _warned = {};

	/*
	 * The client-side drop RECORDER that used to live here is gone with the lists that
	 * made drops possible. There is no longer a "type on neither list" case to record — every input is
	 * routed, so the only place an input can go unhandled is the authoritative world, and the server
	 * reports that in `snapshot.unknownInputs` (SwapSession.unknownInputReport).
	 */

	/**
	 * Presentation ACCUMULATORS the client owns, keyed by the global they live on.
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
	 * tile on purpose, which is a value, not an absence.
	 */
	var CLIENT_OWNED_ENTITY_FIELDS = {
		KinkyDungeonPlayerEntity: ['visual_stamina', 'visual_mana'],
	};

	/**
	 * KDGameData keys that belong to the PERSON AT THIS BROWSER, not to their character.
	 *
	 * `KDGameData` is otherwise server-authoritative: `adoptBundle` writes every key the bundle
	 * carries, which is right for everything describing the run. `LogFilters` is not that. It is which
	 * message-log tabs this viewer wants to see — a preference belonging to the same category as
	 * `visual_*` above, and the server has no opinion about it because the headless host never draws a
	 * log.
	 *
	 * MEASURED, not argued (assessment F4): a player toggling a filter off had it silently restored by
	 * the next state frame, and the same-shape control key toggled in the same breath came back too —
	 * so the finding is "the server owns LogFilters", not "one key is special". Pinned by
	 * `tests/e2e/mp-coop-chat.spec.ts`, which toggles a real filter and a control and requires both to
	 * survive a frame.
	 *
	 * Cost, stated rather than discovered: the server's copy never learns the choice, so an exported
	 * save does not carry it. That is a UI toggle, not run state.
	 */
	var CLIENT_OWNED_GAMEDATA_KEYS = ['LogFilters'];

	/**
	 * `KDGameData.BulletWarnings[].scale` is the same category as `CLIENT_OWNED_ENTITY_FIELDS`
	 * above, one level deeper: a per-ENTRY field the DRAW loop eases from 0 to 1 while an AOE warning
	 * tile (an incoming spell or trap's affected area — a rope trap's burst among them) grows in
	 * (`KinkyDungeonFight.ts` `KinkyDungeonDrawFight`, `t.scale += delta * 0.005`). The array itself
	 * is rebuilt by the SIM once per real turn and must keep being replicated — the client cannot
	 * recompute which tiles are warned — but the headless host never runs that draw loop, so every
	 * entry it ships is frozen at its creation-time `scale` (0 for an area tile). The plain
	 * key-by-key adopt below installs `KDGameData` wholesale on every reply, including a UI-only one
	 * a mouse hover triggers mid-turn with no new turn behind it, so each reply clobbered the
	 * client's own eased-up `scale` back to 0 and the grow-in (and the burst drawn over the same
	 * tiles) replayed on every reply — UAT: "the rope trap animation and affected cells are replayed
	 * again and again on my mouse movements".
	 *
	 * Matched by position (`x,y` — the one stable identity an area-warning entry has), a scale never
	 * regresses: a tile re-sent mid-turn keeps whatever the client already eased it to, a genuinely
	 * new tile (no match) keeps the server's own value and grows in normally, and a tile the server
	 * stops sending is simply absent from the result (the array itself is replaced wholesale, not
	 * merged by identity, so nothing here can keep an expired tile alive).
	 */
	function mergeBulletWarningScale(prevArr, nextArr) {
		if (!Array.isArray(prevArr) || !Array.isArray(nextArr)) return nextArr;
		var byPos = {};
		for (var pi = 0; pi < prevArr.length; pi++) {
			var p = prevArr[pi];
			if (p && p.scale !== undefined && p.x !== undefined && p.y !== undefined) {
				byPos[p.x + ',' + p.y] = p.scale;
			}
		}
		for (var ni = 0; ni < nextArr.length; ni++) {
			var e = nextArr[ni];
			if (e && e.scale !== undefined && e.x !== undefined && e.y !== undefined) {
				var prevScale = byPos[e.x + ',' + e.y];
				if (prevScale !== undefined && prevScale > e.scale) e.scale = prevScale;
			}
		}
		return nextArr;
	}

	/**
	 * WHOLE globals that belong to the person at this browser. The third granularity of the
	 * same idea as the two lists above: a field within a global (`CLIENT_OWNED_ENTITY_FIELDS`), a key
	 * within `KDGameData` (`CLIENT_OWNED_GAMEDATA_KEYS`), and now the global itself.
	 *
	 * `KinkyDungeonShopIndex` is which row of the shared shop stock THIS player has highlighted. The
	 * stock (`KDMapData.ShopItems`) is world state and the cursor into it is not: nothing routes a
	 * cursor move, and every write in the game is a bare local assignment (the click at
	 * `KinkyDungeonShrine.ts:549`, the keyboard at `KinkyDungeon.ts:4281-4286`). The server does hold
	 * a value — its `shrineBuy` handler sets it (`KinkyDungeonInput.ts:615`) — which is exactly
	 * the situation of the client-owned keys above: entitled to hold it, not the authority over it.
	 *
	 * Skipped BEFORE `_bundleDefaults` and `_bundleDirty` are written, and that placement is the whole
	 * point. There are two clobber channels, not one: the adopt below overwrites the cursor whenever
	 * the bundle carries it, and the absent-rule further down resets it to 0 once it has been dirty
	 * and is then omitted (a global drops out of a bundle when it returns to its default). Skipping
	 * only the assignment would leave the second one live. `kdAbsentResets` considers dirty names
	 * alone, so never marking it dirty closes both at once.
	 *
	 * This is deliberately NOT a `GLOBAL_BLACKLIST` entry: that list is "globals that are NOT
	 * per-player, by CATEGORY, never per feature" (headless-host.js) and this one IS per-player — it
	 * is the *authority* that differs, not the category. Server capture is unchanged, same as for those keys.
	 *
	 * Pinned by `tests/e2e/mp-shop-identity.spec.ts`, which only exercises this after the server has
	 * had a reason to carry the value — i.e. after that player has bought something once.
	 */
	var CLIENT_OWNED_GLOBALS = ['KinkyDungeonShopIndex'];

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

	/**
	 * A pure NO-OP OPTIMISATION, not a protection mechanism: skip re-decoding/re-assigning a `gameData`
	 * key when there is nothing to do on EITHER side — the incoming server value is byte-identical to
	 * the last one this client adopted, AND the live value still equals it too. Cheap (one extra
	 * string compare on the hit path; every key already pays one for the raw signature either way),
	 * which matters because it is the common case every UI-only reply hits.
	 *
	 * ── REVISED DECISION (I4 wins for every key) ──────────────────────────────────────────────────
	 * An earlier version of this cache skipped whenever the SERVER's value was unchanged, full stop —
	 * on the theory that this also "protected" any client/draw-owned mutation of the same key from
	 * being clobbered by an identical resend (the `BulletWarnings[].scale` grow-in below was the
	 * motivating case). That theory directly contradicts the render-completeness invariant (I4): the
	 * client's `KDGameData` must match the server's bundle, for every key the server carries, per
	 * player — with no exceptions the server cannot see. The two are incompatible for any key the
	 * GAME's OWN ENGINE locally re-derives between replies without this file's knowledge
	 * (`KinkyDungeonUpdateStats` recomputing `Restriction`, a fresh `KinkyDungeonStartNewGame`
	 * resetting `ListenerList` — neither is a `tools/mp-server/**` write, so the old version's own
	 * grep of this codebase never saw the risk): the drifted value got stuck wrong for the rest of the
	 * session, because the server's own value never changed again to force a re-adopt.
	 *
	 * So: I4 wins by default, for every key. Protection from an unchanged resend is granted ONLY to
	 * state EXPLICITLY DECLARED client/draw-owned — `CLIENT_OWNED_GAMEDATA_KEYS` /
	 * `CLIENT_OWNED_ENTITY_FIELDS` (skipped on adopt by NAME, never reaching this cache at all), and
	 * the `BulletWarnings[].scale` merge below (a NAMED per-entry mechanism, not an instance of this
	 * generic one). This cache itself declares nothing and protects nothing — the live-value check is
	 * what makes that true: a key nobody has touched locally skips harmlessly (nothing to reassign,
	 * nothing to correct), while a key that HAS drifted locally — declared or not — fails the
	 * live-value check and is reasserted from the server's answer, exactly as I4 requires.
	 *
	 * Keyed by the RAW (pre-decode) value, same shape as the host's own divergence hashing. Scoped to
	 * `gameData` only, not `KDMapData`/entity or bullet arrays — `KDMapData` is a far larger, more
	 * varied structure (`ensureAvatarDefsFor`, `applyPeerAppearances`, `av.boundLevel = 0`, below, all
	 * rely on a fresh wholesale map every apply), and the one draw-owned animation state for BULLETS
	 * specifically (`KinkyDungeonBulletsVisual`) lives in a SEPARATE global this file never
	 * references — confirmed by probe, not assumed — so it cannot be clobbered by `KDMapData = s.map`
	 * in the first place and extending this cache there bought nothing. See the "does the same clobber
	 * hit the rope burst ANIMATION itself" tests.
	 *
	 * Two local `gameData` mutations elsewhere in this file were checked by name (both still fine
	 * under the revised rule — neither depends on this cache to be correct):
	 *   - `KDGameData.NPCRestraints` (peer-avatar reset, below, `KDSetNPCRestraints(av.id, {})`) runs
	 *     UNCONDITIONALLY after this loop, every apply, regardless of whether this cache skipped the
	 *     key this round.
	 *   - `KDGameData.JourneyTarget` (`kd-journey-choice.js`, the `KDRenderJourneyMap` wrap) reverts a
	 *     local write back to its PRE-write value synchronously, before any apply() can run — so by
	 *     the time this cache's comparison runs, the live value already equals what was last adopted.
	 *
	 * Does NOT replace the `BulletWarnings` per-entry merge below: this cache is keyed on the WHOLE
	 * value, so it only helps when the array is byte-identical to last time. A real new turn that adds
	 * one newly-warned tile alongside an already-growing one changes the whole array's bytes (it must
	 * — a brand new tile is real content), so this cache does NOT skip that reply, and the per-entry
	 * merge is still what keeps the already-eased tile's progress while the new one starts at 0.
	 */
	var _lastAdoptedGameData = {};

	/**
	 * Bullet SPRITES. KD draws a bullet only from `KinkyDungeonBulletsVisual`
	 * (`Game/src/fight/KinkyDungeonFight.ts:53`), a module-scope Map the snapshot does not carry, and
	 * the only writer of it is the turn simulation (`KinkyDungeonUpdateSingleBulletVisual`, from
	 * launch / update / hit), which this client does not run. Without this, every projectile and spell
	 * is in the adopted `KDMapData.Bullets` and never on screen.
	 *
	 * Mirrors KD's own per-tick order, through KD's own functions:
	 *   1. every bullet of the adopted map is registered (`end` false). KD's function KEEPS an existing
	 *      entry's scale / alpha / visual position, so a UI-only reply restarts nothing;
	 *   2. a bullet the world has dropped is handed to KD's fade-out (`end`), ONCE — re-marking it
	 *      `updated` on every reply would keep KD's housekeeping from ever deleting it;
	 *   3. on a NEW TURN only (the snapshot's tick moved), KD's per-tick housekeeping
	 *      `KinkyDungeonUpdateBulletVisuals` clears `updated` and deletes what has faded.
	 */
	var _lastBulletTick;
	function syncBulletVisuals(tick) {
		if (typeof KinkyDungeonBulletsVisual === 'undefined' || !KinkyDungeonBulletsVisual
			|| typeof KinkyDungeonUpdateSingleBulletVisual !== 'function') return;
		var live = {};
		var bs = (KDMapData && Array.isArray(KDMapData.Bullets)) ? KDMapData.Bullets : [];
		for (var i = 0; i < bs.length; i++) {
			var b = bs[i];
			if (!b || !b.spriteID || !b.bullet) continue;
			live[b.spriteID] = 1;
			try { KinkyDungeonUpdateSingleBulletVisual(b, false); } catch (e) { /* one bad bullet must not stop the frame */ }
		}
		KinkyDungeonBulletsVisual.forEach(function (v, id) {
			if (!live[id] && v && !v.end) { v.end = true; v.updated = true; }
		});
		if (tick !== undefined && tick !== _lastBulletTick) {
			if (_lastBulletTick !== undefined && typeof KinkyDungeonUpdateBulletVisuals === 'function') {
				try { KinkyDungeonUpdateBulletVisuals(1); } catch (e) { /* housekeeping only */ }
			}
			_lastBulletTick = tick;
		}
	}

	var _adoptVal;                       // transfer slot for the direct eval below
	var _kdDec = null;                   // memoised codec decoder (window.KDCodec loads later)

	/**
	 * Assign one global from a captured value. Shared by bundle adoption, by its reset pass, and
	 * by the snapshot's `worldGlobals` — module scope so all three decode identically,
	 * for the same reason the host has a single `assign`.
	 * COPY, never alias: `v` belongs to the bundle (or to `_bundleDefaults`), and both outlive
	 * this call; handing the game a reference lets it mutate our stored copy in place.
	 */
	function assignGlobal(name, v) {
		// Memoised, not re-read per call: this runs once per global on every snapshot, and
		// `window.KDCodec` is a script-load-order lookup, not a value that changes. Cached only once
		// it is actually found, so a call made before the codec loads is retried rather than pinned.
		if (!_kdDec) {
			var codec = (typeof window !== 'undefined' && window.KDCodec) ? window.KDCodec : null;
			if (codec && codec.kdDec) _kdDec = codec.kdDec;
		}
		var dec = _kdDec || function (x) { return x; };
		// A __kdT tag only ever sits at the TOP level, so this O(1) test is enough.
		_adoptVal = (v && typeof v === 'object')
			? (v.__kdT ? dec(v) : JSON.parse(JSON.stringify(v)))
			: v;
		// Carry over the client-owned animation accumulators the server has no
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

	function adoptBundle(b) {
		if (!b) return 0;
		var codec = (typeof window !== 'undefined' && window.KDCodec) ? window.KDCodec : null;
		var dec = (codec && codec.kdDec) ? codec.kdDec : function (v) { return v; };
		var ser = (codec && codec.kdSer) ? codec.kdSer : function (v) { return JSON.stringify(v); };
		var n = 0;

		if (b.gameData && typeof KDGameData !== 'undefined' && KDGameData) {
			for (var gk in b.gameData) {
				if (!Object.prototype.hasOwnProperty.call(b.gameData, gk)) continue;
				if (b.gameData[gk] === undefined) continue;
				// A viewer's own UI preference is never overwritten by the server's copy of it
				// — see CLIENT_OWNED_GAMEDATA_KEYS. Skipped on ADOPT rather than stripped on capture,
				// because the server is entitled to hold a value here; it just is not the authority.
				if (CLIENT_OWNED_GAMEDATA_KEYS.indexOf(gk) >= 0) continue;
				try {
					// GENERIC layer first: nothing to do on EITHER side — skip entirely rather than
					// re-run decode/merge/assign for nothing. See `_lastAdoptedGameData` above for the
					// full reasoning (a NO-OP optimisation, not protection — I4 wins for every key; the
					// live-value check is what makes that true rather than assumed).
					var rawGameDataSig = JSON.stringify(b.gameData[gk]);
					if (_lastAdoptedGameData[gk] === rawGameDataSig
						&& JSON.stringify(KDGameData[gk]) === rawGameDataSig) continue;
					var decodedGameDataVal = dec(b.gameData[gk]);
					if (gk === 'BulletWarnings' && Array.isArray(decodedGameDataVal)) {
						decodedGameDataVal = mergeBulletWarningScale(KDGameData.BulletWarnings, decodedGameDataVal);
					}
					KDGameData[gk] = decodedGameDataVal;
					_lastAdoptedGameData[gk] = rawGameDataSig;
					n++;
				} catch (e) { /* not assignable */ }
			}
		}
		var g = b.globals;
		if (g) {
			for (var name in g) {
				if (!Object.prototype.hasOwnProperty.call(g, name)) continue;
				var v = g[name];
				if (v === undefined) continue;
				// This viewer's own state, never the server's to install — and skipped here,
				// before the two lines below make it eligible for the absent-rule too.
				if (CLIENT_OWNED_GLOBALS.indexOf(name) >= 0) continue;
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

		/*
		 * KDModalArea NEVER ROUND-TRIPS, SO THE ABSENT-RULE ABOVE CANNOT CLOSE IT.
		 *
		 * A tile-object modal's close "X" (`KinkyDungeonDraw.ts:1094`) draws from `KDModalArea` alone,
		 * independently of `KinkyDungeonTargetTile`. Every stock call site OPENS it only from per-frame
		 * DRAW code gated on `KinkyDungeonTargetTile` being truthy (`KDObjectDraw[...]`,
		 * `KinkyDungeonHUD.ts:402-405`) — only a real browser runs that loop — and CLOSES it in
		 * lock-step with `KinkyDungeonTargetTile = null` from INPUT-HANDLER code (e.g. the Heart
		 * Tablet's "heart" purchase, `KinkyDungeonInput.ts:1053-1094`), which in co-op is
		 * turn-consuming and therefore runs on the authoritative SERVER. The server has no draw loop,
		 * so its own `KDModalArea` never diverges from its post-init baseline (`false`) and the
		 * generic capture never ships it either way (`headless-host.js` `_captureGlobals`): it is
		 * never adopted above, so it is never in `_bundleDirty`, so `kdAbsentResets` never considers
		 * it. The browser's own locally-latched `true` (set by last frame's draw call) then survives
		 * forever — UAT: the Heart Tablet's "X" stayed on screen, with no modal body, blocking the
		 * move-path preview under it.
		 *
		 * Every stock open/close pair treats the two as inseparable (grep `KDModalArea = ` across
		 * `Game/src`: every `= true` is reached only via a truthy `KinkyDungeonTargetTile`, and every
		 * `= false` sits beside a `KinkyDungeonTargetTile = null` in the same statement list), so
		 * deriving the flag from that invariant — rather than replicating it — is the one place this
		 * client can see the server's real answer without a server-side change (the game tree is
		 * never edited). Only ever CLEARS: a modal that is still legitimately open
		 * (`KinkyDungeonTargetTile` still truthy) is left exactly as the draw loop set it.
		 */
		if (typeof KDModalArea !== 'undefined' && KDModalArea
			&& typeof KinkyDungeonTargetTile !== 'undefined' && !KinkyDungeonTargetTile) {
			KDModalArea = false;
			n++;
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
				// No `stats` block — it was the host's copy of a hand-kept HUD contract. See
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
				// The OTHER two inputs to the same light-params lookup `level`/`checkpoint`
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
				// Generic now, from the ONE declared list — served to the browser as
				// window.KDWorldGameDataKeys, GENERATED from KDGAMEDATA_WORLD_KEYS rather than copied
				// beside it. The per-field pair this replaces had to be edited in four mirrored places
				// every time a world key was added, and forgetting one of the four is silent.
				worldGameData: (function () {
					var o = {}, ks = (typeof window !== 'undefined' && window.KDWorldGameDataKeys) || null;
					if (!ks) {
						// LOUD, not silent. Without the list this returns {} and the receiver adopts nothing
						// — which is the old lightmap bug exactly (measured then: the wrong alt type moved 0.054 of
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
			installPeerNameFallback();   // so a peer avatar names itself in the ally dialogue
			// Adopt this player's own state FIRST, so the explicit assignments below (which
			// carry snapshot-time render fixups like snapped visual_x/visual_y) still have the last word.
			KDRenderClient.lastBundleFields = adoptBundle(s.bundle);
			// The co-op RELATIONSHIP state (who this player is at war with, and whether they
			// owe an answer to a peace offer). Published as a plain field rather than adopted into a
			// game global: it is the gateway's own state, not KD's, and the context-menu wrap in
			// coop-menu.js reads it every frame. `undefined` is preserved as null so a client talking
			// to an older server can tell "no relationship" from "not supported".
			KDRenderClient.lastCoop = s.coop || null;
			// Surface what the authoritative world could not dispatch. Warned once per
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
			// …and the louder sibling — an input whose dispatch THREW in the authoritative
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
			// The ~12 hand-assigned HUD stats that used to be here are gone, and so is the
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
			if (s.map) syncBulletVisuals(s.tick);
			// Register/re-link a real def for each peer's unique name so the draw path
			// (KDEnemyRank → .tags) doesn't crash on the renamed/JSON-mangled avatar Enemy.
			if (KDMapData && Array.isArray(KDMapData.Entities)) ensureAvatarDefsFor(KDMapData.Entities);
			if (KDMapData && Array.isArray(KDMapData.Entities)) applyPeerAppearances(KDMapData.Entities);
			// The "Tie Up" submenu runs LOCALLY on the attacker and writes the avatar's NPC
				// restraints into KDGameData.NPCRestraints — which the snapshot does NOT reset (it only
				// syncs KDMapData). Over several ties those local slots accumulate and the stock apply
				// (KDGetNPCBindingSlotForItem(...).sgroup, no null guard) crashes on a full slot. Reset each
				// peer avatar's LOCAL bondage every snapshot — the authoritative tie lives on the server and
				// is reflected on the VICTIM's own client via s.restraints below.
				if (KDMapData && Array.isArray(KDMapData.Entities) && typeof KDSetNPCRestraints === 'function') {
					for (var ai = 0; ai < KDMapData.Entities.length; ai++) {
						var av = KDMapData.Entities[ai];
						if (isPeerAvatar(av)) {
							try { KDSetNPCRestraints(av.id, {}); av.boundLevel = av.boundLevel || 0; } catch (e) { /* ignore */ }
						}
					}
				}
				if (typeof KDUpdateEnemyCache !== 'undefined') KDUpdateEnemyCache = true;
			if (s.player && KinkyDungeonPlayerEntity) {
				for (var k in s.player) { if (k !== 'enemyName' && k !== 'Enemy') KinkyDungeonPlayerEntity[k] = s.player[k]; }
			}
			/*
			 * The DERIVATIONS that used to live here are gone.
			 *
			 * This block used to hand-call `KinkyDungeonRefreshRestraintsCache`, `KinkyDungeonUpdateRestraints`
			 * (→ `KinkyDungeonPlayerTags`) and `KinkyDungeonUpdateStruggleGroups` — a partial reimplementation
			 * of KD's per-turn pass, each call added reactively after a bug (the arm pose, the struggle-
			 * group crash). They are unnecessary now: those globals are per-player state that the bundle
			 * carries, so `adoptBundle` above installs the SERVER's already-correct values.
			 *
			 * Measured before deleting: across 4949 candidate globals, a client that adopts
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
				pruneStaleStruggleGroups();
				KinkyDungeonMessageLog = s.messages.log || [];
			/*
			 * ONE-SHOT EVENTS ARE APPLIED AT MOST ONCE.
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
			 * ONE-SHOT EVENTS, APPLIED AT MOST ONCE.
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
							// The ripple + sound echo, on the same exactly-once channel as the
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
			 * Adopt the WORLD half of KDGameData — the room the party is in, the map mod,
			 * where it stands on the journey and which route it agreed to take.
			 *
			 * Two of these were first shipped by name because the lightmap needs them: KinkyDungeonVision
			 * reads `KDGetAltType(level)`, which resolves off RoomType/MapMod rather than the level
			 * number, so a snapshot carrying only the level recomputed the lightmap with the wrong alt
			 * type. The set is now generic — `_clientBundle` STRIPS every declared world key from
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
			 * The WORLD GLOBALS half, on the same terms as worldGameData directly above:
			 * iterate what was SENT, so the declared list lives server-side only and an older
			 * snapshot that carries none of them simply changes nothing.
			 *
			 * Today that is the three item-variant registries. They stopped riding the per-player
			 * bundle when they became world state, and the browser resolves an enchanted item's
			 * NAME through them — without this the item list draws entries with no definition behind
			 * them. Runs AFTER adoptBundle for the same reason: the world's answer wins.
			 */
			if (s.worldGlobals) {
				for (var wg in s.worldGlobals) {
					try { assignGlobal(wg, s.worldGlobals[wg]); } catch (e) { /* not assignable here */ }
				}
			}
			/*
			 * Invalidate the derived vision/light cache HERE, where the state it derives
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
			 * — it never called pinGameScreen, so its "applied" frame stayed the previous
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
		 * reverted; the client is pure monkey-patch). The server is
		 * authoritative; the client never resolves an action or advances a turn locally.
		 */
		/**
		 * Read-only: is this page a co-op render client right now?
		 *
		 * The one question a routed wrap (`kd-perk-choice.js`, `kd-journey-choice.js`) has to ask before
		 * it swaps what a click MEANS: a page that never entered a session is an ordinary solo game, and
		 * rerouting its clicks to a server that is not there is how "Accept does nothing" shipped.
		 */
		isClientMode: function () { return clientMode; },
		/** See `isPeerAvatar` above. */
		isPeerAvatar: isPeerAvatar,

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
				// ROUTE the real dispatcher: KD's own key/click handlers call
				// KDSendInput(type,data) for the default controls — for turn-consuming
				// gameplay we forward {kdType,data} to the server (authoritative) and DON'T
				// run it locally. Local-only UI (menus/choices) still dispatches locally (R6).
				KDSendInput = function (type, data) {
					if (clientMode) {
						// Input diagnostics: trace turn-consuming inputs + dropped ones. We log only
						// Input diagnostics: every input now takes one path, so the trace is just the
						// type. `setMoveDirection` is per-frame mouse chatter, so it is excluded to keep
						// the console readable. Toggle window.__KDMP_DEBUG.
						if (typeof window !== 'undefined' && window.__KDMP_DEBUG && type !== HOVER_TYPE) {
							try { console.log('[mp-client] KDSendInput', type, '-> ROUTE', (data && data.id != null) ? ('id=' + data.id) : ''); } catch (e) { /* ignore */ }
						}
						/*
						 * DIAGNOSTIC GATE. Off by default; nothing sets it in real play.
						 *
						 * The whole per-frame round-trip (send → server → state reply → apply → light
						 * grid recompute) hangs off this ONE input type. Measuring the frame rate with
						 * it routed and again with it dropped is the only way to tell whether that
						 * round-trip STARVES the draw loop or is merely a passenger while something
						 * else does — the question tests/e2e/mp-input-matrix.spec.ts exists to answer.
						 *
						 * Dropped, never silently: it is counted through the same `noteSkip` channel as
						 * every other skipped input (no invisible losses), so the rollup shows
						 * exactly what the reading cost.
						 */
						if (type === HOVER_TYPE && typeof window !== 'undefined' && window.__KDMP_SUPPRESS_HOVER) {
							try { window.__coopDiag.noteSkip(type, 'suppressHover'); } catch (e) { /* diag optional */ }
							return '';
						}
						/*
						 * ⚠️ KNOWN COUPLING — the ONE input still run locally.
						 *
						 * The Bondage cast opens KD's real "tie" SUBMENU, which is a purely client-side UI
						 * construct: measured, the headless world returns "Fail"
						 * for this cast and touches no submenu state whatsoever — only text-message
						 * globals. So there is nothing for the server to send back and nothing the state
						 * bundle can carry; it is the same client-owned category as the paper doll, the
						 * camera and the vision radius.
						 *
						 * Routing it therefore loses the submenu ("tie submenu should be open" in
						 * tests/e2e/mp-pvp-tie.spec.ts). The submenu's own apply (`addNPCRestraint`) is
						 * routed normally, so the authoritative tie still happens server-side.
						 *
						 * This is recorded as a known coupling rather than kept quietly. Its
						 * cause is the synthetic PvP/bondage model, which is slated for removal; delete this
						 * branch when that lands.
						 */
						if (type === 'tryCastSpell' && data && data.spellname === 'Bondage') {
							return _origSend.apply(this, arguments);
						}
						// DEFAULT = ROUTE. This client classifies nothing and swallows
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
		 * Every input type this client could not handle, with whether the GAME's own
		 * registry knows it. Empty is the healthy state; a non-empty list is a to-do, not a mystery.
		 */
		unhandledInputs: function () {
			return _unhandled.slice();
		},

		/**
		 * Every input whose dispatch THREW inside the authoritative world, as the server
		 * reported it. Fourth member of the drop-report family; empty is the healthy state.
		 */
		failedInputs: function () {
			return _failed.slice();
		},

		/** True once disableLocalSim() has marked this browser render-only. */
		isLocalSimDisabled: function () { return clientMode; },

		/** Register a callback invoked when local input should be sent to the server. */
		onInput: function (cb) { inputCb = cb; },

		/** Forward a player action (e.g. {dx,dy}) to the server via the registered cb. */
		sendInput: function (action) { if (inputCb) inputCb(action); return action; },
	};

	(typeof window !== 'undefined' ? window : globalThis).KDRenderClient = KDRenderClient;
})();
