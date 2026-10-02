/**
 * tools/mp-server/turn-classification.js — DATA ONLY. No behaviour change.
 *
 * Step 1 of the co-op turn-model work (design B): classify every function `KinkyDungeonAdvanceTime`
 * and `KinkyDungeonUpdateEnemies` call directly, plus the dispatchers `KinkyDungeonSendEvent` fans
 * out to, as one of:
 *
 *   world  — runs once per ROUND regardless of player count (today it runs once per player; this is
 *            the dupe the turn model removes).
 *   player — one player's own per-turn work; correctly runs once per player, every player.
 *   mixed  — does BOTH under one name, so muting (or not muting) it wholesale is wrong either way.
 *            This is the list that matters most: it is the per-function splitting work's input — each entry here
 *            is a thing that must be SPLIT, not just muted or left alone.
 *   split  — a MIXED function that a bespoke `installTurnModel` wrap (headless-host.js) has actually
 *            split: the world-wide loop is muted on every apply but the round's one real tick, while
 *            the acting-player's own step is replicated (every apply) by calling KD's own smaller
 *            functions directly — never by copying game-rule text. A `split` entry's reason names the
 *            wrap that does it.
 *
 * ── WHY "DIRECT CALLS", NOT EVERYTHING TRANSITIVELY REACHABLE ────────────────────────────────────
 * `KinkyDungeonUpdateEnemies` alone is ~800 lines and the engine is tens of thousands more; classifying
 * every function reachable from a turn would never converge and would stop being checkable by a human.
 * The guard spec (`tests/unit/mp-turn-world-player-audit.spec.ts`) extracts call sites textually from
 * the two functions' OWN bodies (one level — what the function itself names, not what its callees go
 * on to call) plus the names `KinkyDungeonSendEvent`'s own body fans out to. That is the scope this
 * table promises to cover, and it is also exactly the turn-model design's own plan step 1: "Parse
 * KinkyDungeonAdvanceTime.toString() and KinkyDungeonUpdateEnemies.toString() ... list every called
 * function ... fail on any not present in one declared classification table".
 *
 * ── DEFAULT FOR THE UNNAMED MAJORITY OF KinkyDungeonUpdateEnemies' CALLEES ───────────────────────
 * Most of what `KinkyDungeonUpdateEnemies` calls is a per-enemy helper: a faction lookup, a stat
 * getter, a cooldown decay — all keyed by the `enemy` entity the loop is currently iterating, from
 * `KDMapData.Entities` (already WORLD state — `headless-host.js`'s `WORLD_KEYS`). That is the same
 * criterion (a) `KDGAMEDATA_WORLD_KEYS` uses for NPC state: keyed by entity id, not the player slot.
 * `worldHelper()` below applies that default with a citation; every entry that is NOT that default
 * (because it reads or writes the PLAYER SLOT, or does both) is called out explicitly, and several of
 * those were only found by actually reading the body — two (`KinkyDungeonUpdateAngel`,
 * `KDUpdateEffectTiles`) looked world-shaped from their names and turned out to be mixed. Treat the
 * default as a reasoned starting point, not a proof, exactly as `KDGAMEDATA_WORLD_KEYS`'
 * `NPCRestraints` entry already does for its own default.
 *
 * ── TEXT COUPLING ─────────────────────────────────────────────────────────────────────────────────
 * File:line citations point at `Game/src/**`, a tree we never write and which moves under us on
 * every upstream fast-forward. Per the repo's rule for text-coupled work: assert match counts and log
 * drift loudly — the guard spec does this for the two inline, unwrappable sites in
 * `TEXT_COUPLED_SITES` below (the world-clock increment and the AOE player-effect fan-out), and for
 * the classification table itself via the rot checks (an entry whose named global no longer exists).
 */

/** A verdict with its reason. `why` always ends with a Game/src file:line citation. */
function entry(verdict, why) { return Object.freeze({ verdict, why }); }

/** The repeated default for KinkyDungeonUpdateEnemies' per-enemy helpers (criterion a, see header). */
function worldHelper(what, file, line) {
	return entry('world', `${what} — world by criterion (a): keyed by/operating on the enemy entity `
		+ `iterated from KDMapData.Entities (already WORLD state), not the player slot (${file}:${line})`);
}

/**
 * ── direct callees of KinkyDungeonAdvanceTime (Game/src/base/game/KinkyDungeonGame.ts:3482-3829) ──
 */
