/**
 * tools/mp-server/lobby.js  (KD-080)
 *
 * Generalized N-player session (the KD-079/081 reconciler, but for 2–4 players)
 * plus the three concept pillars: a lobby join flow, a PvP interaction, and
 * server-side mod loading. Transport-agnostic — built on the same
 * `makeTransport(role)` factory + protocol as KD-081, so it runs over in-process,
 * worker, or socket transports unchanged.
 *
 * `orchestrator.js` (KD-079) and `mp-session.js` (KD-081) stay as the fixed
 * 2-player baselines; this is the generalized feature build.
 *
 * Pillars:
 *  - Lobby:  join(clientId) → assigns a player instance; 2–4 stub clients.
 *  - Turn clock: a turn advances only when ALL joined clients have submitted.
 *  - Reconciler: world enemy → every player; each player's avatar → every other.
 *  - PvP:    pvp(attacker, target, effect) lands on the TARGET's instance only.
 *  - Mods:   loadMod(file) evals a real mod server-side into the instances.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { factory } = require('./transport');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_MOD = path.join(REPO_ROOT, 'Mods', 'example_enemy', 'init.ks');
const DEFAULT_MOD_ENEMY = 'AngrySkeleton';

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;

class Lobby {
	/**
	 * @param {object} opts { transport='in-process', seed, enemyType='Rat' }
	 */
	constructor(opts = {}) {
		this.makeTransport = factory(opts.transport || 'in-process');
		this.seed = opts.seed || 'kd-poc-seed';
		this.enemyType = opts.enemyType || 'Rat';
		this.world = this.makeTransport('world');
		this.clients = [];          // [{ id, transport }]
		this._byId = {};            // id -> { id, transport }
		this.avatarPos = {};        // id -> {x,y}
		this._pending = {};
		this.turn = 0;
		this.history = [];
		this._started = false;
	}

	get clientIds() { return this.clients.map((c) => c.id); }

	/** Boot the world instance + seed the shared enemy. Call before join(). */
	async start() {
		await this.world.start();
		await this.world.request('init', { id: 'world', seed: this.seed, mode: 'world' });
		const tile = await this.world.request('findOpenTile');
		this.start_tile = tile;
		await this.world.request('placePlayer', { x: tile.x, y: tile.y });
		this.enemy = await this.world.request('summonEnemy', {
			x: tile.x + 2, y: tile.y, type: this.enemyType, opts: { rad: 4 },
		});
		this._started = true;
		return this;
	}

	/**
	 * A stub client joins the session and is assigned a fresh player instance.
	 * Players are placed on a small line near the scenario's open tile.
	 * @returns {{id:string}} client handle
	 */
	async join(clientId) {
		if (!this._started) throw new Error('call start() before join()');
		if (this._byId[clientId]) throw new Error(`client ${clientId} already joined`);
		if (this.clients.length >= MAX_PLAYERS) throw new Error(`lobby full (${MAX_PLAYERS})`);

		const transport = this.makeTransport(`player-${clientId}`);
		await transport.start();
		await transport.request('init', { id: `player-${clientId}`, seed: this.seed, mode: 'player' });

		const slot = this.clients.length;          // 0,1,2,3 → fan out along x
		const t = this.start_tile;
		const pos = await transport.request('placePlayer', { x: t.x + slot, y: t.y });

		const client = { id: clientId, transport };
		this.clients.push(client);
		this._byId[clientId] = client;
		this.avatarPos[clientId] = pos;
		return { id: clientId };
	}

	_requireStarted() {
		if (this.clients.length < MIN_PLAYERS) {
			throw new Error(`need at least ${MIN_PLAYERS} players (have ${this.clients.length})`);
		}
	}

	/** Seed the reconciled view + record the setup snapshot (after all joins). */
	async ready() {
		this._requireStarted();
		await this._reconcile();
		this.history.push(await this._snapshot('setup'));
		return this;
	}

	/** Global turn clock: advance only when ALL joined clients have submitted. */
	async submitMove(clientId, move = { dx: 0, dy: 0 }) {
		if (!this._byId[clientId]) throw new Error(`unknown client ${clientId}`);
		this._pending[clientId] = { dx: move.dx | 0, dy: move.dy | 0 };
		const haveAll = this.clientIds.every((id) => this._pending[id]);
		if (!haveAll) return { advanced: false, pending: Object.keys(this._pending) };
		return { advanced: true, turn: await this._advanceTurn() };
	}

	async _advanceTurn() {
		// 1) apply each player's move to their own avatar
		for (const c of this.clients) {
			const m = this._pending[c.id];
			this.avatarPos[c.id] = await c.transport.request('applyMove', { dx: m.dx, dy: m.dy });
		}
		// 2) world reacts: prey-slot + enemy target follow the first client
		const lead = this.avatarPos[this.clients[0].id];
		await this.world.request('placePlayer', { x: lead.x, y: lead.y });
		await this.world.request('setEnemyTarget', { x: lead.x, y: lead.y });

		// 3) lockstep: advance time once on every instance
		const ticks = { world: (await this.world.request('step', { n: 1 })).tick };
		for (const c of this.clients) ticks[c.id] = (await c.transport.request('step', { n: 1 })).tick;

		// 4) reconcile
		await this._reconcile();

		this.turn += 1;
		this._pending = {};
		const snap = await this._snapshot(`turn-${this.turn}`, ticks);
		this.history.push(snap);
		return snap;
	}

	async _reconcile() {
		// enemy: world authoritative → push to every player
		this.enemy = await this.world.request('getRealEnemy', { index: 0 });
		for (const c of this.clients) {
			await c.transport.request('injectEnemyState', { snapshot: this.enemy });
		}
		// avatars: refresh each, then inject each into every OTHER player + world
		for (const c of this.clients) this.avatarPos[c.id] = await c.transport.request('getPlayerPos');
		for (const c of this.clients) {
			for (const other of this.clients) {
				if (other.id === c.id) continue;
				const p = this.avatarPos[other.id];
				await c.transport.request('upsertAvatar', { id: other.id, x: p.x, y: p.y });
			}
			await this.world.request('upsertAvatar', { id: c.id, x: this.avatarPos[c.id].x, y: this.avatarPos[c.id].y });
		}
	}

	async _snapshot(label, ticks) {
		const enemyView = { world: await this.world.request('getEnemyView') };
		const roles = { world: (await this.world.request('runsEnemyAI')).value };
		const avatars = {};
		const seenBy = {};       // id -> { otherId -> {x,y} } (cross-visibility)
		for (const c of this.clients) {
			enemyView[c.id] = await c.transport.request('getEnemyView');
			roles[c.id] = (await c.transport.request('runsEnemyAI')).value;
			avatars[c.id] = this.avatarPos[c.id];
			seenBy[c.id] = {};
			for (const other of this.clients) {
				if (other.id === c.id) continue;
				seenBy[c.id][other.id] = await c.transport.request('getAvatar', { id: other.id });
			}
		}
		if (!ticks) {
			ticks = { world: (await this.world.request('tick')).tick };
			for (const c of this.clients) ticks[c.id] = (await c.transport.request('tick')).tick;
		}
		return { label, ticks, enemyView, avatars, seenBy, roles };
	}

	// ----- PvP -----------------------------------------------------------------

	/**
	 * A cross-player interaction: `attackerId` acts on `targetId`. The effect is
	 * applied ONLY to the target's instance (restraint and/or damage), proving
	 * per-instance state isolation. Returns before/after vitals for both.
	 * @param {object} effect { restraint?:string, damage?:number, damageType?:string }
	 */
	async pvp(attackerId, targetId, effect = {}) {
		const attacker = this._byId[attackerId];
		const target = this._byId[targetId];
		if (!attacker) throw new Error(`unknown attacker ${attackerId}`);
		if (!target) throw new Error(`unknown target ${targetId}`);
		if (attackerId === targetId) throw new Error('attacker and target must differ');

		const before = {
			attacker: await attacker.transport.request('getVitals'),
			target: await target.transport.request('getVitals'),
		};
		const applied = {};
		if (effect.restraint) {
			applied.restraint = await target.transport.request('addRestraint', { name: effect.restraint });
		}
		if (effect.damage) {
			applied.damage = await target.transport.request('dealDamage', {
				amount: effect.damage, type: effect.damageType || 'pain',
			});
		}
		const after = {
			attacker: await attacker.transport.request('getVitals'),
			target: await target.transport.request('getVitals'),
		};
		return { before, after, applied };
	}

	// ----- server-side mods ----------------------------------------------------

	/**
	 * Load a mod's code server-side into instances. Reads the mod file from disk
	 * (default Mods/example_enemy/init.ks) and evals it in the chosen instances
	 * via the same path the production loader uses. Returns per-instance lookup of
	 * the mod's enemy so callers can verify the effect.
	 * @param {object} opts { file=DEFAULT_MOD, enemyName='AngrySkeleton', scope='all'|'world' }
	 */
	async loadMod(opts = {}) {
		const file = opts.file || DEFAULT_MOD;
		const enemyName = opts.enemyName || DEFAULT_MOD_ENEMY;
		const scope = opts.scope || 'all';
		const code = fs.readFileSync(file, 'utf8');

		const targets = (scope === 'world')
			? [{ id: 'world', transport: this.world }]
			: [{ id: 'world', transport: this.world }, ...this.clients];

		const result = {};
		for (const t of targets) {
			await t.transport.request('loadMod', { code });
			result[t.id] = await t.transport.request('getEnemyByName', { name: enemyName });
		}
		return { enemyName, scope, result };
	}

	/** Look up an enemy by name across all instances (verification helper). */
	async getEnemyEverywhere(name) {
		const out = { world: await this.world.request('getEnemyByName', { name }) };
		for (const c of this.clients) out[c.id] = await c.transport.request('getEnemyByName', { name });
		return out;
	}

	/** Tear down all transports (world + players). */
	async close() {
		await Promise.all([
			this.world.close(),
			...this.clients.map((c) => c.transport.close()),
		]);
	}
}

module.exports = { Lobby, MIN_PLAYERS, MAX_PLAYERS, DEFAULT_MOD, DEFAULT_MOD_ENEMY };
