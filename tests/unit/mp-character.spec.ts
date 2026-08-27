/**
 * KDM-256 — each player builds their OWN character, and gets it.
 *
 * ── THE PROBLEM ───────────────────────────────────────────────────────────────────────────────────
 * Both players are clones of one default new-game character. `_start` captures `_newPlayerTemplate`
 * from a single `KinkyDungeonStartNewGame`, and every seat is a restore of it — so two players can
 * tell each other apart by NAME (KDM-237) and by nothing else.
 *
 * ── THE MECHANISM UNDER TEST, AND WHY IT IS NOT `_templateOf` ─────────────────────────────────────
 * `_seatPlayer` is a restore → mutate → capture window. `setPlayerName` (KDM-237) and `applyPerks`
 * (KDM-238) already live inside it, and a character package is a third mutation of exactly that
 * kind: it belongs beside them, NOT in `_templateOf`.
 *
 * `_templateOf` is KDM-243's, and it answers a different question — "this seat resumes an entire
 * saved run". Its `imported` flag does DOUBLE DUTY: it also means "skip every new-game operation",
 * because a character resumed at floor 9 must not be handed a second starting collar by
 * `KDInitPerks()`. Put a package there and a packaged player silently loses their perks, their modes
 * AND their name — while still looking perfectly seated. R6 exists to pin that.
 *
 *
 * ── WHY IT IS NOT A VACUOUS GREEN ─────────────────────────────────────────────────────────────────
 *  1. Every seating assertion is PAIRED with a control — an UNDECLARED seat, asserted unchanged.
 *     "C declared and got it" and "everyone got it" look identical otherwise, and the second is the
 *     real failure mode: `applyCharacter` writes into the world's ONE shared player slot.
 *  2. Declared values are read back out of the captured BUNDLE, never out of the world slot. The
 *     slot holds whoever was restored last, so asserting on it would pass even with the capture
 *     window wrong — which is the whole of what this feature can get wrong.
 *  3. The seating values are READ OUT OF THE BOOTED WORLD, never written in this file. KD's tables
 *     are the whitelist, so invented names are correctly REFUSED — a spec asserting they applied
 *     would be asserting that KD's validation is broken. (The first draft did exactly that.)
 *  4. `sanitizeCharacter` is asserted NOT to know what a valid outfit is, and a source guard at the
 *     bottom fails the build if a KD table name appears in `join-gate.js` (epic AC2).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JoinGate, sanitizeCharacter, CHAR_MAX } = require('../../tools/mp-server/join-gate');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HOST_JOIN_FIELDS, GUEST_JOIN_FIELDS } = require('../../tools/mp-server/ws-bridge');

const BOOT_TIMEOUT = 240_000;
const BUILD = 'kd-5.5.0-abc123';


/*
 * Values for the PURE half only. Deliberately not real KD names: nothing in `join-gate.js` may know
 * one, so nothing here needs to either, and obvious fakes prove the sanitiser passes values through
 * rather than recognising them. The SEATING half reads real names out of the world instead.
 */
const CHAR_A = { class: 'ClassOne', outfit: 'OutfitOne', style: 'StyleOne' };

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * The pure half — no socket, no world, milliseconds.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════ */