const ADVANCE_TIME = {
	// world: runs once regardless of player count today being the bug — these are the rows the
	// probe (tests/unit/mp-turn-model-probe.spec.ts) measured running once per PLAYER today.
	KDCheckDespawn:              worldHelper('despawn sweep over map entities', 'Game/src/enemy/KinkyDungeonEnemies.ts', 3496),
	KinkyDungeonEnemyCheckHP:    worldHelper('HP/death sweep over map entities', 'Game/src/enemy/KinkyDungeonEnemies.ts', 3359),
	KDUnPackEnemy:               worldHelper('lazy-unpacks a map entity\'s cached Enemy def', 'Game/src/base/game/KinkyDungeonGame.ts', 766),
	KDUpdateCollectionFlags:     entry('world', 'floor population bookkeeping (criterion b) (Game/src/base/game/KinkyDungeonGame.ts near :3589)'),
	KDUpdatePersistentNPCFlags:  entry('world', 'persistent-NPC population bookkeeping (criterion b) (Game/src/base/game/KinkyDungeonGame.ts near :3590)'),
	KDTickCollectionWanderCollectionEntry: entry('world', 'per-collection wander state, keyed by the collection not a player (Game/src/base/game/KinkyDungeonGame.ts near :3591)'),
	KinkyDungeonUpdateJailKeys:  entry('world', 'reads KDMapData.EscapeMethod/KeysHeld (world map state); no player-entity reference (Game/src/prison/KinkyDungeonJail.ts:74)'),
	KDCommanderUpdate:           entry('world', 'assigns squad orders/chokepoints to enemies; reads the acting player\'s combat flags only as an INPUT, writes only enemy state (Game/src/enemy/KDCommander.ts:35)'),
	KDTickMaps:                  entry('world', 'repop queue / chest / NPC-cache bookkeeping across the world map graph, no player-entity reference (Game/src/map/KDRegiments.ts:40)'),
	KDGetEnemyCache:             entry('world', 'rebuilds a position->entity cache from KDMapData.Entities; no player-slot state (Game/src/base/game/KinkyDungeonGame.ts near :4073)'),
	KinkyDungeonMapGet:          entry('world', 'reads a tile from the shared grid (KDMapData, already WORLD_KEYS) (Game/src/base/game/KinkyDungeonGame.ts:341-ish getter family)'),
	KinkyDungeonVisionGet:       entry('world', 'reads KDMapExtraData.VisionGrid, part of the shared map (Game/src/base/game/KinkyDungeonGame.ts:1876)'),
	KinkyDungeonFogMemoryGet:    entry('world', 'reads KDMapData.FogMemory — KDMapData is already WORLD_KEYS whole (Game/src/base/game/KinkyDungeonGame.ts:1896)'),
	KinkyDungeonFogMemorySet:    entry('world', 'writes KDMapData.FogMemory — KDMapData is already WORLD_KEYS whole (Game/src/base/game/KinkyDungeonGame.ts:1899)'),
	KinkyDungeonFogSet:          entry('world', 'writes KDMapData.FogGrid — KDMapData is already WORLD_KEYS whole (Game/src/base/game/KinkyDungeonGame.ts:1893)'),
	KDGetAltType:                entry('world', 'pure read of a floor/map-mod-derived config object, no entity or player-slot write (Game/src/base/game/KinkyDungeonGame.ts:4338)'),

	// mixed: looked world-shaped, read the body, found a player-slot branch inside.
	KinkyDungeonUpdateAngel:     entry('mixed', 'gated by the per-player KinkyDungeonFlags "AngelHelp", but when it fires it MUTATES KDMapData.Tiles (world, shared map) via KinkyDungeonMapSet — a player-flag-gated world write (Game/src/faction/KinkyDungeonReputation.ts:709-724). NOT wrapped (verified by test, not assumed): this name is NOT a WORLD_MUTE_CANDIDATE, so it already runs on every apply, each reading the ACTING player\'s own AngelHelp flag (KinkyDungeonFlags already follows the slot) — and the world removal is naturally idempotent (the "Type == Angel" guard is false once already cleared), so a non-host human\'s own flag still clears the shared tile on THEIR apply, and a later apply re-checking an already-cleared tile is a harmless no-op. Same shape as KinkyDungeonUpdateBuffs below — correct without a new wrap'),
	KDUpdateEffectTiles:         entry('split', 'runs the player-standing-on-tile step for KinkyDungeonPlayerEntity specifically, THEN a separate per-enemy loop, THEN a grid-wide tick-down loop — three different scopes under one name (Game/src/map/KinkyDungeonTiles.ts:516-540). SPLIT: installTurnModel wraps the function — the world loops are muted on every apply but the round\'s one real tick; the player step is replicated every apply via KDGetEffectTiles + KinkyDungeonUpdateSingleEffectTile, the same two functions the engine itself calls for that step'),
	KinkyDungeonUpdateTileEffects: entry('split', 'KDTileUpdateFunctions[tile] fires for the tile under the ACTING player specifically; KDTileUpdateFunctionsLocal then runs over the WHOLE grid (Game/src/map/KinkyDungeonTiles.ts:90-103). SPLIT: installTurnModel wraps the function — the grid-wide loop is muted on every apply but the round\'s one real tick; the player step is replicated every apply via KDTileUpdateFunctions/KDPeripheralTileEffects, the same lookup/function the engine itself calls for that step'),
	KinkyDungeonUpdateBuffs:     entry('mixed', 'ticks KinkyDungeonPlayerEntity\'s buffs, then every map entity\'s, then applies bullet buffs to the player specifically (Game/src/effect/KinkyDungeonBuffs.ts:219-253). NOT wrapped itself — the per-entity split already happens one level down: KinkyDungeonTickBuffs (NAMED_BY_DESIGN_DOC, below) is wrapped to no-op for NPCs while muted, so this function\'s own per-player tick (never muted — entity===KinkyDungeonPlayerEntity) and its enemy loop (muted on every apply but the round\'s one real tick) already come out once-per-player / once-per-round respectively without a wrap on this name. Residual, NOT split: the bullet-buff-to-enemy loop inside this same function reapplies on every apply (not deduped to once per round) — tracked as a follow-up, not silently dropped'),
	KinkyDungeonUpdateTether:    entry('split', 'same function, called once for the player (AdvanceTime) and once per leashed enemy (the loops around it) — branches internally on entity===KinkyDungeonPlayerEntity (Game/src/restraint/KDTethers.ts:323). The player branch was already correct (never muted, follows the slot every apply, same shape as KinkyDungeonTickBuffs); the npc branch was already muted to once per round by the pre-existing entity-split wrap, but that one real call resolved an enemy\'s leash.entity===-1 ("the player", KDTethers.ts:203-210) against whoever HOSTS the round, not necessarily who actually got leashed. SPLIT (this task): installTurnModel\'s wrap now swaps in the leash\'s own owner (tagged "first touch" by the new HeadlessHost.tagOwnedTethers, called every apply like tagOwnedBullets) for that one real call, then swaps back — the same owner-tag + slot-swap shape as the bullet owner mechanism, never a reimplementation of the tether math'),
	KinkyDungeonUpdateBullets:   entry('split', 'per-bullet AOE player-effect check tests only KinkyDungeonPlayerEntity (the slot), while enemy-targeted effects iterate KDMapData.Entities — design doc risk #3 (Game/src/fight/KinkyDungeonFight.ts:2434); followPlayer bullets snap to the slot (Game/src/fight/KinkyDungeonFight.ts:1864). SPLIT: installTurnModel wraps the function — bullet physics (movement/lifetime) runs once per round (muted on every apply but the last); a followPlayer bullet tagged with a non-slot owner (tagOwnedBullets) is corrected to its own owner\'s avatar position after the real call returns; KinkyDungeonPlayerEffect (below) is wrapped separately to replay the AOE player-effect test against every OTHER joined human'),
	KinkyDungeonUpdateBulletsCollisions: entry('split', 'direct hits branch on entity.player per collided entity (player path vs enemy path) — design doc risk #3 (Game/src/fight/KinkyDungeonFight.ts:2287-2301). SPLIT: installTurnModel mutes the function wholesale on every apply but the round\'s one real tick (bullet/entity collision resolution is world physics, run once per round); the per-entity player/enemy branch inside is closed by a separate, one-level-deeper wrap on KDBulletHitEnemy (NAMED_BY_DESIGN_DOC, below) — see that entry'),
	KinkyDungeonUpdateEnemies:   entry('split', 'player-only pre/post code (dialogue tick, TorsoGrabCD, leashed-player jail door, alert/hostile-faction distance checks against KinkyDungeonPlayerEntity, KDRunDefeatForEnemy at the end) interleaved with the per-enemy world loops — design doc risk #2 (Game/src/enemy/KinkyDungeonEnemies.ts:4305-4341, 4905-4918, 5070-5072). The per-enemy loops (target choice, defeat routing) already have their own bespoke wraps (KinkyDungeonNearestPlayer/KDRunDefeatForEnemy, below). SPLIT (this task): installTurnModel\'s own KinkyDungeonUpdateEnemies wrap (called twice per real tick with Allied true/false) now also replicates the two PLAYER-only statements the wholesale mute was silently dropping for every apply but the host\'s — KinkyDungeonUpdateDialogue(KinkyDungeonPlayerEntity, maindelta) when Allied, and the KDGameData.KinkyDungeonLeashedPlayer countdown + nearby jail-door auto-unlock when not Allied — by calling the SAME statements the engine itself runs for that step. KinkyDungeonTorsoGrabCD, the other half of the same "else" branch, is a bare world counter (no entity) and correctly stays muted to once per round'),
	KinkyDungeonSendEvent:       entry('mixed', 'fans out to player dispatchers (magic/weapon/inventory*/buff/outfit) and world ones (bullet/enemy/generic/alt/facility/listener) under one call (Game/src/effect/KinkyDungeonEvents.ts:62-78). Investigated per-dispatcher (see EVENT_DISPATCH below, this task): every child is now independently classified world/player, or — for KinkyDungeonSendBulletEvent/KinkyDungeonSendEnemyEvent — documented as mixed along a DIFFERENT axis (the triggering Event NAME, not the data it reads). KinkyDungeonSendEvent itself is a flat, unconditional dispatcher with no behaviour of its own besides calling its 14 children in sequence, so it needs no wrap of its own once each child is handled correctly — left mixed here only as a label for "composed of both kinds", same precedent as KinkyDungeonUpdateBuffs'),

	// player: player-local work; correctly runs once per player's own apply and must stay that way.
	KinkyDungeonItemCheck:        entry('player', 'the acting player\'s own item/equip pass — measured once-per-player-correct by the probe (Game/src/item/KinkyDungeonItem.ts:279)'),
	KinkyDungeonUpdateStats:      entry('player', 'the acting player\'s own stat recompute (Game/src/player/KinkyDungeonStats.ts:1655)'),
	KinkyDungeonHandleMoveToTile: entry('player', 'reacts to the tile under KinkyDungeonPlayerEntity specifically (Game/src/map/KinkyDungeonTiles.ts:109)'),
	KinkyDungeonResetEventVariablesTick: entry('player', 'resets KinkyDungeonAttackTwiceFlag and KDEventDataReset, the acting player\'s own per-turn combat flags (Game/src/effect/KinkyDungeonEvents.ts:75-79)'),
	KDDoMumble:                   entry('player', 'called with KDPlayer() — the acting player\'s own mumble/dialogue tick (Game/src/base/game/KinkyDungeonGame.ts, called at :3700-ish)'),
	KinkyDungeonSendActionMessage: entry('player', 'pushes to the acting player\'s own message log (Game/src/base/game/KinkyDungeonGame.ts:2621)'),
	KinkyDungeonSendTextMessage:  entry('player', 'pushes to the acting player\'s own message log (Game/src/base/game/KinkyDungeonGame.ts:2591)'),
	KinkyDungeonDressPlayer:      entry('player', 'rebuilds the acting Character\'s appearance (Game/src/player/KinkyDungeonDress.ts:138)'),
	KDUpdateForceOutfit:          entry('player', 'called with KinkyDungeonPlayer — forces the acting player\'s own outfit (Game/src/base/game/KinkyDungeonGame.ts:4441)'),
	KDQuestTick:                  entry('player', 'ticks KDGameData.Quests, not in KDGAMEDATA_WORLD_KEYS — per-player (Game/src/faction/KinkyDungeonQuest.ts:1121)'),
	KDTickNeeds:                  entry('player', 'mutates KinkyDungeonGoddessRep and KDGameData.OrgasmTurns, neither world-listed — per-player needs (Game/src/player/KinkyDungeonNeeds.ts:22)'),
	KinkyDungeonUpdateFlags:      entry('player', 'ticks KinkyDungeonFlags, the per-player flag map (same bucket as KinkyDungeonSetFlag) (Game/src/enemy/KinkyDungeonEnemies.ts:303)'),
	KinkyDungeonSetFlag:          entry('player', 'writes KinkyDungeonFlags — a per-player flag map (e.g. "DangerFlag", "Quickness"), visible on that player\'s own HUD (Game/src/enemy/KinkyDungeonEnemies.ts:276)'),
	KinkyDungeonParseExtraWarningTiles: entry('player', 'populates KDGameData.WarningTiles, reset to {} earlier in the SAME apply, not in KDGAMEDATA_WORLD_KEYS — per-player overlay (Game/src/fight/KinkyDungeonFight.ts near :4113)'),
	KinkyDungeonInDanger:         entry('player', 'pure read of the acting player\'s own stats/flags (Game/src/enemy/KinkyDungeonEnemies.ts:683)'),
	KDAutoSprintCriteria:         entry('player', 'always called with KDPlayer() at this call site; reads the given entity\'s own stats (Game/src/base/game/KinkyDungeonGame.ts:4885)'),
	KinkyDungeonMultiplayerUpdate: entry('player', 'placeholder — "Do nothing. Placeholder for when/if there is ever any MP functionality" (Game/src/base/KinkyDungeon.ts:7930)'),
	KinkyDungeonUpdateBulletVisuals: entry('player', 'client-side sprite-cache bookkeeping (KinkyDungeonBulletsVisual), same bucket as KinkyDungeonCanvas — rendering is per-viewer (Game/src/fight/KinkyDungeonFight.ts:2197)'),
	KDPlayer:                     entry('player', 'returns KinkyDungeonPlayerEntity — the definition of per-player (Game/src/base/KDModUtils.ts:521)'),
	KDGetGlobalEntity:            entry('world', 'resolves an id against KDGameData.Party / map entities — world lookup, no write (Game/src/enemy/KDPersistence.ts:528)'),
};

