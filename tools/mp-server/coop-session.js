/**
 * tools/mp-server/coop-session.js
 *
 * Minimal 2-player session join (KD-084, epic mp-mvp / KD-066) — the SMALLEST
 * session-join for the co-op MVP. Explicitly NOT the full lobby (KD-072): no join
 * codes, no matchmaking, no reconnection, no UX. Two clients register; each is
 * assigned its own player instance; once the required number have joined, the
 * shared world + the global turn clock (SessionOrchestrator, KD-069) start, with
 * the co-op reconciler (KD-070) wired in.
 *
 * The turn clock is unavailable until the session has started (both joined) — a
 * caller submitting early gets an error, not a silently-dropped turn.
 */
'use strict';

const { SessionOrchestrator } = require('./session-orchestrator');
const { CoopReconciler } = require('./coop-reconciler');

class CoopSession {
	/** @param {object} opts { requiredPlayers=2, seed, enemyType='Rat' } */
	constructor(opts = {}) {
		this.required = opts.requiredPlayers || 2;
		this.seed = opts.seed || 'coop-session-seed';
		this.enemyType = opts.enemyType || 'Rat';
		this._joined = [];          // clientIds, in join order
		this.orch = null;           // SessionOrchestrator (created on start)
		this.reconciler = null;     // CoopReconciler (created on start)
		this.started = false;
	}

	get players() { return [...this._joined]; }

	/**
	 * Register a client. Returns { clientId, joined:[...], started, instanceId }.
	 * When the required number of players have joined, the session starts (boots
	 * the shared world + each player's instance and begins the turn clock).
	 */
	join(clientId) {
		if (this.started) throw new Error(`session already started — cannot join (${clientId})`);
		if (this._joined.includes(clientId)) throw new Error(`duplicate join: ${clientId}`);
		this._joined.push(clientId);
		if (this._joined.length >= this.required) this._start();
		return {
			clientId,
			joined: [...this._joined],
			started: this.started,
			instanceId: this.started ? `player-${clientId}` : null,
		};
	}

	_start() {
		this.reconciler = new CoopReconciler({ enemyType: this.enemyType });
		this.orch = new SessionOrchestrator({
			seed: this.seed,
			playerIds: this._joined,
			reconcile: this.reconciler.hook(),
		});
		this.orch.setup();
		this.started = true;
	}

	/** Submit a player's action — only valid once the session has started. */
	submit(clientId, action = {}) {
		if (!this.started) throw new Error('session not started — waiting for players');
		return this.orch.submit(clientId, action);
	}

	/** The HeadlessHost instance assigned to a client (null before start). */
	instanceOf(clientId) {
		return this.orch ? this.orch.players.get(clientId) || null : null;
	}
}

module.exports = { CoopSession };