describe('KDM-256 R3 — sanitizeCharacter', () => {
	it('answers null for anything that is not an object of declarable fields', () => {
		for (const junk of [undefined, null, '', 'a string', 42, [], [1, 2], true, {}]) {
			expect(sanitizeCharacter(junk as any), `${JSON.stringify(junk)} is not a character`).toBeNull();
		}
	});

	it('keeps the declared fields and drops everything else', () => {
		// ⚠️ `perks` USED TO BE ONE OF THE REJECTED KEYS IN THIS TEST. KDM-279 folded the former
		// `join.perks` wire field into the package, so it is now declarable and is asserted below as
		// one of the things that SURVIVES. Left as an explicit note because the inverted assertion is
		// exactly what a reader would otherwise take for a mistake.
		const out = sanitizeCharacter({ ...CHAR_A, hp: 9999, __proto__: { evil: 1 }, nested: { a: 1 } });
		expect(out).toEqual(CHAR_A);
		// A package is a set of CHOICES, not a character sheet. Anything that would let a client
		// declare its own stats is a gameplay decision the gateway must not carry.
		expect(out).not.toHaveProperty('hp');
		expect(out).not.toHaveProperty('nested');
		// CONTROL for the two assertions above: a same-shape key that IS declarable survives, so
		// `not.toHaveProperty` is not passing merely because the sanitiser returned something empty.
		expect(out).toHaveProperty('outfit', 'OutfitOne');
	});

	// KDM-279 — the perk declaration is part of the package now, and goes through the perk rules.
	it('carries perks, through sanitizePerks and not a second copy of its rules', () => {
		const out = sanitizeCharacter({
			...CHAR_A,
			// Every rule `sanitizePerks` owns, in one declaration: a duplicate (a set), the
			// `MagicHands` sentinel KD sets and deletes itself, a non-string, and a live key.
			perks: ['Submissive', 'Submissive', 'MagicHands', 42, 'Studious'],
		});
		expect(out!.perks, 'deduplicated, sentinel removed, non-strings dropped')
			.toEqual(['Submissive', 'Studious']);
		// The rest of the package is unaffected by having perks in it.
		expect(out!.class).toBe(CHAR_A.class);
	});

	it('a package of perks ALONE is still a package', () => {
		// A player may keep KD's default class and outfit and still have chosen perks on KD's own
		// perk screen. If that came back `null` the declaration would be silently dropped and they
		// would be seated with none.
		const out = sanitizeCharacter({ perks: ['Studious'] });
		expect(out).toEqual({ perks: ['Studious'] });
	});

	it('an empty or junk perk list does not manufacture a package out of nothing', () => {
		// The mirror of the above, and the reason `perks` is only set when non-empty: `null` means
		// "declared nothing" all the way down to KD's own default (R4), and a `{ perks: [] }` would
		// send `applyCharacter` down its write path with nothing to write.
		expect(sanitizeCharacter({ perks: [] })).toBeNull();
		expect(sanitizeCharacter({ perks: ['MagicHands'] }), 'a list of only sentinels is an empty list')
			.toBeNull();
	});

	it('a lawful maximum perk list does not get the whole package refused', () => {
		/*
		 * ⚠️ THE REGRESSION THIS EXISTS FOR. `sanitizeCharacter` REFUSES rather than truncates, on a
		 * size cap. Perks are capped at 64 keys × 64 chars ≈ 4 KB of keys before JSON quoting — so
		 * with the pre-KDM-279 cap of 4 KB, a perk list that is entirely legal by its own limits
		 * would have pushed the package over the line and had the WHOLE thing refused, class and
		 * outfit included, with no error anywhere and KD's default seated instead.
		 */
		const perks = Array.from({ length: 64 }, (_, i) => `Perk${String(i).padStart(2, '0')}`.padEnd(64, 'x'));
		const out = sanitizeCharacter({ ...CHAR_A, perks });
		expect(out, 'a lawful declaration must not be refused wholesale').not.toBeNull();
		expect(out!.perks!.length, 'and the perks survive it intact').toBe(64);
		expect(out!.class, 'as does the rest of the package').toBe(CHAR_A.class);
	});

	it('strips control characters and caps each field by the CHARACTER rule', () => {
		// A real BEL, not a printable stand-in: this is the rule `sanitizeName` states, and a
		// test written with a space would pass against a sanitiser that filters nothing.
		const out = sanitizeCharacter({ class: 'A\u0007BC', outfit: 'x'.repeat(200) });
		expect(out!.class, 'C0 controls must not reach KD').toBe('ABC');
		// Capped by the CHARACTER field rule (64), NOT by the lobby NAME rule (24) — an outfit key
		// is an identifier, and borrowing the name cap would silently make it unrecognisable.
		expect(out!.outfit!.length, 'an unbounded field is a wedge, not a choice').toBe(64);
	});

	it('refuses an OVERSIZED package outright rather than truncating it', () => {
		// Truncating would produce a package the player did not choose and cannot see is wrong.
		// Refusing is the same answer `sanitizeSave` gives, for the same reason.
		const huge: any = {};
		for (let i = 0; i < 500; i++) huge['k' + i] = 'v'.repeat(500);
		expect(sanitizeCharacter(Object.assign(huge, CHAR_A))).toBeNull();
		expect(CHAR_MAX, 'a wire cap, not a gameplay constant').toBeGreaterThan(0);
	});

	it('does NOT judge whether a value exists — that is KD\'s table, not ours (epic AC2)', () => {
		// The rule `sanitizePerks` states: an unknown key is carried politely and applied never.
		const out = sanitizeCharacter({ class: 'NoSuchClassAnywhere', outfit: 'NoSuchOutfit' });
		expect(out, 'the gateway must not own a list of valid outfits').toEqual(
			{ class: 'NoSuchClassAnywhere', outfit: 'NoSuchOutfit' });
	});

	it('answers null when nothing declarable survived', () => {
		expect(sanitizeCharacter({ hp: 1, junk: 'x' })).toBeNull();
		expect(sanitizeCharacter({ class: '\u0000\u0001' }), 'emptied by sanitising is still nothing')
			.toBeNull();
	});
});

