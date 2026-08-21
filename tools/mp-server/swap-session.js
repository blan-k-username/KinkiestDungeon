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
const { PeaceRegistry } = require('./peace');
const { KD_PEACE_DIALOGUE } = require('./kd-peace-dialogue');

const PARK = { x: 1, y: 1 };

/**
 * KDM-227: KD's own room type for the mandatory between-floors hub — the "Floor N: Journey Selection"
 * screen with the buff/debuff picks and the merchants. Named once because it is the ONE room that
 * ends a war; every other non-empty room type is an optional detour a grudge survives.
 */
const HUB_ROOM_TYPE = 'JourneyFloor';

/** KDM-230: the name of OUR dialogue, in `kd-peace-dialogue.js`. Named once; matched by it here. */
const PEACE_DIALOGUE = 'KDCoopPeace';

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
		// KDM-164 UAT: enable the stock ClassicHeels perk. OPT-IN — the MP layer does not choose a
		// player's perks; it used to be switched on implicitly whenever a restraint was seeded.
		this.classicHeels = !!opts.classicHeels;
		this.world = new HeadlessHost({ id: 'world' });
		this.bundles = new Map();     // id -> player-state bundle
		this.avatars = new Map();     // id -> world avatar entity id
		this.startOf = new Map();     // id -> {x,y}
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
		this.vitalsOf = new Map();    // id -> {will,willMax,...} last-known vitals (KD-098 HP bar)
		this.defeated = new Set();    // ids whose Will hit 0 — incapacitated (KD-099)
		this.tiedOf = new Map();      // id -> Set of restraint NAMES already reconciled onto this peer (KD-101)
		// KDM-164: the `_armHp = 100` damage gauge is gone. A peer avatar's hp no longer measures
		// anything — the game's own damageInfo is recorded per hit and replayed through the victim's
		// real player pipeline (see installPeerDamageRecorder / _reconcilePeers).
		this._joined = [];
		this._pending = new Map();    // id -> { kdType, data }
		this.unknownInputs = new Map(); // KDM-163 AC3: input type -> count the world had no handler for
		// KDM-163 AC3: `_pending` is ONE slot per player, so a second turn-consuming input REPLACES the
		// first. That is deliberate (a player may change their mind before the peer acts) but it must
		// never be SILENT — the displaced action was a real action that never happened. Recorded here
		// and surfaced in the snapshot, exactly like an unhandled type.
		this.replacedInputs = [];
		// KDM-208: moves cancelled because a peer took the contested tile earlier in the SAME turn.
		// Third member of the same family: a real action by a real player that produced nothing.
		this.cancelledMoves = [];
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
		this.world.init({ seed: this.seed });
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
		// KDM-227: baseline for the hub-arrival check. Seeded HERE rather than left undefined so the
		// room the session STARTS in is not mistaken for an arrival — the game boots on the journey
		// hub itself (level 0), so the very first turn of every session would otherwise fire a reset.
		try { this._lastRoomType = this.world.getRoomType() || ''; } catch (e) { this._lastRoomType = ''; }
		// KD-101 UAT aid: give the (shared) starting player a CARRYABLE loose-restraint ITEM (Items
		// inventory) BEFORE capturing each bundle, so the server can apply it; every capturePlayer below
		// inherits it. The CLIENT shows it via coop-bootstrap (snapshots don't sync the loose inventory).
		if (this.startRestraint) {
			for (const name of KDParseStartRestraints(this.startRestraint)) {
				const r = this.world.addLooseRestraint(name);
				this._dbg(`start-restraint(loose) ${name} -> ${JSON.stringify(r)}`);
			}
		}
		// KDM-164: `ClassicHeels` is a PLAYER PERK, and the server was switching it on behind the
		// player's back as a side effect of seeding a restraint. Convenient for one UAT scenario
		// (without it `KinkyDungeonCalculateSlowLevel` ignores `heelpower`, so seeded heels feel like
		// nothing) — but the MP layer does not get to choose a player's perks. It is now an explicit,
		// opt-in flag and nothing turns it on implicitly.
		this._setClassicHeels();
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
		const base = this.world.findOpenTile();
		let i = 0;
		for (const id of this._joined) {
			const pos = { x: base.x + i, y: base.y };
			// give each player a starting bundle at a distinct position
			this.world.placePlayer(pos.x, pos.y);
			this.bundles.set(id, this.world.capturePlayer());
			this.vitalsOf.set(id, this.world.getVitals());   // KD-098: seed for the HP bar
			const av = this.world.spawnAvatar(pos.x, pos.y, 'Player ' + id);
			this.avatars.set(id, av.entityId);
			this.startOf.set(id, pos);
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
		const avatarId = this.avatars.get(from);
		const bundle = this.bundles.get(target);
		if (!bundle) return false;
		this.world.restorePlayer(bundle);
		const res = this.world.eval(`(function(){
			var speaker = KDMapData.Entities.find(function(e){ return e.id === ${avatarId | 0}; });
			try {
				KDStartDialog('KDCoopPeace', speaker ? speaker.Enemy.name : 'RemotePlayer', false,
					'', speaker || undefined);
			} catch (e) { return { err: String(e && e.message || e) }; }
			return { open: KDGameData.CurrentDialog };
		})()`);
		this.bundles.set(target, this.world.capturePlayer());
		this.world.parkGlobalPlayer(PARK.x, PARK.y);
		this._dbg(`PEACE dialogue opened for ${target} (${JSON.stringify(res)})`);
		return res;
	}

	/** Close it again — on accept, on decline, and whenever the offer is dropped. */
	_closePeaceDialogue(target) {
		const bundle = this.bundles.get(target);
		if (!bundle) return;
		this.world.restorePlayer(bundle);
		this.world.eval(`(function(){
			if (typeof KDGameData !== 'undefined' && KDGameData
				&& KDGameData.CurrentDialog === 'KDCoopPeace') {
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
	_takePeaceAnswer() {
		try {
			const v = this.world.eval('(function(){ var v = globalThis.__kdCoopPeaceAnswer; '
				+ 'globalThis.__kdCoopPeaceAnswer = undefined; return v; })()');
			return (v === true || v === false) ? v : null;
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
		const entries = (this.world.sendFeedback('Peace between ' + a + ' and ' + b + '.',
			'#88ff99', 10) || {}).entries || [];
		for (const id of this._joined) this._pushLog(id, entries);
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
		const ourDialogue = kdType === 'dialogue' && data && data.dialogue === PEACE_DIALOGUE;
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
			// KDM-186: did this player's own state actually move? The caller uses this to decide between
			// a full state reply and a bare ack — a diff, never a judgement about which inputs matter.
			const changed = this._stateChanged(clientId, newBundle);
			// Leave the world exactly as a resolved turn leaves it. `_advanceTurn` ends with the global
			// player parked off-field; an immediate apply must restore that same between-turns
			// invariant, or the world is left with one player swapped in and the next turn (and any
			// read of avatar/enemy positions) starts from a different state than it used to.
			this.world.parkGlobalPlayer(PARK.x, PARK.y);
			this._noteUnknown(kdType, res);
			return { advanced: false, kind: 'ui', changed, unknownType: !!res.unknownType,
				error: res.error || null, notify: answered ? this._joined.filter(function(i){ return i !== clientId; }) : undefined };
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

	/** Input types the authoritative world had no handler for, with counts (KDM-163 AC3). */
	unknownInputReport() {
		return [...this.unknownInputs.entries()].map(([type, count]) => ({ type, count }));
	}

	/**
	 * Queued actions that were displaced before they could be applied (KDM-163 AC3). The OTHER way an
	 * input disappears without a trace: not "the game had no handler" but "the lockstep slot was
	 * overwritten". Both are silent drops; both are now reportable.
	 */
	replacedInputReport() { return this.replacedInputs.slice(); }

	/**
	 * Moves cancelled by the contested-tile rule (KDM-208). The peer won the race for the tile, so the
	 * loser stalled — no attack, no step. Reported for the same reason as the two above: from the
	 * player's side a cancelled move and an ignored input look identical.
	 */
	cancelledMoveReport() { return this.cancelledMoves.slice(); }

	submit(clientId, action = {}) {
		if (!this.started) throw new Error('session not started');
		if (!this._joined.includes(clientId)) throw new Error(`unknown player ${clientId}`);
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
			this.replacedInputs.push(rec);
			while (this.replacedInputs.length > this.maxLog) this.replacedInputs.shift();
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
			// KD-090: capture this player's message-log delta (messages pushed while THEY
			// are the swapped-in player are theirs — incl. enemy-AI lines aimed at them).
			const logLen0 = this.world.messageLogLength();
			const lvl0 = this.world.getLevel();
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
				cancelled = (this.world.takeBumpVetoes() || 0) > 0;
				if (cancelled) {
					this.cancelledMoves.push({ clientId: id, turn: this.turn, kdType });
					while (this.cancelledMoves.length > this.maxLog) this.cancelledMoves.shift();
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
			// `_markRecovered`, `_announceFloorChange`) — a concern the proxy legitimately owns, and one
			// that never depends on reading game content.
			if (added && added.length) this._pushLog(id, added);
			// A floor change moves the whole party, so say so — once, in our own words, to everyone.
			// This is a state comparison, not an inference over message text.
			if (this.world.getLevel() !== lvl0) this._announceFloorChange(id, this.world.getLevel());
			// swap out: persist this player's new state + move their avatar to its new spot
			this.bundles.set(id, this.world.capturePlayer());
			this.vitalsOf.set(id, this.world.getVitals());   // KD-098: refresh for the HP bar
			const p = this.world.getPlayerPos();
			if (avId != null) this.world.moveAvatar(avId, p.x, p.y);
			// KDM-208: this avatar now stands somewhere it did not stand at turn start, so for everyone
			// applied AFTER it, it is an arrival — present enough to block, not to be bumped.
			const s0 = startPos.get(id);
			if (avId != null && s0 && (p.x !== s0.x || p.y !== s0.y)) arrived.add(avId);
			applied.push({ id, kdType, result, pos: p, cancelled });
		}
		// KDM-208: the veto is per-apply. Leave the world with it off, or the immediate ("ui") apply
		// path — which runs outside this loop — would inherit a stale set from the last turn.
		this.world.setBumpVeto([]);
		// KD-100: reconcile each peer avatar's REAL combat result (hp damage, capture) back into its
		// owner's bundle (avatar.hp → Will; real capture/helpless → defeated + broadcast).
		this._reconcilePeers();
		// KDM-227: finishing a level clears the slate between players.
		this._checkHubReset();
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
		this.lastTurn = { order, applied };
		return { turn: this.turn, applied };
	}

	/**
	 * KDM-227 — reaching the between-floors hub puts everyone back at peace.
	 *
	 * The trigger is the room the party is IN, not the floor number: descending goes floor → hub →
	 * floor, and only the hub — the one with the buff/debuff picks and the merchants — ends a war.
	 * The other room types (`Tunnel`, `PerkRoom`, `ShopStart`, `ElevatorRoom`, `Summit`, …) are the
	 * optional detours a grudge is meant to survive, so this matches `JourneyFloor` exactly rather
	 * than "any non-empty RoomType".
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
	_checkHubReset() {
		let room = '';
		try { room = this.world.getRoomType() || ''; } catch (e) { return; }
		const prev = this._lastRoomType;
		this._lastRoomType = room;
		if (room !== HUB_ROOM_TYPE || prev === HUB_ROOM_TYPE) return;   // presence ≠ arrival
		this.rel.resetAll();
		// KDM-230: and take down any peace dialogue the reset just made moot.
		for (const id of this._joined) this._closePeaceDialogue(id);
		// …and clear the hostility the GAME holds, not only our verdict: `_isPvP` governs whether the
		// next turn ARMS the avatars as hostile, it does not undo aggro KD already wrote on them.
		for (const eid of this.avatars.values()) {
			try { this.world.setAvatarHostile(eid, false); } catch (e) { /* avatar gone; nothing to clear */ }
		}
		this._dbg('HUB RESET — every pair back to co-op on arrival at ' + HUB_ROOM_TYPE);
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
	_armPeerEnemies(actorId) {
		for (const [cid, eid] of this.avatars.entries()) {
			if (cid === actorId || !this._isPvP(actorId, cid)) continue;
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
			const v = this.vitalsOf.get(cid) || {};
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
			// KD-101: the avatar must not ACCUMULATE restraint items — its binding slots fill up and the
			// stock submenu (KDGetNPCBindingSlotForItem(...).sgroup, no null guard) crashes after a few
			// ties. Clearing the items stays. The victim keeps the real ties on their own bundle.
			this.world.clearAvatarBondage(eid);
			// KDM-199: …but their bondage LEVEL is then mirrored back through the item-free channel, so
			// KDBoundEffects sees it. Without this the avatar reads as unbound and KDBoundEffects returns
			// 0 at its boundLevel short-circuit, which is why no peer could ever be tied without the
			// invented stun.
			this.world.setAvatarBondage(eid, v.bondage || 0);
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
			if (hits.length || newRestraints.length) {
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
			if (eid != null && ec && ec.maxhp != null) this.world.setAvatarEnemy(eid, ec.maxhp, ec.maxhp, 0);
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

	/**
	 * KDM-164: opt-in ONLY (`classicHeels: true` / `KD_CLASSIC_HEELS=1`). This is a stock PLAYER PERK;
	 * the server used to switch it on implicitly whenever a restraint was seeded, which is the MP layer
	 * making a gameplay choice on the player's behalf. Off unless asked for.
	 */
	_setClassicHeels() {
		if (!this.classicHeels) return;
		try {
			this.world.eval(`(function(){
				if (typeof KinkyDungeonStatsChoice !== 'undefined' && KinkyDungeonStatsChoice)
					KinkyDungeonStatsChoice.set("ClassicHeels", true);
				if (typeof KinkyDungeonCalculateSlowLevel === 'function') KinkyDungeonCalculateSlowLevel(0);
			})()`);
			this._dbg('ClassicHeels perk enabled BY REQUEST (heelpower counts toward slow)');
		} catch (e) { this._dbg('could not enable ClassicHeels — ' + e.message); }
	}

	/** Clear a player's defeat + broadcast a shared "recovered" message to everyone. KD-099 "freed". */
	_markRecovered(id, why) {
		this.defeated.delete(id);
		const txt = `Player ${id} is back on their feet!`;
		const fb = this.world.sendFeedback(txt, '#33ff66', 12);
		const entries = (fb && fb.entries) || [];
		for (const pid of this._joined) this._pushLog(pid, entries);
		this._emitEvent(id, { text: 'Recovered!', color: '#33ff66' });
		this._dbg(`RECOVERED ${id} (${why})`);
	}

	/** Flag a player defeated + broadcast a shared "defeated" message to everyone. KD-099/100. */
	_markDefeated(id, why) {
		this.defeated.add(id);
		const txt = `Player ${id} has been defeated!`;
		const fb = this.world.sendFeedback(txt, '#ff3333', 12);
		const entries = (fb && fb.entries) || [];
		for (const pid of this._joined) this._pushLog(pid, entries);
		this._emitEvent(id, { text: 'Defeated!', color: '#ff3333' });
		this._dbg(`DEFEAT ${id} (${why})`);
	}

	/** Has this player been defeated (real capture / Will floor)? Cleared once Will recovers (_markRecovered). */
	isDefeated(id) { return this.defeated.has(id); }

	/**
	 * KDM-165: a floor change moves the whole party, so tell everyone — EXPLICITLY, in the proxy's own
	 * words. This replaces the old behaviour of duplicating whatever game text happened to be emitted
	 * during the transition into every player's log: those lines are the acting player's (they passed
	 * that player's vision check), while "we are all on floor N now" is genuinely session-level and is
	 * ours to say.
	 */
	_announceFloorChange(id, level) {
		const txt = `The party descends to floor ${level}.`;
		const fb = this.world.sendFeedback(txt, '#88ccff', 10);
		const entries = (fb && fb.entries) || [];
		for (const pid of this._joined) this._pushLog(pid, entries);
		this._dbg(`FLOOR ${id} -> ${level} (announced to all)`);
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
		// KDM-163 AC3: input types the world had no handler for, so a dropped input is visible in the
		// browser instead of being an indistinguishable no-op.
		snap.unknownInputs = this.unknownInputReport();
		// KDM-163 AC3: …and the other silent-drop path — an action displaced out of the lockstep slot
		// before it could ever be applied.
		snap.replacedInputs = this.replacedInputReport();
		// KDM-208: …and a move that really ran but was cancelled because a peer reached the tile first.
		snap.cancelledMoves = this.cancelledMoveReport();
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

module.exports = { SwapSession, KDParseStartRestraints };
