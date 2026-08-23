/**
 * KDM-249 — reconciling two mod sets (`tools/mp-server/mod-sync.js`), on its own.
 *
 * WHICH MODS DOES THE GUEST NOT HAVE, AND WHERE ARE THE BYTES. This is the pure half of "the guest
 * plays with the host's mods": the difference between two declarations, and the in-memory store the
 * payloads sit in between the host's upload and the guest's fetch. No socket, no world, no game
 * globals — the same call as `join-gate.js` / `peace.js` (KDM-233 architecture R1), so every rule
 * below is checked in milliseconds rather than behind a two-browser session boot.
 *
 * IDENTITY IS THE CONTENT HASH, NEVER THE NAME. Two players may hold the same mod under different
 * filenames, or different builds under one filename. A diff keyed on either name would tell the
 * guest to fetch something it already has, or — far worse — tell it that it already has something it
 * does not. Most of the cases below exist to pin that down.
 *
 * Requirement ids refer to the `## Requirements (decided)` section of KDM-249.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { diffDeclarations, ModStore } = require('../../tools/mp-server/mod-sync');

/** A declaration row, as `coop-mods.js` builds it from `KDModLoadOrder`. */
function mod(modname: string, hash: string, extra: any = {}) {
	return Object.assign({
		name: `${modname.toLowerCase()}.zip`,
		modname,
		modbuild: '2026-01-01',
		priority: 0,
		hash,
	}, extra);
}

describe('KDM-249 — diffDeclarations (R3)', () => {
	it('two identical sets leave nothing to do', () => {
		const set = [mod('Cool', 'h1'), mod('Neat', 'h2')];
		const d = diffDeclarations(set, set.slice());
		expect(d.hostOnly).toEqual([]);
		expect(d.guestOnly).toEqual([]);
		expect(d.conflict).toEqual([]);
	});

	it('a mod only the host has is the guest\'s to fetch', () => {
		const d = diffDeclarations([mod('Cool', 'h1')], []);
		expect(d.hostOnly.map((m: any) => m.hash)).toEqual(['h1']);
	});

	it('a mod only the GUEST has is reported but never pushed at the host', () => {
		// "HOST is source of truth" (R2) cuts one way only: a guest-only mod is the guest's business.
		const d = diffDeclarations([], [mod('Mine', 'h9')]);
		expect(d.guestOnly.map((m: any) => m.hash)).toEqual(['h9']);
		expect(d.hostOnly).toEqual([]);
	});

	it('identity is the HASH, not the filename — same file name, different bytes is a conflict', () => {
		const d = diffDeclarations(
			[mod('Cool', 'host-hash')],
			[mod('Cool', 'guest-hash')],
		);
		expect(d.conflict.map((m: any) => m.hash)).toEqual(['host-hash']);
	});

	it('identity is the HASH, not the filename — different file name, same bytes is NOT a difference', () => {
		// The trap this pins: a name-keyed diff would hand the guest a mod it already has.
		const d = diffDeclarations(
			[mod('Cool', 'same', { name: 'cool-v2.zip' })],
			[mod('Cool', 'same', { name: 'downloaded-cool.zip' })],
		);
		expect(d.hostOnly).toEqual([]);
		expect(d.conflict).toEqual([]);
	});

	it('a conflict is a SUBSET of hostOnly — the host copy wins and must be fetched', () => {
		// Stated as a relation rather than left implicit: a caller iterating `hostOnly` to decide what
		// to download must not have to also remember to walk `conflict`.
		const d = diffDeclarations(
			[mod('Cool', 'host-hash'), mod('Extra', 'h2')],
			[mod('Cool', 'guest-hash')],
		);
		const hostOnlyHashes = d.hostOnly.map((m: any) => m.hash);
		expect(hostOnlyHashes).toContain('host-hash');
		for (const c of d.conflict) expect(hostOnlyHashes).toContain(c.hash);
	});

	it('hostOnly keeps the host\'s priority order, because that is the install order', () => {
		// KDMods sorts by priority DESC (`KDMods.ts:311`); the fetch list must not scramble it.
		const d = diffDeclarations(
			[mod('Late', 'h1', { priority: 0 }), mod('Early', 'h2', { priority: 100 })],
			[],
		);
		expect(d.hostOnly.map((m: any) => m.modname)).toEqual(['Early', 'Late']);
	});

	it('a guest that declares NOTHING needs everything — not nothing', () => {
		// The back-compat shape: an older client, or the legacy `#coop=` path, sends no `mods` field.
		// Reading absent-as-satisfied is the silent-zero-mods failure (R9) arriving through the gate.
		for (const empty of [undefined, null, []]) {
			const d = diffDeclarations([mod('Cool', 'h1')], empty as any);
			expect(d.hostOnly.map((m: any) => m.hash)).toEqual(['h1']);
		}
	});

	it('a host that declares nothing asks nothing of the guest', () => {
		for (const empty of [undefined, null, []]) {
			const d = diffDeclarations(empty as any, [mod('Mine', 'h9')]);
			expect(d.hostOnly).toEqual([]);
			expect(d.guestOnly.map((m: any) => m.hash)).toEqual(['h9']);
		}
	});

	it('junk rows are dropped rather than thrown on — a malformed peer must not take the gate down', () => {
		const d = diffDeclarations(
			[mod('Good', 'h1'), null, {}, { modname: 'NoHash' }, 'nonsense'] as any,
			[],
		);
		expect(d.hostOnly.map((m: any) => m.hash)).toEqual(['h1']);
	});

	it('does not mutate either declaration it was handed', () => {
		const host = [mod('Cool', 'h1')];
		const guest = [mod('Mine', 'h9')];
		const hostCopy = JSON.parse(JSON.stringify(host));
		const guestCopy = JSON.parse(JSON.stringify(guest));
		diffDeclarations(host, guest);
		expect(host).toEqual(hostCopy);
		expect(guest).toEqual(guestCopy);
	});
});

describe('KDM-249 — ModStore (R6)', () => {
	let s: any;
	beforeEach(() => { s = new ModStore(); });

	it('starts empty', () => {
		expect(s.size()).toBe(0);
		expect(s.has('h1')).toBe(false);
	});

	it('round-trips the bytes it was given, unchanged', () => {
		const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
		s.put('h1', bytes);
		expect(s.has('h1')).toBe(true);
		expect(Buffer.compare(s.get('h1'), bytes)).toBe(0);
	});

	it('answers undefined for a hash it never saw, rather than throwing', () => {
		expect(s.get('nope')).toBeUndefined();
	});

	it('the same hash stored twice is one entry — content-addressed, so a re-upload is idempotent', () => {
		s.put('h1', Buffer.from([1]));
		s.put('h1', Buffer.from([1]));
		expect(s.size()).toBe(1);
	});

	it('clear() empties it — a new host session must not serve the previous host\'s mods', () => {
		s.put('h1', Buffer.from([1]));
		s.clear();
		expect(s.size()).toBe(0);
		expect(s.get('h1')).toBeUndefined();
	});
});