/**
 * ── direct callees of KinkyDungeonUpdateEnemies (Game/src/enemy/KinkyDungeonEnemies.ts:4265-5072) ──
 * The default bucket (world, criterion a) covers the per-enemy bookkeeping helpers; only the
 * overrides below were found, by reading the body, to touch the player slot.
 */
const UPDATE_ENEMIES = {
	// mixed / player overrides — the ones that matter.
	KinkyDungeonNearestPlayer: entry('mixed', 'the per-enemy target-choice hook (5-arg caller); design B\'s core switch point — must choose WHICH human, not just "the player" (Game/src/enemy/KinkyDungeonEnemies.ts:436-492, call at :4683)'),
	KinkyDungeonEnemyLoop:     entry('mixed', 'branches on player.player 54 times; the only engine-native path to bind/grab/tease/leash/dialogue, so it must run against a REAL player in the slot (Game/src/enemy/KinkyDungeonEnemies.ts:5340)'),
	KDRunDefeatForEnemy:       entry('mixed', 'defeat finalisation runs with whoever is in the slot at that moment — must be routed to the human the defeating enemy actually faced, design doc risk #1 (Game/src/enemy/KinkyDungeonEnemies.ts:5075)'),
	KinkyDungeonUpdateDialogue: entry('mixed', 'same function, called once for KinkyDungeonPlayerEntity (player dialogue tick) and once per enemy inside the loop (Game/src/enemy/KinkyDungeonEnemies.ts:4306,4310)'),
	KinkyDungeonAggressive:    entry('mixed', 'the PrisonerState branch judges against "the player" (Player-mode guard); kept per-player deliberately by mp-transition-write-audit\'s own register entry for KDGameData.PrisonerState (Game/src/faction/KinkyDungeonFactions.ts:8-16)'),
	KDPlayerIsDefeated:        entry('player', 'reads the acting player\'s own defeat state (Game/src/enemy/KinkyDungeonEnemies.ts near :4190 family)'),
	KDPlayerIsStunned:         entry('player', 'reads the acting player\'s own stun state (Game/src/enemy/KinkyDungeonEnemies.ts near :4183 family)'),
	KDIsPlayerTetheredToEntity: entry('player', 'reads the acting player\'s own tether target (Game/src/enemy/KinkyDungeonEnemies.ts, used at :4295)'),
	KinkyDungeonLeashingEnemy: entry('player', 'reads KDGameData.KinkyDungeonLeashingEnemy, not in KDGAMEDATA_WORLD_KEYS — per-player (Game/src/enemy/KinkyDungeonEnemies.ts, used at :4295)'),
	KinkyDungeonAngel:         entry('mixed', 'same function as in ADVANCE_TIME above — also reachable from this loop\'s own control flow in some branches; see that entry (Game/src/faction/KinkyDungeonReputation.ts:709-724)'),
	KDPlayer:                  entry('player', 'see ADVANCE_TIME.KDPlayer (Game/src/base/KDModUtils.ts:521)'),
	KinkyDungeonSetFlag:       entry('player', 'see ADVANCE_TIME.KinkyDungeonSetFlag (Game/src/enemy/KinkyDungeonEnemies.ts:276)'),
	KinkyDungeonVisionGet:     entry('world', 'see ADVANCE_TIME.KinkyDungeonVisionGet (Game/src/base/game/KinkyDungeonGame.ts:1876)'),
	KinkyDungeonMapGet:        entry('world', 'see ADVANCE_TIME.KinkyDungeonMapGet (Game/src/base/game/KinkyDungeonGame.ts:341)'),
	KinkyDungeonSendEvent:     entry('mixed', 'same function as ADVANCE_TIME.KinkyDungeonSendEvent — see that entry (Game/src/effect/KinkyDungeonEvents.ts:62-78)'),

	// world — per-enemy bookkeeping/lookup helpers, the default bucket (criterion a).
	KDAddDistraction:          worldHelper('distraction/struggle meter on the enemy', 'Game/src/enemy/KinkyDungeonEnemies.ts', 10844),
	KDAddThought:              worldHelper('a thought bubble keyed by enemy id', 'Game/src/enemy/KinkyDungeonEnemies.ts', 5298),
	KDAddWarning:              worldHelper('a warning-tile record on the shared map', 'Game/src/fight/KinkyDungeonFight.ts', 4113),
	KDAllied:                  worldHelper('faction check on the enemy', 'Game/src/faction/KinkyDungeonFactions.ts', 33),
	KDBlockDodgeStat:          worldHelper('pure stat-curve math, no entity at all', 'Game/src/enemy/KinkyDungeonEnemies.ts', 3670),
	KDBoundEffects:            worldHelper('reads the enemy\'s own bound level', 'Game/src/enemy/KinkyDungeonEnemies.ts', 4242),
	KDBreakTether:             worldHelper('breaks the given entity\'s tether; called here for the enemy side', 'Game/src/restraint/KDTethers.ts', 245),
	KDCanIdleFidget:           worldHelper('idle-animation eligibility for the enemy', 'Game/src/enemy/KinkyDungeonEnemies.ts', 11011),
	KDCaptureNearby:           worldHelper('captures nearby HELPLESS entities (companions/NPCs), reads KDPlayer() only as a distance input, writes only enemy hp', 'Game/src/enemy/KinkyDungeonEnemies.ts', 8889),
	KDCheckVulnerableBackstab: worldHelper('reads the enemy\'s own facing/vulnerability', 'Game/src/enemy/KinkyDungeonEnemies.ts', 5257),
	KDClearItems:              worldHelper('clears the enemy\'s own loot/items', 'Game/src/enemy/KinkyDungeonEnemies.ts', 9182),
	KDEnemyAddSound:           worldHelper('adds to the enemy\'s own sound/alert meter', 'Game/src/enemy/KinkyDungeonEnemies.ts', 9732),
	KDEnemyCanSignalMap:       worldHelper('enemy alert-signalling eligibility', 'Game/src/enemy/KinkyDungeonEnemies.ts', 9936),
	KDEnemyCanSignalOthers:    worldHelper('enemy alert-signalling eligibility', 'Game/src/enemy/KinkyDungeonEnemies.ts', 9943),
	KDEnemyChangeSprint:       worldHelper('the enemy\'s own sprint meter', 'Game/src/enemy/KinkyDungeonEnemies.ts', 10195),
	KDEnemyDecayBindStun:      worldHelper('the enemy\'s own bind/stun decay', 'Game/src/enemy/KinkyDungeonEnemies.ts', 11650),
	KDEnemyHasFlag:            worldHelper('reads an enemy-keyed flag', 'Game/src/enemy/KinkyDungeonEnemies.ts', 1285),
	KDEnemyHasHelp:            worldHelper('reads whether other enemies are helping this one', 'Game/src/enemy/KinkyDungeonEnemies.ts', 1882),
	KDEnemySoundDecay:         worldHelper('the enemy\'s own sound meter decay', 'Game/src/enemy/KinkyDungeonEnemies.ts', 9696),
	KDEnemyStruggleTurn:       worldHelper('the enemy\'s own struggle-against-bondage turn', 'Game/src/enemy/KinkyDungeonEnemies.ts', 11195),
	KDEnemyVisionRadius:       worldHelper('the enemy\'s own vision radius', 'Game/src/enemy/KinkyDungeonEnemies.ts', 423),
	KDEntityBuffedStat:        worldHelper('reads a buffed stat off the given entity (enemy at this call site)', 'Game/src/effect/KinkyDungeonBuffs.ts', 488),
	KDEntityMaxBuffedStat:     worldHelper('reads a buffed stat off the given entity (enemy at this call site)', 'Game/src/effect/KinkyDungeonBuffs.ts', 500),
	KDFactionHostile:          worldHelper('faction-string relation lookup', 'Game/src/faction/KinkyDungeonFactions.ts', 120),
	KDFactionRelation:         worldHelper('faction-string relation lookup', 'Game/src/faction/KinkyDungeonFactionsList.ts', 1025),
	KDGetBaseBlock:            worldHelper('reads the enemy\'s own base block stat', 'Game/src/enemy/KinkyDungeonEnemies.ts', 10768),
	KDGetBaseDodge:            worldHelper('reads the enemy\'s own base dodge stat', 'Game/src/enemy/KinkyDungeonEnemies.ts', 10790),
	KDGetColor:                worldHelper('the enemy\'s own display color', 'Game/src/enemy/KinkyDungeonEnemies.ts', 3227),
	KDGetEnemyDistractRate:    worldHelper('the enemy\'s own distraction-decay rate', 'Game/src/enemy/KinkyDungeonEnemies.ts', 1969),
	KDGetEnemyDistractionDamage: worldHelper('the enemy\'s own distraction damage', 'Game/src/enemy/KinkyDungeonEnemies.ts', 1984),
	KDGetEnemyPlayLine:        worldHelper('the enemy\'s own dialogue line pick', 'Game/src/enemy/KinkyDungeonEnemies.ts', 5320),
	KDGetFaction:              worldHelper('faction-string lookup for an enemy or string', 'Game/src/faction/KinkyDungeonFactions.ts', 84),
	KDGetFactionOriginal:      worldHelper('faction-string lookup for an enemy', 'Game/src/faction/KinkyDungeonFactions.ts', 104),
	KDGetGenericDialogueParams: worldHelper('builds dialogue template params for an enemy', 'Game/src/dialogue/KinkyDungeonDialogue.ts', 3189),
	KDGetHonor:                worldHelper('faction-string honor lookup', 'Game/src/faction/KinkyDungeonFactions.ts', 190),
	KDGetJailDoor:             worldHelper('reads a shared jail-door tile', 'Game/src/prison/KinkyDungeonJail.ts', 1278),
	KDGetMaxBlock:             worldHelper('reads the enemy\'s own max block stat', 'Game/src/enemy/KinkyDungeonEnemies.ts', 10745),
	KDGetMaxDodge:             worldHelper('reads the enemy\'s own max dodge stat', 'Game/src/enemy/KinkyDungeonEnemies.ts', 10756),
	KDGetMaxShield:            worldHelper('reads the enemy\'s own max shield stat', 'Game/src/enemy/KinkyDungeonEnemies.ts', 2033),
	KDGetShieldRegen:          worldHelper('reads the enemy\'s own shield regen stat', 'Game/src/enemy/KinkyDungeonEnemies.ts', 2040),
	KDHelpless:                worldHelper('reads the enemy\'s own helpless state', 'Game/src/enemy/KinkyDungeonEnemies.ts', 348),
	KDHostile:                 worldHelper('faction-based hostility between two entities', 'Game/src/faction/KinkyDungeonFactions.ts', 43),
	KDIsImprisoned:            worldHelper('reads the ENEMY\'s own imprisoned state (takes `enemy`, not the player)', 'Game/src/map/KDMapGen.ts', 962),
	KDIsTimeImmune:            worldHelper('reads the enemy\'s own time-immunity tag', 'Game/src/enemy/KinkyDungeonEnemies.ts', 10835),
	KDMaintainEnemyAction:     worldHelper('the enemy\'s own action-state maintenance', 'Game/src/enemy/KinkyDungeonEnemiesList.ts', 7281),
	KDMakeHostile:             worldHelper('flips the given enemy hostile', 'Game/src/enemy/KinkyDungeonEnemies.ts', 5237),
	KDNPCStruggleThreshMult:   worldHelper('the enemy\'s own struggle threshold multiplier', 'Game/src/collection/NPCRestrain.ts', 1412),
	KDOpinionRepMod:           worldHelper('reads the enemy\'s own opinion/rep modifier (player is a distance input, not written)', 'Game/src/faction/KinkyDungeonFactions.ts', 64),
	KDRemoveEntity:            worldHelper('removes the enemy entity from the shared map', 'Game/src/enemy/KinkyDungeonEnemies.ts', 10655),
	KDRestockRestraints:       worldHelper('restocks the enemy\'s own restraint supply', 'Game/src/enemy/KinkyDungeonEnemies.ts', 9075),
	KDRestraintBondageStatus:  worldHelper('pure function of a restraint item, no entity at all', 'Game/src/restraint/KinkyDungeonRestraints.ts', 404),
	KDSelfishLeashFaction:     worldHelper('faction-string lookup', 'Game/src/enemy/KinkyDungeonEnemies.ts', 9616),
	KDShouldUnLock:            worldHelper('reads a shared jail-door tile\'s lock', 'Game/src/map/KinkyDungeonTiles.ts', 1007),
	KDUpdatePersistentNPC:     entry('world', 'persistent-NPC population bookkeeping (criterion b) (Game/src/enemy/KDPersistence.ts near :528)'),
	KDUpdateRestraintMetadata: worldHelper('rebuilds a cache entry keyed by enemy id', 'Game/src/enemy/KinkyDungeonEnemies.ts', 4459),
	KDUnPackEnemy:             worldHelper('lazy-unpacks a map entity\'s cached Enemy def', 'Game/src/base/game/KinkyDungeonGame.ts', 766),
	KDistChebyshev:            worldHelper('pure coordinate math, no entity at all', 'Game/src/base/KinkyDungeon.ts', 977),
	KinkyDungeonAllConsumable: worldHelper('reads the acting player\'s inventory as a decoy-check input only; writes nothing', 'Game/src/item/KinkyDungeonInventory.ts', 792),
	KinkyDungeonAllWeapon:     worldHelper('same as KinkyDungeonAllConsumable', 'Game/src/item/KinkyDungeonInventory.ts', 804),
	KinkyDungeonApplyBuffToEntity: worldHelper('applies a buff to the given entity (enemy at this call site)', 'Game/src/effect/KinkyDungeonBuffs.ts', 404),
	KinkyDungeonCheckPath:     worldHelper('pure pathing/LOS math over the shared grid', 'Game/src/base/KinkyDungeonVision.ts', 67),
	KinkyDungeonDamageEnemy:   worldHelper('damages the given ENEMY (not the player — KinkyDungeonDealDamage is the player path)', 'Game/src/fight/KinkyDungeonFight.ts', 1581),
	KinkyDungeonFindID:        worldHelper('entity lookup by id over the shared map', 'Game/src/enemy/KinkyDungeonEnemies.ts', 8462),
	KinkyDungeonFindMaster:    worldHelper('walks the enemy master/summon hierarchy', 'Game/src/enemy/KinkyDungeonEnemies.ts', 4359),
	KinkyDungeonGetBuffedStat: worldHelper('pure function of a buff list, no entity at all', 'Game/src/effect/KinkyDungeonBuffs.ts', 330),
	KinkyDungeonHandleJailSpawns: entry('world', 'floor population bookkeeping (criterion b) (Game/src/prison/KinkyDungeonJail.ts:664)'),
	KinkyDungeonHandleTilesEnemy: worldHelper('enemy-on-tile interaction (traps/hazards) for the enemy', 'Game/src/map/KinkyDungeonTiles.ts', 46),
	KinkyDungeonHandleTraps:   worldHelper('entity-on-trap interaction for the enemy', 'Game/src/map/KinkyDungeonTraps.ts', 411),
	KinkyDungeonHandleWanderingSpawns: entry('world', 'floor population bookkeeping (criterion b) (Game/src/enemy/KinkyDungeonSpawns.ts:414)'),
	KinkyDungeonIsDisabled:    worldHelper('reads the enemy\'s own disabled state', 'Game/src/enemy/KinkyDungeonEnemies.ts', 4190),
	KinkyDungeonIsStunned:     worldHelper('reads the enemy\'s own stun state', 'Game/src/enemy/KinkyDungeonEnemies.ts', 4183),
	KinkyDungeonJailGuard:     entry('world', 'reads KDGameData.JailGuard, already in KDGAMEDATA_WORLD_KEYS (Game/src/enemy/KinkyDungeonEnemies.ts near :4321)'),
	KinkyDungeonMapSet:        worldHelper('writes a tile on the shared grid', 'Game/src/base/game/KinkyDungeonGame.ts', 1770),
	KinkyDungeonMultiplicativeStat: worldHelper('pure stat-curve math, no entity at all', 'Game/src/enemy/KinkyDungeonEnemies.ts', 3660),
	KinkyDungeonNearestJailPoint: worldHelper('nearest-jail-point lookup over shared jail data', 'Game/src/enemy/KinkyDungeonEnemies.ts', 143),
	KinkyDungeonSendDialogue:  worldHelper('the enemy\'s own dialogue bubble', 'Game/src/player/KinkyDungeonStats.ts', 936),
	KinkyDungeonSetEnemyFlag:  worldHelper('writes an enemy-keyed flag', 'Game/src/enemy/KinkyDungeonEnemies.ts', 1239),
	KinkyDungeonStartChase:    worldHelper('the enemy\'s own chase/alert state', 'Game/src/prison/KinkyDungeonJail.ts', 311),
	KinkyDungeonTickFlagsEnemy: worldHelper('ticks down enemy-keyed flags', 'Game/src/enemy/KinkyDungeonEnemies.ts', 4120),
	KinkyDungeonTilesGet:      worldHelper('reads a shared-map tile record', 'Game/src/base/game/KinkyDungeonGame.ts', 341),
	KDGetAltType:              entry('world', 'see ADVANCE_TIME.KDGetAltType (Game/src/base/game/KinkyDungeonGame.ts:4338)'),
	KDRandom:                  entry('world', 'the shared seeded RNG stream — consuming it advances world generation state, same bucket as KinkyDungeonSeed in GLOBAL_BLACKLIST (Game/src/base/KinkyDungeon.ts:7688, `let`, not `function`)'),
	KDResetIntent:             worldHelper('resets the enemy\'s own AI intent state', 'Game/src/enemy/KinkyDungeonEnemyEventList.ts', 1769),
};

