/* =========================================================================
 * KDComputeStateHash — deterministic simulation state fingerprint.
 *
 * Returns a short, deterministic hex string that summarizes the simulation
 * state. Two clients running an identical simulation should produce identical
 * hashes each turn; a mismatch is the canonical desync signal.
 *
 * Non-cryptographic by design: uses FNV-1a (32-bit) over a canonical
 * serialization with sorted object keys so JavaScript's insertion-order
 * dependence doesn't leak into the hash.
 *
 * What is hashed:
 *   - KDGameData (the canonical game-state object)
 *   - a per-entity summary (count + each entity's identity / position / hp)
 *   - KinkyDungeonFactionRelations (faction reputations, mutually-symmetric)
 *
 * What is deliberately NOT hashed:
 *   - render-only transient state (no DOM, no PIXI internals)
 *   - timestamps, Math.random, anything wall-clock
 * ========================================================================= */

const MPStateHash_FNV1A_OFFSET = 0x811c9dc5;
const MPStateHash_FNV1A_PRIME  = 0x01000193;

/**
 * Returns a deterministic hex hash of the current simulation state.
 *
 * Pure function of `KDGameData` and the entity collection at call time. No
 * timestamps, no DOM access, no `Math.random`.
 */
function KDComputeStateHash(): string {
	let h = MPStateHash_FNV1A_OFFSET;
	// KDGameData is a top-level `let` in KinkyDungeon.ts. With es2020, that
	// binding is NOT on `globalThis` — it must be referenced bare. (See
	// memory/MEMORY.md, "Mod authoring" section.)
	h = MPStateHash_foldString(h, MPStateHash_canonicalStringify(MPStateHash_gameDataForHash()));
	h = MPStateHash_foldString(h, MPStateHash_entitySummary());
	h = MPStateHash_foldString(h, MPStateHash_canonicalStringify(
		typeof KinkyDungeonFactionRelations !== 'undefined' ? KinkyDungeonFactionRelations : null,
	));
	// >>> 0 forces unsigned 32-bit; toString(16) gives a compact hex string.
	return (h >>> 0).toString(16);
}

/**
 * KDGameData with the per-client multiplayer transport block removed. Under the
 * host-authoritative model both clients hold the same simulation state but a
 * different *local* transport identity (`KDGameData.multiplayer`: playerId, session,
 * pending action). That block is per-client runtime state — the same spirit as the
 * render-only state already excluded above — so folding it in would make host and
 * guest hashes differ every turn and falsely flag desync. Omitting it keeps the hash
 * a true cross-client integrity check.
 */
function MPStateHash_gameDataForHash(): any {
	if (typeof KDGameData === 'undefined' || !KDGameData) return null;
	const { multiplayer, ...rest } = KDGameData as any;
	return rest;
}

/**
 * Compact FNV-1a hex hash of an arbitrary string. Used by the multiplayer integrity
 * check to tag a transmitted full-state payload: both host and guest hash the
 * identical payload string, so the server's desync check confirms transport fidelity.
 * (The live `KDComputeStateHash` cannot serve this role — its derived per-avatar
 * fields recompute locally and differ post-load.)
 */
function MPHashString(s: string): string {
	return (MPStateHash_foldString(MPStateHash_FNV1A_OFFSET, s) >>> 0).toString(16);
}

/** FNV-1a 32-bit fold over a string's char codes. */
function MPStateHash_foldString(seed: number, s: string): number {
	let h = seed >>> 0;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		// `Math.imul` is the safe 32-bit multiply; avoids precision loss.
		h = Math.imul(h, MPStateHash_FNV1A_PRIME);
	}
	return h >>> 0;
}

/**
 * JSON-like stringify that walks object keys in sorted order so two
 * semantically-identical objects with differently-ordered key insertion
 * produce the same string. Skips functions, symbols and `undefined` (same
 * spirit as `JSON.stringify`).
 */
function MPStateHash_canonicalStringify(value: any): string {
	if (value === null || value === undefined) return 'null';
	const t = typeof value;
	if (t === 'string') return JSON.stringify(value);
	if (t === 'number') return Number.isFinite(value) ? String(value) : 'null';
	if (t === 'boolean') return value ? 'true' : 'false';
	if (t === 'function' || t === 'symbol' || t === 'bigint') return 'null';
	if (Array.isArray(value)) {
		const parts: string[] = [];
		for (const item of value) parts.push(MPStateHash_canonicalStringify(item));
		return '[' + parts.join(',') + ']';
	}
	if (t === 'object') {
		// Maps and Sets fold by sorted entries / values so insertion order
		// does not leak into the hash.
		if (value instanceof Map) {
			const entries: [string, string][] = [];
			value.forEach((v: any, k: any) => {
				entries.push([MPStateHash_canonicalStringify(k), MPStateHash_canonicalStringify(v)]);
			});
			entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
			return 'M[' + entries.map(([k, v]) => k + ':' + v).join(',') + ']';
		}
		if (value instanceof Set) {
			const items: string[] = [];
			value.forEach((v: any) => items.push(MPStateHash_canonicalStringify(v)));
			items.sort();
			return 'S[' + items.join(',') + ']';
		}
		const keys = Object.keys(value).sort();
		const parts: string[] = [];
		for (const k of keys) {
			const v = value[k];
			if (typeof v === 'function' || typeof v === 'undefined' || typeof v === 'symbol') continue;
			parts.push(JSON.stringify(k) + ':' + MPStateHash_canonicalStringify(v));
		}
		return '{' + parts.join(',') + '}';
	}
	return 'null';
}

/**
 * Compact, order-stable summary of the entity collection. Each entity is
 * reduced to the simulation-relevant fields (identity, position, hp,
 * hostile flag, enemy type). Rows are sorted by id so spawn order does not
 * leak into the hash.
 */
function MPStateHash_entitySummary(): string {
	// Bare reference: KDMapData is a top-level bundle let (see KDComputeStateHash above).
	const entities = (typeof KDMapData !== 'undefined' && KDMapData) ? KDMapData.Entities : undefined;
	if (!Array.isArray(entities)) return 'E0';
	const rows: string[] = [];
	for (const e of entities) {
		if (!e) continue;
		const id = e.id ?? '';
		const x = e.x ?? 0;
		const y = e.y ?? 0;
		const hp = e.hp ?? 0;
		const hostile = e.hostile ?? 0;
		const name = e.Enemy?.name ?? '';
		rows.push(id + ':' + x + ',' + y + ',' + hp + ',' + hostile + ',' + name);
	}
	rows.sort();
	return 'E' + rows.length + '[' + rows.join(';') + ']';
}
