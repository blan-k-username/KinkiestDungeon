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

const { HeadlessHost } = require('./headless-host');

const PARK = { x: 1, y: 1 };

class SwapSession {
	/** @param {object} opts { requiredPlayers=2, seed, enemyType='Rat' } */
	constructor(opts = {}) {
		this.required = opts.requiredPlayers || 2;
		this.seed = opts.seed || 'swap-session-seed';
		this.enemyType = opts.enemyType || 'Rat';
		this.maxLog = opts.maxLog || 100;
		this.pvp = !!opts.pvp;        // global PvP toggle (KD-092) — OFF by default (co-op)
		this.pvpPairs = new Set();    // per-pair PvP relationships (KD-094) — "A|B" sorted keys
		this.world = new HeadlessHost({ id: 'world' });
		this.bundles = new Map();     // id -> player-state bundle
		this.avatars = new Map();     // id -> world avatar entity id
		this.startOf = new Map();     // id -> {x,y}
		this.logs = new Map();        // id -> per-player message log (KD-090)
		this._joined = [];
		this._pending = new Map();    // id -> { kdType, data }
		this.started = false;
		this.turn = 0;
		this.enemyId = null;
		this.lastTurn = null;         // debug/assert record of the last resolution
	}

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
		const base = this.world.findOpenTile();
		let i = 0;
		for (const id of this._joined) {
			const pos = { x: base.x + i, y: base.y };
			// give each player a starting bundle at a distinct position
			this.world.placePlayer(pos.x, pos.y);
			this.bundles.set(id, this.world.capturePlayer());
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
	}

	/**
	 * Submit a player's action ({kdType, data} — KD's real input, or a {kind} for the
	 * built-in move/wait helpers). Returns { advanced, waitingOn } / { advanced, turn }.
	 */
	submit(clientId, action = {}) {
		if (!this.started) throw new Error('session not started');
		if (!this._joined.includes(clientId)) throw new Error(`unknown player ${clientId}`);
		this._pending.set(clientId, action);
		const waitingOn = this._joined.filter((id) => !this._pending.has(id));
		if (waitingOn.length > 0) return { advanced: false, waitingOn };
		return { advanced: true, turn: this._advanceTurn() };
	}

	/** Apply every player's action on the shared world, in random order (R8/R9). */
	_advanceTurn() {
		const order = this._shuffle(this._joined.slice());
		const applied = [];
		for (const id of order) {
			const action = this._pending.get(id) || { kind: 'wait' };
			const { kdType, data } = this._toInput(id, action);
			// swap this player in; park their avatar so it doesn't block their own move
			this.world.restorePlayer(this.bundles.get(id));
			const avId = this.avatars.get(id);
			if (avId != null) this.world.moveAvatar(avId, PARK.x, PARK.y);
			// KD-090: capture this player's message-log delta (messages pushed while THEY
			// are the swapped-in player are theirs — incl. enemy-AI lines aimed at them).
			const logLen0 = this.world.messageLogLength();
			const lvl0 = this.world.getLevel();
			let result = null;
			if (action && (action.kind === 'pvpAttack' || action.kind === 'pvpBind')) {
				// PvP (KD-092/093): A is swapped in now; route A's attack/bind onto target B's bundle.
				result = this._applyPvP(id, action);
			} else {
				// KD-094: a stock `doattack` aimed at a PvP-active peer's avatar becomes a PvP hit.
				const peer = this._pvpTargetOf(id, action, kdType, data);
				if (peer) result = this._applyPvP(id, { kind: 'pvpAttack', target: peer });
				else if (kdType) result = this.world.applyInput(kdType, data);
			}
			// Capture the delta; if the log was reset this turn (e.g. a floor transition
			// clears it), take the whole new log as the delta.
			const newLen = this.world.messageLogLength();
			const added = (newLen >= logLen0) ? this.world.messagesSince(logLen0) : this.world.messageLog();
			if (added && added.length) {
				// A party-wide event (the shared floor changed — e.g. "level completed")
				// is duplicated into EVERY player's log; otherwise it stays private to the actor.
				const shared = this.world.getLevel() !== lvl0;
				const targets = shared ? this._joined : [id];
				for (const tid of targets) {
					const lg = this.logs.get(tid) || [];
					for (const m of added) lg.push(m);
					while (lg.length > this.maxLog) lg.shift();
					this.logs.set(tid, lg);
				}
			}
			// swap out: persist this player's new state + move their avatar to its new spot
			this.bundles.set(id, this.world.capturePlayer());
			const p = this.world.getPlayerPos();
			if (avId != null) this.world.moveAvatar(avId, p.x, p.y);
			applied.push({ id, kdType, result, pos: p });
		}
		this.world.parkGlobalPlayer(PARK.x, PARK.y);
		this.turn += 1;
		this._pending.clear();
		this.lastTurn = { order, applied };
		return { turn: this.turn, applied };
	}