/**
 * ── the 14 dispatchers inside KinkyDungeonSendEvent's own body (Game/src/effect/KinkyDungeonEvents.ts:62-78) ──
 * `KDSendNPCRestraintEvent` is conditional (`if (data.NPCRestraintEvents)`); the other 13 are
 * unconditional. Classified from the design doc's own split: "player dispatchers (magic/weapon/
 * inventory/buff/outfit) and world ones (bullet/enemy/generic/alt/facility)" — with the two the
 * design doc separately flags as an open risk (generic/listener — "mixed and currently run once per
 * player") kept mixed here rather than folded into "world".
 */
const EVENT_DISPATCH = {
	KinkyDungeonSendMagicEvent:       entry('player', 'player spell/magic event dispatch (Game/src/effect/KinkyDungeonEvents.ts:64)'),
	KinkyDungeonSendWeaponEvent:      entry('player', 'player weapon event dispatch (Game/src/effect/KinkyDungeonEvents.ts:65)'),
	KinkyDungeonSendInventorySelectedEvent: entry('player', 'player inventory-selection event dispatch (Game/src/effect/KinkyDungeonEvents.ts:66)'),
	KinkyDungeonSendInventoryIconEvent: entry('player', 'player inventory-icon event dispatch (Game/src/effect/KinkyDungeonEvents.ts:67)'),
	KinkyDungeonSendInventoryEvent:   entry('player', 'player inventory event dispatch (Game/src/effect/KinkyDungeonEvents.ts:68)'),
	KDSendNPCRestraintEvent:          entry('world', 'NPC-restraint event dispatch, conditional on data.NPCRestraintEvents (Game/src/effect/KinkyDungeonEvents.ts:69-70)'),
	// KinkyDungeonSendBulletEvent/KinkyDungeonSendEnemyEvent: investigated by reading the bodies (this
	// task), not guessed. Neither function's OWN body ever reads player-slot state — both are purely
	// keyed by WORLD entities (KDMapData.Bullets / KDMapData.Entities, already world under criterion
	// (a)), so by DATA alone each would classify as plain `world`. The real mixing is along a
	// DIFFERENT axis, confirmed live: `KinkyDungeonSendAltEvent`'s own native "tick" handler
	// (KDEventMapAlt.tick.PerkRoom, KinkyDungeonEvents.ts:13973-13979) proves the generic "tick" Event
	// fires through SendEvent on every apply today (never muted), so a periodic world-tick-driven
	// bullet/enemy event dispatch currently fires once per PLAYER, not once per round — the same bug
	// shape as the four names already split. But the SAME dispatcher also carries player-ACTION-
	// triggered Event names (a spell's own "oncast"/"onhit" firing synchronously inside the CASTING
	// player's one real apply) which MUST keep running on every apply, not be muted to once per round —
	// wholesale-muting these two names (adding them to WORLD_MUTE_CANDIDATES) would silently drop a
	// player's own spell/weapon bullet or enemy event the instant it is cast. Correctly splitting this
	// pair needs enumerating which Event NAME strings are periodic-world-cadence versus per-action
	// one-shot across the whole codebase — a separate, larger problem than this task's per-FUNCTION
	// scope; filed as a precise follow-up rather than guessed at; event-cadence split is still open.
	KinkyDungeonSendBulletEvent:      entry('mixed', 'purely WORLD-keyed by DATA (KDMapData.Bullets), but mixed along the Event-NAME axis instead — a periodic "tick" dispatch must be once-per-round, a player-action-triggered one ("oncast"/"onhit") must run on every apply; see EVENT_DISPATCH\'s own header comment above this entry (Game/src/effect/KinkyDungeonEvents.ts:71)'),
	KinkyDungeonSendBuffEvent:        entry('player', 'player buff event dispatch (Game/src/effect/KinkyDungeonEvents.ts:72)'),
	KinkyDungeonSendOutfitEvent:      entry('player', 'player outfit event dispatch (Game/src/effect/KinkyDungeonEvents.ts:73)'),
	KinkyDungeonSendEnemyEvent:       entry('mixed', 'purely WORLD-keyed by DATA (KDMapData.Entities), but mixed along the SAME Event-NAME axis as KinkyDungeonSendBulletEvent above — see that entry\'s own reason and the EVENT_DISPATCH header comment (Game/src/effect/KinkyDungeonEvents.ts:74)'),
	// KinkyDungeonHandleGenericEvent/KinkyDungeonHandleListenerEvent: investigated by reading the
	// bodies (this task), not guessed. Both dispatch purely through their own registries
	// (KDEventMapGeneric / KDEventMapListener + KDGameData.ListenerIndex/ListenerList), and
	// KDEventMapGeneric is ALREADY classified `per-player` (SLOT_SWAP_GLOBALS below) — deliberately
	// re-asserted on every slot switch by its own setPartyGate mechanism — so a handler registered on
	// one human's bundle only ever fires from THAT human's own apply (confirmed by test: a hook
	// registered on a non-host human's bundle fired on their own apply, not the host's). Neither
	// function is a WORLD_MUTE_CANDIDATE, so both already run on every apply, correctly dispatching to
	// whoever is currently swapped in — reclassified `player`, no wrap needed (KDGameData.ListenerIndex/
	// ListenerList are not in KDGAMEDATA_WORLD_KEYS either, same per-player bucket).
	KinkyDungeonHandleGenericEvent:   entry('player', 'dispatches through KDEventMapGeneric, an already-per-player registry (SLOT_SWAP_GLOBALS) re-asserted on every slot switch — fires correctly for whoever is swapped in on their own apply, confirmed by test (Game/src/effect/KinkyDungeonEvents.ts:75)'),
	KinkyDungeonHandleListenerEvent:  entry('player', 'dispatches through KDGameData.ListenerIndex/ListenerList, neither in KDGAMEDATA_WORLD_KEYS — per-player, same reasoning as KinkyDungeonHandleGenericEvent above (Game/src/effect/KinkyDungeonEvents.ts:76)'),
	KinkyDungeonSendAltEvent:         entry('world', 'alt-floor-type event dispatch, keyed by the floor not a player (Game/src/effect/KinkyDungeonEvents.ts:77)'),
	KinkyDungeonSendFacilityEvent:    entry('world', 'facility event dispatch, keyed by map facilities not a player (Game/src/effect/KinkyDungeonEvents.ts:78)'),
};

