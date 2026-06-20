/**
 * tools/mp-server/coop-reconciler.js
 *
 * Co-op reconciler (KD-070, epic mp-mvp / KD-066) — the core novel design.
 * Plugs into the SessionOrchestrator (KD-069) turn clock via `hook()` and keeps
 * the world instance and the player instances consistent each turn.
 *
 * Authority: the WORLD owns the one authoritative KDMapData (map + shared enemy)
 * and an avatar entity per player; it runs enemy AI. Each PLAYER instance is its
 * own real global player (role 'player', AI suppressed — KD-068) and:
 *   - ADOPTS the world's authoritative MAP (applyWorldMap — no same-seed regen),
 *   - hosts the shared enemy as a PROPER injected entity kept in sync with the world,
 *   - hosts the OTHER players' avatars as PROPER injected entities.
 * Shared entities are managed as well-formed engine entities (NOT a wholesale
 * Entities replacement) so they survive each instance's per-turn CheckHP pass.
 *
 * Enemy attacks are adjudicated by the world using the enemy's REAL def-derived
 * attack profile and ROUTED to the targeted player's instance (real damage lands
 * on the global player there → only that player is affected).
 *
 * See KD-070 "co-op reconcile protocol v1". version: 1.
 */
'use strict';

const PROTOCOL_VERSION = 1;

class CoopReconciler {
	/** @param {object} opts { enemyType='Rat' } */
	constructor(opts = {}) {
		this.version = PROTOCOL_VERSION;
		this.enemyType = opts.enemyType || 'Rat';

		this.worldAvatar = new Map();      // playerId -> world avatar entity id
		this.peerAvatar = new Map();       // viewerId -> Map(ownerId -> entity id in viewer instance)
		this.enemyInPlayer = new Map();    // playerId -> shared-enemy entity id in that instance
		this.worldEnemyId = null;          // shared enemy entity id in the world
		this.startOf = new Map();          // playerId -> {x,y}

		this.lastHits = [];                // routed hits from the most recent post-step
		// When set to a playerId, post-step forces the enemy adjacent to that player's
		// avatar before adjudicating — a deterministic-encounter scaffold for tests.
		this.forceEngagePlayer = null;
	}

	/** The reconcile callback to pass as SessionOrchestrator({ reconcile }). */
	hook() { return (orch, ctx) => this._phase(orch, ctx); }

	_phase(orch, ctx) {
		if (ctx.phase === 'setup') this._setup(orch);
		else if (ctx.phase === 'pre-step') this._preStep(orch);
		else if (ctx.phase === 'post-step') this._postStep(orch);
	}

	// ----- setup ----------------------------------------------------------------
	_setup(orch) {
		const world = orch.world;
		const ids = orch.playerIds;
		const base = world.findOpenTile();

		// place each player's own global player + its world avatar
		let i = 0;
		for (const id of ids) {
			const pos = { x: base.x + i, y: base.y };
			orch.players.get(id).placePlayer(pos.x, pos.y);
			const av = world.spawnAvatar(pos.x, pos.y);
			this.worldAvatar.set(id, av.entityId);
			this.startOf.set(id, pos);
			i++;
		}
		// one authoritative shared enemy, on a VERIFIED movable tile near the avatars.
		// Summon BEFORE parking the world player (summon placement keys off the
		// player position — parking it to the map edge first makes the search fail).
		world.placePlayer(base.x, base.y);
		const enemy = this._summonEnemyNear(world, base.x + ids.length, base.y);
		this.worldEnemyId = enemy ? enemy.id : null;

		// now park the world's own player off-field → the enemy chases the avatars
		world.parkGlobalPlayer(1, 1);

		// transmit the authoritative MAP to every player; inject the shared enemy +
		// every OTHER player's avatar as proper entities in each instance.
		const snap = world.serializeRenderState();
		for (const id of ids) {
			const p = orch.players.get(id);
			p.applyWorldMap(snap);
			const e = p.injectSharedEnemy(this.enemyType, enemy ? enemy.x : base.x, enemy ? enemy.y : base.y, enemy ? enemy.hp : 1);
			if (e) this.enemyInPlayer.set(id, e.entityId);
			const peers = new Map();
			for (const other of ids) {
				if (other === id) continue;
				const op = this.startOf.get(other);
				const pe = p.spawnAvatar(op.x, op.y);
				peers.set(other, pe.entityId);
			}
			this.peerAvatar.set(id, peers);
		}
	}

