/* =========================================================================
 * MP per-player combat routing — per-slot damage application.
 *
 * Mirrors the stats pattern: establishes a *per-slot damage application accessor*
 * WITHOUT touching the enemy AI hot path, so single-player stays byte-identical.
 * The deep wiring — making enemy target selection able to choose P2, and routing
 * the attack resolver's `if (player.player)` branch at it — requires design
 * decisions (the full P2 damage model; per-player blind / MovePoints) so it is
 * kept in separate consumer slices.
 *
 * The accessor is INERT until that wiring lands: no enemy targets P2 today
 * (KinkyDungeonNearestPlayer returns the singular player), so nothing calls the
 * non-local branch yet. It exists so the wiring slice has a tested target.
 * ========================================================================= */

/**
 * Is `ent` a co-op player avatar that is NOT the local/singular player — i.e. a
 * `playerSlot`-tagged map entity (P2 on either client)? Such an entity must be
 * *selectable as a target* but receives damage against its own per-entity fields,
 * not the global player stats.
 */
function KDIsCoopPlayerSlot(ent: any): boolean {
	return !!(ent && ent.player && ent.playerSlot != null && ent.playerSlot !== KDLocalPlayerId);
}

/**
 * Apply an incoming attack to player `slot`.
 *
 * - Local/singular slot → the existing `KinkyDungeonDealDamage` global path,
 *   completely unchanged (single-player byte-identical).
 * - A co-op slot → a provisional minimal model: reduce that avatar's own `hp`
 *   field (seeded at spawn, serialized via Entities, round-trips through save/load
 *   + state_sync). The full per-player model (distraction / willpower / stamina /
 *   blind / MovePoints) is left for the wiring slice — this routes damage to
 *   per-player storage so that slice can flesh out the model.
 *
 * Returns a small result `{happened, slot, hp?}` (mirrors KinkyDungeonDealDamage's
 * `{happened}` shape) so callers can branch uniformly.
 */
/**
 * Equal-aggro target resolution. Both co-op players are equal-priority targets —
 * so an enemy targets the **nearer** of the two (Chebyshev distance; ties favour
 * P1 for determinism, which keeps the host's broadcast view and the guest's view
 * in agreement).
 *
 * Single-player / no active session / no P2 ⇒ returns the singular player
 * (`KinkyDungeonPlayerEntity`) unchanged — byte-identical to the legacy
 * `return KinkyDungeonPlayerEntity` it replaces at the end of
 * `KinkyDungeonNearestPlayer`.
 */
function KDResolveAggroTarget(enemy: any): any {
	const p1 = (typeof KinkyDungeonPlayerEntity !== 'undefined') ? KinkyDungeonPlayerEntity : undefined;
	if (typeof MPState === 'undefined' || !MPState.active) return p1;
	const p2: any = (typeof KDFindPlayerSlotEntity === 'function') ? KDFindPlayerSlotEntity(1) : undefined;
	if (!p2 || !p1 || !enemy) return p1;
	const d1 = Math.max(Math.abs(enemy.x - p1.x), Math.abs(enemy.y - p1.y));
	const d2 = Math.max(Math.abs(enemy.x - p2.x), Math.abs(enemy.y - p2.y));
	return d2 < d1 ? p2 : p1;   // ties → P1 (deterministic)
}

function KDDealDamageToSlot(slot: number, dmg: { damage: number; type?: string }): { happened: number; slot: number; hp?: number } {
	const amount = (dmg && typeof dmg.damage === 'number') ? dmg.damage : 0;
	const isLocal = (typeof KDLocalPlayerId === 'number') ? slot === KDLocalPlayerId : slot === 0;
	if (isLocal) {
		// Normalize to the engine's required {damage, type} shape (type defaults to
		// the generic untyped hit) and defer to the unchanged global path.
		const r = (typeof KinkyDungeonDealDamage === 'function')
			? KinkyDungeonDealDamage({ damage: amount, type: (dmg && dmg.type) || 'unarmed' })
			: { happened: 0 };
		return { happened: (r && (r as any).happened) || 0, slot };
	}
	const ent: any = (typeof KDPlayerById === 'function') ? KDPlayerById(slot) : undefined;
	if (!ent) return { happened: 0, slot };
	const before = (typeof ent.hp === 'number') ? ent.hp : 0;
	ent.hp = Math.max(0, before - amount);
	return { happened: before - ent.hp, slot, hp: ent.hp };
}

/**
 * Apply an enemy attack's effects to co-op player `slot`'s OWN stats — the
 * per-player analogue of the singular player's damage block in the enemy attack
 * resolver. Uses the stat accessor so it writes P2's stat block, never P1's globals.
 * Main damage raises distraction (clamped to max), willpower/stamina damage lower
 * those stats, blind/stun set the per-player blind + dock MovePoints.
 *
 * Returns `{happened}`.
 */