/**
 * One level deeper than the declared scope (not a direct callee of either audited function), but
 * named explicitly by the design doc as a split point the muting must account for, and wrapped
 * directly by the investigation probe. Kept here, clearly marked, rather than silently dropped.
 */
const NAMED_BY_DESIGN_DOC = {
	KinkyDungeonTickBuffs: entry('mixed', 'branches on entity === KinkyDungeonPlayerEntity vs an NPC; called from inside KinkyDungeonUpdateBuffs, one level below the audited scope (Game/src/effect/KinkyDungeonBuffs.ts:85)'),
	KDBulletHitEnemy: entry('split', 'the enemy-path sink KinkyDungeonUpdateBulletsCollisions\'s entity loop calls for every collided entity (Game/src/fight/KinkyDungeonFight.ts:3142), one level below that function\'s own audited scope — only ever NPC-style damage (KinkyDungeonDamageEnemy) plus a restraint bind-tag shortcut, never the real player pipeline (KinkyDungeonPlayerEffect) a slot occupant gets for the SAME bullet (KDBulletHitPlayer, :3134). SPLIT: installTurnModel wraps it to detect when the "enemy" argument is actually one of this round\'s avatar stand-ins (globalThis.__kdSlotAvatarIds) and, for that case only, swap the owning human into the slot and resolve the SAME bullet through the real KDBulletHitPlayer instead — exactly as it would if they already held the slot — using the shared __kdReplayPlayerHit helper for bulletObj.alreadyHit (see KinkyDungeonPlayerEffect\'s entry below for why that one piece cannot be made per-player). A real monster or any other entity (not a joined human\'s avatar) falls through to the original function unchanged.'),
	KinkyDungeonPlayerEffect: entry('split', 'the sink every AOE bullet player-effect call resolves to — always called with KinkyDungeonPlayerEntity as the target by its engine call sites, so it only ever reaches the slot occupant (Game/src/magic/KinkyDungeonPlayerEffects.ts:2727, called from Game/src/fight/KinkyDungeonFight.ts:2434/:2694, the pinned aoePlayerEffectFanOut text-coupled site below). SPLIT: installTurnModel wraps it to, after the real call lets the slot occupant\'s own effect resolve, replay the identical AOE test (AOECondition + KDBulletAoEMod, the same two functions the engine call site itself uses) against every OTHER joined human\'s avatar position and call KinkyDungeonPlayerEffect again for any in range, swapped into the slot for that one call. One level below the audited scope, same bucket as KinkyDungeonTickBuffs above. The replay\'s swap also closes a once-residual gap for free: KDPlayerHitBy (a hitTag\'s own dedup array, magic/KinkyDungeonMagic.ts:44) is a plain, non-blacklisted script GLOBAL, so the real per-human swap (capturePlayer/restorePlayer, not a position-only move) already carries each human their OWN copy — a hitTag effect dedupes per human, not once for the whole round, with no extra code needed. bulletObj.alreadyHit (KDBulletAlreadyHit, KinkyDungeonStats.ts:545) is the one piece that genuinely CANNOT be made per-player this way, because it is a property on the shared WORLD bullet object, not a global at all — see __kdReplayPlayerHit\'s own doc comment (headless-host.js) for the unmark/remark workaround that remains for it.'),
};

