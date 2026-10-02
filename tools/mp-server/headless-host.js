/**
 * tools/mp-server/headless-host.js
 *
 * Headless Node game host (PoC scope). Boots the stock out/main.js inside
 * an isolated V8 context (vm) behind the shim layer, and exposes a small API:
 *   init(opts) · step(n) · getState() · loadSave(str) · saveOf() · eval(code)
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
 * Zero edits to Game/src/** or Scripts/** (a standing invariant). The serverMode
 * flag is set via a bundle global from the orchestrator, not a source edit.
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
 * Keys of KD's own save that describe the SHARED WORLD, not a player.
 *
 * `player = KinkyDungeonGenerateSaveData() - WORLD_KEYS` — the swap model keeps one authoritative
 * world and N players, and this is the subtraction that separates them. Deliberately short and
 * SEMANTIC: it changes only when the world model changes, which is far rarer than feature additions.
 * (Enumerating the *player* side instead is what produced an earlier bug class — the player side is
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
 * KDGameData keys that are FLOOR/WORLD scope rather than player scope.
 *
 * KDGameData is 221 keys and mixes both — in single-player the distinction does not exist (one
 * player, one world, one bag), so upstream has no reason to separate them. Everything NOT listed
 * here is treated as per-player.
 *
 * The default is deliberately per-player: a player field wrongly shared is exactly the contamination
 * bug class this epic exists to remove. Measured evidence: 86 of 123 probed primitive keys leaked
 * between players before this list existed.
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
	// Three more that are keyed by MAP COORDINATES or by a world slot, found by the
	// transition-write audit rather than by a bug:
	//   PersistentItems    keyed by `RoomType + "," + KDCurrentWorldSlot.x + "," + .y`
	//                      (KDMapGen.ts:70) and read across every slot by KinkyDungeonInventory.ts:3369.
	//   AlreadyOpened      `{x, y}` map coordinates (KinkyDungeonTilesList.ts:643/659/687), read by
	//                      `KDAlreadyOpened(x, y)` (KinkyDungeonGame.ts:381). "Has the party opened
	//                      this tile" — the direct sibling of ChestsGenerated directly above.
	//   KeyringLocations   `{x, y}` map coordinates for jail keyring placement (KinkyDungeonJail.ts:651).
	// Pinned by tests/unit/mp-world-generation-keys.spec.ts (divergence + control on each).
	'PersistentItems', 'AlreadyOpened', 'KeyringLocations',
	// The run's JOURNEY TYPE ("Random"/"Harder"/"Explorer"), written at
	// KDStairActions.ts:187 and KinkyDungeon.ts:4455. It is the INPUT to
	// `KDInitializeJourney(KDGameData.Journey, level)` (KDStairActions.ts:188, KDMapGen.ts:681), which
	// builds `JourneyMap` — already a world key. Leaving the input per-player while its
	// output is world is exactly the half-classified pair the RoomType fix warns about: two players holding
	// different journey types would generate different journey maps for one party.
	'Journey',
	// The jail-point selection timer for ENEMIES (KinkyDungeonEnemies.ts:202/205/215, reset
	// at KDMapGen.ts:48). Decisive detail: it is compared against and assigned from
	// `KinkyDungeonCurrentTick`, which is itself blacklisted world state. A per-player value
	// denominated in a world clock is incoherent — whoever was swapped in last would move the party's
	// shared jail timer. Pinned by tests/unit/mp-journey-jail-keys.spec.ts.
	'PreferredJailPointTick',
	// The seed the CURRENT map was generated from, and the value KD's save loader re-seeds
	// the RNG to (`KinkyDungeon.ts:7379`). Classified with `KinkyDungeonSeed` in GLOBAL_BLACKLIST,
	// which is where the full argument lives: they are written by one statement
	// (`KinkyDungeonGame.ts:962-970`) and describe the party's one world, not a player.
	'LastMapSeed',
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
	// (b) WHICH MAP the party is on — "" for a dungeon floor, JourneyFloor for the between-floors
	// hub, Tunnel/PerkRoom/ShopStart for the side rooms. The session has one world and one map, and a
	// floor change moves the whole party.
	//
	// Unlike NPCRestraints above, this one is PROVEN rather than reasoned: the game assigns these two
	// in exactly four places and every one is a map load, a map generation or a floor transition —
	// KDMapGen.ts:87-88, KDStairActions.ts:201, the new-game boot at KinkyDungeon.ts:6025, and
	// decisively KinkyDungeonGame.ts:841-842, which is
	//
	//     KDGameData.RoomType = KDMapData.RoomType;
	//     KDGameData.MapMod   = KDMapData.MapMod;
	//
	// i.e. the game itself says these are a COPY of a field on KDMapData — state this layer already
	// treats as authoritative and shared. Being DERIVED makes a per-player copy wrong twice over: a
	// bundle can hold a value its own source of truth has since moved past.
	//
	// They classify together because they are written by the same statements; splitting them would
	// leave the pair half-classified. No client compensation is needed — render-client.js:617-618
	// already restores both from the snapshot's own world-sourced fields, after adoptBundle, so the
	// browser has always preferred the world's answer. This makes the server agree.
	//
	// Pinned by tests/unit/mp-room-world-state.spec.ts (the divergence case) and, generically, by
	// mp-noninterference.spec.ts, which checks declared world keys from both directions.
	'RoomType', 'MapMod',
	// WHERE ON THE JOURNEY the party stands, and how deep this RUN has gone.
	//
	// JourneyX/JourneyY are committed by the transition itself
	// (KinkyDungeonTiles.ts:861-862 copies them out of JourneyTarget), i.e. derived from the same
	// event that sets MiniGameKinkyDungeonLevel — which is blacklisted just above for the same reason.
	// A party walks one route; two players cannot stand on different journey nodes and be in the same
	// map.
	//
	// HighestLevelCurrent/HighestLevel are how deep this run has been. One run, one answer. NOT
	// cosmetic: `MiniGameKinkyDungeonLevel == KDGameData.HighestLevelCurrent` is the condition under
	// which the game generates a PerkRoom instead of advancing (KinkyDungeonTiles.ts:930-946), so a
	// per-player copy makes the between-floors room appear or not depending on WHO took the stairs.
	//
	'JourneyX', 'JourneyY', 'HighestLevelCurrent', 'HighestLevel',
	// WHICH ROUTE the party is taking out of the hub, and the map of routes it is
	// choosing from.
	//
	// These three were deliberately left per-player at first, because until there was a rule for what a
	// "target" means when two players disagree, the acting player's target was the only answer
	// available. The journey agreement (party-choice.js) IS that rule — one pending proposal, one agreed target, arbitrated by the
	// session — so the committed answer is now the PARTY's, and can no longer be a copy belonging to
	// whoever happens to be swapped in.
	//
	// Criterion (b), and by the same evidence as JourneyX/JourneyY above: `KDAdvanceLevel`
	// (KinkyDungeonTiles.ts:859-872) COPIES JourneyTarget into JourneyX/JourneyY and clears
	// UseJourneyTarget in one statement block, so the five are written together and splitting them
	// leaves the set half-classified. `KDStairActions.ts:45` then reads
	// `JourneyMap[JourneyTarget]` for the next floor's MapMod / Faction / EscapeMethod / RoomType —
	// a per-player copy makes the next floor whichever player's copy was swapped in, which is R11's
	// bug stated exactly.
	//
	// JourneyMap belongs with them for a reason of its own: `KDAdvanceLevel` MUTATES it on every
	// descent, pruning the departed slot's Connections down to the one actually taken. Two players'
	// maps are byte-identical at boot — MEASURED — so the divergence does not exist until
	// a descent creates it, and then one player's pruned map would be stamped onto the party (R10).
	// A test comparing two boot-time maps would therefore be vacuous; the coverage constructs the
	// divergence instead.
	'JourneyMap', 'JourneyTarget', 'UseJourneyTarget',
	// WHICH ESCAPE the party is playing towards.
	//
	// Criterion (b), and by the same evidence as RoomType/MapMod above: the game itself says this is
	// the source of a KDMapData field. `KDMapGen.ts:694-695` is literally
	//
	//     if (!KDGameData.SelectedEscapeMethod) KDGameData.SelectedEscapeMethod = "Key";
	//     KDMapData.EscapeMethod = KDGameData.SelectedEscapeMethod;
	//
	// i.e. the next floor's LEVEL GOAL is a copy of it. A per-player copy makes
	// the goal depend on which player took the stairs, which is the defect already fixed for RoomType.
	//
	// It became reachable mid-run with the perk agreement: a perk altar can set it (KinkyDungeonShrine.ts:965-967,
	// and KD's own routed handler at KinkyDungeonInput.ts:1028-1030), and that grant now goes to the
	// whole party.
	// The ITEM ID counter, `KDGameData.ItemID` (KinkyDungeonEnemies.ts:7812). It is the
	// direct sibling of `RegimentID` two lines up and of the `KinkyDungeonEnemyID` /
	// `KinkyDungeonSpellID` globals in GLOBAL_BLACKLIST: a monotonic counter whose only job is to
	// make a NAME unique.
	//
	// It moves with the variant registries, and it is not optional. `KDGiveInventoryVariant` builds
	// the variant's key as `template + KinkyDungeonGetItemID()`, so two per-player counters both
	// starting at 1 hand two different players the SAME variant name — and on a now-shared registry
	// the second write silently loses to the first (`if (!KinkyDungeonRestraintVariants[newname])`,
	// KinkyDungeonInventory.ts:3641). One player's enchanted item would quietly become the other's.
	'ItemID',
	'SelectedEscapeMethod',
]);

/**
 * KDGameData keys that are reset and fully recomputed by EVERY real engine pass — NOT genuinely
 * cross-turn/cross-player SHARED state the way `KDGAMEDATA_WORLD_KEYS` is — but that still must
 * survive a MID-PASS slot-swap restore, because the one real pass accumulates them across several
 * enemies/engaged humans before it is done. Restoring an earlier-captured bundle over one of these
 * mid-pass would silently drop an earlier-processed group's contribution — the same clobber shape
 * `__kdWorldMuted` and `KDCustomDefeat`/`KDCustomDefeatEnemy` were found by (per-enemy slot-switch
 * global write audit, tests/unit/mp-slot-swap-global-audit.spec.ts, turn-classification.js
 * SLOT_SWAP_GAMEDATA_KEYS). Deliberately a SEPARATE list from `KDGAMEDATA_WORLD_KEYS`: a value the
 * engine resets to a fresh baseline at the top of every pass has nothing left to legitimately bleed
 * from one player's bundle into another's by the END of a round, so it does not belong in the
 * "declared, genuinely shared" contract `mp-noninterference.spec.ts` checks, nor in the client's
 * `worldGameData` snapshot. `restorePlayer` skips both lists via `KDGAMEDATA_RESTORE_SKIP_KEYS` below
 * — that merged set is the actual protection mechanism and what `mp-slot-swap-global-audit.spec.ts`
 * checks a `pass-world` KDGameData key against.
 *
 *   tickAlertTimer   reset false at the top of the pass, set true by any enemy's own alert
 *                    escalation mid-loop (KinkyDungeonEnemies.ts:4266/4908/4915), read at the END
 *                    of the SAME pass (:5027) to decide a floor-wide alert.
 *   HostileFactions  the floor's own provoked-faction list for THIS pass (KinkyDungeonFactions.ts:161-162).
 *   otherPlaying     reset to 0 then tallied across ALL enemies THIS pass
 *                    (KinkyDungeonEnemies.ts:4669/4759), read by the jail play-chance roll in the
 *                    SAME pass (KinkyDungeonJail.ts:153).
 */
const KDGAMEDATA_PASS_SCOPED_KEYS = Object.freeze(['tickAlertTimer', 'HostileFactions', 'otherPlaying']);

/**
 * The full set of KDGameData keys `restorePlayer` must never overwrite from an incoming bundle: the
 * genuinely shared world state (`KDGAMEDATA_WORLD_KEYS`) plus the pass-scoped accumulators above that
 * would otherwise be clobbered mid-pass. This merged set is the single source of truth the restore
 * mechanism reads — `KDGAMEDATA_WORLD_KEYS` alone is the narrower "genuinely cross-player shared"
 * subset that client-facing code (`worldGameData`) and the noninterference sharing guard use.
 */
const KDGAMEDATA_RESTORE_SKIP_KEYS = Object.freeze([...KDGAMEDATA_WORLD_KEYS, ...KDGAMEDATA_PASS_SCOPED_KEYS]);

/**
 * How many top-level bindings we expect to derive from the bundle.
 * Measured 2026-08-14: 2,254 `let` + 121 `const` + 6 `var` = 2,381 unique names.
 * A materially smaller number means the regex no longer matches upstream's output shape — that MUST
 * be loud, not silently degrade into "this player has almost no state" (same drift contract as
 * BUNDLE_PATCHES site counts in demo-server.js).
 */
const MIN_EXPECTED_GLOBALS = 2000;

/**
 * Only globals whose JSON is at most this long are watched as per-player state.
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
 * How many captures between oversize audit SLICES (_auditOversize).
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
 * ModelDefs (1878 KB) is ONE name and a time budget cannot split it.
 *
 * `_auditOversize(true)` still runs a COMPLETE pass, ignoring the budget — that is the diagnostic and
 * test entry point, never the request path.
 */
const OVERSIZE_AUDIT_EVERY = 30;

/**
 * Wall-clock budget, inside the vm, for ONE audit slice.
 *
 * The budget is checked AFTER each name, so a slice always hashes at least one — the true worst case
 * is therefore the single largest oversize global, not this number. Measured with this budget: slices
 * of 2-5 names, median ~7 ms, worst ~37 ms (the slice that contains ModelDefs, 1878 KB). Splitting one
 * global into sub-chunks would bound that too, at the cost of per-chunk baseline hashes; not worth it
 * until it shows up in a measurement of the real path.
 */
const OVERSIZE_AUDIT_BUDGET_MS = 4;

/**
 * The ONE definition of the divergence hash, shared by every vm payload that needs it.
 *
 * It is a source string rather than a function because these payloads run inside the bundle's own
 * `vm.Context` — nothing from this module is in scope there. It was copy-pasted into four payloads
 * (baseline, capture, oversize audit, restore); a hash that drifts between the pass that WRITES a
 * baseline and the pass that COMPARES against it would silently report everything as changed.
 */
const KD_HASH_FN = 'function hash(s){ var x = 5381, i = s.length; while (i) { x = (x*33) ^ s.charCodeAt(--i); } return x>>>0; }';

/**
 * Globals that are NOT per-player, by CATEGORY (never per feature — a per-feature entry
 * here would rebuild the whitelist under a new name). Everything not listed is per-player.
 */
const GLOBAL_BLACKLIST = Object.freeze([
	// --- shared world: the dungeon and its inhabitants -----------------------
	'KDMapData', 'KDMapExtraData', 'KDWorldMap', 'KDCurrentWorldSlot',
	'KinkyDungeonCurrentTick', 'KinkyDungeonEnemyID', 'KinkyDungeonSpellID',
	// The three ITEM VARIANT REGISTRIES. `KinkyDungeonRestraintVariants`,
	// `KinkyDungeonWeaponVariants` and `KinkyDungeonConsumableVariants`
	// (KinkyDungeonInventory.ts:116-120) are name → definition tables: an enchanted item's identity
	// is a generated NAME, and every consumer resolves it through these
	// (`KDRest`/`KDRestraint`, KinkyDungeonRestraints.ts:256/264).
	//
	// They are WORLD tables because the names they define live in world containers, not only in a
	// player's inventory: `KDMapData.GroundItems` (a dropped item records a NAME and nothing else —
	// `KDDropItemInv`, KinkyDungeonInventory.ts:3084), `enemy.items` (the Bondage action pushes
	// `item.inventoryVariant || item.name`, KDInventoryActions.ts:1370), `KDGameData.Containers` and
	// `KDGameData.NPCRestraints` — and KD's own garbage collector agrees, scanning exactly those
	// world sources for live references (`KDPruneInventoryVariants`, :3261). Leaving the table
	// per-player while the names it defines sit in shared world state is the half-classified pair
	// the RoomType fix warns about.
	//
	// MEASURED, not reasoned: with these per-player, a variant item dropped by one player resolved to
	// `undefined` for the partner who picked it up — `KDRest(name)` false for B, true for A, with a
	// stock template name as the control. tests/unit/mp-drop-transfer.spec.ts.
	//
	// Two things had to move WITH them, and neither is optional:
	//   · `KDGameData.ItemID` becomes a world key (below). It is the uniqueness counter these names
	//     are built from; per-player counters both start at 1, so a shared table would collide.
	//   · `KDPruneInventoryVariants` is suppressed in a managed session (kd-variant-registry.js). It
	//     runs on every descent (KDStairActions.ts:32) against the SWAPPED-IN player's inventory, so
	//     on a shared table it would delete every variant only the partner holds.
	'KinkyDungeonRestraintVariants', 'KinkyDungeonWeaponVariants', 'KinkyDungeonConsumableVariants',
	// WHICH FLOOR the party is on, and which checkpoint that floor belongs to. Same
	// category as KDMapData/KDCurrentWorldSlot above — this file already says so at the `level()`
	// accessor ("The current dungeon floor … A change is a party-wide event"), it just did not act on
	// it. Left per-player, each turn's restorePlayer installed the acting player's copy and their turn
	// captured it straight back, so two disagreeing bundles made the world OSCILLATE between floors
	// and the party never got past floor 1 (measured over ten real descents).
	//
	// This is the RoomType argument applied to the level, including its client half: the thin
	// client has always preferred the world's answer, restoring both from the snapshot's own
	// `s.level` / `s.checkpoint` (render-client.js:609-610). This makes the server agree.
	'MiniGameKinkyDungeonLevel', 'MiniGameKinkyDungeonCheckpoint',
	/*
	 * THE MAP GENERATION SEED. Same argument as the floor directly above, and found the same
	 * way — by a case that made the world's copy disagree with a bundle's.
	 *
	 * `KinkyDungeonSeed` decides what the NEXT floor looks like: `KDInitTempValues` re-randomises it
	 * per map and stores it as `KDGameData.LastMapSeed` (`KinkyDungeonGame.ts:960-970`), and the save
	 * loader restores from that pair (`KinkyDungeon.ts:7116`, `:7379`). One party, one world, one next
	 * floor — a per-player copy makes map generation depend on whose bundle was swapped in, which is
	 * the exact non-determinism this epic exists to prevent (cf. world-affecting perks).
	 *
	 * MEASURED, in the save-import unit spec: an imported world's seed was reverted to the pre-import
	 * value by the FIRST restore of the guest's bundle, because the guest's template predates the
	 * import and the seed was watched per-player. The floor already generated was unaffected (the map
	 * is in `KDMapData`); the damage is entirely to what comes next, which is why it is invisible
	 * until someone descends.
	 *
	 * `LastMapSeed` is classified with it, in KDGAMEDATA_WORLD_KEYS, for the reason given for
	 * RoomType/MapMod: they are written by the same statement, and splitting a pair leaves it
	 * half-classified.
	 */
	'KinkyDungeonSeed',
	'AIData', 'KDAwareEnemies', 'KDEnemiesTargetingPlayer', 'KDPathfindingCacheFails',
	'KDPathfindingCacheHits', 'KDPathCache', 'KDUpdateEnemyCache',
	// Same category: a memoisation cache keyed by the last ENEMY argument (not the player), and a
	// dirty-flag for a cache rebuilt from KDMapData.Entities. Found by the per-enemy slot-switch
	// global write audit (tests/unit/mp-slot-swap-global-audit.spec.ts, turn-classification.js
	// SLOT_SWAP_GLOBALS) — a mid-pass restore of a stale per-player bundle would otherwise clobber
	// these with whichever human's earlier value, the same clobber shape __kdWorldMuted and
	// KDCustomDefeat/KDCustomDefeatEnemy were found by previously.
	'geteligrest_lastTagsEnemy', 'geteligrest_lastExtraTags', 'KDUpdateEntityFlagCache',
	// Derived lookup caches over the world's ENTITIES — same category as KDPathCache above, and the
	// same criterion (a) as KDGAMEDATA_WORLD_KEYS' entity-keyed entries: they describe world entities,
	// not a player. They only became visible when the capture layer learned about Map, and they
	// are emphatically NOT per-player: MEASURED, resetting them on swap-in wiped the enemy lookup, so
	// a PvP bump-attack landed once and then stopped doing damage (mp-pvp-realcombat, -bind-reconcile,
	// -defeat-recovery all went red). KDEnemiesCache alone is 400 KB after one turn.
	// The enemy DEFINITION table — the templates every entity's `.Enemy` points at, not any entity's
	// state. Same category as the entity caches above, and the drift audit settled it with evidence rather
	// than argument: the audit reported it CHANGED on every pass, and the writer turned out to be
	// OURS. `spawnAvatar` pushes a `RemotePlayer_<peer>` def clone into it (measured: 337 → 338 defs)
	// so the peer avatar renders as a real character. That is world content shared by both players —
	// proven, not assumed: the def appears in NO player bundle, and it survives swapping the other
	// player in. Excluded before this only by its 386 KB size, which meant a one-time append warned
	// forever (the audit never re-baselines) while costing 3.9 ms of every audit.
	'KinkyDungeonEnemies',
	// DEFEAT FINALISATION, in flight. `KinkyDungeonUpdateEnemies` (KinkyDungeonEnemies.ts:5070) sets
	// `KDCustomDefeatEnemy`/`KDCustomDefeat` the instant one enemy's own decision comes back a defeat,
	// and reads them back only once, at the END of the SAME pass — the two writes can straddle a
	// LATER enemy's own per-enemy slot switch (`installTurnModel`'s `armSlotSwitch`/`_slotSwapTo`),
	// which restores a per-player bundle mid-pass. Same failure shape as the turn-model's own flags
	// above (a stale per-player copy overwrites the live value): MEASURED, a forced defeat on an enemy
	// engaged with one human was silently DROPPED — not merely misrouted — because a second enemy's
	// own swap (to a different human, later in the same pass) restored that human's bundle with their
	// own stale `KDCustomDefeatEnemy: null` on top of the live one, so by the time the end-of-pass
	// check ran there was no defeat left to route anywhere.
	'KDCustomDefeat', 'KDCustomDefeatEnemy',
	// The enemy COMMANDER ROLE table, `Map<number, string>` keyed by `enemy.id`
	// (KDCommander.ts:174/179, deleted at :205/:209). A number key in KD is an entity id, so this is
	// criterion (a) verbatim — the same argument KDIDCache and KDEntityFlagCache below already rest
	// on. Flagged by the transition-write audit because KinkyDungeonCreateMap resets it.
	'KDCommanderRoles',
	// Generation state, by name and by use. Set during generation
	// (KDMapGen.ts:239/245, KinkyDungeonSetpiece.ts:355, KinkyDungeonAlt.ts:2504/2548) and read BY
	// generation to decide jail placement (KDMapGen.ts:460, :615).
	'KDStageBossGenerated',
	// Map points of interest emitted by the generator (KDMapGen.ts:383-384),
	// drawn at KinkyDungeonDraw.ts:4355. They describe the map, so they belong to the one map.
	'KinkyDungeonPOI',
	'KDEnemiesCache', 'KDEnemyCache', 'KDEnemyEventCache', 'KDIDCache', 'KDEntityFlagCache',
	'KDEntityRestraintMetadata', 'KDThoughtBubbles',
	'KDBuffedStatTypeMemo', 'KDBuffedStatTypeMemoUpdate',
	// --- render / dirty flags: the server has no screen ----------------------
	// KDDamageQueue belongs HERE, and its absence was a real bug. It is a CONSUME-ONCE
	// presentation queue drained by `KinkyDungeonDrawFight` (KinkyDungeonFight.ts:3368) — the draw
	// emits a floater per entry and splices it out. The server has no draw loop, so it never drained
	// it; the generic capture then replicated the stale entries as ordinary state and EVERY snapshot
	// re-delivered them. Measured in UAT: one hit produced a floater per snapshot for as long as
	// snapshots kept arriving (i.e. while the mouse moved), and stopped the moment they did.
	// Presentation-only state is not authoritative state and must not be replicated; what the player
	// needs to be TOLD travels as a sequenced EVENT instead (SwapSession `pendingEvents`).
	'KDDamageQueue',
	// The same criterion, applied to the two queues that are consume-once but harmless
	// only BY ACCIDENT. Neither was a live bug when this was written; both are one upstream change
	// away from being one, and an exclusion that rests on an accident is not an exclusion. Listed
	// here so that it is a DECISION.
	//
	// `KinkyDungeonInputQueue` is drained by the SIM, not the draw loop: `KDSendInput`
	// (KinkyDungeonInput.ts:1679) pushes and `KDProcessInputs` (:1690) splices. It stays empty on the
	// server only because `KDSendInput`'s `process` parameter DEFAULTS to true, so push and drain
	// happen inside one synchronous call — `applyInputObserved` does route through that queueing
	// path, contrary to the assumption it never touches it. Any of the 184 call sites passing
	// `process = false` leaves it non-empty at capture time. Replicating that is GHOST INPUTS: the
	// client gates its whole per-frame block on an empty queue (KinkyDungeon.ts:3033), then feeds the
	// entries to its own `KDProcessInput`. MEASURED before this entry: driving
	// `KDSendInput('Wait', {}, false, false, false)` put the queue on the wire (mp-consume-once-queues).
	'KinkyDungeonInputQueue',
	// `KDSaveQueue` is drained by the browser's async save loop (KinkyDungeon.ts:1520), which writes
	// `localStorage.KinkyDungeonSave`. Replicating it makes a client persist the SERVER's save over
	// its own. It was excluded before this only by SIZE — a real save exceeds BASELINE_MAX_LEN — and
	// that protection is both accidental and INVISIBLE: unlike the baseline-time oversize set, a
	// watched name that grows past the cap later is `continue`d in `_captureGlobals` and never
	// reaches `_auditOversize`. MEASURED: a sub-20 KB entry rode the wire.
	'KDSaveQueue',
	'KDDrawUpdate', 'KDVisionUpdate', 'KDUpdateChokes', 'KDAlertCD',
	// Three more of exactly this category, found by the transition-write audit rather
	// than by a bug — they were missing from a decision that had already been made, which is the
	// cheapest possible kind of finding and the reason that audit exists.
	//
	// Every read of each is on the DRAW path, and each is cleared only by draw-path code:
	//   KinkyDungeonUpdateLightGrid  read at KinkyDungeonDraw.ts:1236 / :4906, cleared at :4887 by
	//                                KDUpdateVision. Its eight writers all mean "re-render".
	//   KDRedrawFog                  a countdown set by map gen (KDMapGen.ts:755), the save load
	//                                (KinkyDungeon.ts:7901) and KDUpdateVision (Draw.ts:4888); read
	//                                and decremented ONLY by the fog/minimap render
	//                                (KinkyDungeonVision.ts:618, :917).
	//   KDTileModes                  read by exactly one thing — a draw-time alpha oscillator
	//                                (KinkyDungeonTiles.ts:392-393). Presentation, not state.
	//
	// Same consequence as KDDamageQueue: the server has no draw loop, so the clearing code
	// never runs and these never return to baseline — they were captured as diverged per-player state
	// on every bundle, letting the acting player's stale "please redraw" land on the world.
	// Pinned by tests/unit/mp-render-dirty-flags.spec.ts, with a same-SHAPED control per flag
	// (boolean / number / object) so "absent from the bundle" cannot pass on a broken capture layer.
	'KinkyDungeonUpdateLightGrid', 'KDRedrawFog', 'KDTileModes',
	'lastFloaterRefresh', 'KDParticleid', 'KDCurrentModels', 'KDRefreshCharacter',
	// --- client audio: neither player nor world ------------------------------
	'KDMusicToast', 'KDMusicUpdateTime',
	// --- already managed per-player by swap-session (do NOT double-manage) ---
	'KinkyDungeonMessageLog', 'KinkyDungeonFloaters',
	// --- carried by its OWN path, not by divergence -------------
	// KDGameData is the one global no mechanical rule can classify: 221 keys mixing per-player
	// (Guilt, ShieldTokens, RevealedFog) with world (GuardSpawnTimer, JailGuard, ChestsGenerated).
	// The swap layer inverts it — capture whole, restore whole minus KDGAMEDATA_WORLD_KEYS — which is a
	// semantic subtraction, not a whitelist. It is also 27 KB (JourneyMap alone is 21 KB), so the
	// divergence path would exclude it on size anyway. Listed here so that exclusion is a DECISION.
	'KDGameData',
	// --- debug noise ---------------------------------------------------------
	'KDRestraintDebugLog',
	// --- turn-model control flags (installTurnModel) -------------------------
	// Session-level control state for the one-engine-tick-per-round mechanism, not a PLAYER'S state —
	// MEASURED, the hard way: left off this list, the generic per-player capture/restore swept these
	// up like any other new global, so `_slotSwapTo`'s mid-tick `restorePlayer` (swapping a human IN
	// to let an enemy face them) silently restored a STALE `__kdWorldMuted` from that human's own
	// bundle (captured true, from their own earlier muted apply this round) back over the live flag —
	// flipping the round's one real tick muted partway through and reverting its own clock increment.
	// `__kdSlotChoose` is a function (installed once, never diverges) but is listed anyway so a
	// future capture-layer change that starts walking functions cannot regress this silently.
	'__kdTurnModelInstalled', '__kdWorldMuted', '__kdInTick', '__kdSlotSwitch', '__kdSlotHost',
	'__kdSlotCurrent', '__kdSlotHumans', '__kdSlotAvatarIds', '__kdStickyTarget', '__kdSlotChoiceLog',
	'__kdSlotChoose',
	// A companion/ally always acts with its OWNER in the slot, never the sticky/nearest fallback the
	// hostile-enemy chooser uses — `{entityId: ownerClientId}`, computed fresh each round from every
	// joined player's own `KDGameData.Party` (SwapSession._computeCompanionOwners). Session-level
	// control state, same reasoning and same risk as the rest of this block.
	'__kdSlotOwner',
	// Per-owner war-team faction bookkeeping (`setEntityFaction`/`installCompanionFactionGuard`):
	// `__kdCompanionWarFaction` is `{entityId: factionName}`, the registry the persistent-NPC-update
	// hook reads to self-heal a companion's faction stamp every real tick (see `setEntityFaction`'s own
	// doc comment); `__kdCompanionFactionGuardInstalled` is the one-time wrap sentinel. Both session
	// control state, same bucket and same reasoning as the turn-model flags above.
	'__kdCompanionWarFaction', '__kdCompanionFactionGuardInstalled',
	// Nested ticks (removing the one-round delay for a non-host human's own post-enemy tail): a
	// non-last apply's own `KinkyDungeonAdvanceTime` call hands control to the NEXT player's own apply
	// before its own tail runs, recursively, down to the round's one real tick — so a MUTED apply can
	// now have a REAL clock advance happen nested inside its own call, not only at its own (reverted)
	// level. `__kdRoundRealTickDelta` accumulates that real advance across the whole round so every
	// muted level's own clock hand-back restores to "before MY OWN fake increment" without also erasing
	// the nested real one — session-level control state, same reasoning as `__kdWorldMuted` above, not
	// a player's own value. `__kdNestedDispatch` is the one-shot callback itself (a function, installed
	// fresh per apply by `setNestedDispatchCallback`'s caller) — listed for the same defensive reason as
	// `__kdSlotChoose`/`__kdReplayPlayerHit`.
	'__kdRoundRealTickDelta', '__kdNestedDispatch',
	// `KDEnemyAddSound`'s own wrap (`installTurnModel`) records `{x, y, sound}` per call so
	// `SwapSession._harvestNoise` can re-offer the SAME hearing decision to every joined human, not
	// only whoever holds the slot — session-level, drained once per harvest by `takeNoiseSources`,
	// never a player's own value.
	'__kdPendingNoiseSources',
	// `__kdReplayPlayerHit` is a function (installed once, never diverges) — same reasoning as
	// `__kdSlotChoose` above: listed anyway so a future capture-layer change that starts walking
	// functions cannot regress this silently. Shared by the AOE replay and the direct-hit bullet
	// reroute (both in `installTurnModel`) to work around `bulletObj.alreadyHit`'s single shared
	// "player" dedup key — see that helper's own doc comment for why this cannot be made per-player.
	'__kdReplayPlayerHit',
	// `tagOwnedBullets`'s side-channel (spriteID -> clientId), NOT a property on the bullet objects
	// themselves — keeping it off KDMapData.Bullets means a 1-player session's bullets are byte-
	// identical to a reference run with no turn-model code involved at all (mp-parity-oracle).
	// Session-level, same reasoning as the rest of this block: listed here, not left to diverge.
	'__kdBulletOwner',
	// `tagOwnedTethers`'s side-channel (leashed enemy id -> clientId), same shape and same reasoning as
	// `__kdBulletOwner` above: a tether's own `leash.entity` is the generic `-1` "the player" marker
	// (KDTethers.ts:203-210, KinkyDungeonAttachTetherToEntity), so there is no engine-native way to
	// tell which HUMAN a leash belongs to once more than one exists. Kept off the enemy entity itself
	// (would diverge a 1-player session's KDMapData.Entities from a reference run — mp-parity-oracle).
	'__kdTetherOwner',
]);


