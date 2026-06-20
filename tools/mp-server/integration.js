/**
 * tools/mp-server/integration.js  (KD-082)
 *
 * Real in-game integration on top of the Lobby (KD-080). Where the lobby/reconciler
 * copied {x,y,hp} VALUES, this represents every player as a REAL injected KD entity
 * (an ally-faction "RemotePlayer" avatar) in the world and in every other player's
 * instance — so the engine's own AI targets/collides/attacks them, and interactions
 * are adjudicated by the authoritative world and routed to the target's instance.
 *
 * Proves the four real pillars:
 *  1. Players as real entities — avatar entities the engine sees (vision/targeting).
 *  2. Enemy AI attacks players — the world enemy targets the nearest avatar; the hit
 *     is routed to that player's own instance (real damage/restraint on the global
 *     player there); other players are unaffected.
 *  3. Routed P2P — A→B is validated/authorized by the world (adjacency of the two
 *     avatar entities) and only then applied in B's instance.
 *  4. Independent params — each instance holds a full, independent player param set.
 *
 * Each player is the GLOBAL player of their own instance (where real stats live).
 * The world's own global player is parked off-field — it is a non-participant whose
 * only job is to host the authoritative enemy + the avatar entities.
 */
'use strict';

const { Lobby } = require('./lobby');

// The world enemy's nominal attack, applied to a player's instance when the enemy
// is adjacent to that player's avatar. (PoC profile — production would derive this
// from the enemy def / a real hit-roll.)
const ENEMY_ATTACK = { damage: 2, type: 'pain', restraint: null };

class IntegratedSession extends Lobby {
	constructor(opts = {}) {
		super(opts);
		// avatarId -> entity id, per host where that avatar is injected.
		// shape: this.avatarEntities[hostKey][clientId] = entityId
		// hostKey is 'world' or a clientId (the instance the avatar lives in).
		this.avatarEntities = { world: {} };
	}

	/** transport for a host key ('world' or a clientId). */
	_t(hostKey) {
		return hostKey === 'world' ? this.world : this._byId[hostKey].transport;
	}

	/**
	 * Join + inject this player's avatar entity into the world and into every
	 * already-joined player's instance, and inject the existing players' avatars
	 * into the newcomer's instance.
	 */
	async join(clientId) {
		const handle = await super.join(clientId);          // boots+places the player instance
		const pos = this.avatarPos[clientId];
		this.avatarEntities[clientId] = this.avatarEntities[clientId] || {};

		// inject newcomer's avatar into the world
		const w = await this.world.request('spawnAvatar', { x: pos.x, y: pos.y });
		this.avatarEntities.world[clientId] = w.entityId;

		// inject newcomer into each existing peer, and each peer into the newcomer
		for (const other of this.clients) {
			if (other.id === clientId) continue;
			const inPeer = await other.transport.request('spawnAvatar', { x: pos.x, y: pos.y });
			this.avatarEntities[other.id] = this.avatarEntities[other.id] || {};
			this.avatarEntities[other.id][clientId] = inPeer.entityId;

			const op = this.avatarPos[other.id];
			const inNew = await this._t(clientId).request('spawnAvatar', { x: op.x, y: op.y });
			this.avatarEntities[clientId][other.id] = inNew.entityId;
		}
		return handle;
	}

	/** After all joins: park the world's global player so the enemy targets avatars. */
	async ready() {
		await this.world.request('parkGlobalPlayer', { x: 1, y: 1 });
		return super.ready();   // seeds reconcile + setup snapshot
	}

	/**
	 * Override the Lobby turn: in the integrated model the world's global player is
	 * PARKED and the enemy targets the injected avatars — so we must NOT mirror a
	 * player into the world / re-aim the enemy each turn (the base Lobby does that).
	 * We step every instance, reconcile avatar entities, then run the routed
	 * enemy-attack phase as part of the turn.
	 */
	async _advanceTurn() {
		for (const c of this.clients) {
			const m = this._pending[c.id];
			this.avatarPos[c.id] = await c.transport.request('applyMove', { dx: m.dx, dy: m.dy });
		}
		const ticks = { world: (await this.world.request('step', { n: 1 })).tick };
		for (const c of this.clients) ticks[c.id] = (await c.transport.request('step', { n: 1 })).tick;
		await this._reconcile();

		// gap #2: the world enemy may now be adjacent to an avatar → route the hit.
		const enemyHit = await this.enemyAttackPhase();

		this.turn += 1;
		this._pending = {};
		const snap = await this._snapshot(`turn-${this.turn}`, ticks);
		snap.enemyHit = enemyHit;
		this.history.push(snap);
		return snap;
	}

