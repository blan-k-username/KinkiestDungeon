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
 * first-mover wins a contested tile/target (KD's own collision blocks the rest) —
 * random conflict resolution falls out of the model, no special-casing.
 *
 * Other players are shown as avatar entities (KD-082) for rendering; the acting
 * player's avatar is parked while they're swapped in (they ARE the global player).
 */
'use strict';

const { HeadlessHost, KDGAMEDATA_WORLD_KEYS } = require('./headless-host');

const PARK = { x: 1, y: 1 };

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
		this.pvpPairs = new Set();    // per-pair PvP relationships (KD-094) — "A|B" sorted keys
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
		// KDM-163: input type -> "turn" | "ui", LEARNED from real turns (never from a speculative apply,
		// which would double-apply world-mutating actions — see HeadlessHost.applyInputObserved).
		this.inputKind = new Map();
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
		if (this.seedInputKinds) this._seedInputKinds();
		// KD-074: load server-side mods into the ONE authoritative world (players are state
		// bundles — no per-instance engine, so "all instances agree" is automatic). Same eval
		// path as the browser loader (KDMods.ts) — mods push to KD globals / reassign functions.
		for (const code of this.mods) { try { this.world.loadMod(code); } catch (e) { /* keep going */ } }
		// KDM-164: record the damage the GAME produces for each peer-avatar hit, so `_reconcilePeers`
		// can hand it to the victim's own `KinkyDungeonDealDamage` instead of converting avatar hp into
		// Will with arithmetic KD does not have.
		this.world.installPeerDamageRecorder();
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
	apply(clientId, action = {}) {
		if (!this.started) throw new Error('session not started');
		if (!this._joined.includes(clientId)) throw new Error(`unknown player ${clientId}`);
		const { kdType, data } = this._toInput(clientId, action);
		if (!kdType) return { advanced: false, kind: 'noop' };

		// Known NOT to consume a turn (learned from a real turn, below) → apply it now, exactly once.
		if (this.inputKind.get(kdType) === 'ui') {
			const bundle = this.bundles.get(clientId);
			this.world.restorePlayer(bundle);
			const res = this.world.applyInputObserved(kdType, data) || {};
			if (res.advanced > 0) {
				// The classification was wrong for this occurrence — an input that did not advance
				// before just did. Reclassify loudly rather than silently desynchronising lockstep.
				this.inputKind.set(kdType, 'turn');
				this._dbg(`RECLASSIFY "${kdType}" ui -> turn (it advanced time outside lockstep)`);
			}
			this.bundles.set(clientId, this.world.capturePlayer());
			// Leave the world exactly as a resolved turn leaves it. `_advanceTurn` ends with the global
			// player parked off-field; an immediate apply must restore that same between-turns
			// invariant, or the world is left with one player swapped in and the next turn (and any
			// read of avatar/enemy positions) starts from a different state than it used to.
			this.world.parkGlobalPlayer(PARK.x, PARK.y);
			this._noteUnknown(kdType, res);
			return { advanced: false, kind: 'ui', unknownType: !!res.unknownType, error: res.error || null };
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
			const { kinds, report } = classifyInputs(loadSources().bundle);
			const live = this.world.eval('(typeof KDInputTypes !== "undefined" && KDInputTypes) ? Object.keys(KDInputTypes) : []') || [];
			let seeded = 0;
			for (const t of live) { if (kinds[t]) { this.inputKind.set(t, kinds[t]); seeded++; } }
			this.inputSeedReport = { ...report, live: live.length, seeded, missing: live.length - seeded };
			// Drift: the registry moved and the analysis no longer covers it. Not fatal — the unseeded
			// types just fall back to the safe default — but it must be visible.
			if (!report.found || seeded < live.length) {
				const msg = `[mp-server] KDM-163 input-classifier DRIFT: seeded ${seeded}/${live.length} live input ` +
					`types (parsed ${report.handlers} handlers from the bundle). Unseeded types default to ` +
					'turn-consuming, so behaviour is safe but menus may cost a turn until observed.';
				try { console.warn(msg); } catch (e) { /* ignore */ }
				this._dbg(msg);
			} else {
				this._dbg(`input-classifier seeded ${seeded} types (${report.ui} ui / ${report.turn} turn)`);
			}
		} catch (e) {
			// Never let classification take the session down — an empty cache is merely the old behaviour.
			try { console.warn('[mp-server] KDM-163 input-classifier failed, falling back to observe-only: ' + e.message); } catch (e2) { /* ignore */ }
		}
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

	submit(clientId, action = {}) {
		if (!this.started) throw new Error('session not started');
		if (!this._joined.includes(clientId)) throw new Error(`unknown player ${clientId}`);
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
			// KD-090: capture this player's message-log delta (messages pushed while THEY
			// are the swapped-in player are theirs — incl. enemy-AI lines aimed at them).
			const logLen0 = this.world.messageLogLength();
			const lvl0 = this.world.getLevel();
			let result = null;
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
				this._noteUnknown(kdType, obs);
				// Observation beats the static seed, in BOTH directions:
				//  - a seeded "turn" that demonstrably never advanced is demoted to "ui" (this is what
				//    repairs the classifier's deliberate conservatism — it over-approximates by design,
				//    and probe14 measured 12 of 25 known-UI types landing in that bucket);
				//  - a "ui" that did advance is promoted straight back to "turn".
				const seen = obs.advanced > 0 ? 'turn' : 'ui';
				if (this.inputKind.get(kdType) !== seen) {
					const had = this.inputKind.get(kdType);
					this.inputKind.set(kdType, seen);
					this._dbg(`${had ? 'reclassified' : 'learned'} "${kdType}"${had ? ' ' + had + ' ->' : ' ='} ${seen}`);
				}
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
			applied.push({ id, kdType, result, pos: p });
		}
		// KD-100: reconcile each peer avatar's REAL combat result (hp damage, capture) back into its
		// owner's bundle (avatar.hp → Will; real capture/helpless → defeated + broadcast).
		this._reconcilePeers();
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
			// Reset the avatar to FULL hp before the attacker acts — it's a per-turn DAMAGE GAUGE, not
			// the peer's health. _reconcilePeers reads `ARM_HP - hp` as the real damage dealt and
			// KDM-164: the avatar is a STAND-IN the attacker's real weapon can reach — nothing about the
			// victim's health is encoded in it, and `_reconcilePeers` no longer reads its hp. It is
			// simply kept alive (restored to its own def's maxhp, not to a number we invented) so the
			// peer stays targetable and combat keeps working.
			// A peer is bindable at KD's own floor — Will zero — which is the owner's directive
			// ("0 WP allows another co-op player to use the tie action") and nothing more. The stun is
			// what the game's real KDCanApplyBondage gate needs to see; a peer who is up cannot be tied.
			const v = this.vitalsOf.get(cid) || {};
			const cur = this.world.getEntityCombat(eid);
			const full = (cur && cur.maxhp != null && cur.maxhp > 0) ? cur.maxhp : 10;
			const down = this.defeated.has(cid) || this._isDown(v);
			this.world.setAvatarEnemy(eid, full, full, down ? 6 : 0);
			this._dbg(`arm ${cid} down=${down} -> stun=${down ? 6 : 0} (will=${v.will != null ? v.will.toFixed(1) : '?'})`);
			// KD-101: clear the avatar's bondage gauge each turn so reconcile reads only THIS turn's new
			// ties. The avatar must NOT accumulate restraints — its binding slots would fill up and the
			// stock submenu apply (KDGetNPCBindingSlotForItem(...).sgroup, no null guard) crashes after a
			// few ties. The victim STAYS bound on their own bundle (reconcile adds, never removes) and
			// renders it client-side (serializeRenderState→render-client). hp is the per-turn damage gauge.
			this.world.clearAvatarBondage(eid);
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
		this.actionMsgOf.set(id, { text: 'Recovered!', color: '#33ff66' });
		this._dbg(`RECOVERED ${id} (${why})`);
	}

	/** Flag a player defeated + broadcast a shared "defeated" message to everyone. KD-099/100. */
	_markDefeated(id, why) {
		this.defeated.add(id);
		const txt = `Player ${id} has been defeated!`;
		const fb = this.world.sendFeedback(txt, '#ff3333', 12);
		const entries = (fb && fb.entries) || [];
		for (const pid of this._joined) this._pushLog(pid, entries);
		this.actionMsgOf.set(id, { text: 'Defeated!', color: '#ff3333' });
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
		const key = [a, b].sort().join('|');
		if (on === false) this.pvpPairs.delete(key); else this.pvpPairs.add(key);
		return this._isPvP(a, b);
	}

	/** Are players `a` and `b` in a PvP relationship? (global toggle OR a per-pair relationship.) */
	_isPvP(a, b) {
		if (this.pvp) return true;
		return this.pvpPairs.has([a, b].sort().join('|'));
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
		return { v: bundle.v, gameData, globals: bundle.globals };
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

	/** Fisher–Yates (plain Math.random — node side, not the bundle's seeded RNG). */
	_shuffle(a) {
		for (let i = a.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
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
		if (am && snap.messages) { snap.messages.action = am.text; snap.messages.actionColor = am.color; snap.messages.actionTime = 2; }
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
				// KD-101: set the avatar's disabled state DIRECTLY in the snapshot from whether the peer
				// is down. The world avatar's `stun` is armed per-turn and may decay before snapshot
				// time; setting it here guarantees the CLIENT sees the peer as disabled so its real
				// KDCanApplyBondage gate allows the tie.
				// KDM-164: "down" is KD's own floor (Will zero), not an invented fraction of WillMax.
				if (this.defeated.has(cid) || this._isDown(v)) ent.stun = Math.max(ent.stun || 0, 6);
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