/** The merged register the guard spec checks against. Later sources do not override earlier ones here — every name appears once. */
const TURN_CALL_CLASSIFICATION = Object.freeze(
	Object.assign({}, ADVANCE_TIME, UPDATE_ENEMIES, EVENT_DISPATCH, NAMED_BY_DESIGN_DOC),
);

/**
 * ── text-coupled sites that cannot be wrapped (inline statements, not functions) ──
 * Pinned by exact match COUNT, per the repo's rule for text-coupled work. A count that drops means
 * upstream removed or renamed the statement; a count that rises means upstream added a second one
 * the turn model has not accounted for. Either way: log drift loudly, do not silently adjust.
 */
const TEXT_COUPLED_SITES = Object.freeze({
	worldClockIncrement: Object.freeze({
		file: 'Game/src/base/game/KinkyDungeonGame.ts',
		pattern: 'KinkyDungeonCurrentTick += delta',
		expectedCount: 1,
		why: 'the world clock increment inline inside KinkyDungeonAdvanceTime — no wrapper can mute an inline statement; a muted apply must hand the clock back instead (the probe does this) (KinkyDungeonGame.ts:3721)',
	}),
	aoePlayerEffectFanOut: Object.freeze({
		file: 'Game/src/fight/KinkyDungeonFight.ts',
		pattern: 'b.bullet.spell.playerEffect || b.bullet.playerEffect) && AOECondition(b.x, b.y, KinkyDungeonPlayerEntity.x, KinkyDungeonPlayerEntity.y,',
		expectedCount: 2,
		why: 'the AOE player-effect fan-out tests only the slot (KinkyDungeonPlayerEntity) — a 2-human AOE needs this replicated per human, design doc risk #3 (KinkyDungeonFight.ts:2434, :2694)',
	}),
	// The following three sites are the exact statements installTurnModel's own KinkyDungeonUpdateEnemies
	// wrap (ueWrapped, headless-host.js) REPLICATES while muted, rather than calling through to the real
	// function — see KinkyDungeonUpdateEnemies' own turn-classification.js entry above. Per the repo's
	// text-coupled-work rule, copied engine logic (not called through) gets a drift guard: these three
	// pin the replicated text by exact match count so the audit spec goes red the moment upstream
	// changes the shape this wrap assumes, instead of the copy silently going stale.
	ueDialogueTick: Object.freeze({
		file: 'Game/src/enemy/KinkyDungeonEnemies.ts',
		pattern: 'KinkyDungeonUpdateDialogue(KinkyDungeonPlayerEntity, maindelta);',
		expectedCount: 1,
		why: 'the acting player\'s own dialogue-duration decay inside the Allied branch of KinkyDungeonUpdateEnemies — replicated verbatim by ueWrapped while muted so every human\'s own dialogue still ticks down, not just the round\'s host (KinkyDungeonEnemies.ts:4306)',
	}),
	ueLeashedPlayerCountdown: Object.freeze({
		file: 'Game/src/enemy/KinkyDungeonEnemies.ts',
		pattern: 'KDGameData.KinkyDungeonLeashedPlayer -= 1;',
		expectedCount: 1,
		why: 'the acting player\'s own leashed-to-jail countdown inside the non-Allied branch of KinkyDungeonUpdateEnemies — replicated verbatim by ueWrapped while muted (KDGameData.KinkyDungeonLeashedPlayer is per-player, not in KDGAMEDATA_WORLD_KEYS) so every human\'s own countdown still decays, not just the round\'s host (KinkyDungeonEnemies.ts:4321-4322)',
	}),
	ueLeashedPlayerJailUnlock: Object.freeze({
		file: 'Game/src/enemy/KinkyDungeonEnemies.ts',
		pattern: 'jaildoor?.Lock && jaildoor.Type == "Door" && KDShouldUnLock(xx, yy, jaildoor)',
		expectedCount: 1,
		why: 'the nearby jail-door auto-unlock condition the leashed-player countdown above gates — replicated verbatim by ueWrapped (same wrap, same branch) so a non-host human\'s own nearby jail door still auto-unlocks on their own apply (KinkyDungeonEnemies.ts:4327)',
	}),
});

/**
 * ── SLOT-SWAP GLOBAL AUDIT (a different question from TURN_CALL_CLASSIFICATION above) ───────────────
 *
 * TURN_CALL_CLASSIFICATION above answers "does this FUNCTION need muting/splitting so the world does
 * not advance once per player instead of once per round". This register answers a related but
 * separate question for the per-ENEMY slot switch specifically (`swap-session.js` `_slotSwapTo`,
 * armed by `headless-host.js`'s `installTurnModel`): once the slot switch is armed, `_slotSwapTo`
 * restores the INCOMING human's bundle mid-pass, and `restorePlayer` overwrites every watched global
 * NOT in `GLOBAL_BLACKLIST` with that bundle's value — so any global the pass writes BEFORE a later
 * swap, that is not protected, is silently clobbered back to whatever the incoming human's bundle
 * held before the round. Found twice already by luck (`__kdWorldMuted`, `KDCustomDefeat`/
 * `KDCustomDefeatEnemy`) before this register existed to make it a standing guard instead.
 *
 * Every name here is one the slot-swap audit spec (`tests/unit/mp-slot-swap-global-audit.spec.ts`)
 * actually observed a real 2-player round WRITE mid-pass (several real enemies engaged with both
 * players, a cast bullet in flight, an effect tile, a forced engine-triggered defeat) — this is not a
 * speculative enumeration of every global that exists, only of ones proven live in that scenario, in
 * the same spirit as `TURN_CALL_CLASSIFICATION`'s own liveness checks above.
 *
 *   per-player — correctly follows the human: captured on swap-out, restored on swap-in. Safe to
 *                leave off GLOBAL_BLACKLIST; doing so would be the OPPOSITE bug (one player's state
 *                leaking onto another).
 *   pass-world — must survive a mid-pass swap intact. MUST be in GLOBAL_BLACKLIST (bare global) or
 *                KDGAMEDATA_WORLD_KEYS (a KDGameData key) — checked independently by the guard spec,
 *                so a `pass-world` entry whose protection is later removed (upstream rename, a stray
 *                edit) goes red even if this particular scenario does not happen to re-observe the
 *                write that round.
 */