	/** Entity-level reconcile: push each player's real position into its avatars. */
	async _reconcile() {
		await super._reconcile();   // enemy world→players + host-side avatar coords
		for (const c of this.clients) {
			const p = this.avatarPos[c.id];
			// world avatar
			const wid = this.avatarEntities.world[c.id];
			if (wid != null) await this.world.request('moveAvatar', { entityId: wid, x: p.x, y: p.y });
			// peer avatars
			for (const other of this.clients) {
				if (other.id === c.id) continue;
				const eid = this.avatarEntities[other.id] && this.avatarEntities[other.id][c.id];
				if (eid != null) await other.transport.request('moveAvatar', { entityId: eid, x: p.x, y: p.y });
			}
		}
	}

	// ----- gap #2: enemy AI attacks players (routed) ---------------------------

	/**
	 * Read the world enemy's target; if it is adjacent to a player's avatar, route
	 * the enemy's attack into THAT player's instance (real damage on their global
	 * player). Returns { targetClient, applied } or null if no hit this turn.
	 */
	async enemyAttackPhase() {
		const tgt = await this.world.request('worldEnemyTarget');
		if (!tgt || tgt.target == null) return null;

		// which client's world-avatar is the enemy targeting?
		const targetClient = Object.keys(this.avatarEntities.world)
			.find((cid) => this.avatarEntities.world[cid] === tgt.target);
		if (!targetClient) return null;

		// adjacency: enemy must be next to the avatar (the world is authoritative)
		const dist = await this.world.request('entityDistance', {
			idA: tgt.enemyId, idB: tgt.target,
		});
		if (dist == null || dist > 1) return { targetClient, applied: null, dist };

		// route the hit into the target player's own instance
		const applied = await this._byId[targetClient].transport.request('applyEnemyHit', {
			profile: ENEMY_ATTACK,
		});
		return { targetClient, applied, dist };
	}

	// ----- gap #3: routed player-to-player interaction -------------------------

	/**
	 * A→B interaction, adjudicated by the world. The world checks the two players'
	 * avatar entities are adjacent (authority); only then is the effect applied in
	 * the target's instance. Returns { authorized, reason, before, after }.
	 */
	async routedPvp(attackerId, targetId, effect = {}) {
		const aEid = this.avatarEntities.world[attackerId];
		const bEid = this.avatarEntities.world[targetId];
		if (aEid == null || bEid == null) throw new Error('both players must have world avatars');

		// world authority: require adjacency (range 1) between the avatars
		const dist = await this.world.request('entityDistance', { idA: aEid, idB: bEid });
		const authorized = dist != null && dist <= 1;

		const before = {
			attacker: await this._byId[attackerId].transport.request('getVitals'),
			target: await this._byId[targetId].transport.request('getVitals'),
		};
		let applied = null;
		if (authorized) {
			applied = {};
			if (effect.restraint) {
				applied.restraint = await this._byId[targetId].transport.request('addRestraint', { name: effect.restraint });
			}
			if (effect.damage) {
				applied.damage = await this._byId[targetId].transport.request('dealDamage', { amount: effect.damage, type: effect.damageType || 'pain' });
			}
		}
		const after = {
			attacker: await this._byId[attackerId].transport.request('getVitals'),
			target: await this._byId[targetId].transport.request('getVitals'),
		};
		return { authorized, reason: authorized ? 'adjacent' : `too far (dist=${dist})`, dist, before, after, applied };
	}

	/** Force two players' world avatars adjacent (test helper for the authorized path). */
	async forceAdjacentInWorld(aId, bId) {
		const aEid = this.avatarEntities.world[aId];
		const bEid = this.avatarEntities.world[bId];
		const ae = (await this.world.request('listEntities')).find((e) => e.id === aEid);
		await this.world.request('moveAvatar', { entityId: bEid, x: ae.x + 1, y: ae.y });
	}

	// ----- gap #4: independent params ------------------------------------------

	/** Per-player param snapshot across the session (proves independence). */
	async paramsSnapshot() {
		const out = {};
		for (const c of this.clients) out[c.id] = await c.transport.request('getParams');
		return out;
	}

	/** Entities visible in a given instance ('world' or a clientId). */
	async entitiesIn(hostKey) {
		return this._t(hostKey).request('listEntities');
	}

	async entityAtIn(hostKey, x, y) {
		return this._t(hostKey).request('entityAt', { x, y });
	}
}

module.exports = { IntegratedSession, ENEMY_ATTACK };