	/** Enable/disable GLOBAL player-vs-player damage for this session (KD-092). */
	setPvP(on) { this.pvp = !!on; return this.pvp; }

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

	/**
	 * If `id`'s action is a stock attack aimed at a PvP-active PEER's avatar, return that peer's
	 * clientId (so the turn loop routes it to `_applyPvP` — the "peers-as-Enemy" model: a normal
	 * `doattack` on a peer becomes a PvP hit). Else null. KD-094.
	 */
	_pvpTargetOf(id, action, kdType, data) {
		if (kdType !== 'doattack') return null; // spell-PvP is a later extension
		const d = data || (action && action.data) || {};
		let targetEnt = (d.id != null) ? d.id : null;
		if (targetEnt == null && d.enemy && typeof d.enemy === 'object' && d.enemy.__kdEnt != null && d.enemy.__kdEnt !== 'player') {
			targetEnt = d.enemy.__kdEnt;
		}
		if (targetEnt == null) return null;
		let peer = null;
		for (const [cid, eid] of this.avatars.entries()) { if (eid === targetEnt) { peer = cid; break; } }
		if (!peer || peer === id) return null;
		return this._isPvP(id, peer) ? peer : null;
	}

	/**
	 * Route attacker `id`'s attack/bind onto target `action.target` (KD-092/093, Strategy B). The
	 * attacker is ALREADY swapped in. Gated by the session PvP toggle and world adjacency. For
	 * `pvpAttack`: computes the attacker's weapon attack and applies damage via the player path
	 * (applyEnemyHit → KinkyDungeonDealDamage). For `pvpBind`: applies a restraint via the player
	 * path (addRestraint → KinkyDungeonAddRestraint). Either way: swap the target in, apply,
	 * capture the target, then restore the attacker (so the turn loop's capture stays correct).
	 * The target's restraint-derived locks (slow/blind/tags) self-heal from the captured inventory
	 * on the target's next turn (KD-073 §B) — see HeadlessHost.playerSlowLevel.
	 */
	_applyPvP(id, action) {
		const targetId = action.target;
		if (!this._joined.includes(targetId) || targetId === id) {
			return { applied: false, reason: 'bad-target' };
		}
		if (!this._isPvP(id, targetId)) return { applied: false, reason: 'pvp-off' };
		// adjacency: attacker (swapped in) vs the target's avatar entity
		const a = this.world.getPlayerPos();
		const bEnt = this.world.listEntities().find((e) => e.id === this.avatars.get(targetId));
		if (!bEnt) return { applied: false, reason: 'no-target-avatar' };
		const dist = Math.max(Math.abs(a.x - bEnt.x), Math.abs(a.y - bEnt.y));
		if (dist > 1) return { applied: false, reason: 'out-of-range', dist };

		// compute the attacker's outgoing attack while they are swapped in
		const atk = this.world.computePlayerAttack();
		// swap the attacker out, the target in, apply, capture target, swap attacker back in
		const aBundle = this.world.capturePlayer();
		this.world.restorePlayer(this.bundles.get(targetId));
		const before = this.world.getVitals();
		let restraint = null;
		if (action.kind === 'pvpBind') {
			restraint = this.world.addRestraint(action.restraint || atk.bindType || 'DuctTapeFeet');
		} else {
			this.world.applyEnemyHit({ damage: atk.damage, type: atk.type });
		}
		const after = this.world.getVitals();
		this.bundles.set(targetId, this.world.capturePlayer());
		this.world.restorePlayer(aBundle);
		return { applied: true, kind: action.kind, dist, atk, before, after, restraint };
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
		const ownAvatar = this.avatars.get(clientId);
		if (snap.map && Array.isArray(snap.map.Entities) && ownAvatar != null) {
			snap.map.Entities = snap.map.Entities.filter((e) => e.id !== ownAvatar);
		}
		// KD-090: replace the shared world log with THIS client's personal log so each
		// player sees only their own relevant messages (not the other player's actions).
		if (snap.messages) snap.messages.log = (this.logs.get(clientId) || []).slice(-this.maxLog);
		// KD-094: peers in a PvP relationship with this client render+target as Enemy faction
		// (stock attack mechanics then "just work" — the client originates a normal doattack).
		if (snap.map && Array.isArray(snap.map.Entities)) {
			for (const [cid, eid] of this.avatars.entries()) {
				if (cid === clientId || !this._isPvP(clientId, cid)) continue;
				const ent = snap.map.Entities.find((e) => e.id === eid);
				if (ent) { ent.faction = 'Enemy'; ent.hostile = 9999; }
			}
		}
		this.world.parkGlobalPlayer(PARK.x, PARK.y);
		return snap;
	}
}

module.exports = { SwapSession };