function KDApplyEnemyAttackToSlot(
	slot: number,
	dmg: { damage?: number; type?: string; staminaDamage?: number; willpowerDamage?: number; blind?: number; stun?: number },
): { happened: number } {
	if (typeof KDGetPlayerStat !== 'function' || typeof KDSetPlayerStat !== 'function') return { happened: 0 };
	const g = (n: string) => (KDGetPlayerStat(slot, n) as number) || 0;
	const s = (n: string, v: number) => KDSetPlayerStat(slot, n, v);
	let happened = 0;
	const d = dmg || {};
	if (d.damage) {
		const dmax = (KDGetPlayerStat(slot, 'distractionMax') as number) || (g('distraction') + d.damage);
		s('distraction', Math.min(dmax, g('distraction') + d.damage));
		happened += d.damage;
	}
	if (d.willpowerDamage) { s('will', Math.max(0, g('will') - d.willpowerDamage)); happened += d.willpowerDamage; }
	if (d.staminaDamage) { s('stamina', Math.max(0, g('stamina') - d.staminaDamage)); happened += d.staminaDamage; }
	if (d.blind) { s('blind', Math.max(g('blind'), d.blind)); happened += d.blind; }
	if (d.stun) {
		s('blind', Math.max(g('blind'), d.stun));
		s('movePoints', Math.min(-1, g('movePoints') - d.stun));  // stun-lock budget
		happened += d.stun;
	}
	return { happened };
}

/**
 * Bind player `slot` with the restraints an enemy attack rolled.
 *
 * - Local/singular slot → the unchanged global add path (`KinkyDungeonAddRestraintIfWeaker`,
 *   the same core the P1 resolver chain ultimately reaches) ⇒ single-player byte-identical.
 * - Co-op slot → land a faithful worn-`item` (mirroring the literal built in
 *   `KinkyDungeonAddRestraint`) on that avatar's OWN `restraintList` — so it serializes via
 *   Entities (save/load + state_sync) and renders through the character pipeline
 *   (`KDDressPlayerSlot` already feeds `KDGetWornRestraintsFor(slot)` to the dresser).
 *   One restraint per Group (mirrors the engine's group-occupancy rule).
 *
 * Deliberately a per-slot apply primitive, NOT a slot threaded through `KDRunBondageResist`
 * — that chain reads/writes the global worn set, block-calc, Shield and PlayerEntity buffs;
 * per-slot resist / lock / curse / tag fidelity for P2 is a later slice. Here the restraint
 * just lands, persists, and renders. Returns the count actually added.
 */
function KDAddRestraintToSlot(
	slot: number,
	restraintAdd: { r: any; v?: any; iv?: string }[],
	opts?: { enemy?: any; faction?: string; lock?: string },
): { added: number } {
	const list = restraintAdd || [];
	const o = opts || {};
	const isLocal = (typeof KDLocalPlayerId === 'number') ? slot === KDLocalPlayerId : slot === 0;
	let added = 0;
	if (isLocal) {
		if (typeof KinkyDungeonAddRestraintIfWeaker !== 'function') return { added };
		for (const r of list) {
			if (!r || !r.r) continue;
			const power = ((o.enemy && o.enemy.Enemy)
				? (o.enemy.Enemy.power || 0) + ((typeof KDEnemyRank === 'function') ? KDEnemyRank(o.enemy) : 0)
				: 0) || (r.r.power || 0);
			const bb = KinkyDungeonAddRestraintIfWeaker(r.r, power, o.enemy?.Enemy?.bypass,
				o.lock || r.r.DefaultLock || "", undefined, undefined, undefined, o.faction,
				undefined, undefined, o.enemy, true, undefined, undefined, undefined, r.v);
			if (bb) added += 1;
		}
		return { added };
	}
	// Co-op slot → the avatar's own worn list.
	if (typeof KDGetWornRestraintsFor !== 'function') return { added };
	const worn = KDGetWornRestraintsFor(slot);
	if (!Array.isArray(worn)) return { added };
	for (const r of list) {
		if (!r || !r.r || !r.r.name) continue;
		if (r.r.Group && typeof KDSlotHasRestraintGroup === 'function'
			&& KDSlotHasRestraintGroup(slot, r.r.Group)) continue;   // group already occupied
		const item: any = {
			name: r.r.name,
			id: (typeof KinkyDungeonGetItemID === 'function') ? KinkyDungeonGetItemID() : (worn.length + 1),
			type: (typeof Restraint !== 'undefined') ? Restraint : 'restraint',
			tightness: (typeof r.r.power === 'number') ? r.r.power : 0,
			lock: o.lock || "",
			faction: o.faction,
			events: (typeof KDGetEventsForRestraint === 'function') ? KDGetEventsForRestraint(r.iv || r.r.name) : undefined,
		};
		if (r.iv) item.inventoryVariant = r.iv;
		worn.push(item);
		added += 1;
	}
	return { added };
}