const SLOT_SWAP_GLOBALS = {
	// --- pass-world: session-level turn-model control state, already protected (installTurnModel's
	// own GLOBAL_BLACKLIST block, headless-host.js) -----------------------------------------------
	__kdWorldMuted:        entry('pass-world', 'round-wide world-mute flag for WORLD_MUTE_FNS; a mid-pass restore of a stale value reverts the round\'s one real tick to muted partway through (the original mid-pass-restore clobber this register exists to catch) — GLOBAL_BLACKLIST'),
	__kdInTick:            entry('pass-world', 'AdvanceTime re-entrancy depth, session-wide for the round — GLOBAL_BLACKLIST'),
	__kdSlotSwitch:        entry('pass-world', 'whether the per-enemy slot switch is armed for this pass — GLOBAL_BLACKLIST'),
	__kdSlotHost:          entry('pass-world', 'clientId the round\'s one real apply belongs to (hand-back target) — GLOBAL_BLACKLIST'),
	__kdSlotCurrent:       entry('pass-world', 'clientId currently holding the slot mid-pass — GLOBAL_BLACKLIST'),
	__kdSlotHumans:        entry('pass-world', 'this round\'s roster, session-wide for the pass — GLOBAL_BLACKLIST'),
	__kdSlotAvatarIds:     entry('pass-world', 'avatar entity ids, never themselves a switch target — GLOBAL_BLACKLIST'),
	__kdStickyTarget:      entry('pass-world', 'enemy id -> clientId persisted target, session-wide — GLOBAL_BLACKLIST'),
	__kdSlotChoiceLog:     entry('pass-world', 'enemy id -> clientId this pass\'s decision, read back by defeat routing — GLOBAL_BLACKLIST'),
	__kdBulletOwner:       entry('pass-world', 'bullet spriteID -> owning clientId side-channel for the whole pass — GLOBAL_BLACKLIST'),
	__kdTetherOwner:       entry('pass-world', 'leashed enemy id -> owning clientId side-channel for the whole pass (tagOwnedTethers), same shape as __kdBulletOwner — GLOBAL_BLACKLIST'),
	// --- pass-world: engine globals a defeat/jail decision is threaded through, single-slot ---------
	KDCustomDefeat:        entry('pass-world', 'set the instant any one enemy\'s decision is a defeat, read back at the end of the SAME pass by KDRunDefeatForEnemy — a mid-pass restore from an EARLIER bundle drops the defeat entirely — GLOBAL_BLACKLIST'),
	KDCustomDefeatEnemy:   entry('pass-world', 'the enemy that caused KDCustomDefeat, read back by installTurnModel\'s own KDRunDefeatForEnemy wrap to route the defeat to the right human — same clobber as KDCustomDefeat — GLOBAL_BLACKLIST'),
	// --- pass-world: world/engine counters and the shared map, already protected by category ------
	KinkyDungeonCurrentTick:   entry('pass-world', 'the shared world clock; a mid-pass restore from a stale bundle would move the party\'s one clock backwards — GLOBAL_BLACKLIST'),
	KDUpdateEnemyCache:        entry('pass-world', 'dirty flag for the shared position->entity cache, keyed by no player — GLOBAL_BLACKLIST'),
	// --- pass-world: derived lookup caches keyed by an ENEMY entity, not the player slot — same
	// criterion (a) as KDPathfindingCacheFails/KDUpdateEnemyCache above. Self-healing (a stale value
	// only costs one extra recompute, never a wrong answer), but classified pass-world for the same
	// reason as the sibling caches rather than left to a swap's correctness-by-luck — PROTECTED:
	// added to GLOBAL_BLACKLIST by this task.
	geteligrest_lastTagsEnemy:  entry('pass-world', 'memoisation key for KDGetEligibleRestraints — last ENEMY argument, not the player (KinkyDungeonRestraints.ts:3511) — GLOBAL_BLACKLIST'),
	geteligrest_lastExtraTags:  entry('pass-world', 'memoisation key sibling of geteligrest_lastTagsEnemy — GLOBAL_BLACKLIST'),
	// --- pass-world: a world-entity cache dirty-flag, same shape as KDUpdateEnemyCache above —
	// PROTECTED: added to GLOBAL_BLACKLIST by this task.
	KDUpdateEntityFlagCache:    entry('pass-world', 'dirty flag for a cache rebuilt from KDMapData.Entities (KinkyDungeonCollection.ts:394, KinkyDungeonGame.ts:3833), keyed by no player — GLOBAL_BLACKLIST'),
	// --- per-player: ordinary per-turn player state, correctly captured/restored with the human ----
	KinkyDungeonStatWill:          entry('per-player', 'the acting human\'s own Will stat'),
	KinkyDungeonStatMana:          entry('per-player', 'the acting human\'s own current mana, spent by their own spell cast'),
	KinkyDungeonStatManaMax:       entry('per-player', 'the acting human\'s own max mana'),
	KinkyDungeonSleepiness:        entry('per-player', 'the acting human\'s own per-turn sleepiness counter'),
	KinkyDungeonBlindLevel:        entry('per-player', 'the acting human\'s own blind level'),
	KinkyDungeonStatBlind:         entry('per-player', 'the acting human\'s own blind stat'),
	KinkyDungeonPlayerEntity:      entry('per-player', 'THE player entity object itself — the whole point of the swap is that this identity follows whichever human is in the slot'),
	KinkyDungeonPlayers:           entry('per-player', 'mirrors KinkyDungeonPlayerEntity exactly (`[KinkyDungeonPlayerEntity]`, KinkyDungeonStats.ts:1680) — same classification as its source'),
	KinkyDungeonPlayerBuffs:       entry('per-player', 'the acting human\'s own active buff list (KinkyDungeonFight.ts:227)'),
	KDBoundPowerLevel:             entry('per-player', 'the acting human\'s own bound-power-level stat'),
	KDOrigMana:                    entry('per-player', 'the acting human\'s own mana baseline (KinkyDungeonStats.ts:341/1002)'),
	KDPersonalAlt:                 entry('per-player', 'carried in the human\'s own save data (save.KDPersonalAlt, KinkyDungeon.ts:7256) — their own personal-alt-floor state'),
	KinkyDungeonJailedOnce:        entry('per-player', 'has THIS human been jailed before (KinkyDungeonJailList.ts:571) — a defeat is already routed to the right human before this is set (KDRunDefeatForEnemy\'s own slot-switch wrap), so it lands on the right bundle'),
	KinkyDungeonTargetY:           entry('per-player', 'the acting human\'s own current cast/aim target coordinate'),
	KDEventData:                   entry('per-player', 'carried in the human\'s own save data (save.KDEventData, KinkyDungeon.ts:7251) — their own event-flag record'),
	KDAllowDialogue:               entry('per-player', 'whether the acting human may currently be offered a dialogue window (KinkyDungeonGame.ts:3753, KinkyDungeonStats.ts:996)'),
	// Message/action toast state — same bucket as KinkyDungeonMessageLog/Floaters above, declared
	// together in the engine itself (KinkyDungeonGame.ts:80-90, :3474-3475): the acting human's own
	// last-shown text, not a world broadcast.
	KinkyDungeonTextMessage:            entry('per-player', 'the acting human\'s own current toast text (KinkyDungeonGame.ts:81)'),
	KinkyDungeonTextMessagePriority:     entry('per-player', 'sibling of KinkyDungeonTextMessage'),
	KinkyDungeonTextMessageTime:         entry('per-player', 'sibling of KinkyDungeonTextMessage'),
	KinkyDungeonTextMessageColor:        entry('per-player', 'sibling of KinkyDungeonTextMessage'),
	KinkyDungeonTextMessageNoPush:       entry('per-player', 'sibling of KinkyDungeonTextMessage'),
	KinkyDungeonActionMessage:           entry('per-player', 'sibling of KinkyDungeonTextMessage, for the acting human\'s own action text (KinkyDungeonGame.ts:87)'),
	KinkyDungeonActionMessagePriority:   entry('per-player', 'sibling of KinkyDungeonActionMessage'),
	KinkyDungeonActionMessageTime:       entry('per-player', 'sibling of KinkyDungeonActionMessage'),
	KinkyDungeonActionMessageColor:      entry('per-player', 'sibling of KinkyDungeonActionMessage'),
	KinkyDungeonActionMessageNoPush:     entry('per-player', 'sibling of KinkyDungeonActionMessage'),
	KinkyDungeonLastAction:              entry('per-player', 'the acting human\'s own last action string (KinkyDungeonGame.ts:3474)'),
	KinkyDungeonLastTurnAction:          entry('per-player', 'sibling of KinkyDungeonLastAction (KinkyDungeonGame.ts:3475)'),
	// Found only once the mutation test below (removing KDCustomDefeatEnemy from GLOBAL_BLACKLIST)
	// changed this scenario's execution path (a dropped defeat let the enemy pass continue further),
	// which is itself informative: this scenario is not fully path-independent, so a future run
	// surfacing another new name here is expected, not a sign the audit is broken.
	KD_Avg_VX: entry('per-player', 'the CURRENT player\'s own average velocity, derived from KinkyDungeonPlayerEntity.x/.lastx by KDCommanderUpdate (KDCommander.ts:245/273) — describes whoever is currently in the slot, recomputed from their own position delta each time it runs'),
	KD_Avg_VY: entry('per-player', 'sibling of KD_Avg_VX (KDCommander.ts:246/274)'),
	KinkyDungeonMessageLog:        entry('per-player', 'already managed per-player by swap-session directly (captured/flushed per human by _slotSwapTo itself, not via the generic bundle path) — listed here only because this scenario\'s pass observes it change'),
	KinkyDungeonFloaters:          entry('per-player', 'same as KinkyDungeonMessageLog — floating combat text, harvested per human by _slotSwapTo'),
	KinkyDungeonSlowLevel:         entry('per-player', 're-derived for whoever is currently in the slot from THEIR OWN restraints (KinkyDungeonCalculateSlowLevel, called by restorePlayer) — a world global in STORAGE terms but a per-player VALUE, correctly recomputed on every swap rather than carried; not a GLOBAL_BLACKLIST gap because nothing restores a stale copy of it'),
	// --- per-player, by the engine's OWN documented design — the mid-pass re-derivation gap this
	// register flagged for the owner is now FIXED ---------------------------------------------------
	// `headless-host.js`'s own `setPartyGate` doc comment documents that a swap wipes this registry
	// and must be re-asserted. It used to be re-asserted only once per OUTER per-player apply
	// (`_pushPartyGate`, called from `_advanceTurn`'s own loop), never from inside the per-ENEMY
	// mid-pass slot switch this spec audits — a beforeStairCancel fired for an engaged non-driving
	// human mid-pass would have run WITHOUT the party-gate handler for that one event. Fixed by also
	// calling `_pushPartyGate` from inside `_slotSwapTo` itself, for whichever human the switch just
	// brought in — see that method's own doc comment and
	// `tests/unit/mp-coop-slot-swap-human-context.spec.ts` ("the party-gate registry").
	KDEventMapGeneric:             entry('per-player', 'deliberately captured per-player by the engine\'s own design (setPartyGate\'s own doc comment) — re-asserted on every mid-pass slot switch (`_slotSwapTo`) as well as the outer per-player apply, so it is always relative to whoever currently holds the slot'),
	// --- per-player, with the SAME re-derivation gap as KDEventMapGeneric above, now fixed the same
	// way: it used to be recomputed only per OUTER apply (`_advanceTurn`, `this._anyPartnerFree(id)`)
	// from the APPLYING human's own point of view, never re-derived for whichever human the per-enemy
	// slot switch is currently engaged with — so a capture/defeat decision made mid-pass for a
	// non-driving human read the DRIVING human's "is my partner free" answer, not their own. Fixed by
	// also calling `_anyPartnerFree`/writing `__kdCoopPartnerFree` from inside `_slotSwapTo` itself —
	// see `tests/unit/mp-coop-slot-swap-human-context.spec.ts` ("the partner-free fact").
	__kdCoopPartnerFree:           entry('per-player', 'the "is my partner free" fact `kd-coop-capture.js` reads for the jail-vs-held decision — re-derived for whoever the mid-pass slot switch just brought in, not only the outer applying human'),
};