/**
 * World globals the BROWSER must be told about.
 *
 * `GLOBAL_BLACKLIST` answers "is this per-player?", and the answer "no" removes the name from the
 * per-player bundle — which is also the only route most globals had to the client. `KDMapData` has
 * its own snapshot field; these have none, so without this list a world global is correctly shared
 * between server-side players and INVISIBLE to every browser.
 *
 * Deliberately a small SUBSET of the blacklist, not the blacklist itself: most of what is blacklisted
 * is either enormous (KDMapData), already sent (worldGameData) or client-local by nature (the render
 * dirty flags, the audio toasts). A name earns a place here only when the client RESOLVES something
 * through it.
 *
 * Generic on purpose, in the shape already arrived at for `worldGameData`: one list, one loop on each
 * side. The per-field form of the same idea was four mirrored edits and a silent omission every time.
 */
const WORLD_GLOBALS_CLIENT = Object.freeze([
	// The item variant registries. An enchanted item's identity is a generated NAME, and the browser
	// resolves it through these on every draw of the item list (KDRest / KDRestraint / KDGetItemName).
	// They arrived in the per-player bundle until they were made world state.
	'KinkyDungeonRestraintVariants', 'KinkyDungeonWeaponVariants', 'KinkyDungeonConsumableVariants',
]);

/**
 * A tagged codec for the values plain JSON silently destroys.
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
// The codec moved to its own module — the BROWSER thin client needs the same decoder to
// adopt a state bundle, and two hand-kept copies in two runtimes is the drift this epic deletes.
const { KD_CODEC } = require('./kd-codec');
// The world/player classification of KD's game-mode keys. Own module so the
// lightweight join-gate can validate a declaration without loading this engine host.
const { MODE_WORLD_KEYS, MODE_PLAYER_KEYS, MODE_SOURCE, isModeKey } = require('./game-modes');
// The world/player/mixed classification of KinkyDungeonAdvanceTime's and KinkyDungeonUpdateEnemies'
// own direct callees — the single source of truth `WORLD_MUTE_FNS` (below) is DERIVED from, not a
// second hand-kept list that could silently disagree with it.
const { TURN_CALL_CLASSIFICATION } = require('./turn-classification');

/**
 * Entity re-resolution + the dispatch call, shared by applyInput and applyInputObserved.
 * The thin client cannot ship live entity object refs, so it sends {__kdEnt:id} (or
 * {__kdEnt:'player'}); these are replaced with THIS world's authoritative entities before dispatch.
 *
 * One copy on purpose: the probed and unprobed paths must dispatch IDENTICALLY, or the classification
 * the probe reports would not describe what the real apply does.
 */

/**
 * Run KD's DEFERRED map generation, which nothing else on the server ever will.
 *
 * `KDGoThruTile` does not always build the new map inline. When
 * `!forceInstant && level < maxLevel-1 && …` it sets `KinkyDungeonState = "GenMap"` and parks the work
 * in `KDGenMapCallback` (KDStairActions.ts:251-258). The ONLY thing upstream that ever runs it is the
 * DRAW loop — `if (KDGenMapCallback) setTimeout(RunGenMapCallback, 100)` (KinkyDungeon.ts:2858). The
 * server has no draw loop, so the transition simply never completed: measured, four consecutive real
 * descents left the callback armed and the session sitting in `GenMap` with the map unchanged. And
 * the client ADOPTS the server's screen, so both players would stare at a `GenMap` screen
 * that never resolves.
 *
 * ⚠️ CLEAR BEFORE CALLING. This is a paid-for lesson as code, not a style choice: when
 * `KDPostStairSave` threw, the exception escaped AFTER the map had been generated but BEFORE
 * `KDGenMapCallback = null` ran, leaving a stale callback that poisoned every later turn
 * (see `_neuterAutosave`). Clear-then-call makes a throw cost one transition instead of the
 * session. It is also exactly what upstream's own `RunGenMapCallback` (KinkyDungeon.ts:7926) does.
 *
 * The loop is bounded because a callback may arm another; the bound is REPORTED rather than silently
 * obeyed, since "nothing pending" and "we gave up" look identical from the outside.
 *
 * @returns {number} how many deferred generations ran (0 in the overwhelmingly common case)
 */
const KD_RUN_DEFERRED_MAPGEN = `(function(){
	if (typeof KDGenMapCallback === 'undefined') return { ran: 0, exhausted: false, errors: [] };
	var ran = 0, errors = [];
	while (KDGenMapCallback && ran < 4) {
		var ff = KDGenMapCallback;
		KDGenMapCallback = null;              // BEFORE the call — see the note above
		ran += 1;
		// A throw must cost ONE transition, never the acting player's turn. Caught, never swallowed:
		// the message is returned so the host can report it.
		try {
			var next = ff();
			if (typeof next === 'string' && next) KinkyDungeonState = next;
		} catch (e) { errors.push(String((e && e.message) || e)); }
	}
	return { ran: ran, exhausted: !!KDGenMapCallback, errors: errors };
})()`;
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
 * Derive the bundle's top-level binding NAMES from its source.
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
			`bundle-global DRIFT: derived ${names.length} top-level names, expected at least ` +
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

/**
 * Candidate OUTER, once-per-tick world system entry points `KinkyDungeonAdvanceTime` calls directly —
 * the set a blanket "mute = no-op" is even the right SHAPE of fix for (a void-returning, side-effect-
 * only step, not a getter whose return value the caller reads back the same tick). This is a separate
 * question from the world/player/mixed VERDICT (below): most of `turn-classification.js`'s ~100
 * `world` entries are per-enemy helpers (faction lookups, stat getters) that run many times per tick
 * by design and are never meant to collapse to once per round — muting THOSE would corrupt the very
 * call that reads their return value, not just reduce a count.
 *
 * `KinkyDungeonUpdateEnemies` is deliberately NOT here — it gets its own wrap in `installTurnModel`
 * (grouping + the slot switch, not a plain no-op).
 */
const WORLD_MUTE_CANDIDATES = Object.freeze([
	'KinkyDungeonUpdateBullets', 'KinkyDungeonUpdateBulletsCollisions',
	'KDUpdateEffectTiles', 'KinkyDungeonUpdateTileEffects', 'KinkyDungeonUpdateJailKeys',
	'KDCommanderUpdate', 'KDTickMaps',
]);

/**
 * The actual mute list: `WORLD_MUTE_CANDIDATES` filtered down to the ones `turn-classification.js` —
 * the single source of truth the audit spec (`tests/unit/mp-turn-world-player-audit.spec.ts`) keeps
 * honest against the live engine — verdicts as pure `world`. A candidate the table calls `mixed`
 * (currently `KDUpdateEffectTiles`, `KinkyDungeonUpdateTileEffects`, `KinkyDungeonUpdateBullets`,
 * `KinkyDungeonUpdateBulletsCollisions` — each runs a step for the ACTING player before or alongside
 * its world-wide loop) is EXCLUDED, not force-muted: wholesale-muting a mixed function would silently
 * drop the non-host player's own per-turn step, a real regression this list refuses to introduce.
 * Those four keep running once per player-phase apply, same as before this change — a recorded,
 * deliberate residue (the mixed-function split is its own follow-up), not a silent gap: a candidate
 * missing from the table, or no longer classified at all, throws at require time rather than being
 * guessed about.
 */
const WORLD_MUTE_FNS = Object.freeze(WORLD_MUTE_CANDIDATES.filter((name) => {
	const verdict = TURN_CALL_CLASSIFICATION[name] && TURN_CALL_CLASSIFICATION[name].verdict;
	if (!verdict) {
		throw new Error(`turn-classification.js has no entry for mute candidate "${name}" — ` +
			'classify it (world/player/mixed/split) before deciding whether to mute it');
	}
	return verdict === 'world';
}));

/**
 * `WORLD_MUTE_CANDIDATES` members `turn-classification.js` now calls `split` rather than `world` —
 * a mixed function `installTurnModel` has a bespoke wrap for (below) instead of a plain no-op, so it
 * is excluded from `WORLD_MUTE_FNS` (a blanket no-op would also silence its replicated player step)
 * but still derived from the same table, not hand-duplicated. Thrown error mirrors `WORLD_MUTE_FNS`'s
 * own guard: a candidate missing a verdict, or no longer `split`, must not be silently ignored.
 */