describe('KDM-256 R1 — the declaration travels the perks road', () => {
	it('is a field on the join handshake for BOTH roles', () => {
		// Unlike `world`/`save`, a character is not host-only: it is the one thing a guest most needs
		// to bring. KDM-260's drift guard fails the build if the client sends it and this is missing.
		expect(HOST_JOIN_FIELDS).toContain('character');
		expect(GUEST_JOIN_FIELDS, 'a guest brings a character — that is the whole feature')
			.toContain('character');
	});

	it('the gate sanitises where it STORES, and answers null for a seat that declared nothing', () => {
		const gate = new JoinGate({ build: BUILD });
		gate.claimHost('H', { name: 'Host', build: BUILD, character: { ...CHAR_A, hp: 5 } });
		expect(gate.characterOf('H'), 'stored sanitised, never raw').toEqual(CHAR_A);
		expect(gate.characterOf('nobody'), 'declared nothing must have exactly one answer').toBeNull();
	});
});
/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * The seating half — ONE boot, and both halves of the question in it.
 *
 * ⚠️ THE VALUES ARE READ OUT OF THE BOOTED WORLD, NEVER WRITTEN HERE. KD's own tables are the
 * whitelist (`applyCharacter` consults `KDClassStart` / `KDGetDressList()`), so a spec asserting on
 * invented names would assert that KD's validation is BROKEN — which is what the first draft of this
 * file did, and it read as an implementation bug for an hour. Naming a real outfit here would also
 * put a gameplay constant in the test for a layer that is forbidden one.
 *
 * That creates a chicken-and-egg — the tables need a booted world, and a declaration must precede
 * seating. It is resolved with a JOIN-LATE rather than a second boot: A and B seat undeclared (which
 * is R4's case, asserted for free), then the tables are read, then C arrives declaring real values.
 * One boot, both cases, and the join-late path exercised as a bonus.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════ */

describe('KDM-256 — a declared character, against a world that has one', () => {
	let s: any;
	let real: any;

	/** What a seat's OWN bundle says about its character — read from the BUNDLE, never the slot. */
	const declaredIn = (cid: string) => {
		s.world.restorePlayer(s.bundles.get(cid));
		return s.world.eval('({ cls: typeof KinkyDungeonClassMode === "string" ? KinkyDungeonClassMode : null,'
			+ ' dress: typeof KinkyDungeonCurrentDress !== "undefined" ? KinkyDungeonCurrentDress : null })');
	};

	beforeAll(async () => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'kdm256' });
		s.join('A'); s.join('B');
		await s.ready();
		// KD's own tables, and a value from each that is NOT what a default seat already has — or the
		// assertion "the declaration was applied" would be satisfied by doing nothing at all.
		const now = declaredIn('A');
		real = s.world.eval('({'
			+ ' classes: (typeof KDClassStart !== "undefined") ? Object.keys(KDClassStart) : [],'
			+ ' dresses: (typeof KDGetDressList === "function") ? Object.keys(KDGetDressList() || {}) : [] })');
		real.cls = (real.classes || []).find((c: string) => c !== now.cls);
		real.dress = (real.dresses || []).find((d: string) => d !== now.dress);
	}, BOOT_TIMEOUT);
	afterAll(() => { try { s && s.close && s.close(); } catch (e) { /* noop */ } });

	it('SELF-CHECK: the world really offers a class and an outfit other than the default', () => {
		// Without this the join-late below would declare `undefined`, apply nothing, and every
		// assertion after it would be comparing two defaults and passing.
		expect(real.classes.length, 'KDClassStart moved — applyCharacter must move with it')
			.toBeGreaterThan(1);
		expect(real.dresses.length, 'KDGetDressList moved — applyCharacter must move with it')
			.toBeGreaterThan(1);
		expect(real.cls).toBeTruthy();
		expect(real.dress).toBeTruthy();
	}, BOOT_TIMEOUT);

	it('R4 — the two undeclared seats are unchanged: KD\'s own default, and identical', () => {
		// The `#coop=<id>` road, which the whole MP e2e suite runs on. "Declared nothing" must have
		// exactly one answer and it must be KD's.
		expect(s.characterOf('A'), 'no declaration, no package').toBeNull();
		expect(declaredIn('A')).toEqual(declaredIn('B'));
	}, BOOT_TIMEOUT);

	it('R1/R5 — a declaring seat gets its own class and outfit, and nobody else moves', () => {
		const before = declaredIn('A');
		// Declared BEFORE the seat exists — `setCharacter` is order-independent by design, and this
		// is the order the bridge really uses (`_carrySeat` runs before the session seats anyone).
		s.setCharacter('C', { class: real.cls, outfit: real.dress, style: 'StyleC' });
		expect(s.joinInProgress('C')).toEqual({ seated: true, deferred: false });

		const c = declaredIn('C');
		// eslint-disable-next-line no-console
		console.log('\nKDM-256 — C declared ' + JSON.stringify({ cls: real.cls, dress: real.dress })
			+ '\n           C seated as ' + JSON.stringify(c)
			+ '\n           A (undeclared) ' + JSON.stringify(declaredIn('A')) + '\n');
		expect(c.cls, 'C chose this class').toBe(real.cls);
		expect(c.dress, 'C chose this outfit').toBe(real.dress);
		// THE CONTROL, and the one that matters most: `applyCharacter` writes into the world's ONE
		// shared player slot, so a call outside the restore→capture window would land on everybody.
		expect(declaredIn('A'), 'A declared nothing and must be exactly as before').toEqual(before);
	}, BOOT_TIMEOUT);

	it('R6 — a packaged seat is NOT a resumed run: it still gets perks and modes', () => {
		// The `imported` trap. If a package is ever routed through `_templateOf`, `_seatPlayer` skips
		// applyPerks/applyModes/setPlayerName for it — silently, while still looking seated.
		expect(s._templateOf.has('C'), 'a package is not a template').toBe(false);
		s.world.restorePlayer(s.bundles.get('C'));
		const perks = s.world.eval('(typeof KinkyDungeonStatsChoice !== "undefined")'
			+ ' ? Array.from(KinkyDungeonStatsChoice.keys()).length : -1');
		expect(perks, 'applyPerks/applyModes must still run for a packaged seat').toBeGreaterThan(0);
	}, BOOT_TIMEOUT);

	it('R2 — the peer\'s avatar carries the look its owner chose, on the wire', () => {
		// `style` and `outfit` are already in ENT_FIELDS, so they already cross. What this pins is
		// that they are driven by the PACKAGE rather than by `spawnAvatar`'s constant.
		const ents = ((s.snapshotFor('A') || {}).map || {}).Entities || [];
		const peer = ents.find((e: any) => e.id === s.avatars.get('C'));
		expect(peer, 'precondition: C\'s avatar must be in A\'s snapshot').toBeTruthy();
		// eslint-disable-next-line no-console
		console.log('\nKDM-256 peer avatar on the wire: ' + JSON.stringify(
			{ style: peer.style, outfit: peer.outfit, CustomName: peer.CustomName }) + '\n');
		expect(peer.style, 'C chose this look; A must be able to see it').toBe('StyleC');
		expect(peer.outfit).toBe(real.dress);
		// CONTROL: an UNDECLARED avatar keeps the constant, so one shared value cannot satisfy both.
		// B, not A: a player's own avatar is not in their own snapshot (they are the player there),
		// so `s.avatars.get('A')` finds nothing in A's frame and the control would be vacuous.
		const plain = ents.find((e: any) => e.id === s.avatars.get('B'));
		expect(plain, 'precondition: B is an undeclared avatar A can see').toBeTruthy();
		expect(plain.style, 'B declared nothing and keeps the default look').not.toBe(peer.style);
		expect(plain.outfit, 'and carries no outfit key at all').toBeUndefined();
	}, BOOT_TIMEOUT);
});


describe('KDM-256 — the gateway still owns no gameplay names', () => {
	it('this feature adds no outfit / style / class list to tools/mp-server', () => {
		// The same guard `mp-perk-choice.spec.ts` keeps over perk names, aimed at the three tables
		// this feature is closest to accidentally importing. `sanitizeCharacter` must stay
		// shape-only: KD's own tables decide what a value MEANS.
		const src = fs.readFileSync(
			path.resolve(__dirname, '../../tools/mp-server/join-gate.js'), 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');
		for (const table of ['KDModelStyles', 'KinkyDungeonOutfits', 'KinkyDungeonStatsPresets']) {
			expect(src, `${table} is KD's table — consult it in headless-host, never here`)
				.not.toContain(table);
		}
	});
});
