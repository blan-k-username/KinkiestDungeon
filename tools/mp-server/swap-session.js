/**
 * tools/mp-server/swap-session.js  (KD-085 — uniform action model)
 *
 * Server-authoritative co-op on the SWAP model (replaces the per-instance action
 * routing): ONE authoritative world; each player is a STATE BUNDLE; per turn each
 * player is swapped into the world's player globals, their action runs through KD's
 * REAL dispatcher (applyInput → KDSendInput/KDProcessInput — full fidelity, ANY
 * action incl. future ones), then swapped back out. The client uses KD's DEFAULT
 * controls and just forwards `{kdType, data}`.
 *
 * Lockstep (R8): the turn advances only when every player has submitted.
 * Conflict (R9): players are applied in RANDOM order on the shared world, so the
 * first-mover wins a contested tile/target — random conflict resolution falls out
 * of the model, no special-casing.
 * KDM-208: the loser is stopped by a VETO on the bump-attack, not by KD's collision
 * as this comment used to claim. Collision never applied: `_armPeerEnemies` makes
 * each peer a real hostile enemy, so the loser's move was promoted to a stock
 * bump-attack instead of blocked. The veto is keyed on the world at TURN START —
 * a peer who was already there stays fully attackable (deliberate PvP is stock).
 *
 * Other players are shown as avatar entities (KD-082) for rendering; the acting
 * player's avatar is parked while they're swapped in (they ARE the global player).
 */
'use strict';

const { HeadlessHost, KDGAMEDATA_WORLD_KEYS } = require('./headless-host');
const { PartyChoice } = require('./party-choice');
const { PeaceRegistry } = require('./peace');
const { KD_PEACE_DIALOGUE } = require('./kd-peace-dialogue');
const { KD_PERK_CHOICE } = require('./kd-perk-choice');
const { KD_JOURNEY_CHOICE } = require('./kd-journey-choice');
const { KD_SHOP_BUY } = require('./kd-shop-buy');
const { KD_COOP_CAPTURE } = require('./kd-coop-capture');
const { KD_DISCONNECT_DIALOGUE, HOST_LOST_DIALOGUE, PEER_LOST_DIALOGUE } = require('./kd-disconnect-dialogue');
const { sanitizeName, sanitizePerks } = require('./join-gate');
// KDM-239 R3/R5 — same normaliser the gate uses, so what the session stores and what the gate
// accepted cannot drift apart.
const { sanitizeWorld } = require('./game-modes');

const PARK = { x: 1, y: 1 };

/**
 * KDM-227/262: KD's own room types for the between-floors hub — the room with the perk pick, the
 * merchants and the path choice. Named once because this is the ONE detector: every consumer asks it,
 * nothing re-tests the room for itself.
 *
 * ⚠️ KDM-262 CORRECTED WHICH ROOM THIS IS, and the correction is the whole task. KDM-227 matched
 * `JourneyFloor` alone, believing it to be "the mandatory between-floors hub". It is not — it is the
 * level-0 START room, assigned only at new-game boot (KinkyDungeon.ts:6025, KinkyDungeonGame.ts:457)
 * and holding the five journey-TYPE portals (KDJourneyList, KinkyDungeonAlt.ts:1227). No journey slot
 * can carry it: the slot factories emit "" or "ShopStart" (KDJourney.ts:47/124/142).
 *
 * Since `_lastRoomType` is seeded from the world at session start — which IS that room — and the rule
 * is arrival-not-presence, the reset could never fire from the only room it matched. Measured: a fresh
 * two-player session reports RoomType === 'JourneyFloor' at level 0.
 *
 * The real between-floors room is `PerkRoom`. `KDAdvanceAmount['s']` (KinkyDungeonTiles.ts:930-946)
 * FORCES it whenever the main stairs are taken down from the deepest floor reached, so one follows
 * each main floor. It is also the room with `requireJourneyTarget` (KinkyDungeonAlt.ts:388), the shop
 * and quest NPCs, and KD's own between-floors autosave (KDStairActions.ts:266).
 *
 * `JourneyFloor` stays in the set: arriving at the start room is a legitimate slate-clean, it costs
 * nothing, and it keeps KDM-227's original cases meaningful. `Tunnel` / `ShopStart` / `ElevatorRoom`
 * are deliberately absent — those really are the optional detours a grudge is meant to survive.
 */
const HUB_ROOM_TYPES = Object.freeze(['PerkRoom', 'JourneyFloor']);

/**
 * KDM-240 D1: how close the rest of the party must be to the stairs before they will fire.
 *
 * Chebyshev 1 — on the stair tile or touching it. It is the TIGHTEST rule that is satisfiable: the
 * stair tile itself is occupied by whoever is leaving, so a partner physically cannot stand on it too,
 * and demanding they do would soft-lock every run.
 *
 * This is the one number the feature adds, and it is MP-specific by construction — "how near does the
 * other player have to be" has no meaning in a one-player game, which is the epic's own test for what
 * belongs in this layer. It is not a gameplay rule about combat or progression, so it is outside what
 * `mp-i6-no-gameplay-constants.spec.ts` guards. Named ONCE, here; `setPartyGate`'s own default exists
 * only for a caller that supplies nothing.
 */
const PARTY_GATE_RADIUS = 1;

/** KDM-230: the name of OUR dialogue, in `kd-peace-dialogue.js`. Named once; matched by it here. */
const PEACE_DIALOGUE = 'KDCoopPeace';

/**
 * KDM-251: every dialogue the GATEWAY itself owns — as opposed to the hundreds the game ships.
 *
 * Two rules need this set, and before this task each hand-rolled its own answer to "is this ours?"
 * (`apply()` matched `PEACE_DIALOGUE` exactly; `submit()`'s peace check exempted ANY dialogue). A
 * third copy was about to be written for the pause gate, so they are unified here instead.
 *
 * WHY IT MATTERS THAT THE SET IS RIGHT. Our dialogues are the ones whose ANSWER is the only thing
 * that can clear the state that is blocking the player. Refuse one and the survivor is soft-locked
 * holding the only key to their own cell — the trap KDM-230 documents against the peace offer, and
 * the same trap the disconnect dialogues walk into.
 */
const OWN_DIALOGUES = new Set([PEACE_DIALOGUE, HOST_LOST_DIALOGUE, PEER_LOST_DIALOGUE]);

/**
 * KDM-162: KDGameData fields the CLIENT owns, because only the client can compute them.
 *
 * These three are the OUTPUTS of `KinkyDungeonGetVisionRadius` (`KinkyDungeonVision.ts` →
 * `KinkyDungeonStats.ts:376`-`378`), which the headless world never runs — it has no screen. Its
 * values are therefore the post-init defaults, i.e. a DERIVED value that is already wrong at the
 * source. Shipping one is the exact mistake this slice removes (`stats.slowLevel` was recomputed and
 * then sent); the browser recomputes vision every frame and is authoritative for it.
 *
 * This is the same client-owned category the camera and `KDMapExtraData` (vision/light) are already
 * in — deliberately not synced, and documented as such in `serializeRenderState`. It is a bounded,
 * declared exception with a stated reason, NOT a reintroduced whitelist: the rule is "the headless
 * server cannot compute it", not "we decided these fields matter".
 *
 * The vision INPUTS (`visionBlind`, `visionAdjust`, …) are per-player state and stay synced.
 */
const CLIENT_OWNED_GAMEDATA_KEYS = ['NightVision', 'MaxVisionDist', 'MinVisionDist'];

/**
 * KDM-196: CONSUME-ONCE presentation members of an otherwise per-player global.
 *
 * The criterion is KDM-186's: if only the presentation layer consumes it, the server must not
 * replicate it. `KDDamageQueue` could satisfy that by name, in GLOBAL_BLACKLIST, because the whole
 * global is presentation. These cannot — they are sub-keys of `KDEventData`, which also holds real
 * accumulating sim state (`SlimeLevel`, `CurseHintTick`, …). One entry per (global, key) so the rule
 * stays "this VALUE is consume-once presentation", never "this feature is special".
 *
 * See `_stripPresentation` for why this is the invariant rather than the mechanism.
 */
const PRESENTATION_SUBKEYS = Object.freeze({
	// pushed by the enemy-noise path (KinkyDungeonEnemies.ts:9607), drained by the draw layer
	// (KinkyDungeonEvents.ts, afterDrawFrame/shockwave) — the ripple + sound echo.
	KDEventData: ['sounddesc', 'shockwaves'],
});

/**
 * KD_START_RESTRAINT accepts ONE name or a comma/space-separated list
 * (e.g. "MasterworkHeels,HighsecShackles"). Single source of truth for the
 * server seeding and the client's copy in coop-bootstrap.js.
 */