const SPLIT_MUTE_FNS = Object.freeze(WORLD_MUTE_CANDIDATES.filter((name) => {
	const verdict = TURN_CALL_CLASSIFICATION[name] && TURN_CALL_CLASSIFICATION[name].verdict;
	if (!verdict) {
		throw new Error(`turn-classification.js has no entry for mute candidate "${name}" — ` +
			'classify it (world/player/mixed/split) before deciding whether to mute it');
	}
	return verdict === 'split';
}));

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
		this._neuterAutosave();
		this._installServerRoleShim();
		return this;
	}

	/**
	 * Server-authoritative role flag + shared-entity AI suppression — installed as a
	 * RUNTIME monkey-patch (mod-style reassignment, same pattern as _neuterRendering),
	 * NOT a game-source edit (zero source edits were restored; the earlier source flag
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
		this._stubOut([
			'DrawCharacter', 'DrawCharacterModels', 'DrawModelProcessPoses',
			'KinkyDungeonDressPlayer', 'KDDrawPlayer',
		]);
	}

	/**
	 * KD's OWN AUTOSAVE, which made headless game flows throw.
	 *
	 * `KinkyDungeonGenerateSaveData` reads `KDCurrentModels.get(KinkyDungeonPlayer).Poses` off a
	 * paper-doll model that `_neuterRendering` above deliberately never builds, and it does so
	 * WITHOUT a null guard (unlike its four sibling call sites). So every automatic save throws
	 * `TypeError: cannot read 'Poses' of undefined`. This is NOT an upstream bug — it is the direct
	 * consequence of a rendering neuter this layer chose, and it is why the README calls headless
	 * save GENERATION unsupported.
	 *
	 * The damage is never cosmetic, because KD autosaves from the MIDDLE of game flows — so whatever
	 * was still to happen in that flow does not. The two measured cases differ in how far the throw
	 * travelled, which is worth knowing before assuming a third one is loud:
	 *
	 *   stairs   KDGoThruTile -> KDGenMapCallback -> KDPostStairSave -> KinkyDungeonSaveGame
	 *            `KDPostStairSave` is the second-to-last statement of `KDGenMapCallback`
	 *            (KDStairActions.ts:239), so the throw escaped AFTER the new map was generated but
	 *            BEFORE `KDGenMapCallback = null` ran — a stale callback, on every floor change.
	 *   defeat   KinkyDungeonAdvanceTime -> KDRunDefeatForEnemy -> KinkyDungeonDefeat
	 *            `KinkyDungeonSaveGame()` is the LAST statement of `KinkyDungeonDefeat`
	 *            (KinkyDungeonJail.ts:1894). `applyInputObserved` DOES catch this one, so the session
	 *            survived — but on the turn path `obs.error` is read only by `_learnInputKind`
	 *            (swap-session.js:1125), never logged and never shown. So a captured player had the
	 *            rest of their own input discarded and the session reported a normal turn. The
	 *            reporting hole itself is a separate fix; this only removes one cause of hitting it.
	 *
	 * TWO NAMES, BOTH LOAD-BEARING — neither makes the other redundant:
	 *
	 *   `KinkyDungeonSaveGame`  the save itself, and therefore all 12 of its call sites at once
	 *                           (five in KinkyDungeonJail.ts alone). The first fix stubbed only the stairs
	 *                           wrapper because it believed `saveOf()` needed this function; it does
	 *                           NOT — `saveOf` calls `KinkyDungeonGenerateSaveData` directly
	 *                           (see `saveOf`), as does the only other consumer. Nothing in
	 *                           `tools/mp-server/**` or `tests/**` calls `KinkyDungeonSaveGame`.
	 *   `KDPostStairSave`       does MORE than save: on the PerkRoom floor it sets
	 *                           `KinkyDungeonState = "Save"` and builds a DOM textarea via
	 *                           `KDTextArea` / `ElementValue` (KDStairActions.ts:265). Headless that
	 *                           is just as unwanted as the throw was, and it survives the stub above.
	 *
	 * Losing the autosave costs this layer nothing and saves a little. It writes the browser's
	 * `localStorage.KinkyDungeonSave`, for which shims.js provides an in-memory stand-in nothing ever
	 * reads back, and a co-op run's persistence is the SERVER's (see the note at :233 on why
	 * replicating KD's own save to clients is actively harmful). It also pushes to `KDSaveQueue`,
	 * which is drained by the browser's async save loop (KinkyDungeon.ts:1520) that never runs here —
	 * so each call used to add a >20 KB entry nothing would ever consume. That queue is already
	 * GLOBAL_BLACKLISTed for exactly that reason; not calling the save is what stops the growth.
	 *
	 * `KinkyDungeonGenerateSaveData` is deliberately left ALONE: it is the parity/non-interference
	 * instrument (`saveOf`, `_seedHeadlessModel`), and it is only unsafe when nobody seeded a model.
	 */
	_neuterAutosave() {
		this._stubOut(['KDPostStairSave', 'KinkyDungeonSaveGame']);
	}

	/**
	 * Replace named globals with no-ops. One place, because "assign a stub over a KD global" is the
	 * mechanism BOTH neuterings use and a second hand-rolled copy is how the two drift apart.
	 */
	_stubOut(names) {
		this.eval(names
			.map((fn) => `if (typeof ${fn} === 'function') ${fn} = function(){ return undefined; };`)
			.join('\n'));
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

	// ----- message log (per-player log composition) --------------------

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
	 * Push a combat-feedback line through KD's REAL message API. Reuses
	 * `KinkyDungeonSendTextMessage` so the entry has the same shape/styling as any in-game
	 * message (and sets the floating `KinkyDungeonActionMessage`), then returns the produced
	 * log entry so the caller can route it to the right player's personal log. NOT a fake
	 * string injection — the game's own messaging code runs. Used for PvP hit feedback, which
	 * the silent `KinkyDungeonDealDamage` path never emits on its own.
	 *
	 * `Filter` is KD's own log-filter TAG (`KinkyDungeonGame.ts:2601`, 8th parameter),
	 * which the log's draw pass honours (`KinkyDungeonDraw.ts:2819/2862`). It defaults to KD's own
	 * `'Self'`, so every pre-existing caller is unchanged. Co-op chat passes `'Chat'`, which is what
	 * lets a player hide chat without hiding the game.
	 *
	 * `noDupe` is deliberately left falsy: two identical chat lines must both appear.
	 */
	sendFeedback(text, color, priority, filter) {
		return this.eval(`(function(){
			var before = (typeof KinkyDungeonMessageLog!=="undefined"&&KinkyDungeonMessageLog)?KinkyDungeonMessageLog.length:0;
			if (typeof KinkyDungeonSendTextMessage === 'function') {
				KinkyDungeonSendTextMessage(${priority | 0} || 10, ${JSON.stringify(String(text))}, ${JSON.stringify(String(color || '#ff5555'))}, 2, undefined, undefined, undefined, ${JSON.stringify(String(filter || 'Self'))});
			}
			var L = (typeof KinkyDungeonMessageLog!=="undefined"&&KinkyDungeonMessageLog)?KinkyDungeonMessageLog:[];
			var added = L.slice(before);
			try { return JSON.parse(JSON.stringify({ entries: added, action: ${JSON.stringify(String(text))} })); } catch(e) { return { entries: [], action: '' }; }
		})()`);
	}

	/** A spell's AOE footprint + damage as data (friendly-fire): {aoe,power,type}. */
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
	 * Which ROOM the party is in — `''` for a plain dungeon floor, otherwise one of KD's own
	 * room types (`JourneyFloor`, `Tunnel`, `PerkRoom`, `ShopStart`, `ElevatorRoom`, `Summit`, …).
	 *
	 * The floor NUMBER is not enough to tell "we finished a level" from "we ducked into a shop": both
	 * are transitions, and only the between-floors hub (`JourneyFloor`) is the one that ends a war.
	 * Sibling of getLevel() for the same reason — a party-wide state the session compares turn to turn.
	 */
	getRoomType() {
		return this.eval('(typeof KDGameData !== "undefined" && KDGameData && KDGameData.RoomType) '
			+ '? String(KDGameData.RoomType) : ""');
	}

	/**
	 * The swapped-in player's movement slow-level, RE-DERIVED from their worn restraints
	 * (self-heal proof): runs the real `KinkyDungeonCalculateSlowLevel` (reads
	 * `KinkyDungeonAllRestraint()`) then returns `KinkyDungeonSlowLevel`. >0 ⇒ bound/slowed.
	 */
	playerSlowLevel() {
		return this.eval('(function(){ if (typeof KinkyDungeonCalculateSlowLevel === "function") KinkyDungeonCalculateSlowLevel(0); return (typeof KinkyDungeonSlowLevel !== "undefined") ? KinkyDungeonSlowLevel : 0; })()');
	}

	/**
	 * Compute the CURRENTLY swapped-in player's outgoing weapon attack as data (PvP):
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
		/*
		 * The half of the stock start the co-op path never ran.
		 *
		 * `KinkyDungeonStartNewGame` below is genuinely KD's own new-game entry, so the FLOOR has
		 * always been real. What was missing is everything the stock start BUTTONS do around it
		 * (`KinkyDungeon.ts:2553-2565` for Quick/Kinky, `:2875-2884` for the perk screen's Start):
		 *
		 *     KDLose = false;  KDUpdatePlugSettings(true, false);  <StartNewGame>;
		 *     if (!KDToggles.SkipTutorial) KDStartDialog("Tutorial");  KDAddListener("SpeciesChecker");
		 *
		 * `KDLose` first: it is a sticky "you lost" flag (`KinkyDungeonInput.ts:907`), and a session
		 * booting with it set from a previous run is the same class of bug as inheriting a stale
		 * `KDGameData` field.
		 */
		this.eval('KDLose = false');
		/*
		 * …then the game-mode toggles, BEFORE the map exists — `randomMode` changes generation.
		 *
		 * Driven through KD's OWN `KDUpdatePlugSettings`, which is the only thing that knows how the
		 * nine `KinkyDungeonStatsChoice` keys derive from the nine source globals
		 * (`KinkyDungeon.ts:6114-6127`). We set the SOURCE globals the host asked for and let KD
		 * compute the keys; we never write the derived keys here. Anything not asked for keeps KD's
		 * own default, which is what a host that chose nothing should get.
		 */
		const declared = Array.isArray(opts.worldModes) ? opts.worldModes : [];
		// Walk MODE_SOURCE in ITS order, not the caller's: the multi-valued dials resolve by
		// last-assignment-wins and the table is ordered ascending for exactly that (see game-modes.js).
		/*
		 * ⚠️ BARE ASSIGNMENTS, NOT `globalThis[name] = v`.
		 *
		 * These source globals are bundle-scope `let`s, so they are NOT properties of `globalThis`
		 * (repo CLAUDE.md, "No module system at runtime"). Writing through `globalThis` would create a
		 * brand-new property and leave KD's own bare-name reads seeing the unchanged original — the
		 * modes would appear to be set here and have no effect whatsoever on the game.
		 *
		 * Emitting identifiers into source is safe because the names come from our own frozen
		 * `MODE_SOURCE` table, never from the wire; the wire only ever supplies KEYS, which are
		 * matched against that table.
		 */
		const writes = Object.keys(MODE_SOURCE)
			.filter((k) => declared.indexOf(k) >= 0)
			.map((k) => `${MODE_SOURCE[k].global} = ${JSON.stringify(MODE_SOURCE[k].value)};`)
			.join('\n\t\t\t');
		this.eval(`(function(){
			${writes}
			if (typeof KDUpdatePlugSettings === 'function') KDUpdatePlugSettings(true, false);
		})()`);
		// KinkyDungeonStartNewGame is the real new-game entry: it calls
		// KinkyDungeonInitialize AND KinkyDungeonCreateMap (which fills the dungeon
		// Grid). The Playwright fixtures call the bare Initialize (empty map — fine
		// for faction/save tests), but the sim PoC needs a real generated map.
		this.eval('KinkyDungeonStartNewGame(false)');
		this.eval('typeof KinkyDungeonInitReputation === "function" && KinkyDungeonInitReputation()');
		this.eval('typeof KDInitPerks === "function" && KDInitPerks()');
		this.eval('typeof KDSyncLocalPlayerSlot === "function" && KDSyncLocalPlayerSlot()');
		/*
		 * The listener the stock start registers after the game exists. `KDAddListener`
		 * with no id pushes onto `KDGameData.ListenerList` (`KinkyDungeon.ts:8473-8489`); registered
		 * here, before `_newPlayerTemplate` is captured, so it rides into every player's bundle.
		 */
		this.eval('typeof KDAddListener === "function" && KDAddListener("SpeciesChecker")');
		/*
		 * GAG PARTICLES OFF IN THE AUTHORITATIVE WORLD. The server has no screen.
		 *
		 * Not a workaround for a test: it is a real server-side crash. `KDSendGagParticles`
		 * (KDParticles.ts:336-360) asks `GetHardpointLoc` where the player's MOUTH is, which walks the
		 * paper-doll rig via `GetModelLoc` -- and `KDCurrentModels` is blacklisted from capture in this
		 * very file as "render / dirty flags: the server has no screen". So the rig is empty and the
		 * lookup throws `Cannot read properties of undefined (reading 'Mods')` inside
		 * `KinkyDungeonAddRestraintIfWeaker` (KinkyDungeonRestraints.ts:5053), taking the whole call
		 * with it. MEASURED by mp-perk-agreement: a perk whose bondage price includes a gag killed the
		 * grant mid-loop, so one player got the perk and the other got nothing.
		 *
		 * Turned off through KD'S OWN TOGGLE (`KDToggles.GagParticles`, the function's first line)
		 * rather than by wrapping the function: it is a presentation switch whose honest value on a
		 * machine with no renderer is `false`, and the CLIENT keeps its own copy and its own particles.
		 * Same category as the blacklist entry above, applied to the one call site that crashes.
		 */
		this.eval('(function(){ if (typeof KDToggles !== "undefined" && KDToggles) KDToggles.GagParticles = false; })()');
		/*
		 * THE TUTORIAL IS SUPPRESSED ON PURPOSE, FOR BOTH PLAYERS. This is a decision,
		 * not an omission, and it is the one place the co-op start knowingly does not reproduce the stock
		 * start (owner, 2026-08-24).
		 *
		 * The stock buttons run `if (!KDToggles.SkipTutorial) KDStartDialog("Tutorial")`. In a
		 * lockstep co-op session a dialogue is server-driven and party-wide, so calling it would park
		 * BOTH players on a dialogue neither asked for, and the guest has no way to dismiss the
		 * host's copy. A co-op run is also unlikely to be anyone's first game.
		 *
		 * ⚠️ Do NOT "restore parity" by adding the call here without re-reading the reasoning above first —
		 * `mp-start-ritual.spec.ts` asserts no Tutorial dialogue is open after a co-op start, and it
		 * will tell you about this comment rather than about a mistake.
		 */
		this.setServerMode(this.serverMode);
		// Record the post-init fingerprint. Anything that diverges from it later is mutable,
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

	// ----- serverMode (PoC scope) ----------------------------------------------

	/**
	 * Gate shared-entity (enemy) AI via the real source flag `KDServerRole`.
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

	/** Where does this entity stand? `null` if it is not in the world. */
	entityPos(entityId) {
		return this.eval(`(function(){
			var e = KDMapData.Entities.find(function(x){ return x.id === ${entityId | 0}; });
			return e ? { x: e.x, y: e.y } : null;
		})()`);
	}

	/**
	 * The nearest legal, UNOCCUPIED tile to (x,y), searched in expanding rings.
	 *
	 * `findOpenTile` above answers a different question: it scans the whole map for the most open
	 * spot, which is a boot-time layout choice. This one is "put them next to their friend", so the
	 * ring order IS the requirement — the first hit is the nearest, and J2's "nearest legal tile if
	 * every neighbour is blocked" falls out of continuing the search rather than being a special case.
	 *
	 * ⚠️ `KinkyDungeonMovableTilesEnemy`, NOT `KinkyDungeonMovableTiles`. The latter is the
	 * INTERACTABLE alias (chests, doors, orbs) — tiles you can spend a turn on without standing on
	 * them — so using it here would drop a player inside a chest.
	 *
	 * Occupancy matters as much as terrain: without the entity check the joiner lands on top of the
	 * shared enemy or the host's own avatar, which reads to the player as "I spawned inside a rat".
	 *
	 * Bounded (`maxR`) and returns `null` rather than searching for ever; the caller falls back.
	 */
	findFreeTileNear(x, y, maxR = 12) {
		return this.eval(`(function(){
			var cx = ${x | 0}, cy = ${y | 0}, maxR = ${maxR | 0};
			function free(px, py){
				if (KinkyDungeonMovableTilesEnemy.indexOf(KinkyDungeonMapGet(px, py)) < 0) return false;
				return !KDMapData.Entities.some(function(e){ return e.x === px && e.y === py; });
			}
			for (var r = 1; r <= maxR; r++) {
				for (var dx = -r; dx <= r; dx++) {
					for (var dy = -r; dy <= r; dy++) {
						if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;   // ring edge only
						var px = cx + dx, py = cy + dy;
						if (free(px, py)) return { x: px, y: py };
					}
				}
			}
			return null;
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

	// ----- features: PvP + server-side mods ---------------------------

	/**
	 * Load a mod's code into this instance — the same path the production loader
	 * uses (`eval(res)` at KDMods.ts:483) and the test mod-injector
	 * (tests/helpers/mod-injector.ts). Runs in the bundle's scope via the bridge,
	 * so the mod can push to KD globals (e.g. KinkyDungeonEnemies). No source edit.
	 */
	loadMod(code) {
		this.eval(code);
		// A mod introduces NEW globals, and its freshly-initialised values are the world's new
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
			// The peer state a STAND-IN avatar must mirror, so KD own gate can read it.
			// All three are the GAME computing them for the swapped-in player; none is a rule of ours.
			disabled: (typeof KDPlayerIsDisabled === "function") ? !!KDPlayerIsDisabled() : null,
			stunTurns: (typeof KinkyDungeonFlags !== "undefined" && KinkyDungeonFlags && KinkyDungeonFlags.get)
				? (KinkyDungeonFlags.get("playerStun") || 0) : 0,
			// How many turns KD still considers this player DEFEATED. Set by KinkyDungeonDefeat
			// itself in the stay-put branch (KinkyDungeonJail.ts:1651) and expired by KD, so "currently
			// held" is read from the game — the session keeps no timer of its own.
			defeatTurns: (typeof KinkyDungeonFlags !== "undefined" && KinkyDungeonFlags && KinkyDungeonFlags.get)
				? (KinkyDungeonFlags.get("defeat") || 0) : 0,
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
			// The swapped-in player's own defensive stats, RAW — the buff totals, not the
			// multiplicative values KinkyDungeonPlayerEvasion/Block derive from them. Raw is what the
			// stand-in needs: KD applies its own MultiplicativeStat to an entity's buff total
			// (KinkyDungeonGetEvasion:486, KinkyDungeonEnemies.ts:6681/:6684), so passing the raw stat
			// lets the game do its own arithmetic. Handing it a derived value, or inverting one back
			// into a stat, would be a seam of ours.
			// typeof on BOTH: these are bundle let-globals, not properties of globalThis, so a bare
			// reference before init is a TDZ throw that would take the whole getVitals read down.
			// (No backticks in this comment — it lives inside a template literal. See WRAP_CONVENTION.)
			evasion: (typeof KinkyDungeonGetBuffedStat === "function" && typeof KinkyDungeonPlayerBuffs !== "undefined")
				? (KinkyDungeonGetBuffedStat(KinkyDungeonPlayerBuffs, "Evasion") || 0) : 0,
			block: (typeof KinkyDungeonGetBuffedStat === "function" && typeof KinkyDungeonPlayerBuffs !== "undefined")
				? (KinkyDungeonGetBuffedStat(KinkyDungeonPlayerBuffs, "Block") || 0) : 0,
		}; })()`);
	}

	/**
	 * Record every hit the game lands on a peer AVATAR, with the damage info the game itself
	 * produced — `{damage, type}` — so the victim can take it through KD's own player pipeline instead
	 * of us converting avatar hp into Will by hand.
	 *
	 * Measured (in a proof of concept): the real chain is
	 * `KinkyDungeonMove → KDDoAttack → KinkyDungeonAttackEnemy → KinkyDungeonDamageEnemy → KDDamageEnemy`,
	 * the damageInfo arrives intact WITH its type, and the call is NOT inside `KinkyDungeonEnemyLoop`
	 * (so this wrap is not re-entrant with KD's enemy iteration).
	 *
	 * ⚠️ The tally lives ON THE WRAPPER FUNCTION, not in a global. `restorePlayer` resets globals to
	 * their post-init baseline on every swap, which would silently empty a global tally and make a live
	 * wrap look as if it had never fired.
	 *
	 * The same wrap also KEEPS THE AVATAR ALIVE, because this is the only place a peer
	 * avatar can take damage and therefore the only place the rule can be enforced.
	 *
	 * `_armPeerEnemies` mirrors the peer's Will onto the avatar as hp, floored at 0.01 — so a peer
	 * worn down to a sliver is armed *at* that floor and the next real hit takes hp through zero. KD
	 * then does to it what it does to any enemy at zero: `KinkyDungeonEnemyCheckHP`
	 * (`KinkyDungeonEnemies.ts:3340`) `KDRemoveEntity`s it, mid-turn, permanently — and `posOf` /
	 * every snapshot map returns nothing for that player from then on. But the avatar is not a
	 * combatant that can die; it is a stand-in for a PLAYER, and a downed player stays on the map
	 * (down ≠ frozen — they keep agency, and can be bound). KD's own "knocked
	 * down instead of killed" branch (`KinkyDungeonFight.ts:1370`) covers bound / in-party /
	 * `Damage.nokill` targets and nothing else, so an avatar falls straight through it.
	 *
	 * It surfaced as a rare intermittent red in two PvP specs (a null position, a missing snapshot
	 * entity) because the fatal band is narrow — the peer's Will has to sit a sliver above zero at
	 * turn start. `tests/unit/mp-pvp-avatar-lifetime.spec.ts` drives that state directly.
	 */
	/**
	 * "Knocked down, never killed", as ONE rule the world enforces in one place.
	 *
	 * `KDMPFloorAvatar` lifts a peer avatar off the death threshold. 0.001 is the GAME's own knockdown
	 * value, not a number we chose: it is what `KinkyDungeonFight.ts:1386` writes for a target its
	 * bound/in-party/nokill branch spares. We apply the same floor to the one entity class KD has no
	 * rule for.
	 *
	 * Installed as a world global rather than inlined, because it now has TWO callers — the damage
	 * wrapper and the death gate — and two hand-written copies of a floor is exactly how the two
	 * drift.
	 */
	_installAvatarFloor() {
		return this.eval(`(function(){
			if (typeof globalThis.KDMPFloorAvatar === 'function') return { ok: true, already: true };
			globalThis.KDMPIsAvatar = function (E) {
				return !!(E && E.id != null && E.Enemy && typeof E.Enemy.name === 'string'
					&& E.Enemy.name.indexOf('RemotePlayer') === 0);
			};
			globalThis.KDMPFloorAvatar = function (E) {
				if (!globalThis.KDMPIsAvatar(E) || E.hp > 0) return false;
				E.hp = 0.001;
				// ...and do not leave the avatar standing as the pending kill, or KD prints its kill
				// line for it — "[NotFound] KillRemotePlayer_<peer>", since an avatar def has no Kill
				// text key — and the next enemy KD really does kill loses its own line
				// (KinkyDungeonEnemies.ts:3354 compares by identity).
				if (typeof KinkyDungeonKilledEnemy !== 'undefined' && KinkyDungeonKilledEnemy === E)
					KinkyDungeonKilledEnemy = null;
				globalThis.KDMPFloorAvatar.count = (globalThis.KDMPFloorAvatar.count || 0) + 1;
				return true;
			};
			globalThis.KDMPFloorAvatar.count = 0;
			return { ok: true };
		})()`);
	}

	/**
	 * The floor belongs at the DEATH GATE, not on one writer.
	 *
	 * The original fix floored hp inside the `KinkyDungeonDamageEnemy` wrapper. That covers exactly
	 * one of the ways KD lowers an enemy's hp; the engine assigns `enemy.hp` DIRECTLY in ~30 other
	 * places — damage-over-time ticks (`KinkyDungeonEvents.ts:11225/11237/11249`), spells
	 * (`KinkyDungeonMagicCode.ts:95/785/839`), dialogue outcomes, prison code — and none of those
	 * passes through the wrapper. MEASURED in a live session: `[mp] arm A hp=0.01/10` at turn 54,
	 * where the `/10` is `_armPeerEnemies` falling back because `getEntityCombat` returned null — the
	 * avatar was already gone. Player A vanished from B's screen and B's log carried
	 * `[NotFound] KillRemotePlayer_PlayerA`.
	 *
	 * `KinkyDungeonEnemyCheckHP` is the ONE function that turns `hp <= 0` into removal — by
	 * `KDRemoveEntity`, or by `KinkyDungeonCapture` in its bound branch, which removes the entity just
	 * as thoroughly. Every writer funnels into it, so flooring here covers the writers we have not
	 * enumerated as well as the ones we have. Generic over the entity class, not over the cause.
	 */
	installAvatarDeathGuard() {
		this._installAvatarFloor();
		return this.eval(`(function(){
			if (KinkyDungeonEnemyCheckHP.__kdAvatarGuard) return { ok: true, already: true };
			var _chk = KinkyDungeonEnemyCheckHP;
			KinkyDungeonEnemyCheckHP = function (enemy, E, mapData) {
				globalThis.KDMPFloorAvatar(enemy);
				return _chk.apply(this, arguments);
			};
			KinkyDungeonEnemyCheckHP.__kdAvatarGuard = 1;
			return { ok: true };
		})()`);
	}

	/** How many times the floor has caught an avatar — the death paths a live session actually hits. */
	avatarFloorCount() {
		return this.eval(`(typeof globalThis.KDMPFloorAvatar === 'function' ? (globalThis.KDMPFloorAvatar.count || 0) : -1)`);
	}

	installPeerDamageRecorder() {
		this._installAvatarFloor();
		return this.eval(`(function(){
			if (KinkyDungeonDamageEnemy.__kdPeerRec) return { ok: true, already: true };
			var _dmg = KinkyDungeonDamageEnemy;
			KinkyDungeonDamageEnemy = function (E, D) {
				var nm = (E && E.Enemy && E.Enemy.name) || '';
				var isAvatar = !!(E && E.id != null && nm.indexOf('RemotePlayer') === 0);
				if (D && isAvatar) {
					var w = KinkyDungeonDamageEnemy;
					if (!w.__hits) w.__hits = {};
					if (!w.__hits[E.id]) w.__hits[E.id] = [];
					w.__hits[E.id].push({ damage: Number(D.damage) || 0, type: D.type || 'pain' });
				}
				var res = _dmg.apply(this, arguments);
				// Floor it as soon as the damage lands, so everything the rest of the turn
				// reads (targeting, KDHelpless, the fight path's own follow-ups) sees a live entity.
				// The DEATH GATE below is the backstop for every other writer.
				globalThis.KDMPFloorAvatar(E);
				return res;
			};
			KinkyDungeonDamageEnemy.__kdPeerRec = 1;
			KinkyDungeonDamageEnemy.__hits = {};
			return { ok: true };
		})()`);
	}

	/** Take (and clear) the hits recorded against one peer avatar this turn. */
	/**
	 * Take the game's own presentation output for the player currently swapped in.
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
	 * Drain the game's NOISE presentation queues; the sibling of takeDamageFloaters above.
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

	/**
	 * Drain this harvest's noise ORIGINS — `[{x, y, sound}]`, one entry per real `KDEnemyAddSound`
	 * call since the last drain (the `installTurnModel` wrap, not a copy of its engine math) — so
	 * `SwapSession._harvestNoise` can decide, per OTHER joined human, whether they would ALSO have
	 * perceived the same ambient sound from their own position. Always drains in the same call that
	 * drains `takeNoisePresentation`, so one harvest's sources batch corresponds 1:1 with that same
	 * harvest's shockwaves/sounddesc batch.
	 */
	takeNoiseSources() {
		const out = this.eval('(globalThis.__kdPendingNoiseSources || []).slice()');
		this.eval('globalThis.__kdPendingNoiseSources = [];');
		return out || [];
	}

	/**
	 * KD's own hearing/distance rule (`KDCanHearSound`, KinkyDungeonEnemies.ts), evaluated for a
	 * listener at `(listenerX, listenerY)` who is NOT necessarily the current slot occupant —
	 * `KDCanHearSound` takes an explicit listener argument, so a plain `{x, y, player: true}`
	 * stand-in works without swapping anyone into the slot. `sourceX`/`sourceY`/`sound` are the noise
	 * origin (`HeadlessHost.takeNoiseSources`'s own entries); `mult` matches the 1.5 constant
	 * `KDEnemyAddSound`'s own call site uses for a player listener, so this is the SAME threshold the
	 * engine already applied to decide whether the current occupant could hear it — just re-asked for
	 * a different position.
	 *
	 * Deliberately does not attempt the DEAF-LEVEL half of `KinkyDungeonGetHearingRadius` for the
	 * other human specifically — that function reads deafness off the CURRENT global player
	 * (`KinkyDungeonAllRestraintDynamic`) regardless of the entity argument passed to it, so it is
	 * already only an approximation for anyone but the slot occupant, including in the single
	 * evaluation this mirrors. Fixing that would need a real slot swap per listener; out of scope
	 * here and no worse than the existing single-listener check's own fidelity.
	 */
	canHearFrom(listenerX, listenerY, sourceX, sourceY, sound, mult) {
		return this.eval(`(function(){
			if (typeof KDCanHearSound !== 'function') return 0;
			return KDCanHearSound({ x: ${+listenerX}, y: ${+listenerY}, player: true },
				${+sound}, ${+sourceX}, ${+sourceY}, ${+mult}) || 0;
		})()`);
	}

	/**
	 * Record every untie performed on a peer avatar — the sibling of `installPeerDamageRecorder`.
	 *
	 * WHY A RECORDER AND NOT A LEVEL DELTA. The obvious reading of "someone untied this peer" is the
	 * drop in the avatar's `boundLevel` since it was armed. That is wrong for the same reason the hp
	 * delta was given up: the avatar is a live entity in a running world, and a standing delta
	 * picks up everything ELSE that moves it. Measured — a bound avatar sheds bind level on its own
	 * every turn, so every quiet turn read as an untie and quietly stripped the peer's real
	 * restraints (`mp-slow-per-player`: a hobbled player walked away unslowed).
	 *
	 * So the untie is taken from the CALL, not from the state: the amount is what `KDUntieEnemy`
	 * actually removed, on an entity that is actually an avatar, at the moment it happened. Nothing
	 * else can forge it, and a quiet turn records nothing at all.
	 *
	 * WRAP_CONVENTION: sentinel-gated, `_prev` captured in closure and called first.
	 */
	installPeerUntieRecorder() {
		return this.eval(`(function(){
			if (typeof KDUntieEnemy !== 'function') return { ok: false, error: 'no KDUntieEnemy' };
			if (KDUntieEnemy.__kdPeerUntie) return { ok: true, already: true };
			var _untie = KDUntieEnemy;
			KDUntieEnemy = function (enemy) {
				var before = (enemy && enemy.boundLevel) || 0;
				var res = _untie.apply(this, arguments);
				var nm = (enemy && enemy.Enemy && enemy.Enemy.name) || '';
				if (enemy && enemy.id != null && nm.indexOf('RemotePlayer') === 0) {
					var removed = before - ((enemy.boundLevel) || 0);
					if (removed > 0) {
						var w = KDUntieEnemy;
						if (!w.__unties) w.__unties = {};
						w.__unties[enemy.id] = (w.__unties[enemy.id] || 0) + removed;
					}
				}
				return res;
			};
			KDUntieEnemy.__kdPeerUntie = 1;
			KDUntieEnemy.__unties = {};
			return { ok: true };
		})()`);
	}

	/**
	 * A co-op partner's avatar IS a talk target — the owner's revised rule: bumping your partner in
	 * peace opens KD's own ally dialogue (`GenericAlly`), the same branch stock KD offers for any
	 * `Player`-faction, non-hostile entity (`KinkyDungeonLaunchAttack` -> `KDTalkToEnemy` ->
	 * `KDStartDialog`). That dialogue is how a partner's bondage gets UNTIED (`KDGetPlayerUntieBindAmt`
	 * / `KDUntieEnemy`, `KinkyDungeonDialogue.ts:851-896`) — the earlier "do nothing" guard
	 * (`installPeerTalkGuard`) blocked that along with everything else, which is the regression
	 * `mp-coop-untie` caught. In PvP the armed peer is `faction: 'Enemy'` and `KDTalkToEnemy` is
	 * already false for a hostile entity, so the dialogue never opens there regardless.
	 *
	 * Most of `GenericAlly`'s OTHER options are NPC-only and either do nothing for a peer avatar (it
	 * is rebuilt from the real player every turn, so a leash/tie/follow-stay flag written onto it is
	 * gone by the next turn) or actively misrepresent a real second player (recruiting your partner
	 * into your own party, "feeding" hp that is not theirs, an out-of-band attack bypassing the real
	 * PvP arm). This hides those the KD-native way: wrap each one's own `prerequisiteFunction` — the
	 * same gate KD's own dialogue renderer already calls per entry before drawing its button
	 * (`KDCheckDialoguePrereq`, `KinkyDungeonDialogue.ts:80-90,169`) — so it reports false whenever
	 * the dialogue's current entity is a peer avatar; the button simply never appears. `Untie` and
	 * `Leave` are untouched.
	 */
	installPeerAllyDialogueGuard() {
		return this.eval(`(function(){
			if (typeof KDDialogue === 'undefined' || !KDDialogue.GenericAlly || !KDDialogue.GenericAlly.options) {
				return { ok: false, error: 'no GenericAlly dialogue' };
			}
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
			var hidden = [];
			for (var i = 0; i < hide.length; i++) {
				var entry = opts[hide[i]];
				if (!entry || entry.__kdPeerAllyGuard) continue;
				wrapEntry(entry);
				hidden.push(hide[i]);
			}
			return { ok: true, hidden: hidden };
		})()`);
	}

	/** Take (and clear) the bind level untied off one peer avatar this turn. Take-once, like the hits. */
	takePeerUnties(entityId) {
		return this.eval(`(function(){
			var w = KDUntieEnemy, k = ${entityId | 0};
			if (!w || !w.__unties || !w.__unties[k]) return 0;
			var out = w.__unties[k]; delete w.__unties[k]; return out;
		})()`) || 0;
	}

	takePeerHits(entityId) {
		return this.eval(`(function(){
			var w = KinkyDungeonDamageEnemy, k = ${entityId | 0};
			if (!w || !w.__hits || !w.__hits[k]) return [];
			var out = w.__hits[k]; delete w.__hits[k]; return out;
		})()`) || [];
	}

	/**
	 * How many hits are recorded against this avatar, WITHOUT consuming them.
	 *
	 * `takePeerHits` is take-once by design (a hit may be charged to the victim exactly once), so it
	 * cannot also answer "was this avatar attacked this turn?" for a second caller. This peeks.
	 */
	peekPeerHits(entityId) {
		return this.eval(`(function(){
			var w = KinkyDungeonDamageEnemy, k = ${entityId | 0};
			return (w && w.__hits && w.__hits[k]) ? w.__hits[k].length : 0;
		})()`) || 0;
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

	/**
	 * Spend `amount` of bondage POWER on the swapped-in player's worn restraints — the untie half of
	 * `addRestraint`, and what an ally's `Untie` on a peer avatar has to mean for a PLAYER victim.
	 *
	 * WHY THIS SHAPE. KD has two bondage models: an NPC carries a bind LEVEL (`boundLevel`, what
	 * `KDUntieEnemy` decrements), a player wears restraint ITEMS with `struggleProgress`. Nothing in
	 * the game bridges them, because in single player nobody ever unties the player. So the untie is
	 * denominated in the ONE unit both sides already use — bondage power, `KDRestraint().power`, the
	 * same sum `getVitals().bondage` reports and `_mirrorPeerBondage` puts on the avatar. Removing X
	 * power of bondage is X/power of the way through a restraint of that power. No third scale.
	 *
	 * Completion goes through the game's own `KinkyDungeonRemoveRestraint`, with the untier passed as
	 * `Remover` (the stock parameter for "someone else took this off"), so the removal fires KD's own
	 * events and messages — exactly as the tie path uses the stock `KinkyDungeonAddRestraint`.
	 *
	 * Cheapest first: a small budget still frees the easiest binding rather than being spread so thin
	 * that nothing ever comes off.
	 *
	 * KNOWN LIMITATION — protected bondage still COUNTS toward the amount KD offers to untie, so
	 * choosing Untie on a peer wearing only locked or cursed gear spends the turn and frees nothing.
	 * KD's own answer is `helpImmune` (`KDGetPlayerUntieBindAmt` subtracts those channels,
	 * KinkyDungeonDialogue.ts:2931), but NO stock `KDSpecialBondage` type sets it — the one that did
	 * is commented out — so using it would mean inventing a `specialBoundLevel` key, and that is a
	 * road already travelled: `setAvatarBondage` below documents an invented key ("MPPeer") crashing
	 * the client outright, because `KDSpecialBondage[key]` is indexed UNGUARDED on the draw path.
	 * A wasted click is a far smaller cost than a crash, so the amount stays honest-but-generous and
	 * this method is the thing that refuses.
	 */
	untieRestraints(amount, removerEntityId) {
		const budget = Number(amount) || 0;
		if (!(budget > 0)) return { removed: [], progressed: [], protectedItems: [], spent: 0 };
		return this.eval(`(function(){
			var budget = ${budget};
			var rid = ${removerEntityId | 0};
			var remover = rid ? KDMapData.Entities.find(function(en){ return en.id === rid; }) : undefined;
			var worn = KinkyDungeonAllRestraint().slice();
			worn.sort(function(a, b){
				return ((KDRestraint(a) || {}).power || 0) - ((KDRestraint(b) || {}).power || 0);
			});
			var removed = [], progressed = [], protectedItems = [], spent = 0;
			for (var i = 0; i < worn.length && budget > 0; i++) {
				var it = worn[i];
				var def = KDRestraint(it);
				if (!def || !def.Group) continue;
				// PROTECTED BONDAGE IS NOT AN ALLY'S TO REMOVE.
				//
				// KD's own untie is documented "not including protected bondage"
				// (KinkyDungeonDialogue.ts:2924): it subtracts the bind level backed by real items and
				// anything flagged helpImmune, and runs with includeUnlocked = true. A friend loosens
				// what is merely tied on. A LOCK wants a key or a pick and a CURSE cannot be taken off
				// at all — neither is something being untied can reach, so the budget skips them
				// rather than spending itself on something it must not finish.
				if (it.lock) { protectedItems.push({ name: it.name, why: 'locked', lock: it.lock }); continue; }
				if (typeof KDGetCurse === 'function' && KDGetCurse(it)) {
					protectedItems.push({ name: it.name, why: 'cursed' });
					continue;
				}
				var power = def.power || 1;
				if (!it.struggleProgress) it.struggleProgress = 0;
				// power still standing between this item and coming off
				var need = Math.max(0, (1 - it.struggleProgress - (it.cutProgress || 0))) * power;
				var pay = Math.min(budget, need);
				if (pay <= 0) continue;
				it.struggleProgress = Math.min(1, it.struggleProgress + pay / power);
				budget -= pay; spent += pay;
				if (it.struggleProgress + (it.cutProgress || 0) >= 1) {
					KinkyDungeonRemoveRestraint(def.Group, false, false, false, false, false, remover);
					removed.push(it.name);
				} else {
					progressed.push({ name: it.name, struggleProgress: it.struggleProgress });
				}
			}
			// The struggle-group cache describes the worn set, so it has to follow it. (A stale cache
			// here is what crashed KDDrawStruggleGroups — see UPSTREAM_ISSUES.md #3.)
			if (typeof KinkyDungeonUpdateStruggleGroups === 'function') KinkyDungeonUpdateStruggleGroups();
			return { removed: removed, progressed: progressed, protectedItems: protectedItems,
				spent: spent, count: KinkyDungeonAllRestraint().length };
		})()`);
	}

	/** Add a CARRYABLE loose-restraint item (Items inventory), not a worn one. */
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

	// ----- real in-game integration: players-as-entities ---------------

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
					bound: 'Apprentice', // sprite name; presence makes KDCanBind true so the Truss/bind option appears
					AI: 'guard', immobile: true, visionRadius: 0, maxhp: 100, minLevel: 0, weight: -1000,
					movePoints: 1000, attackPoints: 0, attack: '', attackRange: 0,
					// Evasion 0 = NEUTRAL, and it must stay neutral. It used to be -100, and
					// KinkyDungeonMultiplicativeStat(-100) is 101 — a x101 hit chance that made every PvP
					// attack land unconditionally and swamped anything the peer brought (measured: a peer
					// with an Evasion buff of 3.0 still came out at 25.25, i.e. still an unconditional
					// hit). The peer's real evasion now arrives on the entity's buff list instead, via
					// setAvatarDefenses; a non-zero value here would silently cancel it again.
					evasion: 0, armor: 0, followRange: 100, lowpriority: true,
					// style → the client renders the avatar as a full character (NPC path,
					// KDQuickGenNPC + DrawCharacter) so the other player is VISIBLE, not just
					// an HP bar. Server never draws (rendering neutered) so this is client-only.
					style: 'BlueHair',
					terrainTags: {}, floors: KDMapInit([]),
				});
				if (typeof KinkyDungeonRefreshEnemiesCache === 'function') KinkyDungeonRefreshEnemiesCache();
			}
			// Register the def's display-name key so real combat text reads a real name
			// ("Your attack hits the Rival …") instead of "[NotFound] NameRemotePlayer".
			if (typeof addTextKey === 'function') addTextKey('NameRemotePlayer', 'Rival');
			return true;
		})()`);
	}

	/**
	 * Set the display name of the player currently in the world's player slot.
	 *
	 * `KDGameData.PlayerName` is KD's own field for this (`KinkyDungeon.ts:647` seeds it, the "Name"
	 * creation screen writes it). Deliberately NOT `KinkyDungeonPlayer` / `CharacterLoadNPC`: that is
	 * the BC-era Character path, and this repo prefers KD-native state.
	 *
	 * Whoever is in the slot — that is the point. Callers sandwich this between `restorePlayer` and
	 * `capturePlayer` so the name lands inside one player's bundle (see `SwapSession._seatPlayer`);
	 * `PlayerName` is absent from `KDGAMEDATA_WORLD_KEYS`, so the generic capture already carries it
	 * per player and nothing else is needed.
	 */
	setPlayerName(name) {
		return this.eval(`(function(){
			if (typeof KDGameData === 'undefined' || !KDGameData) return '';
			KDGameData.PlayerName = ${JSON.stringify(String(name || ''))};
			return KDGameData.PlayerName;
		})()`);
	}

	/**
	 * Give the player currently in the world's player slot the perks they chose.
	 *
	 * Whoever is in the slot, exactly as `setPlayerName` above: callers sandwich this between
	 * `restorePlayer` and `capturePlayer` so everything it does lands inside ONE player's bundle
	 * (`SwapSession._seatPlayer`). Applied anywhere else, the start-effects below would attach to
	 * whoever happens to be swapped in — a stranger's starting rope on your character.
	 *
	 * ⚠️ A PERK IS NOT A FLAG. `KDInitPerks()` (`KinkyDungeonPerks.ts:711`) walks `KDPerkStart` and
	 * runs real start-effects: `Submissive` adds a BasicCollar and a BasicLeash, `Pacifist` and
	 * `Rigger` add weapons, `Unchained` adds a RedKey, `Studious` adds a spell point, `FuukaCollar`
	 * swaps the outfit and pushes a spell. Writing the map without this call gives the player a
	 * checkbox and nothing else, which is why the tests assert on what is on the body.
	 *
	 * ⚠️ KD'S OWN TABLE IS THE WHITELIST. A key is applied only if `KinkyDungeonStatsPresets` has it,
	 * so an unknown or malicious key is dropped by the GAME rather than by a perk list of ours —
	 * epic AC2 forbids gameplay tables in `tools/mp-server/**`, and `join-gate.js` deliberately does
	 * not validate names for the same reason. This is where an unknown declaration dies.
	 *
	 * The map is REPLACED, not merged: starting from the template's own choices would let a previous
	 * player's perks survive into this one, which is the bug R6 exists to prevent.
	 *
	 * @param {string[]} keys perk keys, already sanitised by `sanitizePerks`
	 * @returns {string[]} the keys that were actually switched on — i.e. minus anything KD rejected
	 */
	applyPerks(keys) {
		const list = Array.isArray(keys) ? keys.filter((k) => typeof k === 'string') : [];
		return this.eval(`(function(){
			if (typeof KinkyDungeonStatsChoice === 'undefined') return [];
			var want = ${JSON.stringify(list)};
			KinkyDungeonStatsChoice = new Map();
			for (var i = 0; i < want.length; i++) {
				// KD's own perk table answers "is this a perk?" — see the note above.
				if (typeof KinkyDungeonStatsPresets !== 'undefined' && KinkyDungeonStatsPresets
					&& KinkyDungeonStatsPresets[want[i]]) KinkyDungeonStatsChoice.set(want[i], true);
			}
			if (typeof KDInitPerks === 'function') KDInitPerks();
			return Array.from(KinkyDungeonStatsChoice.keys())
				.filter(function(k){ return KinkyDungeonStatsChoice.get(k); });
		})()`);
	}

	/**
	 * ADD perk keys to whoever is swapped in, without rebuilding them as a new character.
	 *
	 * ⚠️ NOT A SECOND `applyPerks`, and the difference is the whole point. `applyPerks` above is the
	 * SEATING operation: it replaces the map and runs `KDInitPerks()`, i.e. it decides what character
	 * walks into the dungeon, starting rope and all. This is the MID-RUN operation: the party's start
	 * perk set widened after a seat was already taken (a latecomer declared something the party did
	 * not have), and the players already in the dungeon have to hold the same set or the shared world
	 * stops being deterministic (`Stealthy` scales the floor's enemy and treasure counts
	 * from whichever bundle is swapped in when generation runs).
	 *
	 * So it sets the flag and nothing else. No wipe — the seat's own perks and the game-mode keys in
	 * the same Map must survive. No `KDInitPerks()` — re-running it would hand every already-seated
	 * player a second copy of their OWN start-effects (`Submissive` adds its collar and leash
	 * unconditionally), and somebody else's arrival is not a reason to re-equip a player mid-run.
	 * This is the boundary the perk agreement drew: a mid-run grant is a perk, not a character.
	 *
	 * KD's own table is still the whitelist, exactly as in `applyPerks` — an unknown key dies in the
	 * GAME, not in a perk list of ours (epic AC2).
	 *
	 * `set(k, true)` from a VARIABLE, never a literal name: `mp-perk-choice.spec.ts` greps this
	 * source for a literal and fails the build if one appears.
	 *
	 * @param {string[]} keys perk keys, already sanitised by `sanitizePerks`
	 * @returns {string[]} the keys that were actually switched on — i.e. minus anything KD rejected
	 */
	grantPerks(keys) {
		const list = Array.isArray(keys) ? keys.filter((k) => typeof k === 'string') : [];
		if (!list.length) return [];
		return this.eval(`(function(){
			if (typeof KinkyDungeonStatsChoice === 'undefined' || !KinkyDungeonStatsChoice) return [];
			var want = ${JSON.stringify(list)};
			var got = [];
			for (var i = 0; i < want.length; i++) {
				if (typeof KinkyDungeonStatsPresets !== 'undefined' && KinkyDungeonStatsPresets
					&& KinkyDungeonStatsPresets[want[i]]) {
					KinkyDungeonStatsChoice.set(want[i], true);
					got.push(want[i]);
				}
			}
			return got;
		})()`);
	}

	/**
	 * Re-assert KD's game-mode keys AFTER `applyPerks` has wiped them.
	 *
	 * ⚠️ THIS IS NOT A SECOND WAY TO SET PERKS, and it must not become one.
	 *
	 * `applyPerks` above does `KinkyDungeonStatsChoice = new Map()` and then re-adds a key only if
	 * `KinkyDungeonStatsPresets[k]`. The nine game-mode keys are NOT in that table — they are written
	 * into the same Map by KD's `KDUpdatePlugSettings`, not by the perk system — so `applyPerks`
	 * silently discards every one of them. Which means the modes established at `init()` are gone
	 * from the slot the moment the first player is seated, and each player would then be running
	 * whatever the wipe left behind.
	 *
	 * So this runs immediately AFTER `applyPerks` on each seat, and sets only classified mode keys
	 * (`isModeKey`). Anything else is dropped — an unknown key here would be this layer choosing
	 * something for a player, which is exactly what the "never choose for a player" rule forbids.
	 *
	 * `set(k, true)` from a VARIABLE, never from a literal name: `mp-perk-choice.spec.ts` greps this
	 * source for `KinkyDungeonStatsChoice.set("<literal>"` and fails the build if one appears.
	 *
	 * No `KDInitPerks()` here. `applyPerks` already ran it for this seat, and a mode key has no
	 * start-effect to run — re-running it would re-apply the player's starting restraints twice.
	 */
	/**
	 * The game-mode keys currently set in the world, so they can be restored after a wipe.
	 *
	 * Read once, right after `init()`, rather than reconstructed from the host's declaration: what
	 * `KDUpdatePlugSettings` produced is KD's DEFAULTS *plus* whatever the host chose, and a seat must
	 * get the whole picture. Restoring only the declared half is what broke `mp-parity-oracle` — a
	 * co-op player ended up with an empty `KinkyDungeonStatsChoice` where a single-player run has the
	 * full default set, and the two runs diverged on `statchoice` from the very first turn.
	 */
	/**
	 * The WHOLE of `KinkyDungeonStatsChoice` as the world's own init left it, split into
	 * the half `applyPerks` preserves (`perks`) and the half it destroys (`modes`).
	 *
	 * Read once, right after `init()`. Both halves are needed to reconstruct a seat, and finding that
	 * out took two rounds of `mp-parity-oracle`:
	 *
	 *  1. Restoring only the host's DECLARED modes left a co-op player with an empty StatsChoice
	 *     where a single-player run has KD's full default set.
	 *  2. Restoring all non-perk keys still diverged — because `KDUpdatePlugSettings` also runs
	 *     `KDUpdateConsentSettings`, which sets REAL preset perks from the consent settings
	 *     (`KinkyDungeon.ts:6100-6109`). Those are perks by KD's table, so `applyPerks` is willing to
	 *     keep them, but a player who declared nothing passes `[]` and they are wiped with nothing to
	 *     put them back.
	 *
	 * Hence a snapshot of both halves, rather than a cleverer filter. "What did KD's own new game
	 * produce" is a question with one answer; this reads it instead of deriving it.
	 */
	statsChoiceSnapshot() {
		return this.eval(`(function(){
			if (typeof KinkyDungeonStatsChoice === 'undefined') return { perks: [], modes: [] };
			var perks = [], modes = [];
			KinkyDungeonStatsChoice.forEach(function(v, k){
				var isPerk = (typeof KinkyDungeonStatsPresets !== 'undefined'
					&& KinkyDungeonStatsPresets && !!KinkyDungeonStatsPresets[k]);
				if (isPerk) { if (v) perks.push(k); return; }
				// ⚠️ MODES KEEP THEIR VALUE, INCLUDING undefined. KDUpdatePlugSettings writes
				// set(key, undefined) for every mode that is OFF, so the Map CONTAINS those keys with
				// an undefined value -- 20 of the 24 entries in a default new game. Capturing only the
				// truthy ones left a seat holding 4 keys against a single-player run's 24, which is
				// the statchoice divergence mp-parity-oracle reported. null encodes undefined,
				// because JSON.stringify would drop the property otherwise.
				modes.push({ k: k, v: (v === undefined ? null : v) });
			});
			return { perks: perks, modes: modes };
		})()`);
	}

	modeKeys() {
		return this.eval(`(function(){
			if (typeof KinkyDungeonStatsChoice === 'undefined') return [];
			var out = [];
			// EXACTLY the complement of what applyPerks keeps: it re-adds a key only when
			// KinkyDungeonStatsPresets has it, so everything else in this Map is what it destroys.
			// Defined as a complement rather than as "the mode keys" on purpose — the two must add up
			// to the whole Map or a seat cannot reproduce what init built, and mp-parity-oracle
			// measures exactly that against a reference single-player run.
			KinkyDungeonStatsChoice.forEach(function(v, k){
				if (v && !(typeof KinkyDungeonStatsPresets !== 'undefined'
					&& KinkyDungeonStatsPresets && KinkyDungeonStatsPresets[k])) out.push(k);
			});
			return out;
		})()`);
	}

	applyModes(keys) {
		// NOT narrowed to the classified mode keys: this restores whatever `modeKeys()` saw the world's
		// own init leave behind (the complement of the perk set). Narrowing it to MODE_WORLD_KEYS is
		// exactly what made a co-op seat diverge from a single-player run in mp-parity-oracle. Wire
		// safety lives where wire data enters — `sanitizeWorld` gates a HOST's declaration before it
		// can ever reach `init`, so nothing unvalidated arrives here.
		// Accepts either a bare key (meaning "set it true" — the wire/declaration shape) or a
		// `{k, v}` pair from `statsChoiceSnapshot` (meaning "restore exactly this value", where
		// `null` is KD's own `undefined`). One applier, because two would drift.
		const list = (Array.isArray(keys) ? keys : [])
			.map((e) => (typeof e === 'string' ? { k: e, v: true } : e))
			.filter((e) => e && typeof e.k === 'string');
		return this.eval(`(function(){
			if (typeof KinkyDungeonStatsChoice === 'undefined') return [];
			var want = ${JSON.stringify(list)};
			for (var i = 0; i < want.length; i++) {
				KinkyDungeonStatsChoice.set(want[i].k, want[i].v === null ? undefined : want[i].v);
			}
			return want.map(function(e){ return e.k; });
		})()`);
	}

	/**
	 * Inject an avatar entity representing another player at (x,y). Returns the
	 * real KD entity id (the engine now sees/targets/collides with it).
	 */
	/**
	 * Apply a player's CHARACTER PACKAGE to whoever is currently in the world's player slot.
	 *
	 * Whoever is in the slot, exactly as `setPlayerName` and `applyPerks` are: callers sandwich this
	 * between a template restore and `capturePlayer()`, and that sandwich is the entire mechanism.
	 * See `swap-session._seatPlayer`.
	 *
	 * ⚠️ KD'S OWN TABLES ARE THE WHITELIST, AND THEY ARE CONSULTED HERE — never in `join-gate.js`.
	 * The gate sanitises SHAPE (epic AC2 forbids a list of outfit names in `tools/mp-server/**`);
	 * this is the layer with a world to ask, so this is the layer that decides what a value MEANS. An
	 * unrecognised class or outfit is DROPPED, silently and per-field: a package is three independent
	 * choices, and a typo in one must not cost the player the other two.
	 *
	 * Returns what was actually applied, so a caller (and a test) can tell "applied" from "dropped"
	 * without re-deriving KD's tables.
	 */
	applyCharacter(pkg) {
		if (!pkg || typeof pkg !== 'object') return {};
		return this.eval(`(function(){
			var want = ${JSON.stringify({
		class: typeof pkg.class === 'string' ? pkg.class : '',
		outfit: typeof pkg.outfit === 'string' ? pkg.outfit : '',
		appearance: typeof pkg.appearance === 'string' ? pkg.appearance : '',
	})};
			var got = {};
			// CLASS. KDClassStart is KD's own class table, and assigning KinkyDungeonClassMode from
			// its keys is literally what KD's own class screen does (KDClasses.ts:174). An unknown
			// name is not in the table and is simply not applied.
			if (want.class && typeof KDClassStart !== 'undefined' && KDClassStart[want.class]) {
				KinkyDungeonClassMode = want.class;
				got.class = want.class;
			}
			// OUTFIT. KDGetDressList() is KD's own dress table and KinkyDungeonSetDress its own
			// applier — it rebuilds the player's clothes and appearance, which is precisely the work
			// this layer must not re-implement.
			//
			// The table is checked BEFORE the call, not caught after it: SetDress iterates
			// KDGetDressList()[dress] unguarded (KinkyDungeonDress.ts:109), so an unknown name throws
			// midway and would leave the slot half-dressed. Refusing up front leaves it untouched.
			if (want.outfit && typeof KinkyDungeonSetDress === 'function'
				&& typeof KDGetDressList === 'function' && (KDGetDressList() || {})[want.outfit]) {
				KinkyDungeonSetDress(want.outfit, want.outfit);
				got.outfit = want.outfit;
			}
			/*
			 * APPEARANCE. Without this, the seated player's OWN look (what they see when they look
			 * at themselves) is whatever the fresh template/new-game happened to generate -- NOT what
			 * they declared -- even though the exact same declaration already makes their AVATAR look
			 * right on a PARTNER's screen (spawnAvatar, below). The bug report is about both sides
			 * agreeing, so this layer must put the two in the same place: the player's live state.
			 *
			 * CharacterAppearanceRestore is KD's own call (the wardrobe's revert path) and, same as
			 * AppearanceItemParse inside it, resolves every model by NAME against KD's own
			 * ModelDefs table -- an unresolvable name is silently dropped by that function, not by
			 * this layer, so an unrecognised/corrupt blob degrades to "nothing applied" rather than a
			 * thrown error reaching the caller.
			 *
			 * NOTE: no backticks in this comment -- it lives inside the eval() template literal below
			 * (memory: a stray backtick here terminates that literal at FILE-PARSE time, not at the
			 * call this method makes, which is exactly how this broke the first time it was written).
			 */
			if (want.appearance && typeof CharacterAppearanceRestore === 'function'
				&& typeof DecompressB64 === 'function' && typeof KinkyDungeonPlayer !== 'undefined') {
				try {
					CharacterAppearanceRestore(KinkyDungeonPlayer, DecompressB64(want.appearance), false, true);
					got.appearance = true;
				} catch (e) { /* a malformed/old-build blob must not break seating */ }
			}
			return got;
		})()`);
	}

	/**
	 * @param {object} [character] `{ style, outfit }` this player chose, or null for the
	 *   default look. Per-player-safe because each avatar owns its own def clone (below).
	 */
	spawnAvatar(x, y, name, character) {
		this._ensureAvatarDef();
		const label = name || 'Player';
		/*
		 * The look, which is what makes two players tell each other APART on screen.
		 *
		 * KD draws an entity carrying `CustomName` and (`style` or `outfit`) as a full paper-doll NPC
		 * rather than a flat sprite (`KinkyDungeonEnemies.ts:1042`), building the model from
		 * `KDModelStyles[style]` and dressing it from `outfit` (`:11211-11237`).
		 *
		 * `'BlueHair'` stays as the fallback — it is what every avatar has always looked like,
		 * so a player who declared nothing keeps exactly the look they had (R4). An unknown style is
		 * left to KD, which falls back on its own; nothing here judges the value (epic AC2).
		 *
		 * `style` only ever picks a RANDOM preset (`KDModelStyles[style].Hairstyle[Math.random() * …]`
		 * — `KinkyDungeonEnemies.ts` ~:11378-11391) — it was never the mechanism for "look like the
		 * player really looks". `appearance` is: the player's own serialised `Appearance` (hair item,
		 * colour, everything the wardrobe sets), carried verbatim for the client to apply onto the
		 * generated NPC once it exists (`render-client.js`). Still nothing here judges the value — an
		 * opaque blob is passed through exactly like `outfit`, never decoded.
		 */
		const style = (character && character.style) || 'BlueHair';
		const outfit = (character && character.outfit) || '';
		const appearance = (character && character.appearance) || '';
		// Combat text reads TextGet("Name"+Enemy.Enemy.name) — the def name, NOT CustomName —
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
				CustomName: ${JSON.stringify(label)}, CustomNameColor: '#88bbff',
				style: ${JSON.stringify(style)} };
			// Set only when the player chose one. An empty outfit key on every avatar
			// would cross the wire as a change on a session that declared nothing.
			var outfit = ${JSON.stringify(outfit)};
			if (outfit) ent.outfit = outfit;
			// Same reasoning as outfit: only set when declared, so an avatar whose owner sent
			// nothing does not cross the wire as "changed" every snapshot.
			var appearance = ${JSON.stringify(appearance)};
			if (appearance) ent.appearance = appearance;
			KDAddNewEntity(ent);
			KDUpdateEnemyCache = true;
			return { entityId: ent.id, x: ent.x, y: ent.y };
		})()`);
	}

	/**
	 * Take an injected avatar entity back out of the world.
	 *
	 * The counterpart `spawnAvatar` never had. Removes the ENTITY only: its `RemotePlayer_<name>` def
	 * stays in `KinkyDungeonEnemies`, because that is a template rather than an instance — deleting it
	 * would break a later spawn of the same name and force a full enemy-cache rebuild for nothing.
	 *
	 * `KDUpdateEnemyCache` is set for the same reason `moveAvatar` sets it: KD caches entity lookups
	 * per tile, and a cache still pointing at a removed entity is how a ghost keeps blocking a
	 * doorway. Returns whether anything was actually there.
	 */
	despawnAvatar(entityId) {
		return this.eval(`(function(){
			var i = KDMapData.Entities.findIndex(function(e){ return e.id === ${entityId | 0}; });
			if (i < 0) return false;
			KDMapData.Entities.splice(i, 1);
			KDUpdateEnemyCache = true;
			return true;
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
	 * For the NEXT apply, veto KD's stock bump-to-attack against the listed entity ids.
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

	/**
	 * The LEVEL GOAL IS CO-LOCATED: the stairs do not fire until the whole party is at
	 * them, and never while a member is down (owner decisions D1/D2, 2026-08-24).
	 *
	 * WHY THIS IS THE GATEWAY'S RULE AND NOT A GAME RULE. "Wait for the other player" cannot exist in
	 * a one-player game — the epic's own test for what belongs here. What it must NOT do is invent a
	 * second way to stop a transition, so it is expressed through KD's OWN cancellation path
	 * (KDStairActions.ts:84-95): a beforeStairCancel handler sets data.cancelevent, and the matching
	 * KDCancelEvents entry is what the game runs instead of advancing the level. Nothing here touches
	 * KinkyDungeonMove, so walking ACROSS a stair tile is unaffected — only leaving by it is.
	 *
	 * The registry is a plain lookup with no memoisation
	 * (KDMapHasEvent = (map, event) => map[event] != undefined, KinkyDungeonEvents.ts:51-53), so an
	 * entry added at runtime takes effect on the next event, with no cache to bust.
	 *
	 * ⚠️ CALL THIS AFTER restorePlayer, AND EVERY TIME. Measured 2026-08-24: KDEventMapGeneric and
	 * KDCancelEvents are both captured as per-player bundle state, so a swap REPLACES them and takes
	 * the registration with it. The registration is therefore not a one-off — it has to be re-asserted
	 * inside each player's swap window, which is exactly where _pushPartyGate calls it.
	 *
	 * That is also why the "already installed?" sentinel lives on the guarded registry itself and not
	 * on globalThis. A globalThis sentinel SURVIVES the swap that wipes the registry, so it reports
	 * "installed" about an object that no longer has the handler — the gate then never fires again and
	 * nothing says so. (That was the first version of this method, and it failed exactly this way.)
	 *
	 * THREE DELIBERATE ABSTENTIONS, each of which would otherwise make us the author of a game rule:
	 *   - data.force is never gated. It is the game's own flag for "this transition is not the
	 *     player's choice" — a leash-drag (KinkyDungeonEnemies.ts:5117) or the jail flow — and the
	 *     stock JourneyChoice cancel abstains on it too (KinkyDungeonTiles.ts:6). Gating it would
	 *     make a player un-jailable, which is not ours to decide.
	 *   - An ALREADY-CANCELLED transition is left alone. If the game or a mod has set cancelevent it
	 *     had a reason and it owns the message; overwriting it would swallow that reason.
	 *   - Empty facts disable the gate completely, so a one-player session behaves exactly as before.
	 *
	 * The stair tile is not on the event's data object (KDStairActions.ts:55-79 builds it without
	 * x/y), and it does not need to be: the player-initiated path is
	 * KinkyDungeonHandleStairs -> KDGoThruTile(KDPlayer().x, KDPlayer().y, ...) (KDStairActions.ts:289),
	 * i.e. the stairs are wherever the acting player is standing. The forced path is the only one that
	 * passes some other tile, and that one is abstained from above.
	 *
	 * @param {{peers?: Array<{x:number,y:number,name:string}>, down?: string[], radius?: number,
	 *          waitText?: string, downText?: string}} facts  the party facts, which only the session
	 *          knows. Pass no peers to disable.
	 */
	setPartyGate(facts) {
		const f = facts || {};
		const peers = (Array.isArray(f.peers) ? f.peers : [])
			.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
			.map((p) => ({ x: p.x | 0, y: p.y | 0, name: String(p.name || '') }));
		// The refusal wording is composed HERE and passed in, so the eval'd handler carries no text of
		// its own — the same division as _announceFloorChange, which is likewise the proxy speaking in
		// its own voice about a session-level fact rather than repeating game content.
		const state = {
			peers,
			down: (Array.isArray(f.down) ? f.down : []).map((n) => String(n)),
			// The session owns the radius (swap-session.js PARTY_GATE_RADIUS). The 1 here is only the
			// answer to a caller who supplied none, so the two cannot drift into two different rules.
			radius: Number.isFinite(f.radius) ? Math.max(0, f.radius | 0) : 1,
			waitText: String(f.waitText || 'Waiting for {name} to reach the stairs.'),
			downText: String(f.downText || '{name} is down — the party cannot leave yet.'),
		};
		// TWO payloads, on purpose. The installer's source text never varies, so V8's eval compilation
		// cache serves it for free on every apply; only the tiny state assignment carries per-call data
		// (measured elsewhere in this layer: interpolating into a large hot eval costs ~8.7x).
		this.eval(`globalThis.__KD_PARTY_GATE = ${JSON.stringify(state)};`);
		return this.eval(`(function(){
			if (typeof KDEventMapGeneric === 'undefined' || !KDEventMapGeneric) return false;
			if (typeof KDCancelEvents === 'undefined' || !KDCancelEvents) return false;
			// Already registered on THIS copy of the registries? Then there is nothing to do. The
			// sentinel deliberately lives on the guarded object rather than on globalThis — see the
			// note above setPartyGate on why a globalThis sentinel is silently wrong here.
			if (KDEventMapGeneric.beforeStairCancel
				&& KDEventMapGeneric.beforeStairCancel.MPPartyGate
				&& KDCancelEvents.MPPartyGate) return true;
			KDCancelEvents.MPPartyGate = function(_x, _y, _tile, _data){
				var msg = globalThis.__KD_PARTY_GATE_MSG || '';
				if (msg && typeof KinkyDungeonSendTextMessage === 'function')
					KinkyDungeonSendTextMessage(10, msg, '#ffcc66', 2);
			};
			if (!KDEventMapGeneric.beforeStairCancel) KDEventMapGeneric.beforeStairCancel = {};
			KDEventMapGeneric.beforeStairCancel.MPPartyGate = function(_e, data){
				var g = globalThis.__KD_PARTY_GATE;
				if (!g || !data) return;
				if (data.force) return;                    // not the party's choice, not the party's rule
				if (data.cancelevent) return;              // somebody already refused, and owns the why
				if (!g.peers || !g.peers.length) return;   // nobody to wait for: solo behaviour, untouched
				var p = (typeof KinkyDungeonPlayerEntity !== 'undefined') ? KinkyDungeonPlayerEntity : null;
				if (!p) return;
				for (var i = 0; i < g.peers.length; i++) {
					var peer = g.peers[i];
					var why = null;
					if (g.down.indexOf(peer.name) >= 0) why = g.downText;
					else if (Math.max(Math.abs(peer.x - p.x), Math.abs(peer.y - p.y)) > g.radius) why = g.waitText;
					if (why) {
						globalThis.__KD_PARTY_GATE_MSG = why.split('{name}').join(peer.name);
						globalThis.__KD_PARTY_GATE_HITS = (globalThis.__KD_PARTY_GATE_HITS || 0) + 1;
						data.cancelevent = 'MPPartyGate';
						return;
					}
				}
			};
			return true;
		})()`);
	}

	/** Take-once count of stair transitions the party gate refused (never a silent drop). */
	takePartyGateHits() {
		return this.eval(`(function(){
			var n = globalThis.__KD_PARTY_GATE_HITS || 0;
			globalThis.__KD_PARTY_GATE_HITS = 0;
			return n;
		})()`);
	}

	/**
	 * WHICH MAP the party is on, in the game's own vocabulary.
	 *
	 * The level number alone is not the map, which is exactly what made a party-wide relocation
	 * invisible: a capture regenerates the map at an UNCHANGED level (KinkyDungeonDefeat ->
	 * KinkyDungeonCreateMap, KinkyDungeonJail.ts:1725), and a side room is likewise a different map at
	 * the same level. This is the same tuple the jail code itself uses to name a map
	 * (KDGetNearestExitTo(currentMapData.RoomType, currentMapData.mapX, currentMapData.mapY, ...)).
	 */
	mapId() {
		return this.eval(`(function(){
			var lvl = (typeof MiniGameKinkyDungeonLevel !== 'undefined') ? MiniGameKinkyDungeonLevel : -1;
			var room = (typeof KDGameData !== 'undefined' && KDGameData) ? (KDGameData.RoomType || '') : '';
			var mx = (typeof KDMapData !== 'undefined' && KDMapData) ? KDMapData.mapX : undefined;
			var my = (typeof KDMapData !== 'undefined' && KDMapData) ? KDMapData.mapY : undefined;
			return [lvl, room, mx, my].join('|');
		})()`);
	}

	/**
	 * Where the party should be standing on the map it has just arrived on.
	 *
	 * KD has already placed whoever triggered the transition, and that tile is the truth about "where
	 * the party landed" — preferred over StartPosition, which is the map's nominal entrance and is NOT
	 * where a jail relocation puts you (KinkyDungeonJail.ts:1746 moves the player to an exit instead).
	 * Everyone else gets a free neighbouring tile, so two players never land on one tile.
	 *
	 * @param {number} count how many distinct tiles are needed
	 */
	landingTiles(count) {
		return this.eval(`(function(){
			var n = ${count | 0};
			var p = (typeof KinkyDungeonPlayerEntity !== 'undefined') ? KinkyDungeonPlayerEntity : null;
			var ox = p ? p.x : (KDMapData.StartPosition ? KDMapData.StartPosition.x : 1);
			var oy = p ? p.y : (KDMapData.StartPosition ? KDMapData.StartPosition.y : 1);
			// The anchor is only trustworthy while the swapped-in player really is standing on the new
			// map. When a map change is noticed a turn late, the player in the slot was restored from a
			// bundle holding an OLD-map coordinate — the very defect this method exists to repair — so
			// anchoring on it would land the whole party in a wall. Fall back to the map's own entrance.
			var okOrigin = (typeof KinkyDungeonMapGet === 'function'
				&& typeof KinkyDungeonMovableTilesEnemy === 'string')
				? KinkyDungeonMovableTilesEnemy.indexOf(KinkyDungeonMapGet(ox, oy)) >= 0
				: true;
			if (!okOrigin && KDMapData.StartPosition) {
				ox = KDMapData.StartPosition.x; oy = KDMapData.StartPosition.y;
			}
			var out = [{ x: ox, y: oy }];
			var taken = {}; taken[ox + ',' + oy] = true;
			// Widening rings around the landing tile. Bounded on purpose: a fixed four-ring spiral,
			// never a map-wide search, so a cramped or malformed map cannot turn this into a scan.
			for (var r = 1; r <= 4 && out.length < n; r++) {
				for (var dx = -r; dx <= r && out.length < n; dx++) {
					for (var dy = -r; dy <= r && out.length < n; dy++) {
						if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
						var x = ox + dx, y = oy + dy, k = x + ',' + y;
						if (taken[k]) continue;
						// MovableTilesEnemy, not MovableTiles: the latter is the INTERACTABLE alias
						// (chests, doors, orbs), which are not tiles anybody can stand on.
						var t = (typeof KinkyDungeonMapGet === 'function') ? KinkyDungeonMapGet(x, y) : '';
						if (typeof KinkyDungeonMovableTilesEnemy === 'string'
							&& KinkyDungeonMovableTilesEnemy.indexOf(t) < 0) continue;
						if (typeof KinkyDungeonEntityAt === 'function' && KinkyDungeonEntityAt(x, y)) continue;
						taken[k] = true;
						out.push({ x: x, y: y });
					}
				}
			}
			// Fewer free tiles than players is possible on a cramped map. Stacking on the landing tile
			// is a worse outcome than spreading, and a far better one than being left on the old map.
			while (out.length < n) out.push({ x: ox, y: oy });
			return out;
		})()`);
	}

	/** Take-once count of bump-attacks vetoed since the last read (never a silent drop). */
	takeBumpVetoes() {
		return this.eval(`(function(){
			var n = globalThis.__KD_BUMP_VETO_HITS || 0;
			globalThis.__KD_BUMP_VETO_HITS = 0;
			return n;
		})()`);
	}

	/**
	 * Take-once drain of the variant names a managed prune WITHHELD.
	 *
	 * The wrap (`kd-variant-registry.js`) runs stock KD's prune, records what it deleted here, and puts
	 * it all back; this is how those names reach Node, which is the only side that can see the other
	 * seats. Destructive on purpose, exactly like `takeBumpVetoes` above: a name handed over once has
	 * been decided, and re-offering it would make every sweep re-litigate the whole run.
	 *
	 * Returns the three-kind shape even on an unmanaged world, so callers never branch on absence.
	 */
	takeVariantPending() {
		return this.eval(`(function(){
			var p = globalThis.__kdCoopVariantPending || {};
			globalThis.__kdCoopVariantPending = { restraint: [], weapon: [], consumable: [] };
			return {
				restraint:  Array.isArray(p.restraint)  ? p.restraint  : [],
				weapon:     Array.isArray(p.weapon)     ? p.weapon     : [],
				consumable: Array.isArray(p.consumable) ? p.consumable : [],
			};
		})()`);
	}

	/**
	 * Carry out the deletions Node decided were safe (`decideVariantSweep`).
	 *
	 * Deliberately does NOT re-check reachability: stock KD already proposed every one of these, and a
	 * second opinion computed by us would be exactly the re-implementation of KD's inventory walk the
	 * design refuses. This only executes a verdict.
	 *
	 * Counts what it took into `__kdCoopVariantSwept` so "the sweep is live" is observable — without
	 * it, a sweep silently reduced to a no-op looks identical to the never-prune debt it replaced.
	 *
	 * @param {{restraint?:string[], weapon?:string[], consumable?:string[]}} sweep
	 * @returns {number} how many entries were actually removed
	 */
	deleteVariants(sweep) {
		const s = sweep || {};
		const payload = {
			restraint: (Array.isArray(s.restraint) ? s.restraint : []).map(String),
			weapon: (Array.isArray(s.weapon) ? s.weapon : []).map(String),
			consumable: (Array.isArray(s.consumable) ? s.consumable : []).map(String),
		};
		if (!payload.restraint.length && !payload.weapon.length && !payload.consumable.length) return 0;
		// TWO payloads, the split this layer uses everywhere (see setPartyGate): the handler's source
		// text never varies so V8's eval compilation cache serves it free, and only the tiny state
		// assignment carries per-call data. Interpolating into the hot payload costs ~8.7x here.
		this.eval(`globalThis.__KD_VARIANT_SWEEP = ${JSON.stringify(payload)};`);
		return this.eval(`(function(){
			var s = globalThis.__KD_VARIANT_SWEEP; if (!s) return 0;
			var n = 0;
			// Through KD's OWN removers, not a bare delete: they are the game's definition of "remove a
			// variant", and if upstream ever gives them a second responsibility we inherit it for free.
			var byKind = {
				restraint:  (typeof KDRemoveInventoryVariant  === 'function') ? KDRemoveInventoryVariant  : null,
				weapon:     (typeof KDRemoveWeaponVariant     === 'function') ? KDRemoveWeaponVariant     : null,
				consumable: (typeof KDRemoveConsumableVariant === 'function') ? KDRemoveConsumableVariant : null,
			};
			var tbl = {
				restraint:  (typeof KinkyDungeonRestraintVariants  !== 'undefined') ? KinkyDungeonRestraintVariants  : null,
				weapon:     (typeof KinkyDungeonWeaponVariants     !== 'undefined') ? KinkyDungeonWeaponVariants     : null,
				consumable: (typeof KinkyDungeonConsumableVariants !== 'undefined') ? KinkyDungeonConsumableVariants : null,
			};
			var kinds = ['restraint', 'weapon', 'consumable'];
			for (var i = 0; i < kinds.length; i++) {
				var k = kinds[i], names = s[k] || [], rm = byKind[k], t = tbl[k];
				if (!rm || !t) continue;
				for (var j = 0; j < names.length; j++) {
					if (t[names[j]] === undefined) continue;   // already gone: not a deletion
					rm(names[j]);
					n++;
				}
			}
			globalThis.__kdCoopVariantSwept = (globalThis.__kdCoopVariantSwept || 0) + n;
			globalThis.__KD_VARIANT_SWEEP = null;
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
	 * Await the async text provider so real combat messages resolve to real text instead of
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
	 * Make an injected avatar a REAL hostile enemy so the attacker's stock attack pipeline
	 * (KinkyDungeonMove bump → KDDoAttack/KDDamageEnemy, real defeat/capture) targets it. hp tracks the
	 * peer's Will (maxhp = WillMax) so KD's real low-hp helpless/capture thresholds fire near Will 0.
	 */
	/**
	 * @param {boolean} [aggro=true] Also stamp KD's aggro (`hostile = 9999`). The PvP arming
	 * wants it; the per-turn hp restore does not: `hostile` is exactly what the war detector reads as
	 * "an attack happened", so stamping it there declared war on turn 1 of every co-op session.
	 */
	setAvatarEnemy(entityId, hp, maxhp, stun, aggro = true) {
		return this.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.id === ${entityId | 0}; });
			if (!e) return null;
			e.Enemy.maxhp = ${Number(maxhp) || 10};
			e.hp = Math.max(0, ${Number(hp) || 0});
			e.faction = 'Enemy'; e.ce = undefined; e.player = undefined;
			if (${aggro ? 1 : 0}) e.hostile = 9999;
			// Stun marks the avatar "disabled" (KinkyDungeonIsStunned) so the game's real
			// KDCanApplyBondage gate lets a SUBDUED peer be tied — the avatar's hp is a per-turn damage
			// gauge (always full) and can't express the victim's subdued state, so we set it explicitly.
			e.stun = Math.max(0, ${Number(stun) || 0});
			KDUpdateEnemyCache = true;
			return { id: e.id, hp: e.hp, maxhp: e.Enemy.maxhp, stun: e.stun, faction: (typeof KDGetFaction==='function')?KDGetFaction(e):e.faction };
		})()`);
	}

	/**
	 * Idempotently register a per-owner "war team" faction string, copying KD's own `'Player'`
	 * faction's full relation row (every monster/faction hostility a real player already has) so a
	 * companion stamped with it keeps fighting the ordinary dungeon exactly as it did as `'Player'`.
	 *
	 * Mirrors into BOTH the live relation Map (`KDFactionRelations`, what `KDFactionRelation()`
	 * actually reads) and the declared tables (`KinkyDungeonFactionRelationsBase`/
	 * `KinkyDungeonFactionRelations`) that `KDInitFactions()` rebuilds the Map FROM — a faction absent
	 * from `KinkyDungeonFactionRelationsBase` is silently dropped the next time anything calls
	 * `KDInitFactions()` (`KDSetFactionRelation`/`KDChangeFactionRelation` do, on any reputation-
	 * changing event; a fresh game calls it with `Reset=true`).
	 *
	 * Also self-healing against a DIFFERENT, measured risk: `KDFactionRelations` (the Map) is itself
	 * per-player WATCHED state in the generic global-divergence capture (`BASELINE_MAX_LEN`'s own doc
	 * comment names it, ~12 KB, deliberately NOT excluded — a real player's own faction REPUTATION is
	 * legitimately per-player). So a plain `restorePlayer` can revert this table to a DIFFERENT
	 * player's baseline between applies. Never blacklisted for that reason (blacklisting it would
	 * resurrect the exact contamination bug that comment warns against, for reputation drift that has
	 * nothing to do with this feature). Instead this method is called fresh every apply a war round
	 * arms a companion (`SwapSession._armPeerEnemies`), the same "re-assert every apply" pattern this
	 * file already uses for a peer's mirrored bondage/defences — so a mid-round revert heals itself
	 * before the next real dispatch runs. Idempotent and cheap either way.
	 */
	ensureWarFaction(name) {
		return this.eval(`(function(){
			var name = ${JSON.stringify(String(name))};
			var base = KinkyDungeonFactionRelationsBase['Player'] || {};
			if (!KinkyDungeonFactionRelationsBase[name]) KinkyDungeonFactionRelationsBase[name] = Object.assign({}, base);
			if (!KinkyDungeonFactionRelations[name]) KinkyDungeonFactionRelations[name] = Object.assign({}, base);
			if (!KDFactionRelations.get(name)) KDFactionRelations.set(name, new Map());
			var mine = KDFactionRelations.get(name);
			var playerMap = KDFactionRelations.get('Player');
			if (playerMap) {
				playerMap.forEach(function(value, otherFaction){
					mine.set(otherFaction, value);
					var otherMap = KDFactionRelations.get(otherFaction);
					if (otherMap) otherMap.set(name, value);
				});
			}
			return true;
		})()`);
	}

	/**
	 * Set (`value` a number) or clear (`value` null/undefined) the mutual relation between two war-team
	 * factions — both the live Map and the declared tables, same reasoning as `ensureWarFaction`.
	 * Clearing removes the pair entirely (not merely zeroes it), so a peace negotiation leaves no
	 * residual faction-relation entry for either team string, matching "fully reversible".
	 */
	setWarFactionRelation(a, b, value) {
		const clear = value === null || value === undefined;
		return this.eval(`(function(){
			var a = ${JSON.stringify(String(a))}, b = ${JSON.stringify(String(b))};
			${clear ? `
			if (KDFactionRelations.get(a)) KDFactionRelations.get(a).delete(b);
			if (KDFactionRelations.get(b)) KDFactionRelations.get(b).delete(a);
			if (KinkyDungeonFactionRelationsBase[a]) delete KinkyDungeonFactionRelationsBase[a][b];
			if (KinkyDungeonFactionRelationsBase[b]) delete KinkyDungeonFactionRelationsBase[b][a];
			if (KinkyDungeonFactionRelations[a]) delete KinkyDungeonFactionRelations[a][b];
			if (KinkyDungeonFactionRelations[b]) delete KinkyDungeonFactionRelations[b][a];
			` : `
			var v = ${Number(value)};
			if (KDFactionRelations.get(a)) KDFactionRelations.get(a).set(b, v);
			if (KDFactionRelations.get(b)) KDFactionRelations.get(b).set(a, v);
			if (KinkyDungeonFactionRelationsBase[a]) KinkyDungeonFactionRelationsBase[a][b] = v;
			if (KinkyDungeonFactionRelationsBase[b]) KinkyDungeonFactionRelationsBase[b][a] = v;
			if (KinkyDungeonFactionRelations[a]) KinkyDungeonFactionRelations[a][b] = v;
			if (KinkyDungeonFactionRelations[b]) KinkyDungeonFactionRelations[b][a] = v;
			`}
			return true;
		})()`);
	}

	/**
	 * Stamp (`name` a string) or clear (`name` null/undefined, falling back to the def's own default —
	 * `'Player'` for a party member, via `KDGetFaction`'s `KDIsInParty` check) an entity's own faction
	 * string directly.
	 *
	 * Deliberately NO `hostile`/`rage`/`ceasefire` side effect (unlike `setAvatarHostile`/
	 * `KDMakeHostile`): a companion's cross-player hostility must come ONLY from the faction-relation
	 * table, never from the instance `hostile` flag. MEASURED why: `KinkyDungeonAggressive`'s "Player
	 * mode" branch (`KinkyDungeonFactions.ts`, taken whenever the candidate IS the literal real human in
	 * the slot) reads `enemy.hostile > 0` alone, with NO faction check at all — so a companion with
	 * `hostile` set would read as aggressive toward ANY human in the slot, including its own owner,
	 * regardless of which custom faction it carries. Reproduced in
	 * `mp-companion-teams.spec.ts` > "war owner-safety" before this fix (a companion armed via
	 * `setAvatarHostile(id,true)`/`KDMakeHostile` hurt its own owner's real Will).
	 *
	 * ALSO maintains `__kdCompanionWarFaction` (`{entityId: factionName}`), the registry
	 * `installCompanionFactionGuard`'s hook reads to self-heal a DIFFERENT, measured engine behaviour:
	 * `KinkyDungeonAdvanceTime` replaces `KDGameData.Party`'s entries with LIVE entity references on
	 * EVERY real tick (`KinkyDungeonGame.ts` ~3500-3507, `KDGameData.Party = neww` built from
	 * `KDGetGlobalEntity`), and `KinkyDungeonUpdateEnemies`'s own very first statement then does, for
	 * every one of those (now-live) party members with no `hostile` countdown: `if (en.faction !=
	 * "Player") en.faction = "Player"`. That is unconditional and runs on the LIVE entity — MEASURED
	 * directly (`mp-companion-teams.spec.ts`'s own bisection): a plain `faction` stamp with `hostile`
	 * left at 0 (required for owner safety, above) is silently reverted to `'Player'` by the very next
	 * real tick, before the per-enemy decision loop in the SAME call ever reads it.
	 */
	setEntityFaction(entityId, name) {
		return this.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.id === ${entityId | 0}; });
			if (!e) return null;
			var reg = globalThis.__kdCompanionWarFaction || (globalThis.__kdCompanionWarFaction = {});
			${name ? `
			e.faction = ${JSON.stringify(String(name))};
			reg[${entityId | 0}] = ${JSON.stringify(String(name))};
			` : `
			delete e.faction;
			delete reg[${entityId | 0}];
			`}
			KDUpdateEnemyCache = true;
			return { id: e.id, faction: (typeof KDGetFaction === 'function') ? KDGetFaction(e) : e.faction };
		})()`);
	}

	/**
	 * Idempotent, sentinel-gated (same style as `installTurnModel`): wraps `KDUpdatePersistentNPC`, the
	 * ONE function `KinkyDungeonUpdateEnemies`'s own party-faction-reset statement calls right after it
	 * writes `en.faction = "Player"` onto a live party member — see `setEntityFaction`'s own doc comment
	 * for the full chain of measured behaviour this works around. Re-applying the intended faction
	 * SYNCHRONOUSLY, inside this same call, restores it before the per-enemy decision loop (later in the
	 * same `KinkyDungeonUpdateEnemies` pass) ever reads the reverted value — no timing window, because
	 * nothing yields between the reset statement and this hook.
	 *
	 * Scoped to `__kdCompanionWarFaction` only — any OTHER call to `KDUpdatePersistentNPC` (there are
	 * several, for unrelated persistent-NPC bookkeeping) passes through untouched, including for a
	 * companion that ISN'T currently war-factioned.
	 */
	installCompanionFactionGuard() {
		this.eval(`(function(){
			if (globalThis.__kdCompanionFactionGuardInstalled) return;
			globalThis.__kdCompanionFactionGuardInstalled = true;
			globalThis.__kdCompanionWarFaction = globalThis.__kdCompanionWarFaction || {};
			var _upn = KDUpdatePersistentNPC;
			KDUpdatePersistentNPC = function(id, force){
				var r = _upn.apply(this, arguments);
				var want = (globalThis.__kdCompanionWarFaction || {})[id];
				if (want) {
					var e = KDGetGlobalEntity(id);
					if (e) e.faction = want;
				}
				return r;
			};
		})()`);
	}

	/**
	 * Install the one-engine-tick-per-round turn model's engine hooks — cooperative wraps, same style
	 * as `_installServerRoleShim` (reassign a named global to a wrapper that calls the previous value
	 * first, sentinel-gated on the wrapper function itself so a second call is a no-op). Idempotent;
	 * call once per world (`SwapSession._start`).
	 *
	 * REPLACES the earlier two-phase stun-gate mechanism (`gateEnemiesExcept`/`ungateEnemies`/
	 * `stepEnemiesOnly`) entirely — nothing is stunned, frozen or skipped, no turn is split in two.
	 * Every player's own dispatch still runs KD's real, unmodified per-player pipeline exactly once;
	 * what these hooks add is two independent knobs the caller arms around exactly ONE dispatch per
	 * round (see `setWorldMuted`/`armSlotSwitch` below and `SwapSession._advanceTurn`):
	 *
	 *   1. WORLD MUTE — every world-shared system in `WORLD_MUTE_FNS` becomes a no-op while muted, and the
	 *      world clock's INLINE increment (`KinkyDungeonAdvanceTime` cannot be muted by wrapping it —
	 *      the clock write is a bare statement inside the function body) is handed back by the
	 *      `KinkyDungeonAdvanceTime` wrapper itself. The round's LAST apply runs unmuted, so the world
	 *      (enemies, bullets, effect tiles, jail keys, commander update, the map tick, the clock)
	 *      advances exactly once per round, regardless of player count — every other apply still runs
	 *      the player's own per-turn work (item checks, stats, …) untouched, since none of that is in
	 *      `WORLD_MUTE_FNS`.
	 *   2. SLOT SWITCH — armed only around the round's one unmuted `KinkyDungeonUpdateEnemies` call(s).
	 *      Before each real enemy decides its target (`KinkyDungeonNearestPlayer`'s 5-argument caller —
	 *      Loop 2's own per-enemy AI step; the only other caller passes one argument), the engine asks
	 *      the host-supplied choice (sticky target, else nearest by live position — `SwapSession`
	 *      computes neither; it only hands in the sticky map, "nearest" is resolved here because it
	 *      needs the LIVE slot position, not a position captured before the apply started) which human
	 *      that enemy should face, and if it is not whoever currently holds the slot, calls back into
	 *      the host (`setSlotSwapCallback`, synchronous) to swap them in. Entities are regrouped
	 *      (stable sort by chosen human) before each pass so the cost is at most one swap out + one
	 *      back per OTHER human per pass, not one per enemy (an approved cost trade-off). The slot is handed back to the apply's OWN player before
	 *      `KinkyDungeonUpdateEnemies` returns, so the dispatch's post-enemy tail (stats, tile, delayed
	 *      actions) still runs for the player who owns this apply — the accepted "one-round-delayed"
	 *      phase shift for whoever an enemy faced instead (accepted for this version).
	 *
	 * `WORLD_MUTE_FNS` (module scope, above this class) is DERIVED from `turn-classification.js` — the
	 * declared, audited (`tests/unit/mp-turn-world-player-audit.spec.ts`) table of every direct callee
	 * `KinkyDungeonAdvanceTime`/`KinkyDungeonUpdateEnemies` actually has — not a second, independently
	 * hand-kept list that could silently disagree with it; see its own doc comment for which outer
	 * systems are even candidates and why a `mixed` verdict excludes one rather than muting it anyway.
	 * Also deliberately NOT muted (left ticking once per PLAYER-PHASE apply, same as before this
	 * change, per that table's own `mixed` verdicts): `KinkyDungeonSendEnemyEvent`/
	 * `KinkyDungeonSendBulletEvent` (mixed player/world event fan-out) and anything bullet-targeting-
	 * specific (owner-tag + per-avatar collision switch + AOE fan-out). Both are recorded follow-ups,
	 * not silently dropped.
	 *
	 * ORDERING: `HeadlessHost.boot()` already reassigns `KinkyDungeonUpdateEnemies` once, permanently
	 * (`_installServerRoleShim`'s server/player/world role gate, unrelated to the turn model) — this
	 * method always runs AFTER `boot()` (`SwapSession._start`), so `_ue` below captures that
	 * already-shimmed function and wraps OUTSIDE it: this wrap's own logic (grouping, the switch) runs
	 * first, then falls through to the role gate, then to the real engine function. Calling this
	 * before `boot()` would capture nothing (the global would not exist yet); calling it twice is a
	 * no-op (the top-level sentinel).
	 */
	installTurnModel() {
		this.eval(`(function(){
			if (globalThis.__kdTurnModelInstalled) return true;
			globalThis.__kdTurnModelInstalled = true;
			globalThis.__kdWorldMuted = false;     // mute WORLD_FNS for the next KinkyDungeonAdvanceTime call
			globalThis.__kdInTick = 0;             // AdvanceTime re-entrancy depth — nested ticks recurse one level per remaining non-last player
			globalThis.__kdRoundRealTickDelta = 0; // how much the round's one real tick has advanced the clock so far (nested ticks)
			globalThis.__kdNestedDispatch = null;  // one-shot callback: dispatch the NEXT player's apply from inside this one (nested ticks)
			globalThis.__kdSlotSwitch = false;     // arm the per-enemy slot switch for the next UpdateEnemies call(s)
			globalThis.__kdSlotHost = null;        // clientId this apply belongs to (hand-back target)
			globalThis.__kdSlotCurrent = null;     // clientId currently holding the slot
			globalThis.__kdSlotHumans = [];        // [{cid, avatarId}], this round's roster
			globalThis.__kdSlotAvatarIds = [];      // avatar entity ids — never themselves assigned a target
			globalThis.__kdStickyTarget = {};      // enemy id -> clientId, host-supplied persisted target
			globalThis.__kdSlotChoiceLog = {};      // enemy id -> clientId, this call's decision (host reads back)
			globalThis.__kdBulletOwner = {};       // bullet spriteID -> clientId, who cast it (tagOwnedBullets)
			globalThis.__kdTetherOwner = {};       // leashed enemy id -> clientId, who caused the tether (tagOwnedTethers)
			globalThis.__kdPendingNoiseSources = []; // [{x,y,sound}] this harvest's noise origins (KDEnemyAddSound wrap)

			var WORLD_FNS = ${JSON.stringify(WORLD_MUTE_FNS)};
			WORLD_FNS.forEach(function(name){
				var prev = eval(name);
				if (prev.__kdTurnModelWrapped) return;
				var wrapped = function(){
					if (globalThis.__kdWorldMuted && globalThis.__kdInTick > 0) return undefined;
					return prev.apply(this, arguments);
				};
				wrapped.__kdTurnModelWrapped = true;
				eval(name + ' = wrapped;');
			});

			var _adv = KinkyDungeonAdvanceTime;
			if (!_adv.__kdTurnModelWrapped) {
				var advWrapped = function(){
					var t0 = KinkyDungeonCurrentTick;
					var mutedAtEntry = globalThis.__kdWorldMuted;
					globalThis.__kdInTick++;
					try { return _adv.apply(this, arguments); }
					finally {
						globalThis.__kdInTick--;
						// The clock increment is INLINE in KinkyDungeonAdvanceTime, so no wrapper can mute
						// it directly: a muted apply hands back its OWN increment instead.
						//
						// NESTED TICKS make this two-layered: a muted apply's nested-dispatch hook (the
						// KinkyDungeonUpdateEnemies wrap, below) can recurse into further players before
						// this call's own increment runs — and the round's one real (unmuted) tick, however
						// deep it is nested, genuinely advances the clock for real. Resetting flatly to t0
						// would erase that real advance too, not just this level's own fake one. Instead,
						// the real (unmuted) call records how much it actually advanced into
						// __kdRoundRealTickDelta (accumulated across the whole round, reset once per round
						// by _advanceTurn), and every muted level restores to "my own entry tick PLUS
						// whatever the round's real tick has advanced so far" — correct regardless of
						// nesting depth, since every muted level in one round's chain is entered before the
						// real tick fires (same world-start tick value).
						if (mutedAtEntry) {
							KinkyDungeonCurrentTick = t0 + (globalThis.__kdRoundRealTickDelta || 0);
						} else {
							globalThis.__kdRoundRealTickDelta =
								(globalThis.__kdRoundRealTickDelta || 0) + (KinkyDungeonCurrentTick - t0);
						}
					}
				};
				advWrapped.__kdTurnModelWrapped = true;
				KinkyDungeonAdvanceTime = advWrapped;
			}

			// Per-ENTITY world systems: an NPC's buff decay / tether is world-shared; a human's is not —
			// muting the whole function would also silence the apply's OWN player, so these two split by
			// entity instead of joining WORLD_FNS above.
			var _tickBuffs = KinkyDungeonTickBuffs;
			if (!_tickBuffs.__kdTurnModelWrapped) {
				var tickBuffsWrapped = function(entity){
					var npc = entity && entity !== KinkyDungeonPlayerEntity && !entity.player;
					if (npc && globalThis.__kdWorldMuted && globalThis.__kdInTick > 0) return undefined;
					return _tickBuffs.apply(this, arguments);
				};
				tickBuffsWrapped.__kdTurnModelWrapped = true;
				KinkyDungeonTickBuffs = tickBuffsWrapped;
			}
			// An enemy's leash targets the generic -1 "the player" marker (KDTethers.ts:203-210) —
			// KDLookupID(-1) always resolves to whoever currently holds the slot, not necessarily the
			// human that actually got leashed. Once this call is routed to once-per-round (the mute
			// below), that one real call must also be routed to the leash's OWN owner
			// (__kdTetherOwner, tagged by tagOwnedTethers) — the same owner-tag + swap-and-back
			// shape as the bullet owner-tag mechanism above, not a reimplementation of the tether math.
			var _tether = KinkyDungeonUpdateTether;
			if (!_tether.__kdTurnModelWrapped) {
				var tetherWrapped = function(delta, msg, entity){
					var npc = entity && entity !== KinkyDungeonPlayerEntity && !entity.player;
					if (npc && globalThis.__kdWorldMuted && globalThis.__kdInTick > 0) return false;
					if (npc && globalThis.__kdSlotSwitch && entity.leash && entity.leash.entity === -1) {
						var owners = globalThis.__kdTetherOwner || {};
						var ownerCid = owners[entity.id];
						var current = globalThis.__kdSlotCurrent;
						if (ownerCid != null && ownerCid !== current) {
							globalThis.__kdSlotSwapTo(ownerCid);
							var r = _tether.apply(this, arguments);
							globalThis.__kdSlotSwapTo(current);
							return r;
						}
					}
					return _tether.apply(this, arguments);
				};
				tetherWrapped.__kdTurnModelWrapped = true;
				KinkyDungeonUpdateTether = tetherWrapped;
			}

			// tagOwnedTethers (below, called every apply from SwapSession._advanceTurn) tags a new
			// leash "first touch, owned by whoever is applying" — correct for every leash created
			// through a human's OWN input dispatch, since KinkyDungeonPlayerEntity is them for the
			// whole apply in that case. It is WRONG for a leash an enemy attaches to a SWITCHED-IN,
			// non-applying human: the per-enemy slot switch (KinkyDungeonNearestPlayer's wrap, below)
			// can swap the slot to any joined human mid-pass, entirely inside the round's one real
			// apply, and a successful grab/tease attack against THAT human can attach a tether right
			// there -- by the time the whole apply returns and tagOwnedTethers runs, there is no record
			// left that the leash was ever anchored to anyone but whoever is applying. Found and proved
			// with a test (not guessed): a leash attached while B held the slot, with A hosting the
			// round, was mis-tagged owned by A. Fixed by tagging at CREATION time instead, from the
			// LIVE slot identity (__kdSlotCurrent is exactly who KinkyDungeonPlayerEntity resolves to
			// at this exact call) rather than from the apply's own client id. Guarded on
			// __kdSlotSwitch: outside an armed slot switch (a muted apply, a 1-player session, or no
			// switch yet armed this round) the acting player IS the only human any leash here could
			// ever anchor to, so tagOwnedTethers' own per-apply sweep already handles that case
			// correctly and this wrap intentionally does nothing extra. tagOwnedTethers' own
			// "only if not yet owned" check means whichever of the two tags this leash first always
			// wins, and creation-time (synchronous, inside the apply) always runs before the sweep
			// (called by SwapSession after the whole apply returns).
			var _attachTether = KinkyDungeonAttachTetherToEntity;
			if (!_attachTether.__kdTurnModelWrapped) {
				var attachTetherWrapped = function(dist, entity, player){
					var r = _attachTether.apply(this, arguments);
					if (globalThis.__kdSlotSwitch && r && player && !player.player && entity === KinkyDungeonPlayerEntity) {
						var owners = globalThis.__kdTetherOwner || (globalThis.__kdTetherOwner = {});
						owners[player.id] = globalThis.__kdSlotCurrent;
					}
					return r;
				};
				attachTetherWrapped.__kdTurnModelWrapped = true;
				KinkyDungeonAttachTetherToEntity = attachTetherWrapped;
			}

			// NOISE IS WORLD PRESENTATION, NOT PER-SLOT-OCCUPANT STATE. KDEnemyAddSound
			// (KinkyDungeonEnemies.ts) decides whether to queue a shockwave/sounddesc by checking ONE
			// listener -- whoever currently holds the slot (KinkyDungeonPlayerEntity) -- against
			// KDCanHearSound. In single-player that is the only human there is, so it is correct by
			// construction; in co-op it is only ONE of possibly several humans who would genuinely
			// perceive the same ambient sound. SwapSession._harvestNoise (swap-session.js) needs to
			// re-offer the SAME decision to every OTHER joined human from THEIR OWN position, using
			// KD's own hearing rule -- but it cannot re-derive the sound amount KDCanHearSound was fed
			// (enemy.sound) from the already-baked vol/radius the queued entry carries, and
			// re-deriving it would mean copying the engine's own math a second time. So this wrap
			// records the one fact the harvest actually needs -- {x, y, sound} -- from the SAME call
			// that queued the entry, by reading enemy.sound straight back AFTER _prev sets it
			// (KDEnemyAddSound's own enemy.sound = Math.max(data.base, data.amount)), never
			// duplicating the hearing/visibility logic itself. One array, drained once per harvest by
			// HeadlessHost.takeNoiseSources below, the same shape as takeNoisePresentation's own drain.
			var _kdEas = KDEnemyAddSound;
			if (!_kdEas.__kdTurnModelWrapped) {
				var kdEasWrapped = function(enemy){
					var r = _kdEas.apply(this, arguments);
					if (enemy) {
						var list = globalThis.__kdPendingNoiseSources || (globalThis.__kdPendingNoiseSources = []);
						list.push({ x: enemy.x, y: enemy.y, sound: enemy.sound || 0 });
					}
					return r;
				};
				kdEasWrapped.__kdTurnModelWrapped = true;
				KDEnemyAddSound = kdEasWrapped;
			}

			// SPLIT functions (turn-classification.js verdict 'split'): each does a step for the
			// ACTING player alongside a world-wide loop under one name. Wholesale-muting them (like
			// WORLD_FNS above) would silently drop the non-host player's own per-turn step; leaving
			// them unwrapped would run the world-wide loop once per PLAYER-PHASE apply instead of once
			// per round. Each gets its own wrap: the world-wide work is skipped while muted, and the
			// acting player's own step is replicated every apply by calling KD's own smaller
			// functions directly — the same ones the engine itself calls for that step, never a copy
			// of their logic.
			var _kdUet = KDUpdateEffectTiles;
			if (!_kdUet.__kdTurnModelWrapped) {
				var kdUetWrapped = function(delta){
					if (globalThis.__kdWorldMuted && globalThis.__kdInTick > 0) {
						// Replicate only the acting-player-at-position step (KinkyDungeonTiles.ts:517-518).
						var tiles = KDGetEffectTiles(KinkyDungeonPlayerEntity.x, KinkyDungeonPlayerEntity.y);
						for (var k in tiles) { if (tiles[k]) KinkyDungeonUpdateSingleEffectTile(delta, KinkyDungeonPlayerEntity, tiles[k]); }
						return undefined;
					}
					return _kdUet.apply(this, arguments);
				};
				kdUetWrapped.__kdTurnModelWrapped = true;
				KDUpdateEffectTiles = kdUetWrapped;
			}
			var _kUte = KinkyDungeonUpdateTileEffects;
			if (!_kUte.__kdTurnModelWrapped) {
				var kUteWrapped = function(delta){
					if (globalThis.__kdWorldMuted && globalThis.__kdInTick > 0) {
						// Replicate only the acting-player-under-foot step (KinkyDungeonTiles.ts:90-95).
						var tile = KinkyDungeonMapGet(KinkyDungeonPlayerEntity.x, KinkyDungeonPlayerEntity.y);
						if (!(KDTileUpdateFunctions[tile] && KDTileUpdateFunctions[tile](delta))) {
							KDPeripheralTileEffects(delta);
						}
						return undefined;
					}
					return _kUte.apply(this, arguments);
				};
				kUteWrapped.__kdTurnModelWrapped = true;
				KinkyDungeonUpdateTileEffects = kUteWrapped;
			}

			// Bullets. Physics (movement/lifetime/collision resolution) is world-shared and must run
			// once per round — muted wholesale on every apply but the round's one real tick, same as
			// WORLD_FNS. Two residual player-targeting gaps this closes without touching Game/src:
			//   - a followPlayer bullet OWNED by a non-slot human (tagged by tagOwnedBullets, below)
			//     is snapped to the SLOT occupant by the engine (KinkyDungeonFight.ts:1864/:1898) —
			//     corrected here, after the real call, to its own owner's live avatar position.
			//   - the AOE player-effect test only ever reaches the slot occupant — closed by the
			//     KinkyDungeonPlayerEffect wrap further below, not here.
			var _kUb = KinkyDungeonUpdateBullets;
			if (!_kUb.__kdTurnModelWrapped) {
				var kUbWrapped = function(delta, Allied){
					if (globalThis.__kdWorldMuted && globalThis.__kdInTick > 0) return undefined;
					var r = _kUb.apply(this, arguments);
					if (globalThis.__kdSlotSwitch) {
						var humans = globalThis.__kdSlotHumans || [];
						var owners = globalThis.__kdBulletOwner || {};
						var keep = {};
						for (var bi = 0; bi < KDMapData.Bullets.length; bi++) {
							var b = KDMapData.Bullets[bi];
							var ownerCid = owners[b.spriteID];
							if (ownerCid != null) keep[b.spriteID] = ownerCid;
							if (b.bullet && b.bullet.followPlayer && ownerCid != null && ownerCid !== globalThis.__kdSlotCurrent) {
								var owner = null;
								for (var hi = 0; hi < humans.length; hi++) { if (humans[hi].cid === ownerCid) { owner = humans[hi]; break; } }
								var av = owner && KDMapData.Entities.find(function(en){ return en.id === owner.avatarId; });
								if (av) { b.x = av.x; b.y = av.y; }
							}
						}
						globalThis.__kdBulletOwner = keep; // prune entries for bullets that no longer exist
					}
					return r;
				};
				kUbWrapped.__kdTurnModelWrapped = true;
				KinkyDungeonUpdateBullets = kUbWrapped;
			}
			var _kUbc = KinkyDungeonUpdateBulletsCollisions;
			if (!_kUbc.__kdTurnModelWrapped) {
				var kUbcWrapped = function(){
					if (globalThis.__kdWorldMuted && globalThis.__kdInTick > 0) return undefined;
					return _kUbc.apply(this, arguments);
				};
				kUbcWrapped.__kdTurnModelWrapped = true;
				KinkyDungeonUpdateBulletsCollisions = kUbcWrapped;
			}

			// Shared dedup workaround for both the AOE replay below and the direct-hit reroute
			// further down. bulletObj.alreadyHit (KDBulletAlreadyHit, KinkyDungeonStats.ts:545) is a
			// property on the WORLD bullet object (KDMapData.Bullets), not a script global, so no
			// amount of slot-swapping (which only swaps PER-PLAYER globals, via capturePlayer/
			// restorePlayer) can make it per-human -- it keys a human's dedup entry by the LITERAL
			// STRING "player" (entity.player ? "player" : String(entity.id)), never by WHICH human, so
			// the real call for the slot occupant already marks "player" hit on this bullet before any
			// extra per-human call runs -- replaying straight through would see "already hit" and
			// silently no-op for every other human (measured: KinkyDungeonDealDamage returned
			// happened:0 for a swapped-in second human until this was found). Unmark it for the ONE
			// extra call, then put it straight back -- this bullet's own dedup for the NEXT real tick
			// must stay exactly as it already was, this just lets ONE extra human through on THIS tick.
			// This is the one piece of this mechanism that CANNOT be replaced by routing through the
			// slot switch, because it is not per-player state to begin with.
			globalThis.__kdReplayPlayerHit = function(bulletObj, fn){
				var hit = bulletObj && bulletObj.alreadyHit;
				var markIdx = hit ? hit.indexOf('player') : -1;
				if (markIdx >= 0) hit.splice(markIdx, 1);
				try { fn(); }
				finally {
					if (markIdx >= 0 && bulletObj.alreadyHit && bulletObj.alreadyHit.indexOf('player') < 0) {
						bulletObj.alreadyHit.push('player');
					}
				}
			};

			// The AOE player-effect sink (KinkyDungeonPlayerEffect) is always called by its engine
			// call sites with KinkyDungeonPlayerEntity (the slot) as the target (the pinned
			// aoePlayerEffectFanOut text-coupled site, turn-classification.js — KinkyDungeonFight.ts
			// :2434/:2694). After the real call lets the slot occupant's own effect resolve, replay
			// the SAME AOE test (AOECondition + KDBulletAoEMod, the engine's own functions, not a
			// reimplementation) against every OTHER joined human's avatar position, swapping them
			// (the real per-enemy slot switch, __kdSlotSwapTo — not a position-only move) into the
			// slot for exactly one extra call each if in range. KDPlayerHitBy (a hitTag's own dedup
			// array, magic/KinkyDungeonMagic.ts:44) is a plain script GLOBAL, not blacklisted, so this
			// real swap already carries each human their OWN copy via the generic capturePlayer/
			// restorePlayer bundle — no extra handling needed for a hitTag effect to dedupe per human
			// rather than once for the whole round.
			var _kPe = KinkyDungeonPlayerEffect;
			if (!_kPe.__kdTurnModelWrapped) {
				var kPeWrapped = function(target, damage, playerEffect, spell, faction, bulletObj, entityArg){
					var r = _kPe.apply(this, arguments);
					if (globalThis.__kdSlotSwitch && bulletObj && bulletObj.x != null) {
						var aoe = (bulletObj.bullet && bulletObj.bullet.spell && bulletObj.bullet.spell.aoe) || 0.5;
						var mod = KDBulletAoEMod(bulletObj);
						var humans = globalThis.__kdSlotHumans || [];
						var current = globalThis.__kdSlotCurrent;
						for (var i = 0; i < humans.length; i++) {
							var h = humans[i];
							if (h.cid === current) continue;
							var av = KDMapData.Entities.find(function(en){ return en.id === h.avatarId; });
							if (!av) continue;
							if (AOECondition(bulletObj.x, bulletObj.y, av.x, av.y, aoe, mod)) {
								globalThis.__kdSlotSwapTo(h.cid);
								globalThis.__kdReplayPlayerHit(bulletObj, function(){
									_kPe(target, damage, playerEffect, spell, faction, bulletObj, entityArg);
								});
								globalThis.__kdSlotSwapTo(current);
							}
						}
					}
					return r;
				};
				kPeWrapped.__kdTurnModelWrapped = true;
				KinkyDungeonPlayerEffect = kPeWrapped;
			}

			// DIRECT (non-AOE) bullet hits. The engine's own per-round collision pass
			// (KinkyDungeonBulletsCheckCollision, KinkyDungeonFight.ts:3118) always tests the slot
			// occupant through KDBulletHitPlayer (:3134), then separately walks EVERY entity in
			// KDMapData.Entities — including a joined human's AVATAR stand-in — through
			// KDBulletHitEnemy (:3142), which only ever does NPC-style damage (KinkyDungeonDamageEnemy)
			// plus a restraint bind-tag shortcut, never the real player pipeline
			// (KinkyDungeonPlayerEffect) a slot occupant gets. Reroute: when the "enemy" KDBulletHitEnemy
			// was called for is actually one of this round's avatar stand-ins, swap that human into the
			// slot (the same __kdSlotSwapTo mechanism the per-enemy switch and the AOE replay above
			// both use) and let the bullet resolve through the real KDBulletHitPlayer instead — exactly
			// as it would if they already held the slot — rather than reimplementing any part of what a
			// hit does. Needs the same alreadyHit workaround as the AOE case above, for the same reason
			// (it is bullet-object state, not per-player global state).
			var _kdbhe = KDBulletHitEnemy;
			if (!_kdbhe.__kdTurnModelWrapped) {
				var kdbheWrapped = function(bullet, enemy){
					if (globalThis.__kdSlotSwitch && enemy && (globalThis.__kdSlotAvatarIds || []).indexOf(enemy.id) >= 0) {
						var humans = globalThis.__kdSlotHumans || [];
						var owner = null;
						for (var i = 0; i < humans.length; i++) { if (humans[i].avatarId === enemy.id) { owner = humans[i]; break; } }
						if (owner) {
							var current = globalThis.__kdSlotCurrent;
							globalThis.__kdSlotSwapTo(owner.cid);
							globalThis.__kdReplayPlayerHit(bullet, function(){
								KDBulletHitPlayer(bullet, KinkyDungeonPlayerEntity);
							});
							globalThis.__kdSlotSwapTo(current);
							return;
						}
					}
					return _kdbhe.apply(this, arguments);
				};
				kdbheWrapped.__kdTurnModelWrapped = true;
				KDBulletHitEnemy = kdbheWrapped;
			}

			// THE SLOT SWITCH. Resolve each real enemy's human (sticky, else nearest by LIVE position —
			// the apply owner's position is read off the slot itself since their own move this tick may
			// not be captured to their avatar yet; everyone else's is read off their avatar, already
			// final from their own earlier apply this round).
			// STICKY IS AN ANTI-FLICKER PREFERENCE FOR AN ACTIVELY ENGAGED ENEMY, NOT A PERMANENT
			// LOCK FOR ANY ENEMY. _updateStickyTargets (swap-session.js) just persists whatever this
			// function decides, round after round. Returning the sticky value whenever its distance
			// was merely TIED with (or close to) the true nearest human -- tried first -- still locked
			// an enemy onto whichever human won the very first round's tie-break forever in this
			// codebase's own co-op spawn (players start ADJACENT, one tile apart --
			// tests/e2e/helpers/coop.ts): with A and B one tile apart, EVERY free tile in a 6-10 tile
			// ring around either one of them ties in Chebyshev distance to both (measured: 45 of 45
			// candidate tiles around A also tied exactly with B's own distance) -- so any tie-honoring
			// rule reduces to "whichever human the FIRST round's tie-break happened to favour, forever",
			// exactly the original bug's symptom. That is why the noise-ripple e2e repro
			// (mp-presentation-once.spec.ts) could cycle an idle, non-chasing Rat through 24 spots near
			// A and still deliver zero ripples to A.
			//
			// The actual distinction the doc comment's "sticky current target" always meant is REAL
			// engagement, not a cached distance comparison: enemy.aware is KD's own flag for "this
			// enemy is actively tracking/chasing a target", set by the same per-enemy AI loop that
			// calls this chooser (KinkyDungeonEnemies.ts). An AWARE enemy mid-chase must not ping-pong
			// targets just because a human one tile closer briefly edges it out -- that is the real
			// flicker this mechanism exists to prevent, and ties never arise there because the chasing
			// enemy's own position converges toward its target over the chase, not a static ring around
			// a human who never moves. An ambient/idle (!enemy.aware) enemy -- ANY out-of-sight noise,
			// including this ring-of-ties case -- has no engagement to protect, so it always uses the
			// freshly computed nearest human (natural tie-break: whichever human is first in this
			// round's own roster order, which genuinely varies round to round with the turn shuffle).
			globalThis.__kdSlotChoose = function(enemy){
				// A recruited companion/ally always engages its OWNER, never whichever human it
				// happens to stand closest to -- checked before the sticky/nearest fallback below,
				// which exist only for real hostile enemies that have no owner at all.
				var owner = (globalThis.__kdSlotOwner || {})[enemy.id];
				if (owner) return owner;
				var humans = globalThis.__kdSlotHumans || [];
				var best = null, bestDist = Infinity;
				for (var i = 0; i < humans.length; i++) {
					var h = humans[i], x, y;
					if (h.cid === globalThis.__kdSlotHost) { x = KinkyDungeonPlayerEntity.x; y = KinkyDungeonPlayerEntity.y; }
					else {
						var av = KDMapData.Entities.find(function(en){ return en.id === h.avatarId; });
						if (!av) continue;
						x = av.x; y = av.y;
					}
					var d = Math.max(Math.abs(enemy.x - x), Math.abs(enemy.y - y));
					if (d < bestDist) { bestDist = d; best = h.cid; }
				}
				var fallback = best || (humans[0] && humans[0].cid) || null;
				if (enemy.aware) {
					var sticky = globalThis.__kdStickyTarget || {};
					var want = sticky[enemy.id];
					if (want && humans.some(function(h){ return h.cid === want; })) return want;
				}
				return fallback;
			};

			var _np = KinkyDungeonNearestPlayer;
			if (!_np.__kdTurnModelWrapped) {
				var npWrapped = function(enemy){
					if (globalThis.__kdSlotSwitch && arguments.length >= 5 && enemy && enemy.Enemy
						&& (globalThis.__kdSlotAvatarIds || []).indexOf(enemy.id) < 0) {
						var want = globalThis.__kdSlotChoiceLog[enemy.id] || globalThis.__kdSlotChoose(enemy);
						globalThis.__kdSlotChoiceLog[enemy.id] = want;
						if (want && want !== globalThis.__kdSlotCurrent) globalThis.__kdSlotSwapTo(want);
					}
					return _np.apply(this, arguments);
				};
				npWrapped.__kdTurnModelWrapped = true;
				KinkyDungeonNearestPlayer = npWrapped;
			}

			// Regroup entities (stable sort by chosen human) before each real pass, and mute/hand the
			// slot back to the apply's own player when the pass returns. This is the one WORLD_FNS-style
			// entry NOT in the generic list above because it needs the grouping + hand-back, not a plain
			// no-op.
			//
			// This function is ALSO called twice per real tick with different Allied values
			// (KinkyDungeonGame.ts:3596/3607) and interleaves PLAYER-ONLY pre/post work with its per-
			// enemy world loops (turn-classification.js's own citation,
			// KinkyDungeonEnemies.ts:4305-4341): wholesale-muting the whole call (as below) silently
			// dropped that player-only half for every apply but the round's host. Replicated here, one
			// call each, by calling the SAME smaller functions/statements the engine itself uses for
			// that step — never a copy of unrelated per-enemy logic, which stays muted (it is already
			// routed once-per-round by the slot switch above):
			//   Allied===true  -> KinkyDungeonUpdateDialogue(KinkyDungeonPlayerEntity, maindelta), the
			//                     acting player's own dialogue-duration decay (KinkyDungeonEnemies.ts:4306).
			//                     The enemy loop's OWN dialogue ticks + summon decay a few lines below
			//                     stay muted — per-enemy world state, already once-per-round correct.
			//   Allied===false -> the acting player's own leashed-to-jail countdown + nearby jail-door
			//                     auto-unlock (KinkyDungeonEnemies.ts:4321-4336): KDGameData.
			//                     KinkyDungeonLeashedPlayer is per-player (not in KDGAMEDATA_WORLD_KEYS).
			//                     KinkyDungeonTorsoGrabCD, the other statement in the SAME "else" branch,
			//                     is a bare world counter (no entity at all) and stays muted — it must
			//                     decay once per ROUND, not once per player.
			var _ue = KinkyDungeonUpdateEnemies;
			if (!_ue.__kdTurnModelWrapped) {
				var ueWrapped = function(maindelta, Allied){
					if (globalThis.__kdWorldMuted && globalThis.__kdInTick > 0) {
						// NESTED TICKS: this is the engine's FIRST per-round world call (allied pass fires
						// before the hostile one) — the designated hand-off point. A non-last apply arms
						// exactly one nested-dispatch callback (setNestedDispatchCallback's caller) before
						// its own applyInputObserved; firing it here, before this apply's own post-enemy
						// tail runs below, hands control to the NEXT player's own apply — recursively, down
						// to the round's one real (unmuted) tick — so that tail (KinkyDungeonUpdateStats,
						// HandleMoveToTile, delayed actions, flags, ...) sees the round's FINAL, post-world
						// state once control returns, the same order single-player already guarantees for
						// the host. Taken and cleared immediately (one-shot: never fires twice for one
						// apply, and a 1-player round or the round's own last apply never arms it at all).
						// __kdWorldMuted is saved/restored around the call because the nested chain's own
						// setWorldMuted calls (for players further down the round) overwrite the single
						// shared flag — this apply's OWN remaining muted work (below, and the WORLD_FNS
						// no-ops still to come this call) needs ITS OWN value back, not whatever the
						// innermost apply left behind.
						if (Allied && typeof globalThis.__kdNestedDispatch === 'function') {
							var nestedFn = globalThis.__kdNestedDispatch;
							globalThis.__kdNestedDispatch = null;
							var mutedForMe = globalThis.__kdWorldMuted;
							nestedFn();
							globalThis.__kdWorldMuted = mutedForMe;
						}
						if (Allied) {
							KinkyDungeonUpdateDialogue(KinkyDungeonPlayerEntity, maindelta);
						} else if (KDGameData.KinkyDungeonLeashedPlayer > 0) {
							KDGameData.KinkyDungeonLeashedPlayer -= 1;
							var nearestJail = KinkyDungeonNearestJailPoint(KinkyDungeonPlayerEntity.x, KinkyDungeonPlayerEntity.y);
							if (nearestJail) {
								var jaildoor = KDGetJailDoor(nearestJail.x, nearestJail.y).tile;
								if (jaildoor && jaildoor.Lock && jaildoor.Type == "Door" && KDShouldUnLock(nearestJail.x, nearestJail.y, jaildoor)) {
									jaildoor.OGLock = jaildoor.Lock;
									if (jaildoor.LockSeen) jaildoor.LockSeen = jaildoor.Lock;
									jaildoor.Lock = undefined;
								}
							}
						}
						return undefined;
					}
					if (globalThis.__kdSlotSwitch) {
						var humans = globalThis.__kdSlotHumans || [];
						var rank = {};
						for (var i = 0; i < humans.length; i++) rank[humans[i].cid] = i;
						var avatarIds = globalThis.__kdSlotAvatarIds || [];
						var idx = new Map();
						KDMapData.Entities.forEach(function(e, i){
							idx.set(e, i);
							if (avatarIds.indexOf(e.id) < 0 && e.Enemy) {
								var want = globalThis.__kdSlotChoiceLog[e.id] || globalThis.__kdSlotChoose(e);
								globalThis.__kdSlotChoiceLog[e.id] = want;
							}
						});
						KDMapData.Entities.sort(function(a, b){
							var ra = rank[globalThis.__kdSlotChoiceLog[a.id]]; if (ra === undefined) ra = -1;
							var rb = rank[globalThis.__kdSlotChoiceLog[b.id]]; if (rb === undefined) rb = -1;
							return (ra - rb) || (idx.get(a) - idx.get(b));
						});
					}
					var r = _ue.apply(this, arguments);
					if (globalThis.__kdSlotSwitch && globalThis.__kdSlotCurrent !== globalThis.__kdSlotHost) {
						globalThis.__kdSlotSwapTo(globalThis.__kdSlotHost);
					}
					return r;
				};
				ueWrapped.__kdTurnModelWrapped = true;
				KinkyDungeonUpdateEnemies = ueWrapped;
			}

			// THE DEFEAT ROUTE. KDRunDefeatForEnemy finalises a defeat with whoever currently
			// holds the slot — called from the end of THIS pass (KinkyDungeonEnemies.ts:5070,
			// still inside _ue.apply above, before the hand-back-to-host two lines up runs) and
			// again as a backstop at the very end of KinkyDungeonAdvanceTime itself
			// (KinkyDungeonGame.ts:3636). Once the per-enemy loop has moved on to a LATER group
			// (a different human), the slot is no longer necessarily the one the DEFEATING enemy
			// faced. KDCustomDefeatEnemy always names that enemy (set the instant its ret.defeat
			// came back true; cleared only once KDRunDefeatForEnemy itself runs), so this swaps the
			// slot to that enemy's own choice-log entry — the SAME decision already made for it this
			// pass, never re-decided — before calling through. A defeat caused by the round's host
			// is already on the right human by construction (the host's own group is always
			// processed last), so this is a no-op swap in that case.
			var _rdfe = (typeof KDRunDefeatForEnemy === 'function') ? KDRunDefeatForEnemy : null;
			if (_rdfe && !_rdfe.__kdTurnModelWrapped) {
				var rdfeWrapped = function(){
					if (globalThis.__kdSlotSwitch) {
						var enemy = KDCustomDefeatEnemy;
						if (enemy) {
							var want = globalThis.__kdSlotChoiceLog[enemy.id] || globalThis.__kdSlotChoose(enemy);
							globalThis.__kdSlotChoiceLog[enemy.id] = want;
							if (want && want !== globalThis.__kdSlotCurrent) globalThis.__kdSlotSwapTo(want);
						}
					}
					return _rdfe.apply(this, arguments);
				};
				rdfeWrapped.__kdTurnModelWrapped = true;
				KDRunDefeatForEnemy = rdfeWrapped;
			}
			return true;
		})()`);
	}

	/**
	 * Register the host's own slot-swap logic (`SwapSession._slotSwapTo`) as the function the engine
	 * calls back into, synchronously, from inside `KinkyDungeonNearestPlayer`'s wrapper above. This is
	 * a real cross-realm function reference (not `eval`'d text), set directly on the vm context —
	 * the same mechanism the investigation probe used (`world._context.__kdProbeSwapTo`).
	 */
	setSlotSwapCallback(fn) {
		this._context.__kdSlotSwapTo = fn;
	}

	/**
	 * Arm the ONE-SHOT nested-dispatch hook (nested ticks): `fn` is called synchronously, at most once,
	 * from inside `installTurnModel`'s `KinkyDungeonUpdateEnemies` wrap, the moment THIS apply's own
	 * `KinkyDungeonAdvanceTime` call reaches the round's first per-round world call. The caller is
	 * expected to set this fresh before every non-last apply's own dispatch (`SwapSession._advanceTurn`)
	 * — a real cross-realm function reference, same mechanism as `setSlotSwapCallback`, not `eval`'d
	 * text. Reading it back as `null`/`undefined` (never armed, or already consumed) is how the engine
	 * wrap knows not to fire — see that wrap's own doc comment for why it is taken-and-cleared rather
	 * than a boolean flag.
	 */
	setNestedDispatchCallback(fn) {
		this._context.__kdNestedDispatch = fn;
	}

	/** Mute (or unmute) every `WORLD_MUTE_FNS` system for the NEXT `KinkyDungeonAdvanceTime` call. */
	setWorldMuted(muted) {
		this.eval(`globalThis.__kdWorldMuted = ${!!muted};`);
	}

	/**
	 * Arm the per-enemy slot switch for the round's one unmuted `KinkyDungeonUpdateEnemies` call(s).
	 * `hostCid` is the apply's own player (who the slot is handed back to); `roster` is
	 * `[{cid, avatarId}]` for every joined player; `stickyTarget` is `{enemyId: clientId}` for enemies
	 * with a persisted current target that is still joined — `installTurnModel`'s chooser falls back
	 * to nearest-by-live-position for everything else.
	 */
	armSlotSwitch(hostCid, roster, stickyTarget, companionOwners) {
		this._context.__kdSlotHost = hostCid;
		this._context.__kdSlotCurrent = hostCid;
		this._context.__kdSlotHumans = roster;
		this._context.__kdSlotAvatarIds = roster.map((h) => h.avatarId).filter((id) => id != null);
		this._context.__kdStickyTarget = stickyTarget || {};
		// A companion's owner is not a preference, it is the rule — checked before sticky/nearest in
		// `__kdSlotChoose` below.
		this._context.__kdSlotOwner = companionOwners || {};
		this._context.__kdSlotChoiceLog = {};
		this._context.__kdSlotSwitch = true;
	}

	/** Disarm the slot switch. Always call after the round's one unmuted dispatch, win or throw. */
	disarmSlotSwitch() {
		this._context.__kdSlotSwitch = false;
	}

	/** Who the engine-side switch currently believes holds the slot (defensive read-back). */
	slotCurrent() {
		return this.eval('globalThis.__kdSlotCurrent');
	}

	/** Tell the engine-side switch who now holds the slot — `SwapSession._slotSwapTo` calls this
	 *  every time it actually moves the slot, so the two sides of the switch never disagree. */
	setSlotCurrent(cid) {
		this._context.__kdSlotCurrent = cid;
	}

	/**
	 * Stamp any newly-created, not-yet-owned `followPlayer` bullet with `cid` — the clientId of the
	 * apply that is finishing right now. Every human is id -1 on the slot, so a bullet's own
	 * `bullet.source` (an entity id) cannot tell which human cast it; this is the owner tag the
	 * `KinkyDungeonUpdateBullets` wrap (`installTurnModel`) reads to correct a followPlayer bullet to
	 * its OWN owner's avatar position instead of the slot occupant's. Deliberately NOT a property on
	 * the bullet object (would diverge a 1-player session's KDMapData.Bullets from a reference run —
	 * see GLOBAL_BLACKLIST's `__kdBulletOwner` note); call this after EVERY apply, muted or not — a
	 * player's own cast runs through their own real dispatch regardless of the world-mute state.
	 */
	tagOwnedBullets(cid) {
		this.eval(`(function(){
			var owners = globalThis.__kdBulletOwner || (globalThis.__kdBulletOwner = {});
			(KDMapData.Bullets || []).forEach(function(b){
				if (b.bullet && b.bullet.followPlayer && b.bullet.faction === 'Player' && owners[b.spriteID] == null) {
					owners[b.spriteID] = ${JSON.stringify(cid)};
				}
			});
			return true;
		})()`);
	}

	/**
	 * Tag any newly-leashed enemy (`leash.entity === -1`, the generic "tethered to the player" marker
	 * — KDTethers.ts:203-210) as owned by `cid`, the SAME "first touch wins" shape as `tagOwnedBullets`:
	 * a leash with no owner yet was created by THIS apply's own real dispatch (grabs/binds only ever
	 * happen through the acting player's own pipeline), so whoever is applying right now is its owner.
	 * `installTurnModel`'s `KinkyDungeonUpdateTether` wrap reads this to swap the right human into the
	 * slot for the round's one real tether tick. Prunes entries whose leash no longer exists, same as
	 * `tagOwnedBullets` prunes bullets — call this after EVERY apply, muted or not.
	 */
	tagOwnedTethers(cid) {
		this.eval(`(function(){
			var owners = globalThis.__kdTetherOwner || (globalThis.__kdTetherOwner = {});
			var seen = {};
			(KDMapData.Entities || []).forEach(function(e){
				if (e.leash && e.leash.entity === -1) {
					seen[e.id] = true;
					if (owners[e.id] == null) owners[e.id] = ${JSON.stringify(cid)};
				}
			});
			Object.keys(owners).forEach(function(k){ if (!seen[k]) delete owners[k]; });
			return true;
		})()`);
	}

	/** Which human each real enemy was decided for this call — for the caller to persist as the next
	 *  round's sticky target. `{}` if the switch never armed (nothing decided). */
	slotChoiceLog() {
		return this.eval('globalThis.__kdSlotChoiceLog') || {};
	}

	/**
	 * Mirror a peer's own defensive stats onto their stand-in, so KD evaluates an incoming
	 * PvP attack against the REAL defender's build.
	 *
	 * Hit-or-miss is decided entirely off the ENTITY, never off the player slot:
	 * `KinkyDungeonAttackEnemy` (`KinkyDungeonFight.ts:1649`) passes the player slot as the ATTACKER and
	 * asks `KinkyDungeonEvasion` about the entity, which reads `Enemy.buffs` at
	 * `KinkyDungeonGetEvasion:486`. So no amount of swapping the victim in could have delivered their
	 * evasion — the channel is the buff list, and the stand-in simply had none.
	 *
	 * Evasion + Block is KD's OWN pairing for this question, not a list we chose: the generic
	 * enemy-attack path branches on `player.player` and, for a non-player target, uses exactly
	 * `MultiplicativeStat(GetBuffedStat(player.buffs, "Evasion"))` and the same for `"Block"`
	 * (`KinkyDungeonEnemies.ts:6681`/`:6684`). The values are the game's own raw buff totals; the game
	 * applies its own formula to them here, so there is no arithmetic of ours in the path.
	 *
	 * ⚠️ A FRESH object every call, deliberately. `KinkyDungeonGetBuffedStat` memoises per stat type in
	 * `KDBuffedStatTypeMemo`, a Map keyed by the buff-list OBJECT (`KinkyDungeonBuffs.ts:300`). Mutating
	 * the same list in place would serve a stale total, so a peer who dropped a buff would keep evading.
	 */
	setAvatarDefenses(entityId, evasion, block) {
		return this.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.id === ${entityId | 0}; });
			if (!e) return null;
			var eva = ${Number(evasion) || 0}, blk = ${Number(block) || 0};
			var buffs = {};
			// Only carry a stat the peer actually has; an empty list reads as 0, which is the same
			// neutral answer, and keeps the avatar's buff list honest about what it represents.
			if (eva) buffs.KDPeerEvasion = { id: 'KDPeerEvasion', type: 'Evasion', power: eva, duration: 9999 };
			if (blk) buffs.KDPeerBlock  = { id: 'KDPeerBlock',  type: 'Block',   power: blk, duration: 9999 };
			e.buffs = buffs;
			KDUpdateEnemyCache = true;
			return { id: e.id, evasion: eva, block: blk };
		})()`);
	}

	/** Read an entity's combat + bondage state for reconciliation back to a player bundle.
	 *  npcRestraints = the restraint NAMES tied onto the avatar this turn (real "tie"). */
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
				// KD's OWN aggro on this avatar. The gateway does not classify inputs to decide
				// "was that an attack" — it reads the flag the game sets (KDMakeHostile / KDAggroViaDialogue),
				// which covers the damaging attack AND the sneak that deals none.
				hostile: e.hostile || 0, rage: e.rage || 0,
				captured: (typeof KDHelpless === 'function') ? !!KDHelpless(e) : (e.hp <= 0.52),
				npcRestraints: names };
		})()`);
	}

	/** Clear an avatar's per-turn bondage gauge (NPC restraints + boundLevel) before the turn,
	 *  so _reconcilePeers reads only the bondage applied THIS turn (mirrors the hp damage gauge). */
	/**
	 * Mirror a peer PLAYER real worn bondage onto their stand-in avatar.
	 *
	 * Uses specialBoundLevel — the GAME own ITEM-FREE bondage channel (what KDTieUpEnemy writes, e.g.
	 * specialBoundLevel.Rope). KDResyncBondage sums it back into boundLevel, so the value survives the
	 * engine recomputing it; a bare boundLevel write does NOT (KDResyncBondage zeroes it when
	 * specialBoundLevel is unset). Measured: 1 to 1, 5 to 5, 60 to 60, 80 to 80.
	 *
	 * Item-free is the point: no KDSetNPCRestraints entries are created, so the earlier binding-slot
	 * overflow that crashes the stock submenu cannot come back.
	 */
	/**
	 * Mark a DEFEATED peer avatar as exposed for this turn.
	 *
	 * This is the epic ONE declared co-op rule, and it is deliberately the SMALLEST possible one: it
	 * sets the game own per-turn exposure flag and then lets KD own gate decide. It does NOT override
	 * KDCanApplyBondage, does not fake a stun, and does not invent a bondage level — the branch that
	 * fires is the stock one, target.vulnerable && target.hp <= 0.5 * maxhp, and the hp half comes from
	 * the peer REAL Will (the Will arming).
	 *
	 * Why co-op needs it at all: KD subdues an NPC through stun/freeze or accumulated bondage, both of
	 * which arrive via weapons and spells an NPC fight supplies. Between two PLAYERS the product
	 * requirement is that beating an opponent down is itself enough to tie them — measured otherwise
	 * impossible without dictating the loadout. Declared here, in one place, rather than hidden.
	 *
	 * No duration is invented: the flag is set for THIS turn and re-armed every turn the peer is still
	 * defeated, so it expires the moment they are not.
	 */
	/**
	 * End an avatar's hostility — the inverse of KD's own `KDMakeHostile`
	 * (`KinkyDungeonEnemies.ts:5207`, which sets `hostile` and deletes `ceasefire`/`allied`).
	 *
	 * Both fields, because `KDAllied` and `KinkyDungeonAggressive` each read BOTH: `rage > 0` alone
	 * keeps an entity hostile no matter what `hostile` says (`KinkyDungeonFactions.ts:33/44`).
	 *
	 * Written in the GAME's fields, not in a flag of ours — the MP layer holds the relationship
	 * (peace.js), the game holds the hostility. `hostile` is a countdown the engine decays on its own
	 * (`:4525`), which is exactly why it must not be the durable record of a truce.
	 */
	setAvatarHostile(entityId, on) {
		return this.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.id === ${entityId | 0}; });
			if (!e) return null;
			if (${on ? 1 : 0}) {
				if (typeof KDMakeHostile === 'function') KDMakeHostile(e);
				else e.hostile = 300;
			} else {
				e.hostile = 0;
				e.rage = 0;
				// …and give the avatar its FACTION back. setAvatarEnemy stamps faction='Enemy' onto the
				// world entity when arming a PvP peer, and that stamp is sticky: clearing hostile alone
				// left KDHostile true through the FACTION relation, so a peer stayed an attackable,
				// bindable enemy after a truce (measured, UAT round 3). Deleting the override restores
				// the def own faction ('Player') instead of hard-coding one here.
				// NOTE: no backticks in this comment — it lives inside a template literal, and one would
				// terminate the payload (see reference: backtick-in-template-literal, 3rd recurrence).
				delete e.faction;
				delete e.ceasefire;
				// KDMakeHostile (the "on" branch above) records the pre-hostile faction as
				// factionorig so other engine rules can still tell a turned ally apart from a real
				// enemy. Leaving it standing after a truce is a residual-memory leak for a companion
				// that was never a real enemy to begin with -- drop it so nothing is left to read.
				delete e.factionorig;
			}
			return { hostile: e.hostile || 0, rage: e.rage || 0,
				faction: (typeof KDGetFaction === 'function') ? KDGetFaction(e) : e.faction };
		})()`);
	}

	setAvatarVulnerable(entityId, on) {
		return this.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.id === ${entityId | 0}; });
			if (!e) return null;
			e.vulnerable = ${on ? 1 : 0};
			return { vulnerable: e.vulnerable };
		})()`);
	}

	/**
	 * The key MUST be a type the game registered in `KDSpecialBondage` (Rope, Latex, Metal, ...).
	 *
	 * `specialBoundLevel` is a KEYED channel, not a free-form bag: KD indexes `KDSpecialBondage[key]`
	 * UNGUARDED on the DRAW path — `KinkyDungeonEnemies.ts:2193` (the HP-bar bondage segments) and the
	 * `KDPredictStruggle` sort comparator at `:8614`. An invented key ("MPPeer", shipped here until a
	 * UAT session hit it) is therefore not an inert label: the first frame that draws a bound peer's
	 * HP bar throws `Cannot read properties of undefined (reading 'priority')` and takes the client
	 * down. `Rope` is what KD's own `KDTieUpEnemy` writes, so we borrow the same channel.
	 * Locked by `tests/unit/mp-avatar-bondage-type.spec.ts`.
	 */
	setAvatarBondage(entityId, amount) {
		const amt = Number(amount) || 0;
		return this.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.id === ${entityId | 0}; });
			if (!e) return null;
			if (${amt} > 0) e.specialBoundLevel = { Rope: ${amt} };
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

	/** Write the swapped-in player's Will (the reconcile target), clamped to [0, WillMax]. */
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

	/** The ~20-global per-player independence snapshot. */
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

	// ----- headless-safe render-state snapshot ------------------------

	/**
	 * Serialize a JSON-safe RENDER-STATE snapshot — the minimal set of globals the
	 * stock per-frame render path reads, so a thin client can render it
	 * without simulating. Built DIRECTLY from live globals, NOT from
	 * KinkyDungeonGenerateSaveData() — that throws headless because it reads
	 * render-derived model Poses (KinkyDungeon.ts:6840). This serializer never
	 * touches model/pose data; it carries game state, not pixels.
	 *
	 * Shape is `version`-stamped for protocol evolution (shared with the reconciler and the launcher).
	 * Per-entity `Enemy` defs are reduced to `enemyName` and re-linked on apply
	 * (the client already has the shared defs) — see applyRenderState.
	 */
	serializeRenderState() {
		return this.eval(`(function(){
			function clone(o){ try { return (o === undefined) ? undefined : JSON.parse(JSON.stringify(o)); } catch(e){ return null; } }
			// These are the fields KD OWN predicates read to decide whether a target is
			// subdued — KinkyDungeonIsStunned reads stun/freeze, KDCanApplyBondage reads vulnerable and
			// hp, KDBoundEffects reads boundLevel (and KDResyncBondage rebuilds it from
			// specialBoundLevel). Omitting them meant the CLIENT — where the tie submenu actually
			// evaluates the gate — never saw the state the server had computed, so no server-side fix
			// could ever take effect. The old code hid this by stamping ent.stun onto the snapshot AFTER
			// serialisation, bypassing this list; with the stamping gone the omission became visible.
			var ENT_FIELDS = ['id','x','y','visual_x','visual_y','offX','offY','scaleX','scaleY','flip','hp','visual_hp','boundLevel','specialBoundLevel','stun','freeze','vulnerable','distraction','revealed','player','CustomSprite','CustomName','CustomNameColor','style','outfit','outfitBound','appearance'];
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
				/*
				 * WHICH SCREEN the session is on, so the client can follow the game
				 * instead of overriding it.
				 *
				 * The client used to stamp KinkyDungeonState = 'Game' on every state frame, which
				 * meant no screen the world legitimately entered could ever be seen. It now adopts
				 * this value. Sent as the world's OWN KinkyDungeonState, never as a computed
				 * instruction -- the client renders what the session is on, and this layer does not
				 * get to invent a screen.
				 *
				 * Defaults to 'Game' because that is what an in-progress dungeon is, and because it
				 * keeps every older client that sends no screen and the whole coop suite behaving identically.
				 *
				 * NOTE: no backticks in this comment on purpose -- it lives INSIDE an eval template
				 * literal, where one would terminate the string and blame the requiring file.
				 */
				screen: (typeof KinkyDungeonState !== 'undefined' && KinkyDungeonState) ? String(KinkyDungeonState) : 'Game',
				// The curated stats block is GONE. It named ~12 HUD fields by hand, in TWO
				// languages (here and client/render-client.js), and shipped slowLevel — a value it
				// RECOMPUTED and then sent, i.e. derived state crossing the network, which is exactly
				// what goes stale. Every one of those fields is per-player state the generic bundle
				// already carries (snapshotFor attaches it), so adding a HUD value upstream now needs
				// no change here at all. Measured: a probe + tests/e2e/mp-render-completeness.
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
				// Ship the FULL worn-restraint items (not just name/id) so the client can rebuild
				// the player's worn-restraint Map — a peer-applied tie must render on the victim's screen.
				restraints: (typeof KinkyDungeonAllRestraint === 'function') ? KinkyDungeonAllRestraint().map(function(r){ return clone(r) || { name: r.name, id: r.id }; }).filter(function(r){ return r && r.name; }) : [],
				buffs: clone(typeof KinkyDungeonPlayerBuffs !== 'undefined' ? KinkyDungeonPlayerBuffs : {}),
				level: (typeof MiniGameKinkyDungeonLevel !== 'undefined') ? MiniGameKinkyDungeonLevel : 1,
				checkpoint: (typeof MiniGameKinkyDungeonCheckpoint !== 'undefined') ? MiniGameKinkyDungeonCheckpoint : 'grv',
				// The WORLD half of KDGameData, whole — every key KDGAMEDATA_WORLD_KEYS
				// declares, taken from the world and adopted verbatim by the client.
				//
				// This replaced a hand-written roomType/mapMod pair, which was the same idea
				// spelled out one field at a time in FOUR mirrored places: here, applyRenderState below,
				// and render-client.js serialize/apply. _clientBundle already STRIPS these keys from the
				// per-player bundle, so every world key the list gains is a key the client stops
				// receiving and must be sent here instead - and the per-field form made that a silent
				// omission, four edits wide, every single time. The journey agreement added three at once.
				//
				// Cheap despite the size: the state frame is delta-encoded, so a value that
				// did not change costs nothing on the wire.
				// (No backticks in this comment on purpose - it lives inside an eval template literal.)
				// WORLD GLOBALS the client resolves things through. Same one-list-one-loop
				// shape as worldGameData above, and for the same reason: a name that stops being
				// per-player stops arriving in the bundle, and per-field plumbing made that a silent
				// omission every time. Today this is the three item-variant registries, without which
				// the browser draws an enchanted item with no definition behind it.
				// (No backticks in this comment on purpose - it lives inside an eval template literal.)
				worldGlobals: (function(){
					var o = {}, gs = ${JSON.stringify(WORLD_GLOBALS_CLIENT)};
					for (var i = 0; i < gs.length; i++) {
						var v; try { v = eval(gs[i]); } catch (e) { continue; }
						if (v !== undefined) o[gs[i]] = clone(v);
					}
					return o;
				})(),
				worldGameData: (function(){
					var o = {}, ks = ${JSON.stringify(KDGAMEDATA_WORLD_KEYS)};
					if (typeof KDGameData === 'undefined' || !KDGameData) return o;
					for (var i = 0; i < ks.length; i++) {
						if (KDGameData[ks[i]] !== undefined) o[ks[i]] = clone(KDGameData[ks[i]]);
					}
					return o;
				})(),
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
		// Per-player state arrives as the generic bundle, adopted through the SAME path the
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
			// The hand-assigned HUD stats are gone — per-player state arrives in the bundle,
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
			// See serializeRenderState: the world half of KDGameData, adopted generically.
			// AFTER restorePlayer (which ran before this eval), so the world's answer wins over any
			// copy the bundle still carried. Iterating what was SENT rather than the declared list
			// keeps an older snapshot working: a key it does not carry is simply left alone.
			if (typeof KDGameData !== 'undefined' && KDGameData && s.worldGameData) {
				for (var wk in s.worldGameData) KDGameData[wk] = s.worldGameData[wk];
			}
			// And the WORLD GLOBALS half, on the same terms. Iterating what was SENT keeps
			// the declared list server-side only, so an older snapshot carrying none of them is a
			// no-op rather than a wipe. These are bundle bindings, so bare eval assignment, never
			// globalThis. (No backticks in this comment on purpose - it lives inside an eval template.)
			if (s.worldGlobals) {
				for (var wg in s.worldGlobals) {
					try {
						globalThis.__KD_WG = s.worldGlobals[wg];
						eval(wg + ' = globalThis.__KD_WG;');
					} catch (e) { /* not assignable here */ }
				}
			}
			return { ok: true, entities: KDMapData.Entities.length, grid: KDMapData.Grid.length };
		})()`);
	}

	/**
	 * Adopt the WORLD's authoritative MAP (tiles + vision/lighting) onto THIS player
	 * instance — the reconciler push. Map-ONLY by design: it does NOT touch this
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
	 * instance so it renders + survives the per-turn CheckHP pass. Uses the
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
	 * Read a world enemy's REAL attack descriptor from its def (reconciler adjudication):
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

	// ----- action routing --------------------------------------------

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
	 * KinkyDungeonDamageEnemy (routed attack). Returns {hp, dealt, name} or null.
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
	 * Give KinkyDungeonPlayer a ModelContainer so KD's own save serializer can run headless.
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

	// ----- generic per-player globals (no hand-written whitelist) -----

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
		// The audit is a round robin over _oversize, so a new baseline restarts the cycle.
		this._oversizeCursor = 0;
		this._lastAuditNames = null;
		this._oversizeChanged = [];
		// Hashes of WATCHED globals that have since grown past the cap — the de-dup store for
		// _reportGrownOverMax. Cleared with the baseline, because a re-baseline reclassifies everything.
		this._grownOverMax = {};
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
	 *
	 * ⚠️ KEEP THIS EVAL SOURCE BYTE-IDENTICAL FROM CALL TO CALL. The `_watchNames` literal
	 * below is ~48 KB, and parsing it costs ~4.5 ms — but V8 caches compiled `eval` by source string,
	 * and `_watchNames` is fixed after the baseline, so it is parsed once per process and every later
	 * pass is served from that cache. MEASURED (quiet host, interleaved): identical source 0.58 ms/pass
	 * vs a source made unique per call 5.06 ms/pass — an 8.7x cliff. Interpolating anything that VARIES
	 * per call into this template (a tick, a player id, a timestamp) silently reinstates the full parse
	 * on both halves, ~9 ms on a ~13.6 ms transaction. `mp-eval-source-stable.spec.ts` guards it.
	 *
	 * This is also why the alternative (pass the list over the vm context instead of embedding it)
	 * is CLOSED as neutral: measured 0.57 vs 0.58 ms/pass. There is no per-pass parse cost to remove.
	 */
	_captureGlobals() {
		if (!this._baseline) this._captureBaseline();
		this._context.__KD_BASE_H = this._baseline;
		const res = this.eval(`(function(){
			${KD_CODEC}
			var names = ${JSON.stringify(this._watchNames)}, base = globalThis.__KD_BASE_H, out = {};
			var grew = {};
			${KD_HASH_FN}
			for (var i = 0; i < names.length; i++) {
				var n = names[i], v;
				try { v = eval(n); } catch (e) { continue; }
				if (v === undefined || typeof v === 'function') continue;
				try {
					var s = kdSer(v);
					if (s === undefined) continue;
					// A watched name whose value has GROWN past the cap used to be skipped here
					// with a bare 'continue' — silently dropped from per-player state, forever, with
					// nothing watching it. Record the crossing so the host can report it. The hash is the
					// de-dup key; it is computed on a string kdSer already built, and only for names
					// actually over the cap, so the normal path pays nothing.
					if (s.length > ${BASELINE_MAX_LEN}) { grew[n] = hash(s); continue; }
					if (hash(s) !== base[n]) out[n] = JSON.parse(s);   // diverged ⇒ this player's state
				} catch (e) { /* cyclic / PIXI — not player state */ }
			}
			return { out: out, grew: grew };
		})()`);
		this._reportGrownOverMax(res.grew);
		this._auditOversize();
		return res.out;
	}

	/**
	 * Announce a WATCHED global that has crossed BASELINE_MAX_LEN since the baseline.
	 *
	 * The threshold has three doors. `_captureBaseline` guards its own (over the cap ⇒ into
	 * `_oversize`, audited from then on by `_auditOversize`). The other two — the capture pass above
	 * and the reset half of `_restoreGlobals` — used to take a bare `continue`, so a global that is
	 * small at post-init and large during real play stopped being replicated AND stopped being reset,
	 * with no warning at all. `KDSaveQueue` was the worked example ([] at baseline, >20 KB once a real
	 * save lands); an earlier fix blacklisted that one name, which did nothing about the hole.
	 *
	 * De-dup is the drift-audit contract, not a second mechanism: re-baseline what is reported, so each
	 * DISTINCT drift warns exactly once, while a global that keeps mutating while over the cap keeps
	 * warning — that is the case the contract exists for.
	 *
	 * ⚠️ These names are deliberately NOT moved into `_oversize`. That was the obvious implementation
	 * and it is wrong twice over: they are still in `_watchNames`, so they are already re-serialised on
	 * EVERY capture — the round-robin exists for names nothing else looks at, and would only
	 * double-detect at a ~210-capture latency — and a name that later shrinks back UNDER the cap would
	 * then warn as an "oversize global" it is no longer. They stay watched for the same reason: if the
	 * value comes back under the cap it must resume being captured and reset.
	 */
	_reportGrownOverMax(grew) {
		if (!grew) return [];
		const names = Object.keys(grew);
		if (!names.length) return [];
		if (!this._grownOverMax) this._grownOverMax = {};

		const fresh = names.filter((n) => this._grownOverMax[n] !== grew[n]);
		if (!fresh.length) return [];
		for (const n of fresh) this._grownOverMax[n] = grew[n];
		const seen = new Set(this._oversizeChanged || []);
		fresh.forEach((n) => seen.add(n));
		this._oversizeChanged = [...seen];
		// eslint-disable-next-line no-console
		console.warn(`WATCHED GLOBAL GREW PAST THE CAP: ${fresh.join(', ')} — it was under ` +
			`${BASELINE_MAX_LEN} bytes at baseline (so it is watched as per-player state) and is over it ` +
			'now. While it stays this large it is NOT replicated to the other player, and it is reset to ' +
			'its post-init default on every swap rather than carried. Either it is shared world data ' +
			'(fine — blacklist it explicitly) or it is per-player state the swap is now losing. ' +
			'Do not ignore this.');
		return fresh;
	}

	/**
	 * The size threshold must fail LOUDLY, not silently — affordably, and once per drift.
	 *
	 * Globals whose serialised form exceeds BASELINE_MAX_LEN are excluded from the watch set as static
	 * data tables (measured: every one of them is an enemy/restraint/spell/model definition table, and
	 * they are what made an unbounded pass slow). That reasoning is a classification, not a proof — so
	 * this re-hashes them periodically and reports any that actually changed. A silently-dropped
	 * per-player global is precisely the bug class this epic exists to remove; the same drift contract
	 * as the BUNDLE_PATCHES site counts in demo-server.js.
	 *
	 * Two ways that contract was being paid for badly were fixed, without weakening it:
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
			console.warn(`OVERSIZE GLOBAL CHANGED: ${changed.join(', ')} — excluded from ` +
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
	 *
	 * ⚠️ KEEP THIS EVAL SOURCE BYTE-IDENTICAL FROM CALL TO CALL, for the reason spelled out
	 * over `_captureGlobals`: the ~48 KB name literal is free only because V8 serves it from its eval
	 * compilation cache, and only an unchanging source string hits that cache.
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
			// SUBTRACT THE BLACKLIST HERE TOO, symmetrically with capture.
			//
			// The capture half stopped producing these names, but restore trusted whatever key set the
			// bundle happened to carry — and a bundle outlives the build that made it (a reconnect, a
			// stored bundle, a client-supplied one). A single stale MiniGameKinkyDungeonLevel in an
			// old bundle would then MOVE THE PARTY to another floor on the next swap. "Not per-player"
			// has to mean it on both sides of the round trip, exactly as KDGameData is captured whole
			// and restored minus KDGAMEDATA_WORLD_KEYS.
			var n, i;
			var blacklisted = ${JSON.stringify(GLOBAL_BLACKLIST)};
			var isWorld = {};
			for (i = 0; i < blacklisted.length; i++) isWorld[blacklisted[i]] = true;
			for (n in g) if (!isWorld[n]) assign(n, g[n]);
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
					if (s === undefined) continue;
					// This used to skip on size too, which was a LEAK, not merely a loss. A
					// watched name whose value is over the cap is dirty BY DEFINITION — it was under the
					// cap at baseline, so it cannot still be holding its default — and skipping it left
					// the previous player's data in the world for the incoming player to inherit. That is
					// the contamination class this epic exists to remove. "Absent ⇒ default" must not be
					// exempted by size, and the hash comparison the old guard skipped is not needed here:
					// being over the cap already proves divergence.
					if (s.length > ${BASELINE_MAX_LEN}) { assign(n, defs[n]); continue; }
					if (hash(s) !== base[n]) assign(n, defs[n]);   // dirty from another player ⇒ reset
				} catch (e) { /* skip */ }
			}
			return true;
		})()`);
	}

	/**
	 * This player's state as KD's OWN save format, minus the shared world (WORLD_KEYS).
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

	// ----- per-player state swap (uniform action model) -------------------------

	/**
	 * Capture the CURRENT player's state bundle (everything that defines a player, EXCLUDING the
	 * shared world). Used by the swap model: one authoritative world, players swapped in/out per turn.
	 * JSON-safe, so it can go over the wire unchanged.
	 *
	 * There is NO hand-written list of player globals here any more. It used to name ~20
	 * of them plus a 12-key KDGameData sub-list, and that list could only ever be as complete as our
	 * knowledge of a 280-file moving target — every contamination bug of that era was a hole in it. Both halves are now
	 * inversions:
	 *
	 *   globals  — everything that DIVERGED from the post-init baseline, minus a category blacklist
	 *              (world / render / audio). New state, including a mod's, is carried without being named.
	 *   gameData — KDGameData whole, minus KDGAMEDATA_RESTORE_SKIP_KEYS on restore (the genuinely
	 *              shared KDGAMEDATA_WORLD_KEYS plus the pass-scoped accumulators that must survive a
	 *              mid-pass swap without being genuinely shared — see KDGAMEDATA_PASS_SCOPED_KEYS).
	 *              Its own path because no mechanical rule can split per-player Guilt from world
	 *              GuardSpawnTimer, and because at 27 KB it is over the divergence path's size
	 *              threshold. This is the epic's one declared, bounded exception — not a whitelist
	 *              reintroduced.
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
	 * The ~20 hand-written assignments that used to live here are gone. What remains is
	 * the two inversions plus one recompute — see capturePlayer for why each is not a whitelist.
	 * Generic globals go first so the derived recompute at the end still has the last word.
	 */
	restorePlayer(bundle) {
		if (bundle && bundle.globals) this._restoreGlobals(bundle.globals);
		this._context.__KD_PB = bundle;
		return this.eval(`(function(){
			var b = globalThis.__KD_PB; if (!b) return false;
			// Restore every captured KDGameData key EXCEPT the world-scoped and pass-scoped ones.
			// Inverted from a 12-key allow-list; see capturePlayer, KDGAMEDATA_WORLD_KEYS and
			// KDGAMEDATA_PASS_SCOPED_KEYS.
			if (b.gameData && typeof KDGameData !== 'undefined') {
				var __world = ${JSON.stringify(KDGAMEDATA_RESTORE_SKIP_KEYS)};
				for (var gk in b.gameData) {
					if (b.gameData[gk] === undefined) continue;
					if (__world.indexOf(gk) >= 0) continue;   // shared floor/world or pass-scoped state — leave the world's
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
	 * Complete any map generation the last input deferred. See KD_RUN_DEFERRED_MAPGEN.
	 *
	 * Called by BOTH apply paths, right after their dispatch returns — not from inside `__kdDispatch`,
	 * even though that would be a single call site. `applyInputObserved` keeps a counting wrapper over
	 * `KinkyDungeonAdvanceTime` installed for the duration of the dispatch; generating a map inside
	 * that window would fold the generation's own time advances into the INPUT's `advanced` count and
	 * mis-teach `inputKind`. The two call sites are pinned by a test that drives both paths.
	 */
	runDeferredMapGen() {
		const out = this.eval(KD_RUN_DEFERRED_MAPGEN) || {};
		// Never silent: "we stopped at the bound" must not read as "nothing was pending".
		if (out.exhausted) {
			console.warn(`[${this.id}] deferred map generation still pending after 4 rounds — ` +
				'a callback is arming another. The world may be mid-transition.');
		}
		for (const e of out.errors || []) {
			console.warn(`[${this.id}] deferred map generation threw: ${e}`);
		}
		return out.ran | 0;
	}

	/**
	 * Run a player input through KD's REAL dispatcher (the swap model's uniform action
	 * path). `type`/`data` are KD's own input types (move/doattack/struggle/…). The
	 * acting player must be swapped in first (restorePlayer). Returns the dispatcher result.
	 */
	applyInput(type, data) {
		this._context.__KD_INDATA = (data === undefined) ? {} : data;
		const res = this.eval(`(function(){
			${KD_ENT_RESOLVE}
			return __kdDispatch(${JSON.stringify(type)});
		})()`);
		this.runDeferredMapGen();   // a transition this input started must COMPLETE
		return res;
	}

	/**
	 * Run an input for real and REPORT whether it advanced the shared turn.
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
		const out = this.eval(`(function(){
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
		// AFTER the eval, so the generation runs outside this method's own
		// KinkyDungeonAdvanceTime wrapper and cannot inflate this input's `advanced` count.
		this.runDeferredMapGen();
		return out;
	}

	/**
	 * Load a player's SINGLE-PLAYER SAVE into this world, through KD's own loader.
	 *
	 * Takes the compressed-base64 string the browser keeps in `localStorage.KinkyDungeonSave`, i.e.
	 * exactly what KD's async save loop wrote (`KinkyDungeon.ts:1520-1525`). Nothing here parses the
	 * save format, and nothing here may learn to: `KinkyDungeonLoadGame` is upstream's, it is
	 * versioned with the bundle, and re-implementing any of it in the gateway is what epic AC1
	 * forbids.
	 *
	 * ⚠️ REPLACES `loadState()`, WHICH NEVER WORKED. That method set `__KD_SAVE_IN` to an OBJECT and
	 * branched on `KinkyDungeonLoadGameDataObject`, which does not exist in this bundle — so it fell
	 * through to `KinkyDungeonLoadGame(<object>)`, whose first act is `DecompressB64(String.trim())`.
	 * It had no callers, so nothing ever noticed. `serialize()` went with it for the same reason:
	 * caller-less, and `saveOf()` is the real instrument (see its comment).
	 *
	 * ⚠️ `_seedHeadlessModel()` IS THE ONE PRECONDITION, and it is measured, not assumed. Under
	 * `!KDToggles.OverrideOutfit && saveData.saveStat` the loader ASSIGNS through the paper-doll
	 * container — `KDCurrentModels.get(KinkyDungeonPlayer).Poses = …` (`KinkyDungeon.ts:7305`) — which
	 * `_neuterRendering` deliberately never builds. Same family as the autosave crash `_neuterAutosave`
	 * exists for. With the container seeded, the whole loader runs headless with no
	 * further stubbing: floor, map, entities, worn restraints and inventory all arrive (measured in
	 * a proof of concept, against a pre-load control).
	 *
	 * The save travels through the CONTEXT SLOT, never interpolated into the eval'd source. It is
	 * player-supplied data reaching an eval'd realm, which is precisely the shape that has broken this
	 * project before (memory: backtick-in-template-literal).
	 *
	 * @returns {{ok: boolean, version: string, err: string|null}} — `ok` is KD's own verdict
	 *   (it returns `false` for anything that fails to decompress or lacks the seven fields it
	 *   requires, `KinkyDungeon.ts:7079-7086`), `version` is the save's own `KDVersionStr` so a
	 *   caller can WARN about a mismatch without decoding the save a second time, and `err` carries
	 *   a throw rather than letting it escape into a half-built session.
	 */
	loadSave(str) {
		this._seedHeadlessModel();
		this._context.__KD_SAVE_IN = String(str || '');
		return this.eval(`(function () {
			var version = '';
			try {
				var raw = DecompressB64(String(globalThis.__KD_SAVE_IN || '').trim());
				if (raw) { var parsed = JSON.parse(raw); version = String((parsed && parsed.version) || ''); }
			} catch (e) { /* unreadable — KinkyDungeonLoadGame below answers false for the same reason */ }
			try {
				return { ok: !!KinkyDungeonLoadGame(globalThis.__KD_SAVE_IN), version: version, err: null };
			} catch (e) {
				return { ok: false, version: version, err: String((e && e.message) || e) };
			}
		})()`);
	}

	/**
	 * This world as a SINGLE-PLAYER save string, ready for a browser's save slot.
	 *
	 * The exact counterpart of `loadSave` above, and it produces what that function consumes: the
	 * compressed-base64 form KD's own async save loop writes to `localStorage.KinkyDungeonSave`
	 * (`KinkyDungeon.ts:1520-1538`). The save itself is `KinkyDungeonGenerateSaveData()` — upstream's,
	 * versioned with the bundle — and nothing here parses or repairs the format, for the same reason
	 * `loadSave` does not (epic AC1).
	 *
	 * ⚠️ NOT `saveOf()`, AND NOT A GENERALISATION OF IT. `saveOf` is the parity/non-interference
	 * INSTRUMENT: one player MINUS the world (`WORLD_KEYS` deleted), used to ask "did the swap lose
	 * anything". This is the PRODUCT: the whole world PLUS one player, for a person to keep playing.
	 * They share `_seedHeadlessModel()` and nothing else, and collapsing them would mean one function
	 * with a flag deciding whether its output is a measurement or a save file.
	 *
	 * ⚠️ `_seedHeadlessModel()` IS THE ONE PRECONDITION — the same one `saveOf` and `loadSave` have,
	 * for the same reason: `KinkyDungeonGenerateSaveData` reads
	 * `KDCurrentModels.get(KinkyDungeonPlayer).Poses` with no null guard (`KinkyDungeon.ts:6968`) off
	 * a container `_neuterRendering` deliberately never builds. This is also why the README long said
	 * headless save GENERATION was unsupported: it is supported, and has been since the swap layer
	 * seeded the container.
	 *
	 * ⚠️⚠️ EXCLUDING THE AVATARS IS WHAT MAKES THE SAVE LOADABLE — it is NOT tidiness.
	 * `KDUnPackEnemies` re-resolves every entity's def BY NAME on load
	 * (`KinkyDungeonGame.ts:734-739`), skipping only entities marked `modified`. The
	 * `RemotePlayer_<name>` defs are created at runtime by `spawnAvatar` and are NOT in the save
	 * (the save's key list is hand-picked and carries no enemy table), so a fresh world resolves them
	 * to `undefined`. The very next reader then dereferences that undefined:
	 *
	 *     KinkyDungeonVision.ts:158
	 *     if (Enemy && Enemy.blockVision || (Enemy.blockVisionWhileStationary && !EE.moved && EE.idle))
	 *
	 * `&&` binds tighter than `||`, so an undefined `Enemy` falls past the guarded first term into the
	 * unguarded second one and throws. (Its sibling at `:353` is parenthesised correctly — this is an
	 * upstream missing-paren bug, recorded in UPSTREAM_ISSUES.md. The game tree is read-only, so we
	 * work around it rather than patch it.) MEASURED in a proof of concept: leaving even ONE avatar in
	 * makes the save refuse to load, with any unknown def name reproducing it.
	 *
	 * Marking the avatars `modified` would ALSO make it load (measured) — by carrying the def inline.
	 * That is rejected on its merits, not for lack of options: a peer's avatar is not part of anybody's
	 * single-player run, and a save full of hostile ghosts of your friends is not the run they left.
	 *
	 * ⚠️ THE STRIP HAPPENS ON THE CLONE, NEVER ON THE WORLD. Despawning the avatars and re-spawning
	 * them afterwards was the obvious first design and is wrong: `spawnAvatar` allocates a fresh
	 * `KinkyDungeonGetEnemyID()`, so the round trip would move `KinkyDungeonEnemyID`, invalidate every
	 * entity id the peers hold, and break the caller's `avatars` map. Editing the deep clone that
	 * `saveOf` already pays for costs nothing and mutates nothing — which is what lets the caller
	 * promise the live session is untouched.
	 *
	 * Entity ids are the authoritative filter; the `RemotePlayer` name prefix is belt-and-braces for an
	 * avatar the caller has lost track of. Both, because they cost one predicate and disagree only in
	 * the case worth catching.
	 *
	 * @param {number[]} excludeIds entity ids to drop (the caller's avatar entities)
	 * @returns {{ok: boolean, save: string, version: string, err: string|null}}
	 */
	exportSave(excludeIds = []) {
		this._seedHeadlessModel();
		this._context.__KD_SAVE_EXCLUDE = (excludeIds || []).map((n) => n | 0);
		return this.eval(`(function () {
			try {
				var drop = {};
				(globalThis.__KD_SAVE_EXCLUDE || []).forEach(function (id) { drop[id] = true; });
				var save = JSON.parse(JSON.stringify(KinkyDungeonGenerateSaveData()));
				var isAvatar = function (e) {
					return drop[e.id] || String((e.Enemy && e.Enemy.name) || '').indexOf('RemotePlayer') === 0;
				};
				var gone = {};
				if (save.KDMapData && save.KDMapData.Entities) {
					save.KDMapData.Entities = save.KDMapData.Entities.filter(function (e) {
						if (!isAvatar(e)) return true;
						gone[e.id] = true;
						return false;
					});
				}
				// NPCRestraints is keyed by ENTITY ID and rides in KDGameData, so a removed
				// avatar would leave its ties behind as a record pointing at nothing.
				var ties = save.KDGameData && save.KDGameData.NPCRestraints;
				if (ties) { for (var k in ties) { if (gone[k]) delete ties[k]; } }
				return {
					ok: true, err: null,
					version: String(save.version || ''),
					save: LZString.compressToBase64(JSON.stringify(save)),
				};
			} catch (e) {
				// A throw must never reach the caller as a half-built save: R9 forbids handing back
				// anything a client might write over a real save slot.
				return { ok: false, save: '', version: '', err: String((e && e.message) || e) };
			}
		})()`);
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
	WORLD_KEYS, KDGAMEDATA_WORLD_KEYS, KDGAMEDATA_PASS_SCOPED_KEYS, KDGAMEDATA_RESTORE_SKIP_KEYS,
	// Re-exported so callers have ONE import for "what does the world own".
	MODE_WORLD_KEYS, MODE_PLAYER_KEYS,
	deriveBundleGlobals, GLOBAL_BLACKLIST, WORLD_GLOBALS_CLIENT, MIN_EXPECTED_GLOBALS, HOST_RESERVED,
	BASELINE_MAX_LEN, OVERSIZE_AUDIT_EVERY, OVERSIZE_AUDIT_BUDGET_MS,
};
