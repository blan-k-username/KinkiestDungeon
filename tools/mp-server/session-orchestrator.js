/**
 * tools/mp-server/session-orchestrator.js
 *
 * Production orchestrator + global turn clock (KD-069, epic mp-mvp / KD-066).
 *
 * Owns a session: one WORLD instance (server-authoritative, runs shared-entity AI)
 * plus one PLAYER instance per connected player (each a HeadlessHost, role 'player'
 * → shared-entity AI suppressed by the KD-068 `KDServerRole` flag). Drives the
 * GLOBAL TURN CLOCK (decision Q2=a): a turn advances only when EVERY connected
 * player has submitted an action for that turn (a barrier — no instance steps ahead).
 *
 * The RECONCILER (KD-070) is intentionally NOT here — it plugs in via the
 * `reconcile(orchestrator, ctx)` hook, called at `setup` / `pre-step` / `post-step`.
 * Session JOIN (KD-084) builds on `addPlayer`/`removePlayer`, which adjust the
 * barrier set live. This module knows only the turn-clock contract; the process
 * model (in-process here; worker/socket later) is an implementation detail.
 *
 * In-process by default: the HeadlessHosts are plain objects in one Node process.
 */
'use strict';

const { HeadlessHost } = require('./headless-host');

const NOOP = () => {};

class SessionOrchestrator {
	/**
	 * @param {object} opts
	 *   seed='kd-session-seed'  shared map seed (identical map gen across instances)
	 *   playerIds=['A','B']     initial connected players
	 *   reconcile=noop          (orchestrator, ctx) hook — KD-070 plugs in here
	 *   timeoutPolicy='wait'    slow/absent player policy (default: wait; barrier holds)
	 *   autoBoot=true           setup() boots+inits instances (set false to inject mocks in tests)
	 */
	constructor(opts = {}) {
		this.seed = opts.seed || 'kd-session-seed';
		this.reconcile = typeof opts.reconcile === 'function' ? opts.reconcile : NOOP;
		this.timeoutPolicy = opts.timeoutPolicy || 'wait';
		this._autoBoot = opts.autoBoot !== false;

		this.world = new HeadlessHost({ id: 'world' });
		this.players = new Map();         // id -> HeadlessHost
		this._pending = new Map();        // id -> action (this turn)
		this.turn = 0;
		this._started = false;

		for (const id of (opts.playerIds || ['A', 'B'])) {
			this.players.set(id, new HeadlessHost({ id: `player-${id}` }));
		}
	}

	get playerIds() { return [...this.players.keys()]; }
	get all() { return [this.world, ...this.players.values()]; }

	/** Boot + init every instance on the shared scenario, assign roles, seed reconcile. */
	setup() {
		for (const h of this.all) { h.boot(); h.init({ seed: this.seed }); }
		this.world.setServerMode('world');
		for (const p of this.players.values()) p.setServerMode('player');
		this._started = true;
		this.reconcile(this, { phase: 'setup' });
		return this;
	}

	/** Add a player mid-session — boots+inits its instance and enlarges the barrier set. */
	addPlayer(id) {
		if (this.players.has(id)) return this.players.get(id);
		const h = new HeadlessHost({ id: `player-${id}` });
		if (this._started && this._autoBoot) {
			h.boot();
			h.init({ seed: this.seed });
			h.setServerMode('player');
		}
		this.players.set(id, h);
		this.reconcile(this, { phase: 'join', joined: id });
		return h;
	}

	/** Remove a player mid-session — shrinks the barrier set (and drops any pending action). */
	removePlayer(id) {
		const had = this.players.delete(id);
		this._pending.delete(id);
		if (had) this.reconcile(this, { phase: 'leave', left: id });
		return had;
	}

	/**
	 * Submit a player's action for the current turn. Returns:
	 *   { advanced:false, pending:[...], waitingOn:[...] }  while the barrier holds
	 *   { advanced:true, turn:{turn, ticks} }               when the barrier completes
	 */
	submit(id, action = {}) {
		if (!this.players.has(id)) throw new Error(`unknown player ${id}`);
		this._pending.set(id, action || {});
		const waitingOn = this.playerIds.filter((pid) => !this._pending.has(pid));
		if (waitingOn.length > 0) {
			return { advanced: false, pending: [...this._pending.keys()], waitingOn };
		}
		return { advanced: true, turn: this._advanceTurn() };
	}

	/** Run one synchronized turn across the world + every player instance. */
	_advanceTurn() {
		const actions = new Map(this._pending);

		// 1) apply each player's own movement on their own instance.
		for (const [id, a] of actions) {
			if (a && ((a.dx | 0) !== 0 || (a.dy | 0) !== 0)) {
				this.players.get(id).applyMove(a.dx | 0, a.dy | 0);
			}
		}
		// 2) reconciler pre-step (KD-070: push avatars→world, set enemy targets).
		this.reconcile(this, { phase: 'pre-step', actions });

		// 3) lockstep step: advance time exactly once on every instance.
		const ticks = { world: this.world.step(1) };
		for (const [id, p] of this.players) ticks[id] = p.step(1);

		// 4) reconciler post-step (KD-070: distribute world state → players).
		this.reconcile(this, { phase: 'post-step', actions, ticks });

		this.turn += 1;
		this._pending.clear();
		return { turn: this.turn, ticks };
	}

	/** The common turn counter across all instances (equal when in lockstep). */
	ticks() {
		const t = { world: this.world.tick() };
		for (const [id, p] of this.players) t[id] = p.tick();
		return t;
	}

	/** True iff every instance is at the same tick (the turn-clock invariant). */
	lockstep() {
		const vals = Object.values(this.ticks());
		return vals.every((v) => v === vals[0]);
	}
}

module.exports = { SessionOrchestrator };