	/** Summon the shared enemy on a movable tile, searching outward if needed. */
	_summonEnemyNear(world, x, y) {
		const offsets = [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [2, 0]];
		for (const [dx, dy] of offsets) {
			const ex = x + dx, ey = y + dy;
			if (!world.isMovable(ex, ey)) continue;
			const e = world.summonEnemy(ex, ey, this.enemyType, { rad: 6 });
			if (e && e.name === this.enemyType) return e;
		}
		// last resort: let summonEnemy search by radius from the requested tile
		const e = world.summonEnemy(x, y, this.enemyType, { rad: 8 });
		return (e && e.name === this.enemyType) ? e : null;
	}

	// ----- pre-step: players' positions → their world avatars ------------------
	_preStep(orch) {
		for (const id of orch.playerIds) {
			const avId = this.worldAvatar.get(id);
			if (avId == null) continue;
			const p = orch.players.get(id).getPlayerPos();
			orch.world.moveAvatar(avId, p.x, p.y);
		}
	}

	// ----- post-step: adjudicate + reconcile entity positions ------------------
	_postStep(orch) {
		const world = orch.world;
		this.lastHits = [];

		// optional deterministic engagement (tests): enemy adjacent to a target avatar
		if (this.forceEngagePlayer && this.worldEnemyId != null) {
			const av = this._entity(world, this.worldAvatar.get(this.forceEngagePlayer));
			if (av) world.moveAvatar(this.worldEnemyId, av.x - 1, av.y);
		}

		// adjudicate the enemy's REAL attack against any in-range avatar → route it
		if (this.worldEnemyId != null) {
			const profile = world.getEnemyAttackProfile(this.worldEnemyId);
			if (profile) {
				for (const id of orch.playerIds) {
					const dist = world.entityDistance(this.worldEnemyId, this.worldAvatar.get(id));
					if (dist != null && dist <= (profile.range || 1)) {
						const before = orch.players.get(id).getVitals();
						const after = orch.players.get(id).applyEnemyHit({
							damage: profile.damage,
							type: profile.type,
							restraint: profile.isBind ? 'DuctTapeHands' : null,
						});
						this.lastHits.push({ player: id, profile, before, after });
					}
				}
			}
		}

		// reconcile entity positions: world enemy + avatars → each player instance
		const we = this.worldEnemyId != null ? this._entity(world, this.worldEnemyId) : null;
		for (const id of orch.playerIds) {
			const p = orch.players.get(id);
			// shared enemy
			const eid = this.enemyInPlayer.get(id);
			if (eid != null && we) p.moveAvatar(eid, we.x, we.y);
			// peer avatars (other players' positions, authoritative from the world)
			const peers = this.peerAvatar.get(id);
			if (peers) {
				for (const [ownerId, peEid] of peers) {
					const wa = this._entity(world, this.worldAvatar.get(ownerId));
					if (wa) p.moveAvatar(peEid, wa.x, wa.y);
				}
			}
		}
	}

	_entity(host, id) {
		if (id == null) return null;
		return host.listEntities().find((e) => e.id === id) || null;
	}

	// ----- read helpers for assertions -----------------------------------------

	/** The world's authoritative enemy entity {id,x,y,hp,name}. */
	enemyView(orch) { return this._entity(orch.world, this.worldEnemyId); }

	/** A player instance's view of the shared enemy entity. */
	enemyAsSeenBy(orch, playerId) {
		return this._entity(orch.players.get(playerId), this.enemyInPlayer.get(playerId));
	}

	/** A player's view of ANOTHER player's avatar entity. */
	avatarAsSeenBy(orch, viewerId, ownerId) {
		const peers = this.peerAvatar.get(viewerId);
		if (!peers || ownerId === viewerId) return null;
		return this._entity(orch.players.get(viewerId), peers.get(ownerId));
	}
}

module.exports = { CoopReconciler, PROTOCOL_VERSION };