function KDParseStartRestraints(spec) {
	return String(spec || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

/*
 * KDM-164: the invented `DEFEAT_WILL = 0.52` / `REVIVE_WILL_FRACTION = 0.25` hysteresis is GONE.
 *
 * Those were our numbers, not KD's. "Down" is now KD's own floor — Will at zero — and a player is up
 * again the moment Will is above it. That is the owner's directive in full: default behaviour
 * unchanged, PLUS a 0-WP peer may be tied. Nothing else about defeat is an MP rule.
 *
 * The old hysteresis existed to stop a player flickering between down and up on a point of regen. It
 * is not needed at the floor: `down` no longer gates anything the player does (KD has no "Will 0 ⇒
 * cannot act" rule — KinkyDungeonMove has no Will check, KDPlayerCanMove is terrain-only), so a flicker
 * costs a HUD marker and bindability, not agency.
 */

/**
 * KDM-269 — THE FOUR WAYS A REAL ACTION PRODUCES NOTHING, DECLARED ONCE.
 *
 * A player pressed a key, the game did nothing, and nothing said so. There are four causes, and from
 * the player's side they are indistinguishable — which is why they are one family and not four
 * unrelated logs (`cancelledMoveReport`'s own note: *"a cancelled move and an ignored input look
 * identical"*).
 *
 * ── WHY THIS IS DATA AND NOT FOUR HAND-WRITTEN COPIES ─────────────────────────────────────────────
 * Each member used to be spelled out in four places: a field in the constructor, a `*Report()`
 * accessor, a `snap.*` line in `snapshotFor`, and a `_dbg` at the call site. KDM-268 added the fourth
 * member and unified only the push-and-trim (`_recordDrop`), leaving the DECLARATION fourfold and
 * writing the ritual down in the README — a smell recorded, not a design.
 *
 * The dangerous one is the `snap.*` line, because forgetting it is SILENT: the recording works, the
 * accessor answers correctly, and nothing whatsoever reaches the browser. That is precisely the bug
 * KDM-268 existed to fix. `tests/unit/mp-drop-channels.spec.ts` iterates this registry, so a channel
 * declared here and not carried to the client fails a test instead of disappearing quietly.
 *
 * ⚠️ THE FOUR WIRE FIELD NAMES ARE THE FIELD NAMES, and they stay four SEPARATE additive fields
 * (KDM-269 R2). Collapsing them into one `drops: {reason -> []}` is a wire change that breaks any
 * client older than the server, and `render-client.js` reads two of them by name. Do not do it here.
 *
 * ⚠️ `report` NAMES ARE IRREGULAR ON PURPOSE — `cancelledMoveReport`, not `cancelledMovesReport`.
 * They are called from ~10 spec files and are API; they are listed rather than derived from `field`
 * so that nobody "tidies" one and breaks the callers.
 *
 * ⚠️ NOT in `ws-bridge.js`'s `VERBATIM_CHANNELS`, and that is deliberate (KDM-269 R6). `kdDiff`
 * treats an array as opaque and replaces it whole (`kd-delta.js` — `kdIsPlainObj` is false for
 * arrays), so every channel already reaches the client intact. Listing these cumulative,
 * `maxLog`-bounded arrays there would force them onto EVERY frame and work against the delta
 * encoding, which is a wire regression rather than a fix.
 *
 * Adding a fifth cause: one entry here, plus the `_recordDrop` call and its `_dbg` at the site.
 */
const DROP_CHANNELS = Object.freeze([
	// KDM-163 AC3 — the world's own registry (`KDInputTypes`) has no handler for the type.
	// The odd one out: a Map of type -> count rather than a list, because the useful thing about an
	// unhandled type is HOW OFTEN, not which occurrence. Carries its own `init`/`collect` instead of
	// being flattened into the array shape, which would lose the count.
	Object.freeze({
		field: 'unknownInputs',
		report: 'unknownInputReport',
		init: () => new Map(),
		collect: (m) => [...m.entries()].map(([type, count]) => ({ type, count })),
	}),
	// KDM-163 AC3 — `_pending` is ONE slot per player, so a second turn-consuming input REPLACES the
	// first. Deliberate (a player may change their mind before the peer acts), but never silent: the
	// displaced action was a real action that never happened.
	Object.freeze({ field: 'replacedInputs', report: 'replacedInputReport' }),
	// KDM-208 — a peer reached the contested tile earlier in the SAME turn, so the loser stalled: no
	// attack, no step.
	Object.freeze({ field: 'cancelledMoves', report: 'cancelledMoveReport' }),
	// KDM-268 — the dispatch THREW inside the world. `applyInputObserved` catches it and hands it back
	// as `obs.error`, which the turn path read only inside `_learnInputKind` — so an action aborted
	// half-way reported a perfectly normal turn.
	Object.freeze({ field: 'failedInputs', report: 'failedInputReport' }),
]);

/** A channel's list starts empty unless it declared a shape of its own. */
const dropInit = (c) => (c.init ? c.init() : []);
/** …and is reported as a COPY, so a caller cannot edit what the session believes was dropped. */
const dropCollect = (c, held) => (c.collect ? c.collect(held) : held.slice());

class SwapSession {
	/** @param {object} opts { requiredPlayers=2, seed, enemyType='Rat' } */
	constructor(opts = {}) {
		this.required = opts.requiredPlayers || 2;
		this.seed = opts.seed || 'swap-session-seed';
		this.enemyType = opts.enemyType || 'Rat';
		this.maxLog = opts.maxLog || 100;
		this.pvp = !!opts.pvp;        // global PvP toggle (KD-092) — OFF by default (co-op)
		// KDM-227: the per-pair relationship, and the offer/answer handshake that changes it.
		// This REPLACES the old `pvpPairs` Set (KD-094): two containers that both mean "at war" is the
		// drift this codebase keeps paying for, and that Set had no callers at all — `setPvPPair` was
		// dead code, so nothing could ever start or end a per-pair war. See tools/mp-server/peace.js.
		this.rel = new PeaceRegistry();
		// KDM-164: the `friendlyFire` toggle is gone with the approximation it gated. Under the real
		// path the GAME decides who its AOE hits — walls, line of sight and the actual bullet — and a
		// server-side switch could only re-impose our own answer over the game's.
		this.mods = Array.isArray(opts.mods) ? opts.mods.slice() : []; // server-side mod code (KD-074)
		this.startRestraint = opts.startRestraint || ''; // KD-101 UAT: give every player this CARRYABLE loose item at start (e.g. "HingedCuffs")
		// UAT: put items straight ON the player at start (KD_WEAR_RESTRAINT). Self-equip from the
		// inventory is a DELAYED action (KinkyDungeonInput.ts:386 → KDGameData.DelayedActions) whose
		// queue is not part of the player bundle (headless-host.js:991) and whose auto-wait cannot
		// drive lockstep turns — so it never commits in co-op. Wearing at start sidesteps that
		// entirely, which is what you want when testing movement speed while bound.
		this.wearRestraint = opts.wearRestraint || '';
		/**
		 * KDM-238 R10 — perks applied to any player who declared none of their own.
		 *
		 * This replaces KDM-164's `classicHeels` / `_setClassicHeels`, which was a second, parallel
		 * way to put a perk on a player and named a perk inside `tools/mp-server/**`. It is a list of
		 * KEYS supplied by the operator (`KD_COOP_PERKS=ClassicHeels`), fed through the one
		 * `applyPerks` path like anybody else's declaration — so there is exactly one mechanism, and
		 * no perk name in this layer's source (epic AC2).
		 *
		 * A DEFAULT, not an override: a player who chose their own perks gets theirs and nothing else.
		 */
		this.defaultPerks = sanitizePerks(opts.defaultPerks);
		this.world = new HeadlessHost({ id: 'world' });
		this.bundles = new Map();     // id -> player-state bundle
		this.avatars = new Map();     // id -> world avatar entity id
		this.startOf = new Map();     // id -> {x,y}
		/**
		 * KDM-237 — the name each player chose, keyed by clientId. Empty/absent means "unnamed",
		 * which `displayNameOf` turns into the legacy label. Registered in `_perClientStores()` so a
		 * departing player takes it with them.
		 */
		this.nameOf = new Map();     // id -> chosen display name ('' / absent = unnamed)
		/**
		 * KDM-238 R3 — the perk keys each player chose, keyed by clientId. Absent means "declared
		 * none", which `perksOf` turns into `defaultPerks`. Registered in `_perClientStores()` beside
		 * `nameOf` so a departing player takes it with them.
		 */
		this.perkOf = new Map();     // id -> string[] of chosen perk keys
		/**
		 * KDM-239 R3/R5 — the WORLD each player declared, `{ modes, seed }`. Only the host's is ever
		 * read (`_hostWorld()`), but it is stored per client on the same terms as `perkOf` so a
		 * departing player takes their declaration with them via `_perClientStores()`.
		 */
		this.worldOf = new Map();    // id -> { modes: string[], seed: string }
		this.logs = new Map();        // id -> per-player message log (KD-090)
		this.actionMsgOf = new Map(); // id -> {text,color} transient floating combat text (KD-098)
		// KDM-186: monotonic id per client for ONE-SHOT EVENTS on the wire.
		//
		// A snapshot is STATE and must be idempotent — re-applying it converges. An EVENT (a combat
		// floater, a cast animation) is not: re-applying it duplicates it. They shared one wire, so
		// every snapshot delivered after a hit re-stamped that hit's visuals. Measured in UAT: the
		// floater queue grew only while the mouse moved (each move = a state change = a snapshot) and
		// drained to 0 the moment snapshots stopped — 0 created/s with 84 queued.
		//
		// The sequence travels WITH the event and the client applies each at most once. Generic by
		// construction: neither side enumerates which events exist — one counter, one comparison.
		this._eventSeq = new Map();      // clientId -> last event id issued
		this.pendingEvents = new Map();  // clientId -> events awaiting delivery
		// KDM-196: whether this client's last delivered `sounddesc` list was non-empty, so a list that
		// has just emptied is still sent once (to clear theirs) and silence stays silent afterwards.
		this._sentSoundDesc = new Map();
		/*
		 * KDM-263 A2 — THE PARTY'S ROUTE NEGOTIATION. One pending proposal, and who made it.
		 *
		 * Deliberately here and NOT in `KDGameData`. "Wait for your partner to agree" cannot exist in a
		 * one-player game, which is this epic's own test for what belongs in the gateway rather than in
		 * the world (KDM-225 D-series). Keeping it off `KDGameData` also keeps it out of every state
		 * bundle, so it never crosses the wire as replicated state and no client can be confused about
		 * whose turn it is to agree.
		 *
		 * The AGREED answer is the opposite: it is `KDGameData.JourneyTarget`/`UseJourneyTarget`, KD's
		 * own vocabulary, now world-scoped (KDGAMEDATA_WORLD_KEYS). There is no parallel route model —
		 * R16 — only a proposal that has not become one yet.
		 */
		this._journey = new PartyChoice({
			label: 'JOURNEY',
			seats: () => this._joined.length,
			isValid: (slot) => this._journeySlotIsConnected(slot),
			sameAs: (a, b) => a.x === b.x && a.y === b.y,
			commit: (slot, byId) => this._commitJourneyTarget(slot, byId),
			// Not committed any more, so KD's own JourneyChoice filter is again what stops the stairs —
			// clear whatever a previous agreement had armed, or the party could leave on a route it has
			// stopped agreeing on.
			uncommit: () => this._clearJourneyTarget(),
			announce: (kind, slot, byId) => {
				if (kind === 'proposed') {
					this._broadcast(`${this.displayNameOf(byId)} proposes the route to ${slot.x},${slot.y}. `
						+ 'Pick the same one to agree.', '#88ccff');
					this._dbg(`JOURNEY proposal ${slot.x},${slot.y} by ${byId}`);
				} else {
					this._broadcast(`The party takes the route to ${slot.x},${slot.y}.`, '#88ff99');
					this._dbg(`JOURNEY committed ${slot.x},${slot.y} (agreed by ${byId})`);
				}
			},
		});
		/*
		 * KDM-242 A2 — the party's perk-room negotiation, on the same terms as the route above and in
		 * the same place, for the same reason: "wait for your partner to agree" cannot exist in a
		 * one-player game. The RULES are `PartyChoice`'s (A1); these five hooks are the perk-specific
		 * halves.
		 */
		this._perk = new PartyChoice({
			label: 'PERK',
			seats: () => this._joined.length,
			isValid: (card) => this._perkCardIsOffered(card),
			sameAs: (a, b) => a.index === b.index,
			commit: (card, byId) => this._commitPerkCard(card, byId),
			// Nothing to undo: R10 — a proposal consumes no altar and grants nothing, so until the
			// commit there is no world state to roll back. (Contrast the route, where an agreed
			// JourneyTarget is armed in the world and must be disarmed when the question re-opens.)
			uncommit: () => {},
			announce: (kind, card, byId) => {
				if (kind === 'proposed') {
					this._broadcast(`${this.displayNameOf(byId)} would take perk ${card.index + 1}. `
						+ 'Pick the same one to agree.', '#88ccff');
					this._dbg(`PERK proposal ${card.index} by ${byId}`);
				} else {
					this._broadcast(`The party takes perk ${card.index + 1}.`, '#88ff99');
					this._dbg(`PERK committed ${card.index} (agreed by ${byId})`);
				}
			},
		});
		this.vitalsOf = new Map();    // id -> {will,willMax,...} last-known vitals (KD-098 HP bar)
		this.defeated = new Set();    // ids whose Will hit 0 — incapacitated (KD-099)
		this.tiedOf = new Map();      // id -> Set of restraint NAMES already reconciled onto this peer (KD-101)
		// KDM-164: the `_armHp = 100` damage gauge is gone. A peer avatar's hp no longer measures
		// anything — the game's own damageInfo is recorded per hit and replayed through the victim's
		// real player pipeline (see installPeerDamageRecorder / _reconcilePeers).
		this._joined = [];
		this._pending = new Map();    // id -> { kdType, data }
		// KDM-235: ids admitted mid-turn, waiting for the barrier to clear. See `joinInProgress`.
		this._pendingJoins = [];
		// KDM-235 A2: the fresh-character template, captured in `_start`. See the note there.
		this._newPlayerTemplate = null;
		/*
		 * KDM-243 A4 — a player who is seated from something OTHER than the fresh template.
		 *
		 * Today it has exactly one occupant: the host of an imported run, whose character comes out of
		 * their own save. A Map rather than an `if (isHost && imported)` because "which character does
		 * this seat start from" is a question [[KDM-256]] asks too, and answering it in one lookup is
		 * what keeps `_seatPlayer` a single path.
		 *
		 * Empty in every ordinary session, so `_seatPlayer` falls back to `_newPlayerTemplate` and the
		 * pre-KDM-243 behaviour is reached by the same line it always was.
		 */
		this._templateOf = new Map();
		/*
		 * KDM-243 R1 — the host's single-player save, forwarded from the join gate, or `''`.
		 *
		 * Per-client for the same reason `worldOf` is: the bridge forwards it with the rest of the
		 * seat and needs no role check of its own, because the gate already answered `''` for anyone
		 * who is not the host.
		 */
		this.saveOf = new Map();
		// KDM-269: the drop-report family — `unknownInputs`, `replacedInputs`, `cancelledMoves`,
		// `failedInputs`. What each one means, and why they are one family, is on `DROP_CHANNELS`
		// above; this loop is the only place they are brought into existence.
		for (const c of DROP_CHANNELS) this[c.field] = dropInit(c);
		// KDM-163: input type -> "turn" | "ui", LEARNED from real turns (never from a speculative apply,
		// which would double-apply world-mutating actions — see HeadlessHost.applyInputObserved).
		this.inputKind = new Map();
		// KDM-197: what the STATIC classifier knew when it seeded each type — "proven-turn" /
		// "assumed-turn" / "proven-ui" (see input-classifier.js). Only a guess may be overturned by
		// observation; a proven-turn type that declines to advance is the GAME declining, not a
		// misclassification (measured: a co-op bump into your ally's avatar returns "nomove" and
		// never calls AdvanceTime, which used to take `move` out of lockstep for the whole session).
		this.inputConfidence = new Map();
		// KDM-197: per-type observation tally behind the classification — { advanced, inert, pinned }.
		// The old rule was `advanced > 0 ? 'turn' : 'ui'` evaluated once per occurrence, so a single
		// non-advancing observation decided a type forever. Evidence replaces that guess.
		this._inputEvidence = new Map();
		// How many corroborating non-advancing observations a demotion to "ui" needs. >1 by
		// construction: the whole point is that one observation decides nothing. The cost of a larger
		// number is bounded and one-sided — a genuinely-UI type that the classifier over-approximated
		// costs this many lockstep turns before it is freed, and never costs anything again.
		this.uiDemotionEvidence = Math.max(2, (opts.uiDemotionEvidence | 0) || 3);
		// KDM-186: last state FINGERPRINT sent to each client. A reply carrying the full state is only
		// worth its ~40 KB when the state actually changed; measured, the proxy was answering ~100
		// inputs/s per client with a full snapshot (809 MB egress, one core pegged, replies stopped,
		// lockstep never completed). This is a DIFF, not a feature rule: the session never learns which
		// inputs matter, only whether this player's own captured state moved.
		this._stateFp = new Map();
		// KDM-163: pre-seed inputKind by static analysis. OFF by default — the classifier is sound and
		// unit-tested, but switching the CLIENT to route everything on top of it still destabilises
		// mp-coop-demo (see KDM-163 § CORRECTION 2). Opt in with { seedInputKinds: true }.
		this.seedInputKinds = !!opts.seedInputKinds;
		this.started = false;
		this.turn = 0;
		this.enemyId = null;
		this.lastTurn = null;         // debug/assert record of the last resolution
		// KD-098 diagnostics: set KD_MP_DEBUG=1 (or opts.debug) to trace action resolution
		// per turn to the server console — what each player submitted, how it was classified
		// (move/wait/sneak/peer-attack/plain), the PvP adjacency, and the applied result.
		this.debug = !!opts.debug || (typeof process !== 'undefined' && process.env && process.env.KD_MP_DEBUG === '1');
		this._dbgBuf = [];            // server diagnostics buffered for piping to the browser
	}

	/** Server-side diagnostic log (gated by this.debug / KD_MP_DEBUG). Also buffered so the
	 *  WS bridge can ship it to the browser console (no need to read the Docker terminal). */
	_dbg(msg) { if (this.debug) { try { console.error('[mp] ' + msg); } catch (e) { /* ignore */ } this._dbgBuf.push(msg); if (this._dbgBuf.length > 200) this._dbgBuf.shift(); } }

	/** Drain the buffered server diagnostics (the WS bridge forwards these to clients). */
	takeDbg() { const b = this._dbgBuf; this._dbgBuf = []; return b; }

	get players() { return [...this._joined]; }

	join(clientId) {
		if (this.started) throw new Error(`session already started — cannot join ${clientId}`);
		if (this._joined.includes(clientId)) throw new Error(`duplicate join: ${clientId}`);
		this._joined.push(clientId);
		if (this._joined.length >= this.required) this._start();
		return { clientId, joined: [...this._joined], started: this.started };
	}

	_start() {
		this.world.boot();
		/*
		 * KDM-239 R3/R5 — the host's world, adopted before the map exists.
		 *
		 * `randomMode` changes map generation, so this has to be the SAME call that generates it —
		 * applying the modes afterwards would give the party a map built on the wrong terms while
		 * every later assertion about "the modes are set" still passed.
		 *
		 * The seed follows the same "host is source of truth" rule as the build and the mod set: an
		 * operator-configured `opts.seed` is the fallback, a host that named one wins. That is what
		 * makes R5's "a session property, not a constant" true without anyone having to build a seed
		 * picker.
		 */
		const hostWorld = this._hostWorld();
		this.world.init({ seed: hostWorld.seed || this.seed, worldModes: hostWorld.modes });
		/*
		 * KDM-239 A3 — snapshot the game modes the world was built with, for `_seatPlayer` to restore.
		 *
		 * Captured from the WORLD rather than echoed back from the declaration, because
		 * `KDUpdatePlugSettings` has just produced KD's defaults as well as the host's choices, and a
		 * seat needs both. `mp-parity-oracle` is what proves this: restoring only the declared modes
		 * left a co-op player with an empty StatsChoice against a single-player run's full set.
		 */
		this._baseStats = this.world.statsChoiceSnapshot();
		this.world.setServerMode('world');
		// KDM-197: ALWAYS run the classifier. `seedInputKinds` gates whether its VERDICTS are applied
		// (that switch is about client routing — KDM-163 § CORRECTION 2); its CONFIDENCE is needed
		// either way, because "may this observation demote the type?" is a question every session asks.
		this._seedInputKinds();
		// KD-074: load server-side mods into the ONE authoritative world (players are state
		// bundles — no per-instance engine, so "all instances agree" is automatic). Same eval
		// path as the browser loader (KDMods.ts) — mods push to KD globals / reassign functions.
		for (const code of this.mods) { try { this.world.loadMod(code); } catch (e) { /* keep going */ } }
		// KDM-164: record the damage the GAME produces for each peer-avatar hit, so `_reconcilePeers`
		// can hand it to the victim's own `KinkyDungeonDealDamage` instead of converting avatar hp into
		// Will with arithmetic KD does not have.
		this.world.installPeerDamageRecorder();
		// …and the same treatment for an ally UNTYING a peer: taken from the call, never from a
		// standing bind-level delta (see installPeerUntieRecorder for what that cost).
		this.world.installPeerUntieRecorder();
		// KDM-224: and the death gate itself refuses to remove an avatar — the backstop for the ~30
		// places KD assigns enemy.hp directly, which the damage wrapper above never sees.
		this.world.installAvatarDeathGuard();
		// KDM-230: the peace dialogue, and the hook its options call. Registered in the world because
		// that is where a routed `dialogue` input is applied and therefore where `clickFunction` runs;
		// the browser is served the SAME source text (demo-server INJECT) so it can draw the buttons.
		this.world.loadMod(KD_PEACE_DIALOGUE);
		this.world.eval(`(function(){
			globalThis.KDCoopPeaceDecide = function (accept) { globalThis.__kdCoopPeaceAnswer = !!accept; };
			globalThis.__kdCoopPeaceAnswer = undefined;
		})()`);
		// KDM-261: and the capture rule — "jail only when nobody is free". Server-side only: this
		// draws nothing, and `KinkyDungeonDefeat` runs in the authoritative world and only there.
		this.world.loadMod(KD_COOP_CAPTURE);
		this.world.eval('globalThis.__kdCoopPartnerFree = false; globalThis.__kdCoopCaptureHeld = undefined;');
		// KDM-251: the disconnect dialogues, on the same terms and for the same reason.
		this.world.loadMod(KD_DISCONNECT_DIALOGUE);
		this.world.eval(`(function(){
			globalThis.KDCoopSessionQuit = function () { globalThis.__kdCoopQuit = true; };
			globalThis.__kdCoopQuit = undefined;
			// KDM-253 S4: the host's wait/solo answer, on the same take-once terms as the other two.
			globalThis.KDCoopPeerLostDecide = function (solo) { globalThis.__kdCoopSolo = !!solo; };
			globalThis.__kdCoopSolo = undefined;
		})()`);
		/*
		 * KDM-263 A3/A4 — the routed journey choice, and the hook its input type calls.
		 *
		 * Registered in the world for the same reason the peace dialogue is: this is where a routed
		 * input is dispatched, so this is where `KDInputTypes.KDCoopJourney` has to exist. The browser
		 * is served the SAME source text (demo-server INJECT), where the `KDRenderJourneyMap` wrap is
		 * the half that actually fires.
		 *
		 * ONCE, with no re-assert loop: MEASURED in KDM-241 (P1) that `KDInputTypes` is in no player's
		 * captured globals and a planted entry survives a full turn, so a swap cannot lose it. That
		 * measurement is pinned by a test rather than trusted.
		 */
		this.world.loadMod(KD_JOURNEY_CHOICE);
		this.world.eval(`(function(){
			globalThis.KDCoopJourneyPropose = function (slot) {
				globalThis.__kdCoopJourneyProposal = (slot && typeof slot.x === 'number' && typeof slot.y === 'number')
					? { x: slot.x, y: slot.y } : undefined;
			};
			globalThis.__kdCoopJourneyProposal = undefined;
		})()`);
		/*
		 * …and say what kind of input it is, rather than letting the session learn it the hard way.
		 *
		 * The lockstep default would make proposing a route WAIT for the other player to move — while
		 * the thing they are waiting to be asked about is the proposal itself. It consumes no time
		 * (the handler returns "" and calls nothing that advances), so 'ui' is the truth, not a
		 * convenience. `_learnInputKind` may still PROMOTE it if it is ever observed advancing time;
		 * the asymmetry there is deliberate and this does not weaken it.
		 */
		this.inputKind.set('KDCoopJourney', 'ui');
		/*
		 * KDM-242 A3/A4 — the routed perk-room choice, on exactly the terms above.
		 *
		 * Same reason, same shape: this is where a routed input is dispatched, so this is where
		 * `KDInputTypes.KDCoopPerk` has to exist; the browser is served the SAME source text, where the
		 * `KinkyDungeonDrawPerkOrb` wrap is the half that actually fires. Registered once — KDM-241 P1
		 * again, pinned by a test rather than trusted.
		 */
		this.world.loadMod(KD_PERK_CHOICE);
		this.world.eval(`(function(){
			globalThis.KDCoopPerkPropose = function (card) {
				globalThis.__kdCoopPerkProposal = (card && typeof card.index === 'number')
					? { index: card.index } : undefined;
			};
			globalThis.__kdCoopPerkProposal = undefined;
		})()`);
		// 'ui' for the same reason as the route: accepting a card consumes no time (the handler returns
		// "" and calls nothing that advances), and the lockstep default would make proposing a perk wait
		// for the partner who is being asked about that very proposal.
		this.inputKind.set('KDCoopPerk', 'ui');
		/*
		 * KDM-264 — the hub merchants: resolve a purchase by the ITEM the buyer selected, not by the
		 * index they selected it at.
		 *
		 * Loaded on the same terms and for the same reason as the journey choice above: the server half
		 * is a wrap of `KDInputTypes.shrineBuy`, which only means anything where a routed input is
		 * dispatched. The client halves in the same file are guarded on `KDRenderClient` and therefore
		 * install only in the browser. NOT given an `inputKind` seed — `shrineBuy` is KD's own input
		 * type with KD's own static classification, and overriding that would be the gateway deciding
		 * something about a game input it has no business deciding.
		 */
		this.world.loadMod(KD_SHOP_BUY);
		// KDM-227: baseline for the hub-arrival check. Seeded HERE rather than left undefined so the
		// room the session STARTS in is not mistaken for an arrival — the game boots on the journey
		// hub itself (level 0), so the very first turn of every session would otherwise fire a reset.
		try { this._lastRoomType = this.world.getRoomType() || ''; } catch (e) { this._lastRoomType = ''; }
		// KDM-240 A3: the same argument, for the same reason — the map the session BOOTS on is not a
		// map change. Seeded here so the first turn of every session compares against something real.
		try { this._lastMapId = this.world.mapId(); } catch (e) { this._lastMapId = undefined; }
		// KD-101 UAT aid: give the (shared) starting player a CARRYABLE loose-restraint ITEM (Items
		// inventory) BEFORE capturing each bundle, so the server can apply it; every capturePlayer below
		// inherits it. The CLIENT shows it via coop-bootstrap (snapshots don't sync the loose inventory).
		if (this.startRestraint) {
			for (const name of KDParseStartRestraints(this.startRestraint)) {
				const r = this.world.addLooseRestraint(name);
				this._dbg(`start-restraint(loose) ${name} -> ${JSON.stringify(r)}`);
			}
		}
		// KDM-238 R10: the perk seeding that used to happen HERE is gone. KDM-164 made it explicit and
		// opt-in; this task makes it the SAME path everyone else's perks take — each seat gets its own
		// perks inside `_seatPlayer`, from `perksOf(clientId)`, and an operator's blanket default is
		// just the answer that path gives a player who declared nothing (`defaultPerks`).
		// Worn-at-start items: applied BEFORE each bundle is captured below, so every player
		// starts wearing them (and their slow level is already derived from them).
		for (const name of KDParseStartRestraints(this.wearRestraint)) {
			const r = this.world.addRestraint(name);
			this._dbg(`wear-restraint ${name} -> ${JSON.stringify(r)}`);
		}
		if (this.wearRestraint) {
			// Re-derive slow from what is now worn. Not a perk change — just recomputing a DERIVED
			// value after changing its input, which is the opposite of inventing a rule.
			try {
				this.world.eval('if (typeof KinkyDungeonCalculateSlowLevel === "function") KinkyDungeonCalculateSlowLevel(0);');
				this._dbg(`wear-restraint: slowLevel now ${JSON.stringify(this.world.playerSlowLevel())}`);
			} catch (e) { this._dbg('wear-restraint: slow refresh failed — ' + e.message); }
		}
		/*
		 * KDM-235 A2 — THE FRESH-CHARACTER TEMPLATE, captured here and nowhere else.
		 *
		 * Right now the global player slot holds the pristine new-game character, which is why every
		 * bundle below is a clone of it. Mid-run that is no longer true: the slot holds whoever last
		 * acted (parked between turns), so a latecomer seated with a bare `capturePlayer()` would be
		 * handed a full copy of that player — stats, restraints, inventory. It would look like a
		 * working feature and is exactly what KDM-235 R6 forbids.
		 *
		 * Captured AFTER the start-restraint / perk seeding above, so a latecomer arrives on the same
		 * terms as everyone else. This is also the one seam KDM-237 (own character) and KDM-243
		 * (import a save) replace — they change what the template IS, and touch no seating code.
		 */
		this._newPlayerTemplate = this.world.capturePlayer();
		/*
		 * KDM-243 A3 — THE HOST'S SAVE, LOADED OVER THE WORLD WE JUST BUILT.
		 *
		 * ⚠️ AFTER THE TEMPLATE CAPTURE, AND THAT ORDER IS THE FEATURE. The line above snapshots the
		 * pristine new-game character; the load below replaces the player slot with the HOST's saved
		 * one. Swap the two and `_newPlayerTemplate` becomes a copy of the host — so the guest would
		 * arrive at floor 9 wearing the host's restraints, carrying their inventory and their perks.
		 * That is exactly what KDM-235 R6 forbids, and it would look like a working feature.
		 *
		 * The whole new-game path above still runs on this branch. It costs one map generation that is
		 * about to be thrown away, and it buys the fresh template the guest needs (D2) plus R9: the
		 * no-save path is byte-identical because nothing before this point knows about saves at all.
		 */
		const hostSave = this._hostSave();
		if (hostSave) {
			const res = this.world.loadSave(hostSave);
			if (!res || !res.ok) {
				// R8 — refuse loudly rather than run a half-built world. `started` is still false, so
				// the bridge reports this on the same channel as every other start/join refusal.
				throw new Error('cannot continue this save' + (res && res.err ? ` — ${res.err}` : ''));
			}
			/*
			 * A7/D3 — a version difference is SAID, not refused. KD's own loader carries compat
			 * branches for old saves, so refusing on a version string would reject saves the game
			 * itself handles perfectly well. The proxy speaking about a session-level fact, in its own
			 * voice — not game content.
			 */
			/*
			 * ⚠️ AND ONLY WHEN THE LOCAL VERSION IS ACTUALLY KNOWN. `TextGet` answers
			 * `'[NotFound] KDVersionStr'` until KD's text tables have loaded, which on the server is
			 * an async fetch that may not have finished — measured, and it made every single import
			 * warn about a version mismatch that did not exist. An unresolved lookup means "I cannot
			 * tell", and the honest output for that is silence, not a warning.
			 */
			const build = this.world.eval('typeof TextGet === "function" ? String(TextGet("KDVersionStr")) : ""');
			const known = build && build.indexOf('[NotFound]') < 0;
			if (res.version && known && res.version !== build) {
				this._broadcast(`This save was made in ${res.version}; this game is ${build}.`, '#ffcc66');
			}
			/*
			 * A3 §5 — the modes a SEAT is rebuilt from are now the save's, not the pre-load world's.
			 * `KinkyDungeonStatsChoice` arrives inside the save (`KinkyDungeon.ts:7160`), so the
			 * snapshot taken right after `init()` describes a world that no longer exists.
			 */
			this._baseStats = this.world.statsChoiceSnapshot();
			/*
			 * ⚠️ A3 §6 REVERSED BY MEASUREMENT — THE BASELINE IS DELIBERATELY *NOT* RE-TAKEN HERE.
			 *
			 * The Architecture step argued for `_captureBaseline()` at this point, reasoning that a
			 * load invalidates "what has gameplay touched since init". Implementing it made
			 * `mp-save-import`'s R7 fail, and the failure is the real behaviour:
			 *
			 * KDM-161's baseline is not merely a change detector — its VALUES are the per-player
			 * DEFAULTS that `restorePlayer` resets a watched global to when the incoming bundle does
			 * not mention it. Re-baselining after the load makes the HOST's saved character the
			 * default, so restoring the pristine `_newPlayerTemplate` into the slot leaves every field
			 * the template does not name sitting at the host's value — measured: the guest arrived
			 * wearing the host's `HingedCuffs`. That is precisely the KDM-235 R6 defect this task
			 * exists to avoid, arriving by a route nobody would look at.
			 *
			 * Keeping init's baseline is also the CORRECT semantics, not just the working one: a
			 * newly-seated player's defaults are KD's new-game defaults, and the host's resumed
			 * character is a divergence from them — which is exactly what it is, and exactly what a
			 * host who had played those floors inside the session would have had anyway. World state
			 * is excluded from bundles by CATEGORY (`GLOBAL_BLACKLIST` / `KDGAMEDATA_WORLD_KEYS`),
			 * never by the baseline, so nothing about the loaded map rides along either way.
			 */
			/*
			 * A4 — the host is seated from their SAVED character, everyone else from the fresh
			 * template. Captured here, while the loaded character is still the one in the slot.
			 */
			this._templateOf.set(this._joined[0], this.world.capturePlayer());
		}
		// A3 §7 — on an imported run the party starts where the host's own run left off, not on a
		// tile chosen by the map scan. `findOpenTile` remains the answer for a generated world.
		const base = (hostSave && this.world.getPlayerPos()) || this.world.findOpenTile();
		let i = 0;
		for (const id of this._joined) {
			// give each player a starting bundle at a distinct position
			this._seatPlayer(id, { x: base.x + i, y: base.y });
			i++;
		}
		// one shared enemy near the players; park the global player between turns
		this.world.placePlayer(base.x, base.y);
		const enemy = this.world.summonEnemy(base.x + this._joined.length, base.y, this.enemyType, { rad: 6 });
		this.enemyId = enemy ? enemy.id : null;
		this.world.parkGlobalPlayer(PARK.x, PARK.y);
		// KD-090: seed every player's personal log with the shared intro log; per-turn
		// deltas are appended in _advanceTurn so each client sees only its own messages.
		const intro = this.world.messageLog();
		for (const id of this._joined) this.logs.set(id, intro.slice());
		this.started = true;
		// KD-100: kick the async text load (fire-and-forget) so real combat messages resolve to real
		// text in live sessions; unit tests call `await session.ready()` for determinism.
		try { this.world.ready(); } catch (e) { /* best-effort */ }
	}

	/**
	 * Submit a player's action ({kdType, data} — KD's real input, or a {kind} for the
	 * built-in move/wait helpers). Returns { advanced, waitingOn } / { advanced, turn }.
	 */
	/**
	 * KDM-163 (option A): THE input entry point. Every input the client produces comes here — there is
	 * no client-side classification and nothing is ever swallowed.
	 *
	 * The split this makes possible: `submit()` used to mean BOTH "here is an input" and "I have
	 * finished my turn", because `_pending` holds one action per player. So a menu click either
	 * overwrote the player's queued real action or, if they were the last to submit, advanced the world
	 * for everyone. That conflation is why the client needed two hand-written lists in the first place.
	 *
	 * Now the GAME decides, not us — but it is asked by OBSERVING a real application, never by a
	 * speculative one:
	 *
	 *   unknown type (first time)  → lockstep, the safe default. `_advanceTurn` applies it exactly once
	 *                                and LEARNS whether it called KinkyDungeonAdvanceTime.
	 *   learned "ui"               → applied immediately on this player's own bundle. No turn consumed,
	 *                                no lockstep involvement, menus stay responsive (R6).
	 *   learned "turn"             → lockstep, preserving R8 lockstep and R9 random order.
	 *
	 * ⚠️ An earlier version DID probe speculatively — run it with the advance blocked, then roll the
	 * player back if it turned out to be turn-consuming. It was rejected by measurement: probes/probe9
	 * only sampled player-local inputs, and probes/probe11 then showed `doattack` damaging the target
	 * (hp 1 → -0.575) BEFORE reaching AdvanceTime, which a player-only rollback does not undo — so the
	 * lockstep replay applied the attack twice. Observing is exactly-once by construction.
	 *
	 * Cost of this shape: the FIRST use of each UI type in a session goes through lockstep, so it costs
	 * one turn. It is applied correctly (never lost, never doubled), and every later use is immediate.
	 */
	/**
	 * KDM-186: a cheap content fingerprint of a player's captured state bundle.
	 *
	 * Deliberately GENERIC — it hashes whatever the capture produced, so a mod's new field is covered
	 * with no registration, exactly like the capture itself. djb2 over one JSON pass: no per-field
	 * knowledge, no allowlist, and no idea what any of the values mean.
	 */
	_fingerprint(bundle) {
		let s;
		try { s = JSON.stringify(bundle); } catch (e) { return NaN; }   // uncomparable ⇒ always "changed"
		let h = 5381;
		for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
		return h;
	}

	/**
	 * Did this client's own state move since the last time we told them about it?
	 * Records the new fingerprint, so the answer is "since the last REPLY", not "since the last turn".
	 */
	_stateChanged(clientId, bundle) {
		const fp = this._fingerprint(bundle);
		const prev = this._stateFp.get(clientId);
		this._stateFp.set(clientId, fp);
		return prev === undefined || prev !== fp || Number.isNaN(fp);
	}

	/**
	 * KDM-225 — the peace handshake. An MP-only action: it consumes no turn and never enters the game.
	 *
	 * Returned as `kind: 'ui'` with `changed: true` so the bridge answers with a state frame — the
	 * menu on both clients reads `snap.coop`, so both sides must see the new state at once.
	 */
	_applyMPAction(clientId, action) {
		//  names the OTHER clients whose view this action changed. A ui-kind action normally
		// only answers its sender (ws-bridge.js), which is right for a menu keypress and wrong for a
		// handshake: the offer exists to be seen by the peer, and their menu reads .
		// `notify` names the OTHER clients whose view this action changed. A ui-kind action normally
		// answers only its sender (ws-bridge), which is right for a menu keypress and wrong for a
		// handshake: an offer exists precisely to be seen by the peer, whose menu reads `snap.coop`.
		const ui = (extra) => Object.assign({ advanced: false, kind: 'ui', changed: true }, extra);
		const peer = this._joined.find((id) => id !== clientId);
		if (!peer) return ui({ changed: false, error: 'no peer' });

		if (action.mp === 'peace.offer') {
			// A GLOBAL PvP session has no per-pair war entry — `this.pvp` alone makes `_isPvP` true. The
			// registry only knows about pairs, so materialise the relationship before negotiating it:
			// you cannot make peace with someone you are not recorded as fighting.
			if (this._isPvP(clientId, peer) && !this.rel.atWar(clientId, peer)) {
				this.rel.declareWar(clientId, peer);
			}
			const res = this.rel.offer(clientId, peer, this.turn);
			if (!res.ok) return ui({ changed: false, error: res.why });
			if (res.accepted) {                      // R17 — they had already asked; that is agreement
				this._settlePeace(clientId, peer);
				return ui({ peace: true, notify: [peer] });
			}
			this._emitEvent(peer, { kind: 'peaceOffer', from: clientId });
			this._openPeaceDialogue(peer, clientId);
			this._pushLog(peer, this.world.sendFeedback(
				`${clientId} offers peace.`, '#88ccff', 10).entries || []);
			this._dbg(`PEACE offer ${clientId} -> ${peer}`);
			return ui({ offered: true, notify: [peer] });
		}

		return ui({ changed: false, error: `unknown mp action "${action.mp}"` });
	}

	/**
	 * KDM-230 — put the offer in front of `target` as KD's own modal dialogue.
	 *
	 * Opened SERVER-SIDE, on that player's bundle, and this is not a style choice: `KDStartDialog`
	 * stores the open dialogue in `KDGameData.CurrentDialog`, which is per-player state the client
	 * re-adopts from every snapshot. A dialogue opened on the client would be erased by the very next
	 * state frame — and the offer triggers one immediately (`notify`). Measured in
	 * `tests/unit/mp-peace-dialogue-probe.spec.ts`: opened this way it reaches the peer's snapshot,
	 * stays private to them, and survives a resolved turn.
	 *
	 * The speaker is the OFFERER's avatar, so the dialogue reads as that player talking — and the
	 * game's own `SPEAKER` substitution fills in their name.
	 */
	_openPeaceDialogue(target, from) {
		return this._openOwnDialogue(target, PEACE_DIALOGUE, this.avatars.get(from));
	}

	/**
	 * KDM-251 S5 — put the host-lost dialogue in front of a guest whose host has gone.
	 *
	 * No speaker: there is no avatar to attribute it to (that is the entire message), so it opens as
	 * a plain narration rather than as somebody talking.
	 */
	openHostLostDialogue(target) {
		return this._openOwnDialogue(target, HOST_LOST_DIALOGUE, null);
	}

	/**
	 * KDM-253 S3/S4 — ask the HOST whether to wait for a missing guest or carry on without them.
	 *
	 * No speaker, same as the host-lost dialogue: the entity it would be attributed to is the one who
	 * has gone, which is the entire message.
	 *
	 * Re-openable on purpose. `Wait` closes it, and the host may be asked again — on the next drop, or
	 * because they want the choice back. The dialogue is a prompt, not a one-shot event.
	 */
	openPeerLostDialogue(target) {
		return this._openOwnDialogue(target, PEER_LOST_DIALOGUE, null);
	}

	/**
	 * KDM-251: open one of OUR dialogues on a specific player's bundle.
	 *
	 * Generalised from `_openPeaceDialogue` when the disconnect dialogue needed the identical
	 * restore → KDStartDialog → capture → re-park sequence. That sequence is the load-bearing part —
	 * a second hand-written copy would be free to get the capture or the re-park subtly wrong, and
	 * both failures corrupt player state rather than merely failing to draw.
	 *
	 * @param {string} target      whose bundle the dialogue opens on
	 * @param {string} name        a member of OWN_DIALOGUES
	 * @param {number|null} speakerEntityId  avatar to attribute it to, or null for plain narration
	 */
	_openOwnDialogue(target, name, speakerEntityId) {
		const bundle = this.bundles.get(target);
		if (!bundle) return false;
		this.world.restorePlayer(bundle);
		const res = this.world.eval(`(function(){
			var speaker = ${speakerEntityId == null ? 'null'
		: `KDMapData.Entities.find(function(e){ return e.id === ${speakerEntityId | 0}; })`};
			try {
				KDStartDialog('${name}', speaker ? speaker.Enemy.name : 'RemotePlayer', false,
					'', speaker || undefined);
			} catch (e) { return { err: String(e && e.message || e) }; }
			return { open: KDGameData.CurrentDialog };
		})()`);
		this.bundles.set(target, this.world.capturePlayer());
		this.world.parkGlobalPlayer(PARK.x, PARK.y);
		this._dbg(`${name} dialogue opened for ${target} (${JSON.stringify(res)})`);
		return res;
	}

	/** Close it again — on accept, on decline, and whenever the offer is dropped. */
	_closePeaceDialogue(target) {
		return this._closeOwnDialogue(target, PEACE_DIALOGUE);
	}

	/**
	 * KDM-252 E4 — the host is back, so take the "you have lost the host" modal off the guest's
	 * screen. Server-side, for the same reason it was OPENED server-side (see
	 * `kd-disconnect-dialogue.js`): `CurrentDialog` is per-player state the client re-adopts from
	 * every snapshot, so a close performed on the client is undone by the very state frame that
	 * announces the reconnect.
	 */
	closeHostLostDialogue(target) {
		return this._closeOwnDialogue(target, HOST_LOST_DIALOGUE);
	}

	/**
	 * Close one of OUR dialogues on a specific player's bundle, and only if it is the one open.
	 *
	 * Generalised from `_closePeaceDialogue` when the disconnect dialogue needed the identical
	 * restore → clear → capture → re-park sequence (KDM-252), exactly as `_openOwnDialogue` was
	 * generalised from `_openPeaceDialogue` in KDM-251. The pair now moves together; a second
	 * hand-written copy would be free to get the capture or the re-park subtly wrong, and both
	 * failures corrupt player state rather than merely failing to draw.
	 *
	 * The NAME GUARD is load-bearing: closing "whatever is open" would shut a dialogue the player
	 * opened themselves — an enemy conversation, a shop — because a peer's socket happened to close.
	 *
	 * @param {string} target  whose bundle to close it on
	 * @param {string} name    a member of OWN_DIALOGUES
	 */
	_closeOwnDialogue(target, name) {
		const bundle = this.bundles.get(target);
		if (!bundle) return;
		this.world.restorePlayer(bundle);
		this.world.eval(`(function(){
			if (typeof KDGameData !== 'undefined' && KDGameData
				&& KDGameData.CurrentDialog === '${name}') {
				if (typeof KDResetDialogue === 'function') KDResetDialogue();
				else { KDGameData.CurrentDialog = ''; KDGameData.CurrentDialogStage = ''; }
			}
		})()`);
		this.bundles.set(target, this.world.capturePlayer());
		this.world.parkGlobalPlayer(PARK.x, PARK.y);
	}

	/**
	 * KDM-230 — did the input just applied for `clientId` answer a peace dialogue?
	 *
	 * The answer arrives as KD's own routed `dialogue` input, so it is applied by the normal input
	 * path and the option's `clickFunction` runs inside the game. That function sets a flag in the
	 * world; this reads and clears it. Take-once, so a stale flag cannot answer a later offer.
	 */
	_takePeaceAnswer() { return this._takeCoopFlag('__kdCoopPeaceAnswer'); }

	/** KDM-253 S4 — did the host just answer the wait/solo question? `true` = go on alone. */
	_takeSoloAnswer() { return this._takeCoopFlag('__kdCoopSolo'); }

	/** KDM-253 — did a guest just press Quit on the host-lost dialogue? */
	_takeQuitAnswer() { return this._takeCoopFlag('__kdCoopQuit'); }

	/**
	 * Read-and-clear one boolean a dialogue's `clickFunction` set in the world.
	 *
	 * KDM-253: there are now THREE of these (peace answer, wait/solo, guest quit) and they were about
	 * to become three copies of the same eval. Take-once is the load-bearing part — a flag left set
	 * would answer the NEXT question too, silently — so it gets one implementation rather than three
	 * chances to forget the clear.
	 *
	 * `null` means "nothing was answered", which is different from `false` ("answered: no").
	 */
	_takeCoopFlag(name) {
		const v = this._takeCoopValue(name);
		return (v === true || v === false) ? v : null;
	}

	/**
	 * KDM-263 — the same read-and-clear, for a hook that records a VALUE rather than a yes/no.
	 *
	 * `_takeCoopFlag` narrows to booleans on purpose (its three callers must tell "answered: no" from
	 * "nothing was answered"), so a journey proposal — an {x,y} — cannot use it directly. The
	 * take-once eval is the load-bearing part and stays in ONE place; only the narrowing differs.
	 *
	 * `null` means nothing was recorded.
	 */
	_takeCoopValue(name) {
		try {
			/*
			 * Two shapes here are load-bearing, both taught by KDM-218's payload guard:
			 *
			 * ONE template literal, not two concatenated — the guard extracts each eval payload and
			 * parses it on its own, and it cannot see through a `+`. A payload it cannot parse is a
			 * payload it cannot protect from the silent truncation it exists to catch.
			 *
			 * BRACKET access, not `globalThis.${name}` — the guard substitutes a placeholder for each
			 * interpolation, so a `${}` in a property-NAME position becomes `globalThis.(…)` and cannot
			 * parse. Bracket form is also the safer one: the name lands in a string, never in an
			 * identifier position.
			 */
			const key = JSON.stringify(String(name));
			const v = this.world.eval(`(function(){ var v = globalThis[${key}]; globalThis[${key}] = undefined; return v; })()`);
			return (v === undefined) ? null : v;
		} catch (e) { return null; }
	}

	/** Settle whatever a just-applied input decided. Shared by the immediate and lockstep paths. */
	_settlePeaceAnswerFrom(clientId) {
		const accept = this._takePeaceAnswer();
		if (accept === null) return false;
		const res = this.rel.answer(clientId, accept);
		if (res.ok && res.peace) this._settlePeace(clientId, res.from);
		this._dbg(`PEACE ${accept ? 'ACCEPTED' : 'DECLINED'} by ${clientId} (via dialogue)`);
		return true;
	}

	/* ── KDM-263: agreeing the route out of the hub ───────────────────────────────────────────────── */
	/**
	 * A5/R4-R7 — fold ONE routed journey choice into the party's decision.
	 *
	 * Called from the immediate-apply path with `clientId` already swapped out and banked, exactly
	 * like `_settlePeaceAnswerFrom` and for the same reason: the commit writes to the WORLD (the
	 * journey keys are world-scoped now), and a world write performed while the wrong player is
	 * swapped in is how KDM-230 handed one player another's whole state.
	 *
	 * The RULES are not here. KDM-242 A1 extracted them into `party-choice.js`, because the perk-room
	 * choice needs the identical ones and two copies is exactly the duplication that task's Notes
	 * forbid. This method is now only the wire-to-choice adapter; the journey-specific halves are the
	 * five hooks handed to `PartyChoice` in the constructor.
	 */
	_settleJourneyProposalFrom(clientId) {
		const prop = this._takeCoopValue('__kdCoopJourneyProposal');
		if (!prop || typeof prop.x !== 'number' || typeof prop.y !== 'number') return false;
		return this._journey.propose(clientId, { x: prop.x, y: prop.y });
	}

	/**
	 * Is this slot reachable from where the party stands? KD's own answer, read from KD's own data.
	 *
	 * The connection test is duplicated from `KDRenderJourneyMap` (KDJourney.ts:385-388) rather than
	 * shared, because the client's copy is the DRAW-side check and this is the authoritative one — a
	 * server that trusted the client's verdict would let a modified client walk anywhere on the map.
	 * It reads `Connections` directly, so it stays KD's model and not a second route graph (R16).
	 */
	_journeySlotIsConnected(slot) {
		try {
			return !!this.world.eval(`(function(){
				if (typeof KDGameData === 'undefined' || !KDGameData || !KDGameData.JourneyMap) return false;
				var cur = KDGameData.JourneyMap[KDGameData.JourneyX + ',' + KDGameData.JourneyY];
				if (!cur || !cur.Connections) return false;
				var t = ${JSON.stringify(slot)};
				for (var i = 0; i < cur.Connections.length; i++) {
					if (cur.Connections[i].x === t.x && cur.Connections[i].y === t.y) return true;
				}
				return false;
			})()`);
		} catch (e) { return false; }
	}

	/** R6 — the party agreed: write KD's own answer, in KD's own fields. The announcement is PartyChoice's. */
	_commitJourneyTarget(slot, _byId) {
		this.world.eval(`(function(){
			if (typeof KDGameData === 'undefined' || !KDGameData) return;
			KDGameData.JourneyTarget = ${JSON.stringify(slot)};
			KDGameData.UseJourneyTarget = true;
		})()`);
	}

	/**
	 * Un-commit: back to "no route agreed", which is precisely the state KD's own JourneyChoice filter
	 * refuses the stairs in. `UseJourneyTarget` is left alone — KD sets it true when it cancels
	 * (`KDCancelEvents.JourneyChoice`) and reads the PAIR, so clearing the target is the whole of it.
	 */
	_clearJourneyTarget() {
		try {
			this.world.eval('(function(){ if (typeof KDGameData !== "undefined" && KDGameData) KDGameData.JourneyTarget = null; })()');
		} catch (e) { /* no world to clear */ }
	}

	/**
	 * A2 — the party is somewhere else now, so an unfinished negotiation about how to get there is
	 * over. Called from `_onMapChanged`, which is strictly more general than KDM-262's hub detector
	 * (arriving at the hub IS a map change) and therefore also covers LEAVING it — a second call site
	 * on the hub detector would be a duplicate, not extra safety.
	 */
	_resetJourneyProposal() {
		// Reset UNCONDITIONALLY, even with nothing pending: PartyChoice.reset also forgets that a route
		// was committed, and skipping it would leave the next map's first pick un-committing a route
		// belonging to the map the party has already left. Only the log line is conditional.
		const had = this._journey.report().pending;
		this._journey.reset();
		if (had) this._dbg('JOURNEY proposal cleared (the party changed map)');
	}

	/** What the party has agreed and what is merely proposed — for tests and diagnostics. */
	journeyReport() {
		let committed = null;
		try {
			committed = this.world.eval(`(function(){
				if (typeof KDGameData === 'undefined' || !KDGameData || !KDGameData.JourneyTarget) return null;
				return { x: KDGameData.JourneyTarget.x, y: KDGameData.JourneyTarget.y,
					use: !!KDGameData.UseJourneyTarget };
			})()`);
		} catch (e) { committed = null; }
		return { ...this._journey.report(), committed };
	}

	/* ── KDM-242: agreeing which perk the party takes ─────────────────────────────────────────────── */

	/**
	 * A5/R4-R7 — fold ONE routed perk choice into the party's decision.
	 *
	 * Called from the immediate-apply path with `clientId` already swapped out and banked, exactly like
	 * `_settleJourneyProposalFrom` and for the same reason: the commit swaps every player in turn, and
	 * doing that while a stale copy of the acting player is installed is how KDM-230 handed one player
	 * another's whole state.
	 *
	 * The RULES live in `party-choice.js` (A1) — this is only the wire-to-choice adapter.
	 */
	_settlePerkProposalFrom(clientId) {
		const prop = this._takeCoopValue('__kdCoopPerkProposal');
		if (!prop || typeof prop.index !== 'number') return false;
		return this._perk.propose(clientId, { index: prop.index });
	}

	/**
	 * Is this card actually on offer? KD's own answer, read from KD's own data.
	 *
	 * `KDMapData.PerkShrines` is the list of altar coordinates the generator wrote
	 * (KinkyDungeonAlt.ts:2746-2747), and an altar is still standing only while its tile keeps the
	 * `PerkOrb` type — the commit clears exactly that (R11). So "on offer" is one lookup in the game's
	 * own structures and there is no parallel offer model (R17). A card index outside the list, or one
	 * whose altar is already spent, is dropped silently: KD's own gate is the ONE refusal path and this
	 * does not invent a second.
	 */
	_perkCardIsOffered(card) {
		if (!card || typeof card.index !== 'number') return false;
		try {
			return !!this.world.eval(`(function(){
				var i = ${JSON.stringify(card.index)};
				if (typeof KDMapData === 'undefined' || !KDMapData || !Array.isArray(KDMapData.PerkShrines)) return false;
				if (i < 0 || i >= KDMapData.PerkShrines.length) return false;
				var t = KinkyDungeonTilesGet(KDMapData.PerkShrines[i]);
				return !!(t && t.Type === 'PerkOrb' && t.Perks && t.Perks.length);
			})()`);
		} catch (e) { return false; }
	}

	/**
	 * R1/R11/R13/R16 — the party agreed: grant the card to EVERY seat, then spend the room once.
	 *
	 * WHY EVERY SEAT. F9: several perks rewrite the shared world — `Stealthy` scales the floor's enemy
	 * and treasure counts (KDMapGen.ts:1049, :1770), `Fortify_Barricade` the commander's AI
	 * (KDCommander.ts:392) — and all of them are read from whichever player happens to be swapped in
	 * when generation runs. A perk one player has and the other does not therefore makes the shared map
	 * depend on swap order. The owner's ruling: perks cannot be per-character.
	 *
	 * WHY KD'S OWN HANDLER. `KDInputTypes.perkorb` (KinkyDungeonInput.ts:1011-1040) already applies the
	 * perk, the restraints, the escape method and the `choseperk` flag. Nothing here re-implements any
	 * of it, so this layer contributes no perk logic and names no perk (R16/R17). It is dead upstream —
	 * nothing in the game sends it — which is what makes it ours to drive.
	 *
	 * WHY THE BONDAGE IS RECOMPUTED PER SEAT (R13/D4). `KDGetPerkShrineBondage` reads `perkBondage` and
	 * `perkNoBondage` out of `KinkyDungeonStatsChoice` — keys `game-modes.js` classifies as
	 * PLAYER-level, "about their body … not the party's business". Generation baked one player's answer
	 * into a shared tile (F6); calling it inside each player's own swap-in window means the values
	 * already loaded are the right ones, with no argument threading.
	 *
	 * WHY THE WIPE IS OUTSIDE THE LOOP (R11). `KDMapData` is shared, so spending the room is a single
	 * world write; a per-seat pass would be N redundant writes over the same state. It uses the MODAL's
	 * wider behaviour (every entry of `PerkShrines`, KinkyDungeonShrine.ts:971-974) rather than
	 * `perkorb`'s narrower row-scan (:1036-1039), because the modal is what a single-player run does and
	 * both players must see the room spent.
	 *
	 * THE `_reseatParty` TRAP, inherited verbatim: the acting player is mid-apply, so
	 * `bundles.get(actingId)` is stale BY DEFINITION. Their live state is captured by hand first and
	 * restored last, or the very capture that triggered this commit is discarded.
	 */
	_commitPerkCard(card, byId) {
		const live = this.world.capturePlayer();
		try {
			for (const cid of this._joined) {
				this.world.restorePlayer(cid === byId ? live : this.bundles.get(cid));
				this.world.eval(`(function(){
					var i = ${JSON.stringify(card.index)};
					if (typeof KDMapData === 'undefined' || !KDMapData || !Array.isArray(KDMapData.PerkShrines)) return;
					var key = KDMapData.PerkShrines[i];
					var t = KinkyDungeonTilesGet(key);
					if (!t || !t.Perks) return;
					var xy = String(key).split(',');
					// RE-ARM THE ALTAR FOR EACH SEAT. KD's perkorb handler ends by scanning row data.y
					// and setting every 'P' on it to 'p' (KinkyDungeonInput.ts:1036-1039) -- and all
					// three altars share that row (KinkyDungeonAlt.ts:2723). It also GUARDS on the tile
					// still being 'P' (:1012). So without this the first seat spends the room and every
					// seat after it is silently skipped: MEASURED -- the proposer got the perk and the
					// partner got nothing. These are world writes the post-loop wipe below overwrites
					// anyway; re-arming simply makes each seat's window identical.
					KinkyDungeonMapSet(parseInt(xy[0], 10), parseInt(xy[1], 10), 'P');
					// The restraint price is THIS player's: KDGetPerkShrineBondage reads perkBondage /
					// perkNoBondage out of the StatsChoice that is loaded right now, which is theirs.
					var bondage = (typeof KDGetPerkShrineBondage === 'function')
						? KDGetPerkShrineBondage(t.Perks) : (t.Bondage || []);
					KDInputTypes.perkorb({
						x: parseInt(xy[0], 10), y: parseInt(xy[1], 10),
						perks: t.Perks, bondage: bondage, method: t.Method,
					});
				})()`);
				this.bundles.set(cid, this.world.capturePlayer());
			}
		} finally {
			// Leave the acting player swapped back in: the caller is mid-apply and captures their bundle
			// immediately after this returns.
			this.world.restorePlayer(this.bundles.get(byId) || live);
		}
		// …and spend the room, once, over the shared map.
		this.world.eval(`(function(){
			if (typeof KDMapData === 'undefined' || !KDMapData || !Array.isArray(KDMapData.PerkShrines)) return;
			KDMapData.PerkShrines.forEach(function (key) {
				var xy = String(key).split(',');
				KinkyDungeonMapSet(parseInt(xy[0], 10), parseInt(xy[1], 10), 'p');
				var t = KinkyDungeonTilesGet(key);
				if (t) t.Type = undefined;
			});
		})()`);
	}

	/**
	 * The party moved, so an unfinished argument about a perk room it has left is over. Same
	 * `_onMapChanged` call site and same unconditional-reset reasoning as `_resetJourneyProposal`.
	 */
	_resetPerkProposal() {
		const had = this._perk.report().pending;
		this._perk.reset();
		if (had) this._dbg('PERK proposal cleared (the party changed map)');
	}

	/** What the party has agreed and what is merely proposed — for tests and diagnostics. */
	perkReport() {
		return this._perk.report();
	}

	/**
	 * R1/R2/R3 at SESSION level — may `a` offer peace to `b` right now?
	 *
	 * Not `rel.canOffer`, and the difference is deliberate. The registry answers about the PAIR it
	 * knows: it requires an entry in its war set. The session also has the global `KD_PVP` flag, under
	 * which two players are at war with no pair entry at all — `_applyMPAction` materialises one when
	 * somebody actually negotiates, but the menu has to be offered BEFORE that happens or there is
	 * nothing to click. So "at war" is `_isPvP` here, and only the offer-slot half comes from the
	 * registry.
	 *
	 * One place, called by the snapshot; the client re-derives none of it.
	 */
	_canOffer(a, b) {
		return this._isPvP(a, b) && !this.rel.pendingFor(a) && !this.rel.pendingFor(b);
	}

	/**
	 * Peace is agreed: say so, and make the GAME agree too.
	 *
	 * `_isPvP` only decides whether the next turn ARMS the avatars as hostile — it does not undo the
	 * aggro KD already wrote on the entities, and `hostile` is a 300-turn countdown that would
	 * otherwise keep them enemies to every predicate that reads it. Clearing it is the whole of the
	 * effect: D3 — peace touches hostility and nothing else, so ties applied during the fight stay on.
	 */
	_settlePeace(a, b) {
		this.rel.makePeace(a, b);
		// KDM-230: the question is answered — take the dialogue off both screens. Harmless when it was
		// never open (accept via a counter-offer never opens one on the offerer).
		for (const id of [a, b]) this._closePeaceDialogue(id);
		for (const id of [a, b]) {
			const eid = this.avatars.get(id);
			if (eid == null) continue;
			try { this.world.setAvatarHostile(eid, false); } catch (e) { /* avatar gone */ }
		}
		this._broadcast('Peace between ' + a + ' and ' + b + '.', '#88ff99');
		this._dbg(`PEACE settled ${a} <-> ${b}`);
	}

	apply(clientId, action = {}) {
		if (!this.started) throw new Error('session not started');
		if (!this._joined.includes(clientId)) throw new Error(`unknown player ${clientId}`);
		// KDM-225: MP-only actions are handled HERE and never reach the game.
		//
		// The ordering is load-bearing: `_toInput` ends `return { kdType: 'tick' }`, so anything it
		// does not recognise silently becomes a WAIT and spends the sender's turn — no error, no
		// unknown-type report, just a turn quietly gone. An `mp:` action intercepted after it would be
		// exactly that bug. They also carry no `kdType` on purpose: KD has no handler for a truce, and
		// inventing one would put the gateway's own feature into `KDInputTypes`.
		if (action && action.mp) return this._applyMPAction(clientId, action);
		const { kdType, data } = this._toInput(clientId, action);
		if (!kdType) return { advanced: false, kind: 'noop' };

		/*
		 * KDM-230: OUR OWN dialogue's answer is applied immediately, whatever the classifier thinks of
		 * `dialogue` in general.
		 *
		 * This is not the gateway overruling the game about a game input. The classifier answers "does
		 * type X consume a turn?" for all of KD's dialogues at once, and its safe default for an
		 * unlearned type is lockstep — measured: `dialogue` came back `kind:"turn"`, so the answer sat
		 * waiting for the OTHER player to move before the truce could settle. But this dialogue is
		 * ours: we wrote both options, and neither advances time. Scoped to `KDCoopPeace` by name, so
		 * every other dialogue keeps whatever verdict the game earns for it.
		 */
		// KDM-251: was `data.dialogue === PEACE_DIALOGUE` inline. One shared answer to "is this ours?"
		// now, so this rule and the pause gate in `submit` can never disagree about it.
		const ourDialogue = this._isOwnDialogue(kdType, data);
		// Known NOT to consume a turn (learned from a real turn, below) → apply it now, exactly once.
		if (ourDialogue || this.inputKind.get(kdType) === 'ui') {
			const bundle = this.bundles.get(clientId);
			this.world.restorePlayer(bundle);
			const res = this.world.applyInputObserved(kdType, data) || {};
			// KDM-197: same learning rule as the lockstep path — one function, so the two can never
			// disagree about what an observation means. A `ui` type that advanced is promoted (and
			// pinned) here; it is the direction that desynchronises lockstep, so it is never delayed
			// for corroboration.
			// A forced-immediate action must not teach the classifier anything: we bypassed its verdict,
			// so an observation from this path is not evidence about `dialogue` in general.
			if (!ourDialogue) this._learnInputKind(kdType, res, false);
			const newBundle = this.world.capturePlayer();
			this.bundles.set(clientId, newBundle);
			/*
			 * KDM-230 — the peace answer IS a `dialogue` input, so settle it here. AFTER the capture
			 * above, and that ordering is the whole point.
			 *
			 * UAT bug this fixes: settling swaps OTHER players in and out (it closes the dialogue on
			 * each side, which is restore → mutate → capture per player). Run before the capture, it
			 * left the OFFERER swapped in — and the line above then captured the offerer's state and
			 * stored it as the ANSWERER's bundle. B was handed A's player state: black map, wrong
			 * stats, wrong everything. Settle only once this player's own state is safely banked.
			 */
			const answered = this._settlePeaceAnswerFrom(clientId);
			/*
			 * KDM-263 — and a routed journey choice settles here for the same two reasons: it arrives
			 * as an ordinary input, and everything it decides is a WORLD write that must not happen
			 * while somebody else is swapped in. Placed after the capture above, exactly like the peace
			 * answer, so this player's own state is banked before anything else touches the world.
			 */
			this._settleJourneyProposalFrom(clientId);
			this._settlePerkProposalFrom(clientId);
			/*
			 * KDM-253: the disconnect answers are `dialogue` inputs too, and they are READ here but
			 * ACTED ON by the caller.
			 *
			 * The session must not decide these itself, because deciding them needs two things it
			 * deliberately does not know: who is missing (that is `presence.js`) and which seat that
			 * maps to (that is `join-gate.js`). Reporting the answer keeps the split KDM-250/251/252
			 * all kept — the session owns the world, the bridge owns liveness and seats.
			 *
			 * Read AFTER the capture above, for the reason spelled out in the peace note: acting on
			 * these swaps other players in and out, and the ordering bug that produced is one this
			 * epic has already paid for once.
			 */
			const solo = this._takeSoloAnswer();
			const quit = this._takeQuitAnswer();
			// KDM-186: did this player's own state actually move? The caller uses this to decide between
			// a full state reply and a bare ack — a diff, never a judgement about which inputs matter.
			const changed = this._stateChanged(clientId, newBundle);
			// Leave the world exactly as a resolved turn leaves it. `_advanceTurn` ends with the global
			// player parked off-field; an immediate apply must restore that same between-turns
			// invariant, or the world is left with one player swapped in and the next turn (and any
			// read of avatar/enemy positions) starts from a different state than it used to.
			this.world.parkGlobalPlayer(PARK.x, PARK.y);
			this._noteUnknown(kdType, res);
			// KDM-268 R5: …and record a throw. This path RETURNS `error` to its caller below, but
			// returning is not recording — without this the UI-path failure is still absent from the
			// snapshot and from any later diagnosis, which is the whole complaint.
			this._noteFailedInput(clientId, kdType, res);
			return { advanced: false, kind: 'ui', changed, unknownType: !!res.unknownType,
				error: res.error || null,
				// KDM-253: `null` = not answered, `false` = Wait, `true` = go on alone. The three
				// states are distinct on purpose — "Wait" is an ANSWER (the host has seen the
				// question and chosen), not the absence of one, and the bridge treats them differently.
				solo, quit: quit === true,
				notify: answered ? this._joined.filter(function(i){ return i !== clientId; }) : undefined };
		}

		// Everything else — including every type seen for the first time — goes through lockstep. That
		// is the SAFE default: the action is applied exactly once, by _advanceTurn, which also learns
		// this type's kind for next time.
		return Object.assign({ kind: 'turn' }, this.submit(clientId, action));
	}

	/**
	 * KDM-163: pre-seed `inputKind` by STATIC analysis of the bundle, so no input type is ever
	 * "unlearned" at runtime. Without this, the first use of each type takes the lockstep default and
	 * costs the player a turn — measured to break click-to-move (`mp-coop-demo`), because
	 * `KDFastMoveTo` dispatches through KDSendInput.
	 *
	 * Text-coupled, so it is verified against the LIVE registry and fails LOUD and SAFE: anything the
	 * analysis did not classify simply stays unseeded and defaults to turn-consuming.
	 */
	_seedInputKinds() {
		try {
			const { classifyInputs } = require('./input-classifier');
			const { loadSources } = require('./headless-host');
			const { kinds, confidence, report } = classifyInputs(loadSources().bundle);
			const live = this.world.eval('(typeof KDInputTypes !== "undefined" && KDInputTypes) ? Object.keys(KDInputTypes) : []') || [];
			let seeded = 0;
			for (const t of live) {
				if (!kinds[t]) continue;
				// KDM-197: keep HOW WELL the analysis knew this, not just what it concluded. A type with
				// no entry has no static evidence, which is the demotable default.
				if (confidence && confidence[t]) this.inputConfidence.set(t, confidence[t]);
				if (this.seedInputKinds) this.inputKind.set(t, kinds[t]);
				seeded++;
			}
			this.inputSeedReport = {
				...report, live: live.length, seeded, missing: live.length - seeded,
				applied: this.seedInputKinds,   // were the verdicts used, or only the confidence?
			};
			// Drift: the registry moved and the analysis no longer covers it. Not fatal — the unseeded
			// types just fall back to the safe default — but it must be visible.
			if (!report.found || seeded < live.length) {
				const msg = `[mp-server] KDM-163 input-classifier DRIFT: seeded ${seeded}/${live.length} live input ` +
					`types (parsed ${report.handlers} handlers from the bundle). Unseeded types default to ` +
					'turn-consuming, so behaviour is safe but menus may cost a turn until observed.';
				try { console.warn(msg); } catch (e) { /* ignore */ }
				this._dbg(msg);
			} else {
				this._dbg(`input-classifier classified ${seeded} types (${report.ui} ui / ${report.turn} turn — ` +
					`${report.provenTurn} proven, ${report.assumedTurn} assumed); ` +
					`${this.seedInputKinds ? 'verdicts applied' : 'confidence only, verdicts not applied'}`);
			}
		} catch (e) {
			// Never let classification take the session down — an empty cache is merely the old behaviour.
			try { console.warn('[mp-server] KDM-163 input-classifier failed, falling back to observe-only: ' + e.message); } catch (e2) { /* ignore */ }
		}
	}

	/**
	 * KDM-197: fold ONE observation of `kdType` into what the session knows about it.
	 *
	 * The old rule was `seen = obs.advanced > 0 ? 'turn' : 'ui'`, applied immediately. It made a
	 * measurement out of a single sample, and the sample is not reliable in the "did not advance"
	 * direction: an input can decline to advance for reasons that say nothing about its type — we
	 * vetoed it (KDM-208), it threw, the game refused the action. Measured: in co-op the peer's avatar
	 * is an ALLY, so bumping it returns `nomove` with `advanced === 0`; that single observation
	 * demoted `move` to `ui` and took every subsequent move out of lockstep.
	 *
	 * The rule is deliberately ASYMMETRIC, because the two errors are not equal. Classifying a
	 * turn-consuming input as `ui` applies it outside lockstep — a desync, unbounded damage.
	 * Classifying a UI input as `turn` costs one turn. So:
	 *
	 *   advanced > 0        →  "turn" at once, and PINNED: a type that has ever consumed a turn is a
	 *                          type that sometimes consumes a turn, and lockstep is where those belong.
	 *                          This is the only rule needed for AC2 — a varying type stays safe.
	 *   advanced === 0      →  evidence, not a verdict. Demote only when ALL of:
	 *                            · the observation is admissible (not vetoed, no exception) — a run we
	 *                              stopped measures us, not the type;
	 *                            · the type was never observed to advance (not pinned);
	 *                            · the static verdict was a GUESS. A `proven-turn` type has a concrete
	 *                              call path to AdvanceTime, so "it did not advance" is the game
	 *                              declining, and no number of declines makes it a UI input;
	 *                            · `uiDemotionEvidence` such observations have accumulated.
	 *
	 * @param {string} kdType
	 * @param {{advanced?: number, error?: string|null}} obs  what `applyInputObserved` reported
	 * @param {boolean} cancelled  we stopped this action ourselves (KDM-208 contested-tile veto)
	 */
	_learnInputKind(kdType, obs, cancelled) {
		if (!kdType) return;
		const o = obs || {};
		const advanced = (o.advanced | 0) > 0;
		// An action that was stopped — by our own veto or by an exception — is not a measurement of the
		// type. A POSITIVE observation is exempt: whatever else happened, it did advance time.
		if (!advanced && (cancelled || o.error)) return;

		let ev = this._inputEvidence.get(kdType);
		if (!ev) { ev = { advanced: 0, inert: 0, pinned: false }; this._inputEvidence.set(kdType, ev); }
		const had = this.inputKind.get(kdType);

		if (advanced) {
			ev.advanced += 1;
			ev.inert = 0;
			ev.pinned = true;
			if (had !== 'turn') {
				this.inputKind.set(kdType, 'turn');
				this._dbg(had === 'ui'
					? `RECLASSIFY "${kdType}" ui -> turn (it advanced time outside lockstep)`
					: `learned "${kdType}" = turn`);
			}
			return;
		}

		ev.inert += 1;
		// A type nobody has classified is ALREADY treated as turn-consuming (the lockstep default in
		// `apply`). Record that, so `inputKind` says what the session will actually do rather than
		// staying silent until the first demotion.
		if (had === undefined) this.inputKind.set(kdType, 'turn');
		if (had === 'ui') return;                                        // already where it would go
		if (ev.pinned) return;                                           // AC2: it has advanced before
		if (this.inputConfidence.get(kdType) === 'proven-turn') return;  // the game declined, that is all
		if (ev.inert < this.uiDemotionEvidence) return;                  // AC1: one sample decides nothing
		this.inputKind.set(kdType, 'ui');
		this._dbg(`${had ? 'reclassified' : 'learned'} "${kdType}"${had ? ' ' + had + ' ->' : ' ='} ui ` +
			`(${ev.inert} consecutive non-advancing observations, confidence=` +
			`${this.inputConfidence.get(kdType) || 'none'})`);
	}

	/** KDM-197: the evidence behind each learned classification — for tests and diagnostics. */
	inputKindReport() {
		return [...this.inputKind.entries()].map(([type, kind]) => ({
			type, kind,
			confidence: this.inputConfidence.get(type) || null,
			...(this._inputEvidence.get(type) || { advanced: 0, inert: 0, pinned: false }),
		}));
	}

	/** AC3: an input type the authoritative world has no handler for — never dropped in silence. */
	_noteUnknown(kdType, res) {
		if (!res || !res.unknownType) return;
		this.unknownInputs.set(kdType, (this.unknownInputs.get(kdType) || 0) + 1);
		this._dbg(`UNKNOWN input type "${kdType}" — no handler in KDInputTypes, it did nothing`);
	}

	/**
	 * KDM-269 — the drop reports (`unknownInputReport`, `replacedInputReport`, `cancelledMoveReport`,
	 * `failedInputReport`) are DEFINED ON THE PROTOTYPE from `DROP_CHANNELS`, just below this class.
	 *
	 * They are not written out here because four near-identical `return this.x.slice()` bodies are
	 * four chances for the fifth to be forgotten — and a missing accessor is the least of it; see the
	 * registry's note on the `snap.*` line, which fails silently.
	 *
	 * Each one still answers a COPY, under its exact published name. What each channel means is on the
	 * registry entry, which is the one place worth reading.
	 */

	/**
	 * KDM-268 R7 — the one push-and-trim behind every drop report.
	 *
	 * `replacedInputs`, `cancelledMoves` and `failedInputs` each recorded a real action that produced
	 * nothing, and each had its own copy of `push` + `while (len > maxLog) shift()`. Three copies of a
	 * bound is three chances to forget it; the third one was about to be written by hand.
	 *
	 * The `_dbg` line stays at each CALL SITE on purpose — what is worth saying differs per case, and
	 * a generic "something was dropped" message would be worth less than the three specific ones.
	 */
	_recordDrop(list, rec) {
		list.push(rec);
		while (list.length > this.maxLog) list.shift();
		return rec;
	}

	/**
	 * KDM-268 R1/R3/R5 — note that this player's input threw, from EITHER apply path.
	 *
	 * One place, so the record's shape is defined once: the two paths (lockstep turn and immediate
	 * 'ui') cannot drift into two different records, and a consumer never has to ask which produced
	 * the one it is looking at.
	 *
	 * Takes the whole observation rather than a message so the caller cannot forget to unwrap it, and
	 * answers `null` when there was no error — which makes the call site a plain unconditional line
	 * instead of a fourth `if` somebody has to keep in step with the other three.
	 */
	_noteFailedInput(clientId, kdType, obs) {
		const err = obs && obs.error;
		if (!err) return null;
		const rec = this._recordDrop(this.failedInputs,
			{ clientId, turn: this.turn, kdType: kdType || null, error: String(err) });
		this._dbg(`FAILED input for ${clientId} ("${rec.kdType}") in turn ${this.turn}: ${rec.error}`);
		return rec;
	}

	/**
	 * KDM-251 — stop the turn loop, with a reason the player can be shown.
	 *
	 * The reason is an OPAQUE STRING to this class. Presence lives on the bridge (`presence.js`) and
	 * the session knows nothing about seats, sockets or who is missing — it only knows that somebody
	 * upstream has said "not now, and here is why". That keeps the bridge the single place where
	 * presence is mapped onto behaviour, and means a future reason (a host migration, a save) needs no
	 * change here.
	 */
	pause(reason) { this._pausedReason = reason || 'paused'; return this._pausedReason; }

	resume() { this._pausedReason = null; }

	get paused() { return !!this._pausedReason; }

	/**
	 * Is this input an answer to one of the GATEWAY's own dialogues (`OWN_DIALOGUES`)?
	 *
	 * These must never be refused by a gate, because the answer is the only thing that can clear the
	 * state doing the refusing — see the note on `OWN_DIALOGUES`.
	 */
	_isOwnDialogue(kdType, data) {
		return kdType === 'dialogue' && !!data && OWN_DIALOGUES.has(data.dialogue);
	}

	submit(clientId, action = {}) {
		if (!this.started) throw new Error('session not started');
		if (!this._joined.includes(clientId)) throw new Error(`unknown player ${clientId}`);
		/*
		 * KDM-251 S2/N1 — the session is paused, so this turn does not happen.
		 *
		 * Refused HERE, at the top of submit, because that is the last point at which nothing has
		 * happened yet: `_pending` is untouched and `_advanceTurn` (the only thing that moves the
		 * shared world) runs solely when every player has submitted. A gate any later would have to
		 * undo work.
		 *
		 * `blocked`, never `waiting`. The two are not interchangeable: the client sets
		 * `coop.submitted = true` on `waiting` and then suppresses further input as already-acted, so
		 * answering a refusal that way locks the player out of their own controls. That is the exact
		 * soft-lock KDM-225 shipped and had to fix.
		 *
		 * Our own dialogues are exempt — their answer is what ENDS the pause (KDM-253's wait/solo, and
		 * this task's quit). Refusing them would be the soft-lock one level up.
		 */
		if (this._pausedReason) {
			const input = this._toInput(clientId, action);
			if (!this._isOwnDialogue(input.kdType, input.data)) {
				this._dbg(`BLOCKED ${clientId}: session paused (${this._pausedReason})`);
				return { advanced: false, blocked: this._pausedReason, waitingOn: [clientId] };
			}
		}
		// KDM-225 R5: a player who owes an answer to a peace offer cannot take their turn until they
		// give one. This is the ONE choke point for that — `apply()` routes UI-kind actions around
		// `submit` entirely, so the answer itself is never blocked by this.
		// KDM-230: …except the answer itself. The dialogue option is a routed `dialogue` input, and if
		// the classifier ever decides that type consumes a turn it would arrive HERE — refused, with
		// the only action that could clear the block. Exempt it explicitly rather than depend on the
		// classifier's verdict staying 'ui'.
		if (this.rel.owesAnswer(clientId) && this._toInput(clientId, action).kdType !== 'dialogue') {
			this._dbg(`BLOCKED ${clientId}: owes an answer to a peace offer`);
			return { advanced: false, blocked: 'peace-offer', waitingOn: [clientId] };
		}
		// KDM-163 AC3: a queued action being displaced is a real input that will never be applied.
		// Measured in `tests/unit/mp-ui-chatter-repro.spec.ts`: queue a bump-attack, then send any other
		// turn-consuming input before the peer acts, and the enemy takes no damage — with nothing
		// anywhere to find it by. Report it; do not change the last-wins semantics the client relies on.
		const displaced = this._pending.get(clientId);
		if (displaced) {
			const rec = {
				clientId,
				turn: this.turn,
				displaced: this._toInput(clientId, displaced).kdType || displaced.kind || null,
				by: this._toInput(clientId, action).kdType || action.kind || null,
			};
			this._recordDrop(this.replacedInputs, rec);
			this._dbg(`REPLACED pending input for ${clientId}: "${rec.displaced}" never applied, ` +
				`displaced by "${rec.by}" in turn ${this.turn}`);
		}
		this._pending.set(clientId, action);
		this._dbg(`submit turn=${this.turn} ${clientId} action=${JSON.stringify(action)}`);
		const waitingOn = this._joined.filter((id) => !this._pending.has(id));
		if (waitingOn.length > 0) return { advanced: false, waitingOn };
		return { advanced: true, turn: this._advanceTurn() };
	}

	/** Apply every player's action on the shared world, in random order (R8/R9). */
	_advanceTurn() {
		const order = this._shuffle(this._joined.slice());
		const applied = [];
		this.actionMsgOf.clear();   // floating combat text is per-turn transient (KD-098)
		// KDM-208: where everyone stood at TURN START — the world each player actually acted against.
		//
		// R9's doc comment above claimed collision blocked the loser of a contested tile. It did not:
		// `_armPeerEnemies` makes each peer a REAL hostile enemy, so once the winner's avatar had been
		// moved onto the tile, the loser's move hit KD's stock bump-to-attack instead of a wall — real
		// damage, real bondage, real defeat, purely because of intra-turn application ORDER (measured
		// in `mp-contested-tile.spec.ts`: Will 10 → 8.5 in BOTH orderings).
		//
		// The discriminator is not the input (never classify what the player meant) but the AVATAR: a
		// peer standing where they stood at turn start is a legitimate target and stays fully
		// attackable; a peer who ARRIVED this turn is an artefact of the order and cannot be bumped.
		const startPos = new Map();
		for (const cid of this._joined) {
			const p = this.posOf(cid);
			if (p) startPos.set(cid, { x: p.x, y: p.y });
		}
		const arrived = new Set();   // avatar entity ids that changed tile THIS turn
		for (const id of order) {
			const action = this._pending.get(id) || { kind: 'wait' };
			// KD-099 revised (KDM-154): a downed player is NOT incapacitated by us. KD has no
			// "Will = 0 ⇒ you cannot act" rule — KinkyDungeonMove has no Will check and
			// KDPlayerCanMove is terrain-only; low Will only makes enemies grab you more
			// (KinkyDungeonEnemyTeaseAttacks.ts:746) and immobility comes from bondage/stun
			// (KinkyDungeonIsDisabled = stunned || KDBoundEffects > 3). So being worn down leads to
			// being TIED, and the tie — mirrored into the victim's bundle and enforced by the real
			// pipeline — is what limits them. Escapable by struggling, exactly like single-player.
			// `defeated` therefore survives only as the bindability signal (_armPeerEnemies stuns the
			// avatar so KD's own KDCanApplyBondage gate passes) and the HUD marker.
			const { kdType, data } = this._toInput(id, action);
			// swap this player in; park their avatar so it doesn't block their own move
			this.world.restorePlayer(this.bundles.get(id));
			const avId = this.avatars.get(id);
			if (avId != null) this.world.moveAvatar(avId, PARK.x, PARK.y);
			// KD-100: arm every PvP peer as a REAL hostile enemy (hp = their Will) so this player's
			// stock attack pipeline can hit them for real (no synthetic interception).
			this._armPeerEnemies(id);
			// KDM-208: …but a peer who only got here because they were applied first is not a target.
			this.world.setBumpVeto([...this.avatars.entries()]
				.filter(([cid, eid]) => cid !== id && arrived.has(eid))
				.map(([, eid]) => eid));
			// KDM-240 A2: and tell the world who else is in this party and where they are standing, so
			// the co-located level goal can be decided from inside KD's own stair cancellation. Pushed
			// per APPLY, not per turn: the facts are relative to whoever is acting, and a peer position
			// from the previous apply is a gate that answers about a world that has moved on.
			this._pushPartyGate(id);
			// KDM-261: …and whether anybody ELSE is still up, which is the whole capture rule. Written
			// per APPLY, from two CONSTANT source strings so V8's eval compilation cache serves both
			// for free — interpolating a per-call value into a hot eval costs ~8.7x (measured in this
			// layer, and the same reason `setPartyGate` splits its two payloads).
			this.world.eval(this._anyPartnerFree(id)
				? 'globalThis.__kdCoopPartnerFree = true;'
				: 'globalThis.__kdCoopPartnerFree = false;');
			// KD-090: capture this player's message-log delta (messages pushed while THEY
			// are the swapped-in player are theirs — incl. enemy-AI lines aimed at them).
			const logLen0 = this.world.messageLogLength();
			let result = null;
			let cancelled = false;
			// KDM-164: the synthetic `pvpAttack` / `pvpBind` primitive is GONE. It computed its own
			// attack and wrote the result onto the target's bundle, bypassing the game entirely — a
			// second, parallel combat model kept alive "for tests". There is now exactly one path:
			// the player's real action through KD's own pipeline.
			if (kdType) {
				// KD-100: run the player's REAL action. A move/attack/spell INTO a peer's avatar (armed
				// as a real hostile enemy above) auto-runs KD's real attack pipeline — real damage, real
				// combat text + floaters, real defeat/capture. No interception. Reconciled after the turn.
				// KDM-163: apply for real, and LEARN whether this input type consumes a turn. The
				// classification comes from a genuine application — never a speculative one, which
				// would double-apply world-mutating actions (measured, probes/probe11).
				const obs = this.world.applyInputObserved(kdType, data) || {};
				result = obs.result;
				// KDM-208: did the contested-tile veto fire for this action? Read it before anything else
				// can, and RECORD it — a cancelled move is a real input that produced nothing, exactly the
				// class of silent drop KDM-163 made reportable.
				// KDM-268: did the dispatch THROW? applyInputObserved caught it into obs.error; until now
				// nothing on this path read that, so the action was truncated in silence.
				this._noteFailedInput(id, kdType, obs);
				cancelled = (this.world.takeBumpVetoes() || 0) > 0;
				if (cancelled) {
					this._recordDrop(this.cancelledMoves, { clientId: id, turn: this.turn, kdType });
					this._dbg(`CANCELLED contested move for ${id} ("${kdType}") in turn ${this.turn} — ` +
						`a peer arrived on the target tile earlier in this same turn`);
				}
				// KDM-186: this player is swapped in, so whatever the game just queued for its draw layer
				// is theirs. Harvest it as EVENTS now — it is presentation output, not state, and is no
				// longer captured (it used to be replicated and re-delivered forever).
				this._harvestFloaters(id);
				this._noteUnknown(kdType, obs);
				// KDM-163/KDM-197: fold this occurrence into what we know about the type. Asymmetric on
				// purpose — see `_learnInputKind`. KDM-208's `!cancelled` guard is now one instance of
				// the general rule "an action we stopped is not a measurement of the type".
				this._learnInputKind(kdType, obs, cancelled);
				// KDM-164: the hand-rolled friendly-fire splash is GONE. KD's own AOE already reaches
				// peer avatars — measured: an AOE cast produced a real bullet whose blast damaged a peer
				// avatar via `KinkyDungeonDamageEnemy`, which the peer-damage recorder captures like any
				// other hit, so `_reconcilePeers` applies it through that player's real pipeline
				// (probe: `KDM-164/probes/aoe-real-path.spec.ts` — Will 10 → 6.5, `updateBullets` 16).
				// Splash is now whatever the GAME does: real bullet travel, real walls, real LoS.
			}
			// Capture the delta; if the log was reset this turn (e.g. a floor transition
			// clears it), take the whole new log as the delta.
			const newLen = this.world.messageLogLength();
			const added = (newLen >= logLen0) ? this.world.messagesSince(logLen0) : this.world.messageLog();
			// KDM-165: the delta captured while THIS player was swapped in is THIS player's. No text is
			// inspected to guess an audience — the swap window is engine truth, and it is what the game
			// means by emitting those lines at that moment.
			//
			// The old rule ran `/^you\b|^your\b/i` over the rendered text and broadcast everything else.
			// It was English-only, so in CN/DE/ES/JP/KR/RU nothing matched and every private line leaked
			// to the peer. It was also wrong in the other direction: KD gates messages by VISION at the
			// source (`KinkyDungeonGame.ts:2602`), so a line only reaches the log if the ACTING player
			// can see its subject — broadcasting it showed the peer things they may not be able to see.
			//
			// Genuinely session-level events are broadcast EXPLICITLY (see `_markDefeated`,
			// `_markRecovered`, `_onMapChanged`) — a concern the proxy legitimately owns, and one
			// that never depends on reading game content.
			if (added && added.length) this._pushLog(id, added);
			// KDM-261 R6: did KD's capture just get held in place because a partner is still up? Said
			// ONCE, to everyone, in the proxy's own words — a partner who never hears it cannot come
			// and free them, and KD's own "KinkyDungeonLeashed" line is the captured player's, not a
			// broadcast (KDM-165). Read AFTER the delta above so the announcement is not also folded
			// into the acting player's personal log twice.
			if (this._takeCoopFlag('__kdCoopCaptureHeld') === true) {
				// KD kicked the other players' avatars off the board on its way through
				// (`KDKickEnemies`, `KinkyDungeonJail.ts:1888`) — put them back exactly where they
				// were standing. Nobody MOVES: that is the whole point of holding the capture.
				this._reseatParty(id, null, false);
				this._announceCaptureHeld(id);
			}
			// KDM-240 A3/R5: the party has moved to another MAP, so say so and put everyone on it.
			//
			// This replaces a `getLevel()` comparison. The level number is not the map: a capture
			// regenerates the map at an unchanged level (`KinkyDungeonDefeat` → `KinkyDungeonCreateMap`,
			// KinkyDungeonJail.ts:1725) and relocates the WHOLE party, because there is one world. That
			// went entirely undetected, so the partner kept an old-map coordinate and lost their avatar
			// with nothing said. Comparing the map itself detects a descent, a side room, the hub and a
			// capture with one rule — and it needs no stairs hook, so it never meets the doubled
			// `afterHandleStairs` signal.
			//
			// The baseline is SESSION-level, not per-apply, so a map change that happened outside any
			// apply window is still caught on the next one instead of being silently adopted.
			const mapNow = this.world.mapId();
			if (this._lastMapId !== undefined && mapNow !== this._lastMapId) this._onMapChanged(id, mapNow);
			this._lastMapId = mapNow;
			// swap out: persist this player's new state + move their avatar to its new spot
			this.bundles.set(id, this.world.capturePlayer());
			this.vitalsOf.set(id, this.world.getVitals());   // KD-098: refresh for the HP bar
			const p = this.world.getPlayerPos();
			// KDM-240 F1: …and re-spawn it if it is gone. `moveAvatar` answers `null` for an entity
			// that no longer exists and that answer used to be dropped on the floor, which is how a
			// map change made the players permanently invisible to each other.
			const liveAvId = this._ensureAvatar(id, p.x, p.y);
			// KDM-208: this avatar now stands somewhere it did not stand at turn start, so for everyone
			// applied AFTER it, it is an arrival — present enough to block, not to be bumped.
			// KDM-240: read the id back from `_ensureAvatar`, not from `avId` captured before the apply —
			// a re-spawn changes it, and a stale id here would silently stop marking arrivals.
			const s0 = startPos.get(id);
			if (liveAvId != null && s0 && (p.x !== s0.x || p.y !== s0.y)) arrived.add(liveAvId);
			applied.push({ id, kdType, result, pos: p, cancelled });
		}
		// KDM-208: the veto is per-apply. Leave the world with it off, or the immediate ("ui") apply
		// path — which runs outside this loop — would inherit a stale set from the last turn.
		this.world.setBumpVeto([]);
		// KD-100: reconcile each peer avatar's REAL combat result (hp damage, capture) back into its
		// owner's bundle (avatar.hp → Will; real capture/helpless → defeated + broadcast).
		this._reconcilePeers();
		// KDM-227: finishing a level clears the slate between players.
		this._checkHubArrival();
		// Per-turn state line: who is down and where everyone's Will sits. This is the view you
		// need to tell "my input is ignored" apart from "my input did nothing".
		this._dbg(`turn=${this.turn} done defeated=[${[...this.defeated].join(',')}] ` +
			this._joined.map((pid) => {
				const v = this.vitalsOf.get(pid) || {};
				return `${pid}:will=${v.will != null ? v.will.toFixed(2) : '?'}/${v.willMax != null ? v.willMax : '?'}`;
			}).join(' '));
		this.world.parkGlobalPlayer(PARK.x, PARK.y);
		this.turn += 1;
		this._pending.clear();
		// KDM-235 A3 — THE TURN BOUNDARY. The barrier is empty exactly here, so this is the only
		// moment a new seat can appear without disturbing a turn in flight.
		this._flushPendingJoins();
		this.lastTurn = { order, applied };
		return { turn: this.turn, applied };
	}

	/**
	 * KDM-227/262 — reaching the between-floors hub puts everyone back at peace.
	 *
	 * THE ONE HUB DETECTOR. Every consumer asks this; nothing re-tests the room for itself. (A second
	 * hub test elsewhere is how the gateway would drift into two different answers to "are we at the
	 * hub?" — `mp-peace-hub-reset.spec.ts` counts the room name in this file to keep it at one.)
	 *
	 * The trigger is the room the party is IN, not the floor number: descending goes floor → hub →
	 * floor, and only the hub — the one with the perk pick, the merchants and the path choice — ends a
	 * war. `Tunnel`, `ShopStart`, `ElevatorRoom`, `Summit` are the optional detours a grudge is meant
	 * to survive, so this matches the named set exactly rather than "any non-empty RoomType". Which
	 * rooms are in that set, and why KDM-227's original answer was wrong, is on HUB_ROOM_TYPES.
	 *
	 * ARRIVAL, NOT PRESENCE. It fires on the TRANSITION into the hub and not on the turns spent there,
	 * so a fight that breaks out on the hub is not undone by simply standing on it. A compare-and-store
	 * against the previous room is what buys that: no stairs hook, and therefore none of the
	 * doubled-signal trouble that hooking `afterHandleStairs` brings (it fires twice on a real
	 * floor-to-floor walk, precisely because the hub sits between the floors).
	 *
	 * There is nothing to coordinate between players: the session has ONE world, one
	 * `MiniGameKinkyDungeonLevel` and one `KDGameData.RoomType` — a floor change moves the whole party
	 * (KDM-165) — so no state exists in which one player is on the hub and the other is not.
	 */
	_checkHubArrival() {
		let room = '';
		try { room = this.world.getRoomType() || ''; } catch (e) { return; }
		const prev = this._lastRoomType;
		this._lastRoomType = room;
		// Presence ≠ arrival: this fires on the TRANSITION into a hub, never on the turns spent there.
		if (!HUB_ROOM_TYPES.includes(room) || HUB_ROOM_TYPES.includes(prev)) return;
		this.rel.resetAll();
		// KDM-230: and take down any peace dialogue the reset just made moot.
		for (const id of this._joined) this._closePeaceDialogue(id);
		// …and clear the hostility the GAME holds, not only our verdict: `_isPvP` governs whether the
		// next turn ARMS the avatars as hostile, it does not undo aggro KD already wrote on them.
		for (const eid of this.avatars.values()) {
			try { this.world.setAvatarHostile(eid, false); } catch (e) { /* avatar gone; nothing to clear */ }
		}
		this._dbg("HUB RESET — every pair back to co-op on arrival at " + room);
	}

	/**
	 * KDM-237 N2 — record the name a player chose. Called by the bridge as it seats them, from the
	 * gate's seat record; the session never invents one.
	 *
	 * Idempotent and order-independent: it may be called before `join()` (the normal path, since the
	 * gate knows the name before the session knows the player) or after. `_seatPlayer` reads it at
	 * seating time, which is the only moment it matters.
	 */
	setPlayerName(clientId, name) {
		const n = sanitizeName(name);
		if (n) this.nameOf.set(clientId, n);
		else this.nameOf.delete(clientId);
		return n;
	}

	/**
	 * KDM-237 — what this player is CALLED. The single fallback in the whole feature.
	 *
	 * ⚠️ NF2 lives here. The legacy `#coop=` path supplies no name and is what the entire MP e2e
	 * suite runs on, so the unnamed answer must stay byte-identical to what `_seatPlayer` used to
	 * concatenate inline. Every consumer — the avatar label, the captured bundle — asks this one
	 * function; nothing else builds a label. A fallback copied to a second call site is how that
	 * guarantee rots quietly.
	 */
	displayNameOf(clientId) {
		return this.nameOf.get(clientId) || ('Player ' + clientId);
	}

	/**
	 * KDM-238 R3 — record the perks a player chose. Called by the bridge as it seats them, from the
	 * gate's seat record; the session never invents one.
	 *
	 * Idempotent and order-independent, exactly like `setPlayerName`: it may be called before
	 * `join()` (the normal path, since the gate knows the declaration before the session knows the
	 * player) or after. `_seatPlayer` reads it at seating time, the only moment it matters.
	 */
	setPerks(clientId, perks) {
		const p = sanitizePerks(perks);
		if (p.length) this.perkOf.set(clientId, p);
		else this.perkOf.delete(clientId);
		return p;
	}

	/**
	 * KDM-239 R3/R5 — record the world a player declared. Idempotent and order-independent, exactly
	 * like `setPlayerName` and `setPerks`, and called from the same place (`_carrySeat`).
	 *
	 * ⚠️ ORDERING IS WHAT MAKES THIS FEATURE POSSIBLE. `_start()` is reached from `join()` only once
	 * the required number of players have joined — i.e. on the SECOND join — so by the time the world
	 * is built the host has long since joined and the gate has already handed us its declaration.
	 * That is the only reason the host's choices can reach `world.init()` before the map is
	 * generated, and it is why this must keep working before `join()`.
	 */
	setWorldOptions(clientId, world) {
		const w = sanitizeWorld(world);
		if (w.modes.length || w.seed) this.worldOf.set(clientId, w);
		else this.worldOf.delete(clientId);
		return w;
	}

	/**
	 * KDM-239 R3 — the world declaration that governs THIS session: the host's.
	 *
	 * The host is `_joined[0]` — the first player to join is the one whose machine owns the world
	 * (`join-gate.js` seats the host before it will accept any guest). A guest never has an entry
	 * here at all (the gate refuses to store one), so this is a single lookup rather than a
	 * precedence rule; there is nothing to resolve between.
	 */
	_hostWorld() {
		const host = this._joined[0];
		const w = host !== undefined ? this.worldOf.get(host) : null;
		return w ? { modes: w.modes.slice(), seed: w.seed } : { modes: [], seed: '' };
	}

	/**
	 * KDM-243 R1 — the save this session continues, declared by the host before they joined.
	 *
	 * Stored on the same terms as `setWorldOptions` and read by the same rule (`_joined[0]` is the
	 * host, because the gate seats the host before it will accept any guest), so there is again no
	 * precedence to resolve: a guest has no entry at all.
	 */
	setSaveOption(clientId, save) {
		const s = (typeof save === 'string') ? save : '';
		if (s) this.saveOf.set(clientId, s);
		else this.saveOf.delete(clientId);
		return s;
	}

	/** The host's declared save, or `''` — which means "start a new game", i.e. everything before this. */
	_hostSave() {
		const host = this._joined[0];
		return (host !== undefined && this.saveOf.get(host)) || '';
	}

	/**
	 * KDM-238 — what perks this player STARTS WITH. The single fallback in the whole feature.
	 *
	 * The counterpart of `displayNameOf`, and it exists for the same reason: the legacy `#coop=` path
	 * declares nothing and is what the entire MP e2e suite runs on, so "declared nothing" has to have
	 * exactly one answer and one home. That answer is `defaultPerks` — normally empty, which is KD's
	 * own new-game state, and non-empty only when an operator asked for it (`KD_COOP_PERKS`).
	 *
	 * A player's own declaration is never merged with the default: they chose, so they get theirs.
	 */
	perksOf(clientId) {
		const own = this.perkOf.get(clientId);
		return (own && own.length) ? own.slice() : this.defaultPerks.slice();
	}

	/**
	 * KDM-271 — the START perk set of the PARTY: the union of what every seat declared.
	 *
	 * WHY A UNION AND NOT EACH PLAYER'S OWN. KDM-238 gave each seat its own perks, and F10 of
	 * KDM-242 found that this is the same defect that task fixed for mid-run perks, shipped:
	 * several perks REWRITE THE SHARED WORLD and are read from whichever bundle happens to be swapped
	 * in when the read runs. `Stealthy` scales the floor's enemy count and doubles its treasure count
	 * (`KDMapGen.ts:1049`, `:1770`), `Pristine` its rubble (`:297`), `Doorknobs` whether doors
	 * generate open, `Fortify_Barricade` the enemy commander's AI (`KDCommander.ts:392`),
	 * `Blackout` enemy vision (`KinkyDungeonEnemies.ts:1880`), plus the generic `obj.FilterPerk` gate.
	 * All of them are selectable at character creation — the grid is populated from the whole of
	 * `KinkyDungeonStatsPresets` by category with no `tags: ["start"]` filter
	 * (`KinkyDungeon.ts:930-937`) and `KDValidatePerk` rejects only on `requireArousal`/`blockclass`.
	 * So a host starting with `Stealthy` and a guest without it made the floor's difficulty depend on
	 * SWAP ORDER, which is the non-determinism this whole epic exists to prevent.
	 *
	 * WHY NO "WORLD-AFFECTING PERK" LIST. That is the point of the union. The reads are scattered
	 * across map generation, tile generation, furniture selection and commander AI in the game tree
	 * we do not patch, and there is no seam to classify them at — so this does not classify them.
	 * If no perk differs between two seats, no world read can differ either, whichever seat is loaded.
	 * A subset would have to be named, and naming perks in `tools/mp-server/**` is what epic AC2
	 * forbids (`mp-perk-choice.spec.ts:173` fails the build on a literal perk name in this source).
	 *
	 * WHY THIS IS THE SAME RULE KDM-242 D1 USES, not a second one. D1: "a perk is the PARTY's, not
	 * the character's — on commit it is written into every seated player's `KinkyDungeonStatsChoice`."
	 * That is this, at the other end of the run. One answer to "who owns a perk", in both places.
	 *
	 * WHAT THE PLAYER SEES. Character creation still belongs to each player, and both halves of its
	 * ledger pool: a partner's `Studious` arrives, and so does the `KillSquad` they took to pay for
	 * it. Nothing is ever revoked — a departing player's perks stay with the party, for the same
	 * reason D1 never takes a perk back.
	 *
	 * Order is deterministic (seat order, then declaration order) so `applyPerks` runs
	 * `KDPerkStart` in the same sequence for every seat.
	 */
	partyPerks() {
		const out = [];
		const seen = new Set();
		for (const id of this._joined) {
			for (const k of this.perksOf(id)) if (!seen.has(k)) { seen.add(k); out.push(k); }
		}
		return out;
	}

	/**
	 * KDM-271 — a latecomer widened the party's perk set, so the seats already taken have to catch up.
	 *
	 * `_seatPlayer` gives the ARRIVING player the whole union, because seating builds a character from
	 * KD's own new-game template and `applyPerks` is the operation for that. The players already in
	 * the dungeon cannot be rebuilt — so they are granted the added keys and nothing else
	 * (`HeadlessHost.grantPerks`: the flag, no wipe, no `KDInitPerks()`). Without this the union is
	 * per-seat again the moment anyone joins late, which is the bug with extra steps.
	 *
	 * The asymmetry is deliberate and it is the same one KDM-242 drew: a seat is a character and
	 * gets start-effects; a mid-run grant is a perk and does not. Nobody is re-equipped because
	 * somebody else walked in.
	 *
	 * @param {Set<string>} before the union as it stood before the arrival
	 * @param {string} arrivedId the newcomer, who already has the whole set from `_seatPlayer`
	 */
	_fanOutStartPerks(before, arrivedId) {
		const added = this.partyPerks().filter((k) => !before.has(k));
		if (!added.length) return [];
		for (const cid of this._joined) {
			if (cid === arrivedId) continue;
			const bundle = this.bundles.get(cid);
			if (!bundle) continue;
			this.world.restorePlayer(bundle);
			this.world.grantPerks(added);
			this.bundles.set(cid, this.world.capturePlayer());
		}
		// Leave the arriving player in the slot, as `_seatPlayer` left it.
		const mine = this.bundles.get(arrivedId);
		if (mine) this.world.restorePlayer(mine);
		this._dbg(`PARTY PERKS widened by ${arrivedId}: ${added.join(', ')}`);
		return added;
	}

	/**
	 * KDM-235 A1 — seat ONE player: the recipe `_start` used to inline, now shared with join-late.
	 *
	 * The exact mirror of `removePlayer`, and kept that way on purpose — a player is seated in one
	 * place and unseated in one place, so the two can be read against each other. Every container it
	 * fills is one `removePlayer` empties.
	 *
	 * The template restore is the load-bearing line (see `_start`): it is what makes a latecomer their
	 * own character instead of a copy of whoever last held the player slot.
	 */
	_seatPlayer(clientId, pos) {
		/*
		 * KDM-243 A4 — which character this seat starts from.
		 *
		 * One lookup with the old field as the fallback, so an ordinary session reaches
		 * `_newPlayerTemplate` exactly as it always did and the import path needs no branch at the
		 * call sites (`_start` and `_admit` both stay untouched).
		 */
		const imported = this._templateOf.get(clientId) || null;
		const template = imported || this._newPlayerTemplate;
		if (template) this.world.restorePlayer(template);
		/*
		 * KDM-237 S1/S2 — what this player is called, in the two places it has to appear.
		 *
		 * ⚠️ ORDER IS THE WHOLE MECHANISM. `setPlayerName` writes `KDGameData.PlayerName` into the
		 * world's player slot, and `capturePlayer()` two lines down snapshots `KDGameData` — so the
		 * name rides inside THIS player's bundle only because it is set between the template restore
		 * and the capture. Set it after, and it lands on whoever is restored into the slot next.
		 * `PlayerName` is deliberately absent from `KDGAMEDATA_WORLD_KEYS`, so per-player
		 * replication needs nothing beyond being here.
		 *
		 * ⚠️ AND ONLY A CHOSEN NAME IS WRITTEN. The avatar LABEL always falls back to `Player <id>`
		 * (that is what the other player sees, and what it has always been), but a player who chose
		 * nothing keeps KD's own default `PlayerName` — their character's name, in their own UI.
		 * Stamping `'Player A'` there instead made a 1-player session diverge from a reference
		 * single-player run, which `mp-parity-oracle` caught: the two fields answer different
		 * questions, and only one of them has a co-op fallback.
		 */
		/*
		 * KDM-238 R4/R5 — the party's perks, in the same window and for the same reason (KDM-271: they
		 * used to be this player's alone; see `partyPerks`).
		 *
		 * FIRST among the per-player mutations, because it is the one with side effects: `applyPerks`
		 * runs KD's own `KDInitPerks()`, which adds restraints, weapons, consumables and spell points
		 * to whoever is in the slot. Everything after it (the name, the position) is a plain
		 * assignment and does not care about the order; a perk's starting collar very much does.
		 *
		 * Unconditional, unlike the name: a party that declared nothing still needs the map RESET to
		 * that answer, or a seat would inherit whatever the previous occupant of the slot chose.
		 * `perksOf` is what makes "declared nothing" mean KD's default rather than "leave it alone".
		 */
		/*
		 * KDM-239 A3 — a seat starts from KD's OWN new-game state, then adds what this player chose.
		 *
		 * The base is what `init()` produced (`_baseStats`), NOT an empty map. Those consent-derived
		 * perks are settings, not choices — a player never picked them and never sees them on the perk
		 * screen — so replacing them with a player's declaration would silently drop them, which is
		 * precisely the single-player divergence `mp-parity-oracle` caught.
		 *
		 * A UNION, so nothing KD itself established is dropped: a party that declared nothing gets
		 * exactly KD's default, and declared perks arrive ON TOP of it rather than instead of it.
		 *
		 * KDM-271 — and the declared half is the PARTY's (`partyPerks`), not this player's. KDM-238's
		 * `perksOf(clientId)` here is exactly the defect F10 of KDM-242 found: a perk one seat holds and
		 * another does not makes the generated floor depend on which bundle was swapped in. Every seat
		 * is built from the same set, so no world read can disagree with itself.
		 */
		/*
		 * KDM-243 A4a — AN IMPORTED SEAT SKIPS BOTH OF THE NEXT TWO CALLS.
		 *
		 * `applyPerks` and `applyModes` are NEW-GAME operations. `applyPerks` runs KD's own
		 * `KDInitPerks()`, which hands the player in the slot their starting restraints, weapons,
		 * consumables and spell points, and rebuilds `KinkyDungeonStatsChoice` from scratch. Run over
		 * a character resumed at floor 9 that means a second starting collar and a reset to a fresh
		 * run's rules — it would visibly damage the very character the host asked to continue.
		 *
		 * The save already carries both halves: its perks came back with the character, and its modes
		 * are what `_start` re-read into `_baseStats` after the load. The lobby's perk screen is a
		 * new-game screen, so a host continuing a run is not choosing perks with it.
		 *
		 * The guest's seat has no entry in `_templateOf`, so it still gets the full treatment — which
		 * is what makes their fresh character a real fresh character.
		 */
		if (!imported) {
			const base = (this._baseStats && this._baseStats.perks) || [];
			this.world.applyPerks([...new Set([...base, ...this.partyPerks()])]);
		/*
		 * KDM-239 A3 — and IMMEDIATELY after it, the game modes `applyPerks` just destroyed.
		 *
		 * `applyPerks` above rebuilds `KinkyDungeonStatsChoice` from scratch and keeps only real
		 * perks. KD's game-mode keys live in that same Map but are NOT perks (they are written by
		 * `KDUpdatePlugSettings`, and none of them is in `KinkyDungeonStatsPresets`), so the line
		 * above silently wipes every mode the world was built with. Without this, the two players end
		 * up in one world running on two different sets of rules — and nothing would say so.
		 *
		 * Unconditional and applied to EVERY seat, including a latecomer's: "both players agree about
		 * the world" is the property, so it cannot depend on who joined when.
		 */
			this.world.applyModes((this._baseStats && this._baseStats.modes) || []);
		}
		/*
		 * KDM-243 A4b — and an imported seat is not renamed either. `setPlayerName` writes
		 * `KDGameData.PlayerName`, which is the CHARACTER's name; the lobby name is the SESSION
		 * identity, and that is what every label and announcement already uses (`displayNameOf`). A
		 * host continuing their own run keeps the name that character has always had.
		 */
		const chosen = imported ? '' : (this.nameOf.get(clientId) || '');
		if (chosen) this.world.setPlayerName(chosen);
		this.world.placePlayer(pos.x, pos.y);
		this.bundles.set(clientId, this.world.capturePlayer());
		this.vitalsOf.set(clientId, this.world.getVitals());   // KD-098: seed for the HP bar
		// KDM-240: seating goes through the SAME avatar path as everything else. The delete keeps the
		// old semantics exactly — a seat always spawns a fresh avatar, never adopts one a previous
		// seating left behind — while leaving `spawnAvatar` with a single caller.
		this.avatars.delete(clientId);
		const avId = this._ensureAvatar(clientId, pos.x, pos.y);
		this.startOf.set(clientId, pos);
		// KD-090: a personal log to append per-turn deltas to. At boot `_start` re-seeds every log
		// from the intro after the loop — harmless and deliberate, so boot behaviour is unchanged.
		this.logs.set(clientId, (this.world.messageLog() || []).slice(-this.maxLog));
		return avId;
	}

	/**
	 * KDM-235 — admit a NEW player to a session that is already running.
	 *
	 * Deliberately NOT `join()`: that one is the pre-start collector and throws once started, and the
	 * two have genuinely different rules (a free slot vs a quorum). Reconnect is a third thing again
	 * and lives in the bridge — a known id re-attaching never reaches here.
	 *
	 * ⚠️ TIMING IS THE WHOLE RISK, not the world. `_advanceTurn` is synchronous, so a join can never
	 * interleave inside a turn. What it CAN do is arrive while the submit barrier is open — and since
	 * `waitingOn()` is `_joined` minus `_pending`, seating immediately would either stall a turn that
	 * was one submit from resolving, or enrol someone in a turn they never saw. So an arrival during
	 * an open turn is QUEUED and flushed at the boundary (end of `_advanceTurn`). One rule, one place.
	 *
	 * Returns `{seated, deferred}` — `deferred` says the seat is promised but not yet present, which
	 * the caller needs in order to decide when to send the first snapshot.
	 */
	joinInProgress(clientId) {
		if (!this.started) return { seated: false, reason: 'not-started' };
		if (!clientId) return { seated: false, reason: 'no-id' };
		if (this._joined.includes(clientId)) return { seated: false, reason: 'already-seated' };
		if (this._pendingJoins.includes(clientId)) return { seated: true, deferred: true };
		if (this._pending.size > 0) {
			this._pendingJoins.push(clientId);
			this._dbg(`JOIN-LATE ${clientId} queued — a turn is open`);
			return { seated: true, deferred: true };
		}
		this._admit(clientId);
		return { seated: true, deferred: false };
	}

	/** Actually take the seat. Only ever called with the barrier closed — see `joinInProgress`. */
	_admit(clientId) {
		// J1/J2 — next to the HOST (seat 0), on a legal tile nothing else is standing on. Falls back
		// to the map-wide open tile rather than failing the join: arriving somewhere odd beats not
		// arriving at all.
		const hostId = this._joined[0];
		const hostAv = hostId != null ? this.avatars.get(hostId) : null;
		const hostPos = hostAv != null ? this.world.entityPos(hostAv) : null;
		const pos = (hostPos && this.world.findFreeTileNear(hostPos.x, hostPos.y)) || this.world.findOpenTile();
		// KDM-271: the party's start perk set BEFORE this arrival. Read here, while `_joined` still
		// excludes the newcomer, because the whole question is what they ADD to it.
		const perksBefore = new Set(this.partyPerks());
		this._joined.push(clientId);
		this._seatPlayer(clientId, pos);
		// …and the seats already taken catch up, or the union is per-seat again the moment anyone
		// joins late — which is the very defect `partyPerks` exists to close.
		this._fanOutStartPerks(perksBefore, clientId);
		// KDM-253 lowered `required` on a departure; raise it back, or a solo-then-rejoin session ends
		// with a quorum below its own seat count.
		this.required = Math.max(this.required, this._joined.length);
		this.world.parkGlobalPlayer(PARK.x, PARK.y);
		this._dbg(`JOIN-LATE ${clientId} seated at ${pos.x},${pos.y} — ${this._joined.length} player(s)`);
		return true;
	}

	/** Flush whatever arrived mid-turn. Called at the turn boundary, where the barrier is empty. */
	_flushPendingJoins() {
		if (!this._pendingJoins.length) return [];
		const admitted = [];
		for (const id of this._pendingJoins.splice(0)) {
			if (this._joined.includes(id)) continue;
			this._admit(id);
			admitted.push(id);
		}
		return admitted;
	}

	/**
	 * KDM-253 A5 — EVERY container on this session that is keyed by clientId, declared in ONE place.
	 *
	 * `join()` only ever pushed; until now nothing was ever removed from any of these, and there are
	 * thirteen of them. A `removePlayer` that deleted from the seven the ticket happened to name would
	 * be wrong the day a fourteenth is added — and wrong *silently*, leaving an entry keyed by a
	 * player who no longer exists.
	 *
	 * This list is the intent. The guard is `tests/unit/mp-solo-teardown.spec.ts`, which sweeps the
	 * live session for the departed id by SHAPE rather than by name, so a container missing from here
	 * fails a test instead of leaking quietly. Add new per-player state to this list, not to
	 * `removePlayer`.
	 *
	 * `_joined` is deliberately absent: it is an array and its removal is ordered bookkeeping, done
	 * explicitly below.
	 */
	_perClientStores() {
		return [
			this.bundles, this.avatars, this.startOf, this.logs, this.actionMsgOf, this.nameOf,
			// KDM-243 — the save a host declared, and the character template it produced. Per-client
			// containers like `worldOf` beside them, so a departing player takes both with them; a
			// stale `_templateOf` entry would seat a RECONNECTING player from a character captured
			// before the run moved on.
			this.perkOf, this.worldOf, this.saveOf, this._templateOf,
			this._eventSeq, this.pendingEvents, this._sentSoundDesc, this.vitalsOf,
			this.defeated, this.tiedOf, this._pending, this._stateFp,
		];
	}

	/**
	 * KDM-253 E5/D3 — the survivor has chosen to play on. Take this player out of the world entirely.
	 *
	 * ⚠️ THIS IS THE RISKIEST OPERATION IN THE EPIC. `_joined` is load-bearing across turn order,
	 * per-player logs, PvP pairs, peace, avatar arming and snapshot composition, and it has never had
	 * a removal path. Each step below is asserted separately rather than under one "it did not crash".
	 *
	 * What is deliberately NOT done: the survivor's restraints are left alone. Ties applied by a peer
	 * are mirrored onto the victim through KD's own `KinkyDungeonAddRestraint`, so they are the
	 * victim's OWN items on their OWN bundle with no record of who applied them. The ropes do not fall
	 * off because the person who tied them disconnected, and stripping them would be a state-
	 * destroying "cleanup" dressed up as tidiness.
	 *
	 * Idempotent and safe for an unknown id: this is called from a dialogue answer, and a double click
	 * must not throw at a player who is already alone.
	 */
	removePlayer(clientId) {
		if (!clientId || !this._joined.includes(clientId)) return false;
		// 1. the avatar entity leaves the shared world. Its enemy DEF stays: that is a template, and
		//    removing it would break a later session and disturb KD's enemy cache.
		const eid = this.avatars.get(clientId);
		if (eid != null) {
			try { this.world.despawnAvatar(eid); } catch (e) { this._dbg(`despawn ${eid} failed: ${e}`); }
		}
		// 2. any dialogue of OURS still open on a REMAINING player that was about this one. The
		//    survivor answered the wait/solo question, so KD has already closed it on them — but the
		//    close is idempotent and this also covers a peace offer left hanging with the departed.
		for (const id of this._joined) {
			if (id === clientId) continue;
			for (const name of OWN_DIALOGUES) {
				try { this._closeOwnDialogue(id, name); } catch (e) { /* world may be mid-teardown */ }
			}
		}
		// 3. every relationship naming them — war, peace, and any unanswered offer either way.
		// …and NOT `forget`, which deliberately keeps war/peace for a player who may reconnect. This
		// player is gone for good (see the note on `PeaceRegistry.remove`).
		this.rel.remove(clientId);
		// 4. every per-client container, from the one declaration above.
		for (const store of this._perClientStores()) {
			try { store.delete(clientId); } catch (e) { /* not a Map/Set — nothing to delete */ }
		}
		// 5. the seat itself, and the lockstep barrier with it. `waitingOn()` filters `_joined`, so
		//    THIS is what lets the survivor's own submit resolve a turn — not `required`, which is
		//    only ever read by `join()`. Lowered anyway so the two can never disagree.
		this._joined = this._joined.filter((id) => id !== clientId);
		// KDM-235: …and any promised-but-unseated arrival, or a player dismissed while their join was
		// queued would be seated moments later by the turn-boundary flush.
		this._pendingJoins = this._pendingJoins.filter((id) => id !== clientId);
		this.required = Math.max(1, this._joined.length);
		this._dbg(`REMOVED ${clientId} — ${this._joined.length} player(s) remain`);
		return true;
	}

	/** Enable/disable GLOBAL player-vs-player damage for this session (KD-092). */
	setPvP(on) { this.pvp = !!on; return this.pvp; }

	/** KD-100: await the world's async text load so real combat messages aren't "[NotFound] …".
	 *  Live sessions also kick this fire-and-forget at _start; tests await it explicitly. */
	async ready() { if (this.started) await this.world.ready(); return this; }

	/**
	 * KD-100: before `actorId` acts, make every PvP peer's avatar a REAL hostile enemy whose hp tracks
	 * that peer's current Will (maxhp = WillMax). Then the actor's stock move/attack/spell runs the
	 * game's real combat against it — real damage, real text, real defeat/capture.
	 */
	/**
	 * Put a peer's real bondage onto their avatar, as a LEVEL with no items.
	 *
	 * KD-101: the avatar must not ACCUMULATE restraint items — its binding slots fill up and the stock
	 * submenu (`KDGetNPCBindingSlotForItem(...).sgroup`, no null guard) crashes after a few ties. The
	 * victim keeps the real ties on their own bundle, so the items are cleared every turn.
	 *
	 * KDM-199: …and the LEVEL is then mirrored back through the item-free channel, so `KDBoundEffects`
	 * sees it. Without this the avatar reads as unbound and `KDBoundEffects` returns 0 at its
	 * `boundLevel` short-circuit.
	 *
	 * The scale is the peer's own bondage power (`headless-host.js:775`, the sum of `KDRestraint().power`
	 * over what they are wearing) — the same number the tie path and the untie path both read, so no
	 * third scale is invented between them.
	 */
	_mirrorPeerBondage(cid, eid, vitals) {
		this.world.clearAvatarBondage(eid);
		this.world.setAvatarBondage(eid, (vitals && vitals.bondage) || 0);
	}

	_armPeerEnemies(actorId) {
		for (const [cid, eid] of this.avatars.entries()) {
			if (cid === actorId) continue;
			// BONDAGE IS MIRRORED FOR EVERY PEER, AT WAR OR NOT.
			//
			// It is not a combat stance — it is what the peer IS wearing, and the actor can see it.
			// This used to sit inside the PvP-only block below, so in co-op an avatar always read as
			// unbound: `KDGetPlayerUntieBindAmt` (KinkyDungeonDialogue.ts:2924) returned NaN off the
			// undefined `boundLevel`, `NaN > 0` was false, and the ally dialogue's `Untie` option was
			// never offered. That is the UAT report "players cannot help each other to remove bondage".
			//
			// It also switches on two of KD's OWN rules about a bound helper, which is the point: a
			// peer bound past `KDBoundEffects > 3` stops granting ally-help while you struggle
			// (KinkyDungeonRestraints.ts:1086) and can read as helpless. A hogtied partner being no
			// use is the game's answer, not ours.
			const v = this.vitalsOf.get(cid) || {};
			this._mirrorPeerBondage(cid, eid, v);
			if (!this._isPvP(actorId, cid)) continue;
			// KDM-199: ARM THE AVATAR FROM THE PEER, do not reset it to a placeholder.
			//
			// This used to set hp = FULL, stun = 0, boundLevel = 0 and then patch the consequences with an
			// invented rule (will <= 0 => stun 6). That rule existed only because the reset deleted the
			// three things KD own gate reads. Now each is mirrored from the peer real state, so
			// KDCanApplyBondage answers about the peer instead of about our placeholder.
			//
			// hp: the peer Will, on the avatar own scale. Will IS their defeat meter, snapshotFor already
			// presents it this way to the client, and this docstring said so before KDM-164 changed the
			// code and left the comment behind. It is a REPRESENTATION only — nothing reads it back as a
			// measurement any more (that was KDM-156; hits come from the recorder), which is what makes
			// restoring it safe. Floored just above zero: a hp=0 entity reads as DEAD and untargetable,
			// so the floor is a liveness detail, not a threshold.
			const cur = this.world.getEntityCombat(eid);
			const full = (cur && cur.maxhp != null && cur.maxhp > 0) ? cur.maxhp : 10;
			const frac = (v.will != null && v.willMax > 0)
				? Math.max(0, Math.min(1, v.will / v.willMax))
				: 1;
			const hp = Math.max(0.01, frac * full);
			// stun: the peer OWN engine stun countdown (KinkyDungeonFlags.playerStun). Mirrored, never
			// invented — the engine sets it and the engine counts it down.
			this.world.setAvatarEnemy(eid, hp, full, v.stunTurns || 0);
			this._dbg(`arm ${cid} hp=${hp.toFixed(2)}/${full} (will=${v.will != null ? v.will.toFixed(1) : "?"}) ` +
				`stun=${v.stunTurns || 0} bondage=${v.bondage || 0} disabled=${v.disabled}`);
			// (bondage is mirrored above, for every peer — see `_mirrorPeerBondage`.)
			// KDM-184: …and their own DEFENCES, so the attack that is about to resolve is evaluated
			// against the real defender's build. KDM-164 gave the victim their resistances, armour and
			// on-hit events from the moment damage is dealt (KinkyDungeonDealDamage, with them swapped
			// in); this is the half BEFORE that — hit-or-miss, which KD reads off the ENTITY
			// (KinkyDungeonGetEvasion:486) and so never saw the peer at all. Same mirror-from-the-peer
			// rule as the three above: the values are the game's own buff totals for that player.
			this.world.setAvatarDefenses(eid, v.evasion || 0, v.block || 0);
			// KDM-200: the DEFEATED-peer exposure is stamped on the SNAPSHOT (see snapshotFor), not on
			// the world avatar. Marking the world entity `vulnerable` changes real combat — KD grants
			// crits against a vulnerable target (KinkyDungeonFight.ts:886) — and measured: it killed the
			// avatar outright, which broke a downed peer keeping agency. The client is where the tie gate
			// runs, so the flag belongs on the object the client evaluates and nowhere else.
		}
	}

	/**
	 * KD-100: after the turn, fold each peer avatar's REAL combat result back into its owner's bundle.
	 * The avatar's hp was on the Will scale (armed hp=Will), so `Will = avatar.hp`. A player whose Will
	 * reaches the floor (real single-player defeat condition) — or whose avatar the engine marks helpless
	 * (captured, the real enemy-capture rule once bound) — is flagged `defeated` and broadcast.
	 */
	_reconcilePeers() {
		for (const id of this._joined) {
			const eid = this.avatars.get(id);
			if (eid == null) continue;
			const ec = this.world.getEntityCombat(eid);
			const v = this.vitalsOf.get(id) || {};
			// KDM-225 R15/AC6 — an attack starts a war, and the GAME is what says an attack happened.
			//
			// The signal is KD's own aggro on the avatar (`hostile`/`rage`), not our reading of the
			// input: the sneak option (`doaggro`) deals NO damage and would be missed by a
			// damage-based test, while `KDAggroViaDialogue` sets `hostile` for it just the same. So the
			// gateway records the relationship the game already decided, and classifies nothing.
			//
			// Two players ⇒ the attacker is unambiguous. Attribution for a third player is KDM-226's.
			// KD's aggro flag ONLY — deliberately not "any hit landed".
			//
			// A previous version also declared war when `peekPeerHits` was non-zero, to close the case
			// of a spell wounding a peer without setting `hostile`. That was wrong: the recorder logs
			// EVERY hit on the avatar, including the shared dungeon's own monsters. A Rat mauling a
			// downed peer re-declared war between the two PLAYERS one turn after they made peace
			// (UAT round 4, reproduced in mp-peace-session AC3b). Hits cannot distinguish a peer's
			// attack from a Rat's; `hostile`/`rage` is set by the aggressor, so it can.
			if (ec && (ec.hostile > 0 || ec.rage > 0)) {
				for (const other of this._joined) {
					if (other !== id && !this.rel.atWar(id, other)) {
						this.rel.declareWar(id, other);
						this._dbg(`WAR ${id} <-> ${other} (KD aggro on the avatar: hostile=${ec.hostile})`);
					}
				}
			}
			// KDM-164: the damage is whatever the GAME produced for each hit on this avatar — taken
			// verbatim, WITH its type — not `ARM_HP − hp` converted into Will by us. That conversion was
			// the invented model: it stitched KD's two damage pipelines (entity vs player) together with
			// arithmetic the game does not have, threw the damage type away, and bypassed the victim's
			// own resistances. It is also what caused the KDM-156 potion bug.
			const hits = this.world.takePeerHits(eid) || [];
			// KD-101: restraints the attacker tied onto the avatar THIS turn (avatar is cleared each turn,
			// so this is the per-turn delta). De-dup against what's already on the victim's bundle so a
			// re-detected name isn't double-applied; mirror new ones via the game's real KinkyDungeonAddRestraint.
			const restraints = (ec && Array.isArray(ec.npcRestraints)) ? ec.npcRestraints : [];
			let tied = this.tiedOf.get(id);
			if (!tied) { tied = new Set(); this.tiedOf.set(id, tied); }
			const newRestraints = restraints.filter((rn) => !tied.has(rn));
			// …and the mirror of that: bind level an ally actually untied off this avatar, TAKEN from
			// the recorder rather than read as a standing delta — same rule as the hits above, and for
			// the same measured reason (installPeerUntieRecorder).
			const untied = this.world.takePeerUnties(eid);
			if (hits.length || newRestraints.length || untied > 0) {
				this.world.restorePlayer(this.bundles.get(id));   // swap victim in once for both effects
				for (const h of hits) {
					// The victim is in the player slot, so this is KD's REAL player-damage pipeline
					// applying the game's own damage — the victim's resistances, events and message
					// lines all apply, exactly as when anything else in the game hurts a player.
					const before = this.world.getVitals().will;
					this.world.dealDamage(h.damage, h.type);
					// KDM-186: the victim is swapped in, so the game's own damage presentation for this hit
					// is queued against THEM — take it as an event so they see the number once.
					this._harvestFloaters(id);
					this._dbg(`reconcile ${id} real damage ${h.damage} ${h.type}: will ` +
						`${before != null ? before.toFixed(2) : '?'} -> ${(this.world.getVitals().will ?? 0).toFixed(2)}`);
				}
				if (untied > 0) {
					// The victim is swapped in, so this is the game's REAL removal path on their own
					// restraints, with their events and messages — the mirror of the tie below.
					const u = this.world.untieRestraints(untied, eid);
					// A freed item must leave `tied`, or the de-dup above would silently swallow a later
					// re-tie of the same restraint: it would be "already mirrored" forever.
					for (const rname of u.removed || []) tied.delete(rname);
					this._dbg(`reconcile ${id} untie -${untied.toFixed(2)} power: removed ` +
						`${JSON.stringify(u.removed)} progressed ${JSON.stringify(u.progressed)}`);
				}
				for (const rname of newRestraints) {
					// mirror the tie onto the victim's real player via the game's real KinkyDungeonAddRestraint
					const r = this.world.addRestraint(rname);
					tied.add(rname);
					this._dbg(`reconcile ${id} bind +${rname} (restraints now ${r && r.count})`);
				}
				this.bundles.set(id, this.world.capturePlayer());
				this.vitalsOf.set(id, this.world.getVitals());
			}
			// KDM-156: CONSUME the gauge. It measures damage dealt to this peer THIS TURN
			// KDM-164: the gauge is gone, and with it the KDM-156 bug class by construction. Hits are
			// TAKEN from the recorder (`takePeerHits` clears as it reads), so a hit can only ever be
			// charged once — there is no standing hp delta left to re-read on a later turn. The avatar
			// is still restored to full so it never dies and the peer stays targetable; that is a
			// representation detail now, not a measurement.
			if (eid != null && ec && ec.maxhp != null) {
				this.world.setAvatarEnemy(eid, ec.maxhp, ec.maxhp, 0);
				/*
				 * …but that is the ARMING call, and it also stamps `faction = 'Enemy'` and
				 * `hostile = 9999` (headless-host.js). It runs here for EVERY avatar EVERY turn,
				 * war or not — purely to restore hp — so it silently re-made a peaceful peer an
				 * enemy exactly one turn after a truce.
				 *
				 * UAT round 4: peace looked right for an instant and the peer was attackable again
				 * on the next turn, with `_isPvP` still false the whole time. Measured: faction
				 * `Player` → `Enemy`, talkable true → false, opinion +10 → -20 ("Hates you").
				 *
				 * So undo the hostility half whenever this player is at war with nobody. The hp
				 * restore — the only thing this call is wanted for here — stands.
				 */
				// Scoped to pairs that NEGOTIATED a truce, not to "not at war with anyone". Plain co-op
				// has always left avatars stamped Enemy by this call, and that is load-bearing world
				// state: making them Player faction changes who the dungeon's own monsters fight, which
				// showed up immediately as `mp-presentation-once` losing its noise events. Undoing our
				// own stamp after a truce is the fix that was asked for; quietly re-factioning every
				// co-op session is a different change, and not this one.
				if (this._joined.some((other) => other !== id && this.rel.atPeace(id, other))) {
					this.world.setAvatarHostile(eid, false);
				}
			}
			const cur = this.vitalsOf.get(id) || {};
			if (!this.defeated.has(id) && this._isDown(cur)) {
				this._markDefeated(id, `will=${cur.will.toFixed(2)}`);
			} else if (this.defeated.has(id) && cur.will != null && !this._isDown(cur)) {
				// KD-099 "freed": defeat is a state, not a life sentence. Once Will has recovered
				// well clear of the floor the player acts again. Hysteresis (a fraction of WillMax,
				// not the defeat line) so a sliver of regen doesn't flap them up and down.
				this._markRecovered(id, `will=${cur.will.toFixed(2)}`);
			}
		}
	}

	/** KDM-164: "down" is KD's own floor — Will at zero. No MP-specific threshold, no hysteresis. */
	_isDown(vitals) { return !!vitals && vitals.will != null && vitals.will <= 0; }

	/** Clear a player's defeat + broadcast a shared "recovered" message to everyone. KD-099 "freed". */
	_markRecovered(id, why) {
		this.defeated.delete(id);
		this._broadcast(`Player ${id} is back on their feet!`, '#33ff66', 12);
		this._emitEvent(id, { text: 'Recovered!', color: '#33ff66' });
		this._dbg(`RECOVERED ${id} (${why})`);
	}

	/** Flag a player defeated + broadcast a shared "defeated" message to everyone. KD-099/100. */
	_markDefeated(id, why) {
		this.defeated.add(id);
		this._broadcast(`Player ${id} has been defeated!`, '#ff3333', 12);
		this._emitEvent(id, { text: 'Defeated!', color: '#ff3333' });
		this._dbg(`DEFEAT ${id} (${why})`);
	}

	/** Has this player been defeated (real capture / Will floor)? Cleared once Will recovers (_markRecovered). */
	isDefeated(id) { return this.defeated.has(id); }

	/**
	 * KDM-261 — is this player still able to come and free somebody?
	 *
	 * Three conditions, none of them ours:
	 *   - they are seated in the session at all;
	 *   - they are not `defeated` — the Will floor, KD's own single-player defeat condition, which
	 *     `_updateDefeatFromVitals` / `_reconcilePeers` already maintain;
	 *   - KD's own `defeat` flag is not standing on them. `KinkyDungeonDefeat` sets it in the very
	 *     branch this rule selects (`KinkyDungeonJail.ts:1651`) and KD expires it on KD's schedule,
	 *     so "currently held" is read from the game rather than tracked here. No timer of ours, and
	 *     nothing to leak if a session ends mid-capture.
	 *
	 * Being merely TIED does not disqualify anyone: they can struggle, act and walk over. Being bound
	 * is not being captured (R4).
	 */
	_isFree(id) {
		if (!this._joined.includes(id)) return false;
		if (this.defeated.has(id)) return false;
		const v = this.vitalsOf.get(id) || {};
		if (this._isDown(v)) return false;
		return !(v.defeatTurns > 0);
	}

	/** KDM-261 R1 — is anybody OTHER than `actingId` still free? The whole input to the capture rule. */
	_anyPartnerFree(actingId) {
		return this._joined.some((cid) => cid !== actingId && this._isFree(cid));
	}

	/**
	 * KDM-261 R6 — a capture was held in place. Everyone hears it, once, from the proxy.
	 *
	 * Deliberately shaped like `_markDefeated`'s line rather than KD's: this is a fact about the
	 * SESSION (there are two of you, and that is why the jail door did not open), which is exactly
	 * the class of message the gateway is the only one who can say (KDM-165).
	 */
	_announceCaptureHeld(id) {
		this._broadcast(`${this.displayNameOf(id)} has been overpowered — free them before the party falls!`,
			'#ff8844', 12);
		this._emitEvent(id, { text: 'Overpowered!', color: '#ff8844' });
		this._dbg(`CAPTURE HELD for ${id} (a partner is still free — no jail move)`);
	}

	/**
	 * KDM-240 A2 — hand the world the party facts it needs to decide a CO-LOCATED level goal.
	 *
	 * `actingId` is excluded: the gate asks "is everyone ELSE here", and a player who counted as their
	 * own peer would be blocked by themselves forever. Down players are named rather than positioned,
	 * because D2 blocks them wherever they are standing.
	 *
	 * A one-player session pushes an empty peer list, which disables the gate outright — see
	 * `setPartyGate`. That is why this is unconditional: "there is nobody to wait for" has to be said
	 * every apply, or a session that drops to one player would keep the last two-player facts.
	 */
	_pushPartyGate(actingId) {
		const peers = [];
		for (const cid of this._joined) {
			if (cid === actingId) continue;
			const p = this.posOf(cid);
			if (!p) continue;                     // no avatar to stand anywhere: nothing to wait for
			peers.push({ x: p.x, y: p.y, name: this.displayNameOf(cid) });
		}
		const down = this._joined.filter((cid) => cid !== actingId && this.defeated.has(cid))
			.map((cid) => this.displayNameOf(cid));
		this.world.setPartyGate({ peers, down, radius: PARTY_GATE_RADIUS });
	}

	/**
	 * KDM-240 / KDM-261 — the world changed under the party; make every player whole again.
	 *
	 * ONE loop, two callers, because they want the same three things per player and differ only in
	 * where that player ends up:
	 *
	 *   `_onMapChanged`      tiles = landing tiles   the map was regenerated, so everyone is placed
	 *   held capture (R2)    tiles = null            nobody moves; only the avatars need rebuilding
	 *
	 * WHY THE HOLD NEEDS THIS AT ALL. `KinkyDungeonDefeat` calls `KDKickEnemies` (`:1888`) on BOTH
	 * sides of the fork, and a peer avatar IS an enemy — so a held capture removes the partner's
	 * avatar exactly as a jail move does. On the jail path `_onMapChanged` re-spawned it and the loss
	 * was invisible; on the hold path nothing did, and the partner vanished from the captured
	 * player's screen while standing right next to them. Measured, not reasoned: `posOf('B')` came
	 * back `null`.
	 *
	 * `includeActing` is false for a hold and true for a map change. On a map change the acting
	 * player's tile is the anchor and re-placing them is deliberate (see `_onMapChanged`). On a hold
	 * they are mid-apply and their bundle has NOT been captured yet, so restoring it here would
	 * re-seat them from their PRE-apply state and silently discard the capture that just happened to
	 * them. Their avatar is re-ensured by the apply loop a few lines later either way.
	 */
	_reseatParty(actingId, tiles, includeActing = true) {
		// When we are NOT re-seating the acting player, their live state has to be carried across the
		// loop by hand: they are mid-apply, so `bundles.get(actingId)` is stale BY DEFINITION and
		// restoring it at the end would discard the very capture that triggered this. Measured: KD's
		// own `TimesJailed` increment vanished from the held player's bundle.
		const liveActing = includeActing ? null : this.world.capturePlayer();
		for (const [i, cid] of [...this._joined].entries()) {
			if (!includeActing && cid === actingId) continue;
			this.world.restorePlayer(this.bundles.get(cid));
			let p;
			if (tiles) {
				const t = tiles[i] || tiles[0];
				if (!t) continue;                    // nowhere to land: leave this player alone
				this.world.placePlayer(t.x, t.y);
				p = t;
			} else {
				p = this.world.getPlayerPos();       // stay exactly where the game left them
			}
			this.bundles.set(cid, this.world.capturePlayer());
			if (p) this._ensureAvatar(cid, p.x, p.y);
		}
		// Leave the acting player swapped back in: the caller is mid-apply and captures their bundle
		// immediately after this returns, so anything else here would persist the wrong player's state.
		const back = liveActing || this.bundles.get(actingId);
		if (back) this.world.restorePlayer(back);
	}

	/**
	 * KDM-240 F1 — guarantee this player HAS an avatar at (x, y), and answer with its entity id.
	 *
	 * The single place an avatar comes into existence. `moveAvatar` returns `null` when the entity id
	 * no longer resolves (`headless-host.js`), which is the game telling us the entity is gone — most
	 * often because a map change replaced `KDMapData.Entities` wholesale. That answer used to be
	 * discarded at all three call sites, so the avatar simply stopped existing and the players stopped
	 * seeing each other with nothing logged.
	 */
	_ensureAvatar(clientId, x, y) {
		const eid = this.avatars.get(clientId);
		if (eid != null && this.world.moveAvatar(eid, x, y)) return eid;
		const av = this.world.spawnAvatar(x, y, this.displayNameOf(clientId));
		if (!av || av.entityId == null) return null;
		this.avatars.set(clientId, av.entityId);
		if (eid != null) this._dbg(`AVATAR ${clientId} re-spawned as ${av.entityId} (${eid} was gone)`);
		return av.entityId;
	}

	/**
	 * KDM-240 A3/R4 — the party has arrived on a different map. Put everyone on it, and say so.
	 *
	 * EVERY player is re-placed, including `actingId` — deliberately, and it is not a mistake that the
	 * one player KD already positioned is moved too. `landingTiles` anchors on exactly where KD put
	 * them, so the acting player is handed back their own tile and the others are spread onto free
	 * neighbours. Attributing the move to an actor and skipping them would be both fragile (a capture
	 * has no acting player in any meaningful sense) and pointless (the anchor is their tile anyway).
	 *
	 * Order matters: land first, THEN announce, so a client that reacts to the log line is reacting to
	 * a world in which everybody already exists somewhere sane.
	 */
	_onMapChanged(actingId, mapId) {
		const n = this._joined.length;
		this._reseatParty(actingId, (n ? this.world.landingTiles(n) : []) || []);
		// KDM-263 A2: an unfinished argument about how to get here is over now that we are here.
		this._resetJourneyProposal();
		this._resetPerkProposal();
		this._announceMapChange(mapId);
		this._dbg(`MAP ${this._lastMapId} -> ${mapId} (party re-landed, ${n} players)`);
	}

	/**
	 * KDM-165 / KDM-240 R6: the party moved together, so tell everyone — EXPLICITLY, in the proxy's own
	 * words. This replaces the old behaviour of duplicating whatever game text happened to be emitted
	 * during the transition into every player's log: those lines are the acting player's (they passed
	 * that player's vision check), while "we are all somewhere else now" is genuinely session-level and
	 * is ours to say.
	 *
	 * KDM-240 widened it from "descends to floor N": the party can arrive somewhere without the floor
	 * number changing at all (a side room, the hub, a jail), and announcing a descent that did not
	 * happen is worse than announcing nothing.
	 */
	_announceMapChange(mapId) {
		const room = String(mapId || '').split('|')[1] || '';
		const level = this.world.getLevel();
		this._broadcast(room
			? `The party arrives at ${room} on floor ${level}.`
			: `The party descends to floor ${level}.`);
	}

	/*
	 * KDM-165: the `_isPersonalMessage` heuristic that lived here is DELETED. It decided a message's
	 * audience by matching `/^you\b|^your\b|^you'/i` against the rendered text — the gateway
	 * interpreting game content, in one language, to guess something the swap window already knows
	 * exactly. See `_advanceTurn` for what replaced it.
	 */


	/**
	 * Load a mod's code server-side (KD-074). Before the session starts it's queued and loaded at
	 * `_start`; after start it's eval'd into the live world immediately. One world ⇒ one load.
	 */
	loadMod(code) {
		if (this.started) return this.world.loadMod(code);
		this.mods.push(code);
		return { ok: true, queued: true };
	}

	/** Look up an enemy def by name in the authoritative world (verify a mod took effect). */
	getEnemyByName(name) { return this.world.getEnemyByName(name); }


	/** Enable/disable PvP between a specific PAIR of players (KD-094, "PvP starts between A and B"). */
	setPvPPair(a, b, on) {
		if (on === false) this.rel.makePeace(a, b); else this.rel.declareWar(a, b);
		return this._isPvP(a, b);
	}

	/**
	 * Are players `a` and `b` in a PvP relationship?
	 *
	 * KDM-227 — PEACE IS CHECKED FIRST, and that ordering is the whole point. This used to open with
	 * `if (this.pvp) return true`, so under the global `KD_PVP` flag — the mode every PvP session and
	 * every PvP UAT runs in — ending a war per pair was a NO-OP. An accepted truce has to be
	 * expressible as something that beats the global switch, not merely as the absence of a per-pair
	 * entry.
	 */
	_isPvP(a, b) {
		if (this.rel.atPeace(a, b)) return false;
		return this.pvp || this.rel.atWar(a, b);
	}


	/**
	 * Say something to the WHOLE party, in the proxy's own words.
	 *
	 * KDM-263: extracted when this became the fifth copy of "render one line through the game's own
	 * feedback, then push the resulting entries into every joined player's log". The four before it
	 * (peace settled, defeated, recovered, the party arrived) were identical but for the text and the
	 * colour, and each was free to get the `|| []` guard or the `_joined` loop subtly wrong.
	 *
	 * This is the only sanctioned way for the gateway to address everyone. It is NOT how game text
	 * reaches a player: KD gates its own messages by vision at the source, so per-player game log
	 * lines are captured inside that player's swap window and never broadcast (KDM-165). Broadcasting
	 * is reserved for facts about the SESSION, which the gateway alone knows.
	 */
	_broadcast(text, color = '#88ccff', time = 10) {
		const fb = this.world.sendFeedback(text, color, time);
		const entries = (fb && fb.entries) || [];
		for (const pid of this._joined) this._pushLog(pid, entries);
		return entries;
	}

	/** Append message-log entries to a player's personal log, trimmed to maxLog (KD-098). */
	_pushLog(id, entries) {
		if (!entries || !entries.length) return;
		const lg = this.logs.get(id) || [];
		for (const m of entries) { lg.push(m); while (lg.length > this.maxLog) lg.shift(); }
		this.logs.set(id, lg);
	}

	/**
	 * KDM-162: read a player's live vitals (Will, stamina, distraction, …) on the server.
	 *
	 * Callers used to reach these through `snapshotFor(id).stats.will`, which made the RENDER WIRE
	 * FORMAT double as the server's read API — so a field could not be removed from the wire without
	 * breaking server-side callers, which is half of why the curated `stats` block survived so long.
	 * This is a server-side query with the same semantics (swap the player in, read live) and no
	 * bearing on what crosses the network.
	 */
	vitalsFor(clientId) {
		if (!this.started) throw new Error('session not started');
		const bundle = this.bundles.get(clientId);
		if (!bundle) throw new Error(`unknown player ${clientId}`);
		this.world.restorePlayer(bundle);
		return this.world.getVitals();
	}

	/**
	 * KDM-162: the wire form of a player's state bundle — the capture minus the shared world.
	 *
	 * Same split `restorePlayer` applies on the server (`KDGAMEDATA_WORLD_KEYS`), applied once here so
	 * the client can adopt everything it receives without knowing the rule. Shallow copy: the bundle
	 * belongs to the session and must not be mutated by preparing a snapshot.
	 */
	_clientBundle(bundle) {
		if (!bundle) return null;
		const gameData = {};
		for (const k of Object.keys(bundle.gameData || {})) {
			if (KDGAMEDATA_WORLD_KEYS.includes(k)) continue;
			if (CLIENT_OWNED_GAMEDATA_KEYS.includes(k)) continue;
			gameData[k] = bundle.gameData[k];
		}
		return { v: bundle.v, gameData, globals: this._stripPresentation(bundle.globals) };
	}

	/**
	 * KDM-196 — presentation output never crosses the wire as STATE, only as a sequenced event.
	 *
	 * KDDamageQueue could be excluded wholesale (GLOBAL_BLACKLIST) because the whole global is
	 * presentation. `KDEventData` is a MIXED bag — `SlimeLevel`/`SlimeLevelStart`/`CurseHintTick`/
	 * `ActivationsThisTurn` are real per-player sim state that accumulates across turns, while
	 * `sounddesc`/`shockwaves` are consume-once draw queues. Blacklisting the global would silently
	 * drop the sim half; naming the sub-keys keeps the criterion (not the name) as the rule.
	 *
	 * `_harvestNoise` already drains these every turn, so in practice they are empty here. This is the
	 * INVARIANT, not the mechanism: any future path that queues presentation without a harvest is
	 * stopped at the wire instead of becoming another snapshot-rate animation spam.
	 */
	_stripPresentation(globals) {
		if (!globals) return globals;
		let out = globals;
		for (const name of Object.keys(PRESENTATION_SUBKEYS)) {
			const v = out[name];
			if (!v || typeof v !== 'object') continue;
			const drop = PRESENTATION_SUBKEYS[name].filter((k) => k in v);
			if (!drop.length) continue;
			if (out === globals) out = Object.assign({}, globals);      // shallow copy: the bundle is the session's
			const copy = Object.assign({}, v);
			for (const k of drop) delete copy[k];
			out[name] = copy;
		}
		return out;
	}

	/** Map a submitted action to a KD input {kdType, data}. */
	_toInput(id, action) {
		if (action.kdType) return { kdType: action.kdType, data: action.data || {} };
		// built-in helpers
		if (action.kind === 'move') {
			return { kdType: 'move', data: { dir: { x: action.dx | 0, y: action.dy | 0 }, delta: 1, AllowInteract: true } };
		}
		if (action.kind === 'wait') return { kdType: 'tick', data: { delta: 1 } };
		// legacy {dx,dy}
		if ((action.dx | 0) !== 0 || (action.dy | 0) !== 0) {
			return { kdType: 'move', data: { dir: { x: action.dx | 0, y: action.dy | 0 }, delta: 1, AllowInteract: true } };
		}
		return { kdType: 'tick', data: { delta: 1 } };
	}

	/**
	 * Fisher-Yates over a SEEDED node-side PRNG (KDM-224).
	 *
	 * This used to call `Math.random()`, so turn order was a fresh coin flip on every run even though
	 * the session takes a `seed` and hands it to the world (`this.world.init({seed})`). Turn order is
	 * not a detail: KDM-208 established that intra-turn ORDER decides real outcomes (a peer who
	 * arrived this turn vs one who stood still), so an unseeded shuffle made every PvP session
	 * irreproducible — a test could pass ten times and fail the eleventh with nothing changed, and no
	 * way to replay the sequence that broke it.
	 *
	 * Seeding it from `this.seed` costs nothing in production (the seed is random there) and makes a
	 * failing sequence REPLAYABLE, which is the whole point: a flake you cannot summon is a flake you
	 * cannot prove fixed. Deliberately node-side and independent of the bundle's KDRandom — this
	 * orders PLAYERS, it is not gameplay randomness (cf. reference-kdrandom-vs-mathrandom-stub).
	 */
	_rand() {
		// mulberry32 — small, fast, good enough for ordering; state advances per draw.
		if (this._rngState === undefined) {
			let h = 2166136261 >>> 0;
			const s = String(this.seed);
			for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
			this._rngState = h >>> 0;
		}
		this._rngState = (this._rngState + 0x6D2B79F5) >>> 0;
		let t = this._rngState;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}

	/** Fisher-Yates over `_rand` — seeded, so a turn-order sequence can be replayed. */
	_shuffle(a) {
		for (let i = a.length - 1; i > 0; i--) {
			const j = Math.floor(this._rand() * (i + 1));
			const t = a[i]; a[i] = a[j]; a[j] = t;
		}
		return a;
	}

	/** Players who have NOT yet submitted an action for the current turn. */
	waitingOn() { return this._joined.filter((id) => !this._pending.has(id)); }

	/** Current world tick (lockstep marker). */
	tick() { return this.world.tick(); }

	/** A player's current position (from their bundle's avatar in the world). */
	posOf(id) {
		const e = this.world.listEntities().find((x) => x.id === this.avatars.get(id));
		return e ? { x: e.x, y: e.y } : null;
	}

	/** The shared enemy's authoritative state. */
	enemyView() {
		return this.world.listEntities().find((e) => e.id === this.enemyId) || null;
	}

	/**
	 * Compose a client's render-state snapshot from the ONE authoritative world plus
	 * that client's state bundle: swap the client in (so player entity + stats are
	 * theirs), serialize the world's render-state, then drop the client's OWN avatar
	 * from the Entities list — they render as the global player, not as an avatar
	 * (the other players' avatars stay). Re-park the global player afterwards so the
	 * world is clean between turns. Snapshot shape === HeadlessHost.serializeRenderState
	 * (render-state v1) — exactly what KDRenderClient.apply() consumes in the browser.
	 */
	/**
	 * KDM-186 — queue a ONE-SHOT EVENT for a client, stamped with a fresh sequence id.
	 *
	 * The id is issued per real occurrence, never per snapshot that carries it, so two identical hits
	 * in a row are two events (a content hash would wrongly collapse them). The client applies each
	 * at most once and ignores repeats.
	 */
	_emitEvent(clientId, payload) {
		const seq = (this._eventSeq.get(clientId) || 0) + 1;
		this._eventSeq.set(clientId, seq);
		let q = this.pendingEvents.get(clientId);
		if (!q) { q = []; this.pendingEvents.set(clientId, q); }
		q.push(Object.assign({ seq }, payload));
		while (q.length > 64) q.shift();        // bounded: a client that never reads must not grow it
		return seq;
	}

	/**
	 * Harvest whatever the GAME just queued for its draw layer and turn it into events for `clientId`.
	 * Called with that player swapped in, so the queue holds exactly their occurrences.
	 */
	_harvestFloaters(clientId) {
		let out = [];
		try { out = this.world.takeDamageFloaters() || []; } catch (e) { out = []; }
		for (const f of out) this._emitEvent(clientId, { kind: 'floater', floater: f });
		this._harvestNoise(clientId);
	}

	/**
	 * KDM-196 — the same harvest for the NOISE presentation queues (ripples + the sound echo).
	 *
	 * Same criterion as the floaters, same two call sites, so a queue cannot be drained on one path
	 * and left to accumulate on the other: whatever the draw layer would have consumed is taken here
	 * and re-delivered as ONE sequenced event, applied at most once by the client.
	 *
	 * Emitted only when there is something to say. The exception is a `sounddesc` list that has just
	 * gone empty: it REPLACES the client's list (the game resets it per turn, and the client's own
	 * `KinkyDungeonAdvanceTime` is guarded off in render-only mode), so the client must be told to
	 * clear it or last turn's echo would repeat forever.
	 */
	_harvestNoise(clientId) {
		let p;
		try { p = this.world.takeNoisePresentation(); } catch (e) { return; }
		const shockwaves = (p && p.shockwaves) || [];
		const sounddesc = (p && p.sounddesc) || [];
		const hadSound = this._sentSoundDesc.get(clientId) || false;
		if (!shockwaves.length && !sounddesc.length && !hadSound) return;
		this._sentSoundDesc.set(clientId, sounddesc.length > 0);
		this._emitEvent(clientId, { kind: 'noise', shockwaves, sounddesc });
	}

	/** Events not yet delivered to this client. Take-once: delivered is delivered. */
	_takePendingEvents(clientId) {
		const q = this.pendingEvents.get(clientId);
		if (!q || !q.length) return [];
		this.pendingEvents.set(clientId, []);
		return q;
	}


	snapshotFor(clientId) {
		if (!this.started) throw new Error('session not started');
		const bundle = this.bundles.get(clientId);
		if (!bundle) throw new Error(`unknown player ${clientId}`);
		this.world.restorePlayer(bundle);
		const snap = this.world.serializeRenderState();
		// KDM-162: ship this player's OWN state bundle — the same generic capture the swap model uses
		// (KDM-161), not a curated view of it. The browser runs a full KD instance; it needs its state,
		// not our summary of it. Measured (KDM-162 probe6): a client that adopts this has ZERO wrong
		// player-state fields across 4949 candidate globals, and needs no re-derivation at all.
		//
		// World-scoped KDGameData keys are stripped HERE rather than skipped on the client, so the
		// client needs no copy of the world-key list — the server stays the single source of truth for
		// the player/world split (the mistake the `stats` block made was giving the client a contract
		// to maintain).
		snap.bundle = this._clientBundle(bundle);
		/*
		 * KDM-269 — every drop channel reaches the browser, so a dropped input is visible instead of
		 * being an indistinguishable no-op.
		 *
		 * This loop is the line that used to be forgotten. Four hand-written `snap.x = this.xReport()`
		 * lines meant a fifth channel could record perfectly and never be sent — and nothing would say
		 * so, because the recording and the accessor both work. Driven from the registry, a channel
		 * cannot exist and be unsent.
		 *
		 * Each field is additive and separate (R2): an older client ignores one it does not know.
		 */
		for (const c of DROP_CHANNELS) snap[c.field] = this[c.report]();
		// KD-098: the headless world never runs the draw-ease loop, so entities' visual_x/visual_y
		// stay stuck near spawn while x/y jump via AI — the client then re-eases from the stale
		// spot each turn (the "Rat teleports from its initial tile through several tiles"). Snap
		// visual→real so every entity renders at its authoritative position. Turn-based ⇒ snapping
		// is correct (peer avatars already snap via moveAvatar).
		if (snap.map && Array.isArray(snap.map.Entities)) {
			for (const e of snap.map.Entities) { e.visual_x = e.x; e.visual_y = e.y; }
		}
		if (snap.player) { snap.player.visual_x = snap.player.x; snap.player.visual_y = snap.player.y; }
		const ownAvatar = this.avatars.get(clientId);
		if (snap.map && Array.isArray(snap.map.Entities) && ownAvatar != null) {
			snap.map.Entities = snap.map.Entities.filter((e) => e.id !== ownAvatar);
		}
		// KD-090: replace the shared world log with THIS client's personal log so each
		// player sees only their own relevant messages (not the other player's actions).
		if (snap.messages) snap.messages.log = (this.logs.get(clientId) || []).slice(-this.maxLog);
		// KD-098: this turn's PvP floating combat text, scoped to this client (victim or attacker).
		const am = this.actionMsgOf.get(clientId);
		// KDM-186: the event travels WITH its sequence id, so a client that has already applied it can
		// ignore the copy carried by every later snapshot. Without this, each snapshot re-stamped the
		// last hit's floater — visible as an ever-growing pile while the mouse moved.
		if (am && snap.messages) {
			snap.messages.action = am.text;
			snap.messages.actionColor = am.color;
			snap.messages.actionTime = 2;
			snap.messages.actionSeq = am.seq || 0;
		}
		// KDM-186: one-shot events ride their OWN channel, each with a sequence the client applies at
		// most once. Take-once on delivery so an undelivered backlog cannot grow without bound.
		snap.events = this._takePendingEvents(clientId);
		// KDM-225 A4: the peace menu re-reads this every frame, so it is STANDING STATE, not an event.
		// Deliberately NOT in `VERBATIM_CHANNELS` (ws-bridge.js:40) — that list is for consume-once
		// channels, and this one is a value the delta may legitimately elide when it has not changed.
		snap.coop = {
			war: this._joined.filter((id) => id !== clientId && this._isPvP(clientId, id)),
			peaceOffer: this.rel.pendingFor(clientId),
			canOffer: this._joined.filter((id) => id !== clientId && this._canOffer(clientId, id)),
		};
		// KD-094: peers in a PvP relationship with this client render+target as Enemy faction
		// (stock attack mechanics then "just work" — the client originates a normal doattack).
		if (snap.map && Array.isArray(snap.map.Entities)) {
			for (const [cid, eid] of this.avatars.entries()) {
				if (cid === clientId) continue;
				const ent = snap.map.Entities.find((e) => e.id === eid);
				if (!ent) continue;
				// KD-098: drive the peer's HP bar from their REAL defeat meter (Will). The avatar's
				// own hp is a meaningless static 100; map Will→hp so the bar shows how close this
				// player is to defeat (matches their WP corner gauge). Snapshot ent is a deep clone,
				// so mutating it is per-client and safe.
				const v = this.vitalsOf.get(cid);
				if (v && v.will != null && v.willMax) {
					const maxhp = (ent.Enemy && ent.Enemy.maxhp) || 100;
					// Floor at 1: a hp=0 entity reads as DEAD on the client (untargetable → can't be tied
					// even when defeated). The bar still shows ~empty; defeat is conveyed by defeatedPlayers.
					ent.hp = Math.max(1, Math.round((v.will / v.willMax) * maxhp));
					ent.visual_hp = ent.hp;
				}
				// KD-094: PvP peers render+target as Enemy faction (red bar; stock attack mechanics).
				if (this._isPvP(clientId, cid)) { ent.faction = 'Enemy'; ent.hostile = 9999; }
				// KDM-200: a DEFEATED peer is marked EXPOSED on the snapshot the client evaluates.
				//
				// It must be stamped here, not only at arm time: `vulnerable` is a per-turn flag the
				// ENGINE decays (KinkyDungeonEnemies.ts:4650, `vulnerable -= delta`), so a value set
				// while arming is already consumed by the time the snapshot is composed. The client runs
				// KDCanApplyBondage against THIS object, so the state has to be true at THIS moment.
				//
				// This is the one declared co-op rule and it is deliberately minimal: it sets the game own
				// exposure flag and lets KD OWN branch decide — `vulnerable && hp <= 0.5 * maxhp` — where
				// the hp half is the peer real Will (ent.hp above). It does NOT force `disabled`, does not
				// fake a stun, and invents no duration: it is recomputed per snapshot from whether the
				// peer is defeated right now, so it lapses the moment they recover.
				//
				// (The predecessor stamped `ent.stun = 6` here, which overrode the gate outright.)
				if (this.defeated.has(cid) || this._isDown(v)) {
					ent.vulnerable = Math.max(ent.vulnerable || 0, 1);
				}
			}
		}
		// KD-099: expose the defeated players so the client HUD can mark them (down/incapacitated).
		snap.defeatedPlayers = [...this.defeated];
		// KD-101 UAT: tell the client which carryable loose-restraint item to seed (KD_START_RESTRAINT),
		// so the standard #coop=<id> URL + server env is enough — no per-tab URL param needed. The client
		// adds it once (the Items inventory is client-local; snapshots don't sync it).
		if (this.startRestraint) snap.startItem = this.startRestraint;
		this.world.parkGlobalPlayer(PARK.x, PARK.y);
		return snap;
	}
}

/*
 * KDM-269 — the drop reports, defined once from the registry.
 *
 * On the PROTOTYPE rather than assigned per-instance in the constructor: these are methods, and a
 * per-instance closure would put four functions on every session and would not show up on
 * `SwapSession.prototype` for anything that introspects the class.
 *
 * `configurable`/`writable` are left at their defaults (false) — nothing should be reaching in to
 * replace a report accessor at runtime, and a test that wants a different answer builds a session
 * with different contents rather than swapping the method.
 */
for (const c of DROP_CHANNELS) {
	Object.defineProperty(SwapSession.prototype, c.report, {
		value: function () { return dropCollect(c, this[c.field]); },
		enumerable: false,
	});
}

module.exports = { SwapSession, KDParseStartRestraints, DROP_CHANNELS };
