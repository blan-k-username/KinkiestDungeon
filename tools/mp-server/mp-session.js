/**
 * tools/mp-server/mp-session.js  (KD-081)
 *
 * Async, transport-based port of the KD-079 orchestrator. Identical turn-clock +
 * reconciler logic, but every interaction with an instance goes through a
 * transport as a serialized message (`await transport.request(cmd, args)`) — so
 * the world and the two players can live behind ANY boundary (same-process JSON,
 * worker thread, or a separate OS process over a socket).
 *
 * Constructed with a `makeTransport(role)` factory, so one session body runs over
 * every transport. `orchestrator.js` (KD-079) remains the sync direct-call
 * baseline; this is the version that crosses a real serialization boundary.
 */
'use strict';

const PLAYER_IDS = ['A', 'B'];

class MPSession {
	/**
	 * @param {(role:string)=>object} makeTransport  returns a transport with
	 *        async start()/request(cmd,args)/close()/stats()
	 * @param {object} opts { seed, enemyType }
	 */
	constructor(makeTransport, opts = {}) {
		this.makeTransport = makeTransport;
		this.seed = opts.seed || 'kd-poc-seed';
		this.enemyType = opts.enemyType || 'Rat';
		this.t = {
			world: makeTransport('world'),
			A: makeTransport('player-A'),
			B: makeTransport('player-B'),
		};
		this._pending = {};
		this.turn = 0;
		this.history = [];
		this.avatarPos = {};
	}

	get transports() { return [this.t.world, this.t.A, this.t.B]; }

	/** Boot + init all three instances over the transport, then set the scenario. */
	async setup() {
		await Promise.all(this.transports.map((tr) => tr.start()));
		await this.t.world.request('init', { id: 'world', seed: this.seed, mode: 'world' });
		await this.t.A.request('init', { id: 'player-A', seed: this.seed, mode: 'player' });
		await this.t.B.request('init', { id: 'player-B', seed: this.seed, mode: 'player' });

		const start = await this.t.world.request('findOpenTile');
		this.start = start;
		this.avatarPos.A = await this.t.A.request('placePlayer', { x: start.x, y: start.y });
		this.avatarPos.B = await this.t.B.request('placePlayer', { x: start.x + 1, y: start.y });
		await this.t.world.request('placePlayer', { x: start.x, y: start.y });

		this.enemy = await this.t.world.request('summonEnemy', {
			x: start.x + 2, y: start.y, type: this.enemyType, opts: { rad: 4 },
		});

		await this._reconcile();
		this.history.push(await this._snapshot('setup'));
		return this;
	}

	/** Global turn clock: advance only when both players have submitted. */
	async submitMove(playerId, move = { dx: 0, dy: 0 }) {
		if (!this.t[playerId]) throw new Error(`unknown player ${playerId}`);
		this._pending[playerId] = { dx: move.dx | 0, dy: move.dy | 0 };
		if (!PLAYER_IDS.every((id) => this._pending[id])) {
			return { advanced: false, pending: Object.keys(this._pending) };
		}
		return { advanced: true, turn: await this._advanceTurn() };
	}

	async _advanceTurn() {
		// 1) apply each player's move to their own avatar
		for (const id of PLAYER_IDS) {
			const m = this._pending[id];
			this.avatarPos[id] = await this.t[id].request('applyMove', { dx: m.dx, dy: m.dy });
		}
		// 2) world reacts: prey-slot mirrors avatar A; enemy targets A
		await this.t.world.request('placePlayer', { x: this.avatarPos.A.x, y: this.avatarPos.A.y });
		await this.t.world.request('setEnemyTarget', { x: this.avatarPos.A.x, y: this.avatarPos.A.y });

		// 3) lockstep: advance time once on every instance
		const ticks = {
			world: (await this.t.world.request('step', { n: 1 })).tick,
			A: (await this.t.A.request('step', { n: 1 })).tick,
			B: (await this.t.B.request('step', { n: 1 })).tick,
		};

		// 4) reconcile shared state across instances
		await this._reconcile();

		this.turn += 1;
		this._pending = {};
		const snap = await this._snapshot(`turn-${this.turn}`, ticks);
		this.history.push(snap);
		return snap;
	}

	async _reconcile() {
		// enemy: world authoritative → push to both thin instances
		this.enemy = await this.t.world.request('getRealEnemy', { index: 0 });
		await this.t.A.request('injectEnemyState', { snapshot: this.enemy });
		await this.t.B.request('injectEnemyState', { snapshot: this.enemy });

		// avatars: each player's position visible to the other next turn
		this.avatarPos.A = await this.t.A.request('getPlayerPos');
		this.avatarPos.B = await this.t.B.request('getPlayerPos');
		await this.t.A.request('upsertAvatar', { id: 'B', x: this.avatarPos.B.x, y: this.avatarPos.B.y });
		await this.t.B.request('upsertAvatar', { id: 'A', x: this.avatarPos.A.x, y: this.avatarPos.A.y });
		await this.t.world.request('upsertAvatar', { id: 'A', x: this.avatarPos.A.x, y: this.avatarPos.A.y });
		await this.t.world.request('upsertAvatar', { id: 'B', x: this.avatarPos.B.x, y: this.avatarPos.B.y });
	}

	async _snapshot(label, ticks) {
		const [wEnemy, aEnemy, bEnemy] = await Promise.all([
			this.t.world.request('getEnemyView'),
			this.t.A.request('getEnemyView'),
			this.t.B.request('getEnemyView'),
		]);
		const [BseenByA, AseenByB] = await Promise.all([
			this.t.A.request('getAvatar', { id: 'B' }),
			this.t.B.request('getAvatar', { id: 'A' }),
		]);
		const [wAI, aAI, bAI] = await Promise.all([
			this.t.world.request('runsEnemyAI'),
			this.t.A.request('runsEnemyAI'),
			this.t.B.request('runsEnemyAI'),
		]);
		if (!ticks) {
			ticks = {
				world: (await this.t.world.request('tick')).tick,
				A: (await this.t.A.request('tick')).tick,
				B: (await this.t.B.request('tick')).tick,
			};
		}
		return {
			label,
			ticks,
			enemyView: { world: wEnemy, A: aEnemy, B: bEnemy },
			avatars: { A: this.avatarPos.A, B: this.avatarPos.B, BseenByA, AseenByB },
			roles: { worldRunsAI: wAI.value, ARunsAI: aAI.value, BRunsAI: bAI.value },
		};
	}

	/** Tear down all transports (closes worker threads / child processes). */
	async close() {
		await Promise.all(this.transports.map((tr) => tr.close()));
	}

	/** Aggregate transport stats across the three instances. */
	stats() {
		const acc = { msgs: 0, bytes: 0 };
		for (const tr of this.transports) {
			const s = tr.stats ? tr.stats() : { msgs: 0, bytes: 0 };
			acc.msgs += s.msgs || 0; acc.bytes += s.bytes || 0;
		}
		return acc;
	}
}

module.exports = { MPSession, PLAYER_IDS };
