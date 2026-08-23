/**
 * tools/mp-server/mod-sync.js  (KDM-249)
 *
 * WHICH MODS DOES THE GUEST NOT HAVE, AND WHERE ARE THE BYTES.
 *
 * Two things, both pure: the difference between two mod DECLARATIONS, and the in-memory store the
 * PAYLOADS sit in between the host's upload and the guest's fetch. Nothing here touches a socket, a
 * world, or a game global.
 *
 * WHY IT IS ITS OWN MODULE. The same call as `join-gate.js` and `peace.js`: this is the part whose
 * rules are easy to get subtly wrong, so it is checked in milliseconds
 * (`tests/unit/mp-mod-sync.spec.ts`) instead of behind a two-browser session boot.
 *
 * ⚠️ MP-SPECIFIC BY CONSTRUCTION. A one-player game holds one mod set and has nothing to reconcile
 * (KDM-226's test). This re-implements no game mechanic — installing and executing a mod stays
 * `KDLoadMod` / `KDExecuteMods`, untouched, in the browser.
 *
 * IDENTITY IS THE CONTENT HASH, NEVER THE NAME. Two players may hold the same mod under different
 * filenames, or different builds under one filename. A diff keyed on either name would tell the
 * guest to fetch something it already has — or, far worse, tell it that it already has something it
 * does not, which is the blank-sprite failure this whole task exists to remove.
 *
 * ABSENT IS NOT SATISFIED. A peer that declares nothing needs EVERYTHING. Reading an absent
 * declaration as "nothing to do" is how a guest ends up silently mod-less (R9) — the exact failure
 * the visible-degradation requirement is there to prevent — so it is pinned by its own test.
 */
'use strict';

/**
 * One declaration row, cleaned. Answers `null` for anything unusable.
 *
 * A row is unusable precisely when it has no hash: the hash IS the identity, so a row without one
 * cannot be compared, fetched, or stored. Everything else is descriptive and may be blank.
 *
 * Dropped rather than thrown on, because the rows come off the wire from another machine and a
 * malformed peer must not be able to take the gate down.
 *
 * Returns a COPY — the caller's declaration is never mutated, and a stored row cannot be changed
 * from under us later by whoever still holds the original.
 */
function normalizeRow(r) {
	if (!r || typeof r !== 'object') return null;
	const hash = typeof r.hash === 'string' ? r.hash.trim() : '';
	if (!hash) return null;
	return {
		name: typeof r.name === 'string' ? r.name : '',
		modname: typeof r.modname === 'string' ? r.modname : '',
		modbuild: typeof r.modbuild === 'string' ? r.modbuild : '',
		priority: Number.isFinite(r.priority) ? r.priority : 0,
		hash,
	};
}

/**
 * Clean a whole declaration: drop junk, drop duplicate hashes, and sort into INSTALL order.
 *
 * Sorted by priority DESC to match `KDMods.ts:311` — the order KD itself executes mods in. The
 * fetch list doubles as the install list, so scrambling it here would silently change which mod's
 * wrapper wins. `Array.prototype.sort` is stable, so equal priorities keep the declared order.
 */
function normalizeDeclaration(rows) {
	if (!Array.isArray(rows)) return [];
	const seen = new Set();
	const out = [];
	for (const raw of rows) {
		const row = normalizeRow(raw);
		if (!row) continue;
		if (seen.has(row.hash)) continue;   // content-addressed: the same bytes twice is one mod
		seen.add(row.hash);
		out.push(row);
	}
	return out.sort((a, b) => (b.priority || 0) - (a.priority || 0));
}

/**
 * The difference between the host's mod set and the guest's.
 *
 *   hostOnly   host rows whose bytes the guest lacks — the guest's fetch list, in install order.
 *   guestOnly  guest rows the host lacks. REPORTED, never pushed at the host: "HOST is source of
 *              truth" (R2) cuts one way only, and a guest-only mod is the guest's own business.
 *   conflict   a STRICT SUBSET of hostOnly: same `modname`, different bytes. The host's copy wins.
 *
 * `conflict` being a subset is the load-bearing part of this shape, and the spec asserts it as a
 * relation: a caller iterating `hostOnly` to decide what to download must not also have to remember
 * to walk `conflict`. It is extra information about rows already in the fetch list, not a fourth
 * category of work.
 */
function diffDeclarations(host, guest) {
	const hostRows = normalizeDeclaration(host);
	const guestRows = normalizeDeclaration(guest);

	const hostHashes = new Set(hostRows.map((r) => r.hash));
	const guestHashes = new Set(guestRows.map((r) => r.hash));
	// modname → the guest's hashes under that name. Only ever read to LABEL a row already known to
	// be missing; it never decides whether a row is missing (that is the hash's job alone).
	const guestByName = new Map();
	for (const r of guestRows) {
		if (!r.modname) continue;
		if (!guestByName.has(r.modname)) guestByName.set(r.modname, new Set());
		guestByName.get(r.modname).add(r.hash);
	}

	const hostOnly = hostRows.filter((r) => !guestHashes.has(r.hash));
	const guestOnly = guestRows.filter((r) => !hostHashes.has(r.hash));
	const conflict = hostOnly.filter((r) => r.modname && guestByName.has(r.modname));

	return { hostOnly, guestOnly, conflict };
}

/**
 * The session's mod payloads, keyed by content hash.
 *
 * IN MEMORY ONLY, and deliberately so. Writing them to disk would leave the gateway accumulating a
 * mod directory nobody asked it to keep, and would let a restarted gateway serve a PREVIOUS host's
 * mods to a new session. A restarted gateway holds nothing and re-asks the host, which is the
 * correct answer to "whose mods are these".
 *
 * Content-addressed, so `put` is idempotent: the same bytes uploaded twice is one entry. That is
 * what makes a host retry free.
 */
class ModStore {
	constructor() {
		this._byHash = new Map();
	}

	put(hash, bytes) {
		if (!hash || !bytes) return false;
		if (this._byHash.has(hash)) return true;   // same hash ⇒ same bytes; nothing to do
		this._byHash.set(hash, bytes);
		return true;
	}

	get(hash) { return this._byHash.get(hash); }

	has(hash) { return this._byHash.has(hash); }

	size() { return this._byHash.size; }

	/** Forget everything. A new host session must never serve the previous host's mods. */
	clear() { this._byHash.clear(); }
}

module.exports = { diffDeclarations, normalizeDeclaration, normalizeRow, ModStore };
