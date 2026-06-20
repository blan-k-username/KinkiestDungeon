/**
 * tools/mp-server/orchestrator.js
 *
 * PoC orchestrator + global turn clock + minimal reconciler (KD-069 / KD-070
 * PoC scope). Steps one world instance and two player instances in lockstep over
 * a single hardcoded scenario, keeping the shared enemy and the players' avatars
 * consistent across all three.
 *
 * Turn clock (Q2=a, global): a turn advances only when BOTH players have
 * submitted their action for that turn.
 *
 * Reconciler (minimal): after each turn it
 *   - pushes the world's enemy {x,y,hp} to both player instances,
 *   - pushes each player's avatar position to the world, and
 *   - injects each player's avatar into the other player's view.
 *
 * Transport is stubbed (in-process: the three HeadlessHosts are objects in one
 * Node process). This is throwaway — it proves instance consistency before the
 * feature pillars (KD-080). Production hardening = KD-069/070.
 */
'use strict';

const { HeadlessHost } = require('./headless-host');

const PLAYER_IDS = ['A', 'B'];

class Orchestrator {
	/**
	 * @param {object} opts { seed='kd-poc-seed', enemyType='Rat', verbose=false }
	 */
	constructor(opts = {}) {
		this.seed = opts.seed || 'kd-poc-seed';
		this.enemyType = opts.enemyType || 'Rat';
		this.world = new HeadlessHost({ id: 'world' });
		this.players = {
			A: new HeadlessHost({ id: 'player-A' }),
			B: new HeadlessHost({ id: 'player-B' }),
		};
		this._pending = {};          // playerId -> {dx,dy}
		this.turn = 0;
		this.history = [];           // per-turn snapshots (for assertions/debugging)
	}

	get all() { return [this.world, this.players.A, this.players.B]; }

	/** Boot + init all three instances on one shared (same-seed) scenario. */
	setup() {
		// Boot + init every instance with the same seed → identical map gen.
		for (const h of this.all) { h.boot(); h.init({ seed: this.seed }); }

		// Roles: world runs shared-entity AI; players suppress it (R3).
		this.world.setServerMode('world');
		this.players.A.setServerMode('player');
		this.players.B.setServerMode('player');

		// Hardcoded scenario: pick an open tile; place A and B at adjacent tiles.
		const t = this.world.findOpenTile();
		this.start = t;
		this.avatarPos = {
			A: this.players.A.placePlayer(t.x, t.y),
			B: this.players.B.placePlayer(t.x + 1, t.y),
		};
		// World tracks both avatars; its own player slot mirrors A (the enemy's prey).
		this.world.placePlayer(t.x, t.y);

		// One live enemy in the world, near the avatars, aware & hostile (R4).
		this.enemy = this.world.summonEnemy(t.x + 2, t.y, this.enemyType, { rad: 4 });

		// Seed the reconciled view so all three agree before turn 1.
		this._reconcile();
		this.history.push(this._snapshot('setup'));
		return this;
	}

	/**
	 * Submit a player's action for the current turn. When both players have
	 * submitted, the turn advances (global turn clock) and a turn result is
	 * returned with `advanced: true`. Otherwise `advanced: false`.
	 * @param {'A'|'B'} playerId
	 * @param {object} move { dx, dy }
	 */
	submitMove(playerId, move = { dx: 0, dy: 0 }) {
		if (!this.players[playerId]) throw new Error(`unknown player ${playerId}`);
		this._pending[playerId] = { dx: move.dx | 0, dy: move.dy | 0 };
		const haveAll = PLAYER_IDS.every((id) => this._pending[id]);
		if (!haveAll) return { advanced: false, pending: Object.keys(this._pending) };
		return { advanced: true, turn: this._advanceTurn() };
	}

	/** Internal: run one synchronized turn across all three instances. */
	_advanceTurn() {
		// 1) Apply each player's submitted move to their own avatar.
		for (const id of PLAYER_IDS) {
			const m = this._pending[id];
			this.avatarPos[id] = this.players[id].applyMove(m.dx, m.dy);
		}
		// 2) World reacts: its prey-slot mirrors avatar A; enemy targets A.
		this.world.placePlayer(this.avatarPos.A.x, this.avatarPos.A.y);
		this.world.setEnemyTarget(this.avatarPos.A.x, this.avatarPos.A.y);

		// 3) Lockstep step: advance time once on every instance (R1/R2).
		const ticks = {
			world: this.world.step(1),
			A: this.players.A.step(1),
			B: this.players.B.step(1),
		};

		// 4) Reconcile shared state across instances.
		this._reconcile();

		this.turn += 1;
		this._pending = {};
		const snap = this._snapshot(`turn-${this.turn}`, ticks);
		this.history.push(snap);
		return snap;
	}

	/** Push world→players (enemy) and players↔players (avatars). */
	_reconcile() {
		// Enemy: world is authoritative → push to both thin instances (R4).
		this.enemy = this.world.getRealEnemy(0);
		this.players.A.injectEnemyState(this.enemy);
		this.players.B.injectEnemyState(this.enemy);

		// Avatars: each player's position is visible to the other next turn (R5).
		this.avatarPos.A = this.players.A.getPlayerPos();
		this.avatarPos.B = this.players.B.getPlayerPos();
		this.players.A.upsertAvatar('B', this.avatarPos.B.x, this.avatarPos.B.y);
		this.players.B.upsertAvatar('A', this.avatarPos.A.x, this.avatarPos.A.y);
		// World holds both avatars too.
		this.world.upsertAvatar('A', this.avatarPos.A.x, this.avatarPos.A.y);
		this.world.upsertAvatar('B', this.avatarPos.B.x, this.avatarPos.B.y);
	}

	/** A consistent cross-instance snapshot for assertions. */
	_snapshot(label, ticks) {
		return {
			label,
			ticks: ticks || { world: this.world.tick(), A: this.players.A.tick(), B: this.players.B.tick() },
			enemyView: {
				world: this.world.getEnemyView(),
				A: this.players.A.getEnemyView(),
				B: this.players.B.getEnemyView(),
			},
			avatars: {
				A: this.avatarPos.A,
				B: this.avatarPos.B,
				BseenByA: this.players.A.getAvatar('B'),
				AseenByB: this.players.B.getAvatar('A'),
			},
			roles: {
				worldRunsAI: this.world.runsEnemyAI(),
				ARunsAI: this.players.A.runsEnemyAI(),
				BRunsAI: this.players.B.runsEnemyAI(),
			},
		};
	}

	/** The common turn counter — equal across all three instances by R2. */
	ticks() {
		return { world: this.world.tick(), A: this.players.A.tick(), B: this.players.B.tick() };
	}
}

module.exports = { Orchestrator, PLAYER_IDS };