const SLOT_SWAP_GAMEDATA_KEYS = {
	// --- pass-world: already protected, in KDGAMEDATA_WORLD_KEYS (headless-host.js) ---------------
	NPCRestraints:             entry('pass-world', 'NPC/avatar bondage keyed by entity id — KDGAMEDATA_WORLD_KEYS'),
	JourneyMap:                entry('pass-world', 'the party\'s one journey map — KDGAMEDATA_WORLD_KEYS'),
	KinkyDungeonSpawnJailers:  entry('pass-world', 'floor population bookkeeping — KDGAMEDATA_WORLD_KEYS'),
	KinkyDungeonSpawnJailersMax: entry('pass-world', 'sibling of KinkyDungeonSpawnJailers — KDGAMEDATA_WORLD_KEYS'),
	GuardSpawnTimer:           entry('pass-world', 'floor population bookkeeping — KDGAMEDATA_WORLD_KEYS'),
	PersistentNPCCache:        entry('pass-world', 'floor population bookkeeping — KDGAMEDATA_WORLD_KEYS'),
	// --- pass-world: world/floor-wide state found by THIS task, not previously protected ----------
	// PROTECTED: added to KDGAMEDATA_WORLD_KEYS by this task.
	// These three are reset and fully recomputed by EVERY real pass (not genuinely cross-player
	// shared state) but still need mid-pass restore protection — classified pass-world and protected
	// via KDGAMEDATA_PASS_SCOPED_KEYS (merged into KDGAMEDATA_RESTORE_SKIP_KEYS, the set
	// restorePlayer actually reads), deliberately NOT via KDGAMEDATA_WORLD_KEYS itself: a value the
	// engine resets at the top of its own pass has nothing left to legitimately bleed across a round,
	// so it does not belong in the "declared, genuinely shared" contract mp-noninterference.spec.ts
	// checks against KDGAMEDATA_WORLD_KEYS.
	tickAlertTimer:  entry('pass-world', 'reset false at the top of the pass, set true by any enemy\'s own alert escalation mid-loop (KinkyDungeonEnemies.ts:4266/4908/4915), read at the END of the SAME pass (:5027) to decide a floor-wide alert — a mid-pass restore from an earlier bundle silently drops the escalation — KDGAMEDATA_PASS_SCOPED_KEYS'),
	HostileFactions: entry('pass-world', 'the floor\'s own list of provoked factions for THIS pass (KinkyDungeonFactions.ts:161-162, KDLocks.ts:1632/1645) — not keyed to any one player — KDGAMEDATA_PASS_SCOPED_KEYS'),
	otherPlaying:    entry('pass-world', 'reset to 0 then tallied across ALL enemies each pass (KinkyDungeonEnemies.ts:4669/4759), read by the jail play-chance roll in the SAME pass (KinkyDungeonJail.ts:153) — a world-wide tally for THIS pass, not per-player, and not persisted across rounds — KDGAMEDATA_PASS_SCOPED_KEYS'),
	// --- per-player: the human's own progress/resource counters ------------------------------------
	TimesJailed:   entry('per-player', 'how many times THIS human has been jailed — the defeat-routing oracle itself (mp-defeat-routing.spec.ts)'),
	MovePoints:    entry('per-player', 'the acting human\'s own remaining move budget this turn'),
	Guilt:         entry('per-player', 'the acting human\'s own guilt/reputation counter'),
	LastMP:        entry('per-player', 'the acting human\'s own previous-mana HUD value (KinkyDungeonInput.ts:1685)'),
	BulletWarnings: entry('per-player', 'incoming-attack telegraph markers aimed at the acting human (KinkyDungeonFight.ts:1943)'),
	WarningTiles:   entry('per-player', 'sibling of BulletWarnings, keyed by tile (KinkyDungeonFight.ts:4114)'),
	SawFlags:       entry('per-player', 'per-faction "has this human witnessed crime c times" tally (KinkyDungeonMagic.ts:1509)'),
	TempFlagFloorTicks: entry('per-player', 'decay timer for the human\'s OWN KinkyDungeonFlags entries (KinkyDungeonEvents.ts:12826-12829) — KinkyDungeonFlags itself is per-player (not in GLOBAL_BLACKLIST), so this decays WITH it despite the name'),
	JailTurns:      entry('per-player', 'the acting human\'s own turns-served-in-jail countdown (KinkyDungeonJail.ts:191/665)'),
	PrisonerState:  entry('per-player', 'the acting human\'s own prisoner state — already treated as per-player by mp-transition-write-audit.spec.ts, confirmed here independently'),
};

module.exports = {
	TURN_CALL_CLASSIFICATION, TEXT_COUPLED_SITES, entry, worldHelper,
	SLOT_SWAP_GLOBALS, SLOT_SWAP_GAMEDATA_KEYS,
	// Test-only: the guard spec needs each entry's PROVENANCE (which audited function it was found
	// under) to check R2 (an entry whose source function no longer calls it). The merged table is the
	// product surface — one register — so this is a function, not a second set of named exports, to
	// keep it visibly test-only.
	__sections: () => ({ ADVANCE_TIME, UPDATE_ENEMIES, EVENT_DISPATCH, NAMED_BY_DESIGN_DOC }),
};
