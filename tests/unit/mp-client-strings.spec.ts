/**
 * KDM-281 — the drift guard for player-facing PROSE in the co-op client.
 *
 * ── THE HOLE THIS FILLS ───────────────────────────────────────────────────────────────────────────
 * `coop-lobby.js` resolved its labels through a private `text(key, fallback)` reading KD's own
 * `TextGet`; `coop-bootstrap.js` wrote plain English into the very same `lobby.status` /
 * `lobby.error` fields. So one screen was half translatable — the buttons could be localised and the
 * refusal painted between them could not. Nobody caused it: each task followed the file it was
 * editing, which is the right local call and the wrong global one.
 *
 * That is precisely the failure a convention cannot fix, and it is the same shape as the wire-field
 * drift `mp-outbound-fields.spec.ts` guards — a declaration in one place, call sites in another, and
 * nothing that fails when the two disagree. This file is that guard for strings.
 *
 * ── THE FOUR GUARDS, AND WHY FOUR ─────────────────────────────────────────────────────────────────
 * Each fails on a drift the others cannot see:
 *
 *   R0 LOAD ORDER  — `coop-text.js` is injected before both consumers. Both hold a HARD reference
 *                    (`window.KDMPText.t`), so a wrong order is not a missing translation, it is a
 *                    TypeError that takes the whole lobby with it. Nothing else here would notice.
 *   R1 THE TABLE   — one frozen key→English map, reachable by evaluating the real file.
 *   R2 KEYS        — every `T('…')` in either client file names a declared key, and every declared
 *                    key is used. A typo answers with the key itself, which is a developer
 *                    identifier on a player's screen; an unused key is a promise nobody keeps.
 *   R3 PROSE       — THE ONE THE ACCEPTANCE CRITERIA ASK FOR. A new hardcoded player-facing string
 *                    in either file is a red. This is what stops the next task doing what the last
 *                    six did.
 *
 * ── WHY R3 CAN EXIST AT ALL ───────────────────────────────────────────────────────────────────────
 * Only because the English moved OUT of the call sites. While the convention was
 * `text('KDMPBack', 'Back')`, every legitimate label was itself an inline prose literal, and no
 * scanner could tell one from `lobbySay({ error: 'Back' })`. With the source strings in one table,
 * "a prose literal in a client file" is unambiguous — which is why the refactor and the guard are
 * one task and not two.
 *
 * ── SCOPE: THE OVERLAY IS NOT LOBBY UI ────────────────────────────────────────────────────────────
 * `coop-bootstrap.js` also paints `#coop-overlay` through `setStatus` — a fixed monospace box in the
 * page corner carrying `Co-op A  turn 42` and the reconnect countdown. That is a diagnostic
 * affordance, not lobby UI, and it stays English by decision. So R3 scopes coop-bootstrap.js to the
 * `lobbySay(…)` calls — the ones whose text lands on the translatable screens — and scopes
 * coop-lobby.js to the WHOLE file, which is fully converted. `ALLOWED` below is the short, argued
 * list of non-prose literals; every entry is a claim that can be checked.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { resolve } from 'node:path';

const CLIENT = resolve(__dirname, '../../tools/mp-server/client');
const TEXT_SRC = resolve(CLIENT, 'coop-text.js');
const LOBBY_SRC = resolve(CLIENT, 'coop-lobby.js');
const BOOTSTRAP_SRC = resolve(CLIENT, 'coop-bootstrap.js');

const read = (f: string) => readFileSync(f, 'utf8');

/**
 * Source with comments removed, so PROSE IN A COMMENT can neither trip R3 nor excuse a real literal.
 *
 * Same helper as `mp-outbound-fields.spec.ts`, and it matters more here: these files are heavily
 * commented in English, and a naive scan would drown in it.
 */
function code(file: string): string {
	return read(file)
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

/** Evaluate the real `coop-text.js` the way a classic script sees the page, and take its export. */
function loadText(): any {
	const ctx: any = { window: {}, console: { warn() {}, log() {}, error() {} } };
	createContext(ctx);
	runInContext(read(TEXT_SRC), ctx, { filename: 'coop-text.js' });
	return ctx.window.KDMPText;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * R0 — load order
 * ═════════════════════════════════════════════════════════════════════════════════════════════════ */

describe('KDM-281 R0 — the table is injected before the files that need it', () => {
	it('coop-text.js precedes coop-bootstrap.js and coop-lobby.js in INJECT', () => {
		// The REAL array, exported for exactly this (same source `mp-mod-inject-order.spec.ts` reads).
		// A copy of the list here would be a second declaration free to go stale against the first.
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { INJECT } = require('../../tools/mp-server/demo-server');
		const at = (f: string) => INJECT.indexOf(`/tools/mp-server/client/${f}.js`);
		expect(at('coop-text'), 'coop-text.js is not injected at all').toBeGreaterThanOrEqual(0);
		expect(INJECT.filter((s: string) => s.endsWith('coop-text.js')).length,
			'injected twice would re-freeze a second table over the first').toBe(1);
		expect(at('coop-text'), 'coop-bootstrap.js consumes window.KDMPText and would throw')
			.toBeLessThan(at('coop-bootstrap'));
		expect(at('coop-text'), 'coop-lobby.js consumes window.KDMPText and would throw')
			.toBeLessThan(at('coop-lobby'));
	});

	it('and both consumers really do hold a hard reference — so the order above is load-bearing', () => {
		// The CONTROL for the assertion above: if either file quietly grew a local fallback, R0 would
		// still pass while guarding nothing, and the duplication this task removed would be back.
		for (const [name, src] of [['coop-lobby', code(LOBBY_SRC)], ['coop-bootstrap', code(BOOTSTRAP_SRC)]] as const) {
			expect(src, `${name}.js must take its text helper from the shared table`).toMatch(/KDMPText/);
			expect(src, `${name}.js must not define a local text() helper again`)
				.not.toMatch(/function\s+(text|kdText)\s*\(/);
		}
	});
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * R1 — the table itself
 * ═════════════════════════════════════════════════════════════════════════════════════════════════ */

describe('KDM-281 R1 — one frozen table of English source strings', () => {
	it('evaluates to a frozen key→string map on window.KDMPText', () => {
		const T = loadText();
		expect(T, 'coop-text.js must publish window.KDMPText').toBeTruthy();
		expect(typeof T.t).toBe('function');
		expect(Object.isFrozen(T.STRINGS)).toBe(true);
		const keys = Object.keys(T.STRINGS);
		expect(keys.length, 'an empty table would make every guard below vacuous').toBeGreaterThan(30);
		for (const k of keys) {
			expect(k, `${k} must be a KDMP* key`).toMatch(/^KDMP[A-Za-z0-9]+$/);
			expect(typeof T.STRINGS[k], `${k} must map to a string`).toBe('string');
			expect(T.STRINGS[k].length, `${k} is empty — a key with no source string says nothing`).toBeGreaterThan(0);
		}
	});

	it('KD wins when it has a word, and our English is the fallback — never the raw key', () => {
		const T = loadText();
		// Without a TextGet in scope at all: the English source.
		expect(T.t('KDMPBack')).toBe('Back');
		// KD answers a key it does not have with `[NotFound] <key>`, which must NOT reach a player —
		// the trap that once painted "[NotFound] KDMPYourName" across the whole lobby.
		const ctx: any = { window: {}, TextGet: (k: string) => `[NotFound] ${k}` };
		createContext(ctx);
		runInContext(read(TEXT_SRC), ctx, { filename: 'coop-text.js' });
		expect(ctx.window.KDMPText.t('KDMPBack')).toBe('Back');
		// …and when KD DOES know the key, KD wins. Without this the fallback and the lookup are the
		// same green, and "translatable" would be an untested word.
		const ctx2: any = { window: {}, TextGet: (k: string) => (k === 'KDMPBack' ? 'Zurück' : `[NotFound] ${k}`) };
		createContext(ctx2);
		runInContext(read(TEXT_SRC), ctx2, { filename: 'coop-text.js' });
		expect(ctx2.window.KDMPText.t('KDMPBack')).toBe('Zurück');
	});

	it('templating substitutes by name, and does not interpret the value', () => {
		const T = loadText();
		expect(T.t('KDMPWorldSeed', { SEED: 'abc' })).toBe('• seed: abc');
		expect(T.t('KDMPRefusedBuild', { HOSTBUILD: '1.2.3', GUESTBUILD: '1.2.4' }))
			.toBe('Different game versions — host has 1.2.3, you have 1.2.4.');
		// `$&` is `String.replace`'s "the whole match". A mod name or a player name containing one
		// would otherwise be rewritten on its way to the screen — which is why `fill` uses split/join.
		expect(T.t('KDMPModDegraded', { MODS: 'a$&b' })).toContain('a$&b');
		// An unfilled token stays visible rather than vanishing: a caller that forgot a parameter
		// shows `WHERE`, which names its own bug. A silent gap would read as a finished sentence.
		expect(T.t('KDMPCouldNotReach')).toContain('WHERE');
	});

	it('every TOKEN in the table is filled, and every fill names a token that exists', () => {
		// Pins the two halves of the templating contract together. A token nobody fills paints an
		// UPPERCASE word at a player (`Could not reach WHERE`); a `{ FOO: … }` at a call site whose
		// string has no `FOO` is a substitution that silently does nothing.
		//
		// TWO TIERS, because one key is filled indirectly. `drawModDiff(y, 'KDMPModsToSend')` takes
		// the KEY and fills COUNT where the number is known, which is the right shape — the
		// alternative is a caller resolving half a sentence and a second templating road. So a key
		// named directly at a `T('KEY', {…})` site gets the exact per-key check; one that travels
		// through a variable gets the token-level one, and is listed here by name so the weaker tier
		// cannot silently grow.
		const INDIRECT = new Set(['KDMPModsToSend', 'KDMPModsToGet']);
		const T = loadText();
		const src = code(LOBBY_SRC) + '\n' + code(BOOTSTRAP_SRC);
		const TOKEN = /\b([A-Z]{4,})\b/g;

		const tokensOf = (s: string) => [...new Set(s.match(TOKEN) || [])];
		const declaredTokens = new Set<string>();
		for (const key of Object.keys(T.STRINGS)) {
			for (const tok of tokensOf(T.STRINGS[key])) {
				declaredTokens.add(tok);
				if (INDIRECT.has(key)) {
					// The key really is passed by name to something that fills it.
					expect(src, `${key} is listed as indirect but is not passed as a bare key`)
						.toMatch(new RegExp(`\\(\\s*[^)]*'${key}'\\s*\\)`));
					expect(src, `nothing anywhere fills the token ${tok}`).toMatch(new RegExp(`\\b${tok}\\s*:`));
					continue;
				}
				const filled = new RegExp(`T\\(\\s*'${key}'\\s*,[\\s\\S]{0,200}?\\b${tok}\\s*:`);
				expect(filled.test(src), `${key} contains the token ${tok} and no call site fills it`).toBe(true);
			}
		}
		expect(declaredTokens.size, 'no tokens at all would make this vacuous').toBeGreaterThan(4);

		// The other direction: a fill whose token no string contains.
		const filledTokens = [...new Set(
			[...src.matchAll(/T\(\s*[^)]*?\{([^}]*)\}/g)]
				.flatMap((m) => [...m[1].matchAll(/\b([A-Z]{4,})\s*:/g)].map((x) => x[1])),
		)];
		expect(filledTokens.length, 'no fills found — this half of the check has stopped watching')
			.toBeGreaterThan(3);
		expect(filledTokens.filter((tok) => !declaredTokens.has(tok)),
			'a call site fills this token and no string in coop-text.js contains it — the substitution '
			+ 'does nothing, silently.').toEqual([]);
	});
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * R2 — the keys the client actually asks for
 * ═════════════════════════════════════════════════════════════════════════════════════════════════ */

/** Every `KDMP…` key named anywhere in the two client files (call sites and key tables alike). */
function keysUsed(): Set<string> {
	const src = code(LOBBY_SRC) + '\n' + code(BOOTSTRAP_SRC);
	const out = new Set<string>();
	// Quoted, so a DOM id or a button name (`DrawButtonKDEx('KDMPBack', …)`) is indistinguishable
	// from a text key here — which is fine in this direction: R2 only asks that a key we ASK FOR is
	// declared, and it treats the union as the used-set for the unused check below. The button names
	// really are the same words on purpose (`KDMPBack` labels the `KDMPBack` button).
	for (const m of src.matchAll(/'(KDMP[A-Za-z0-9]+)'/g)) out.add(m[1]);
	return out;
}

describe('KDM-281 R2 — asked-for keys and declared keys are the same set', () => {
	it('SELF-CHECK: the reader finds the keys we know are there', () => {
		const used = keysUsed();
		expect(used.size, 'a reader finding nothing would make the guard vacuous').toBeGreaterThan(30);
		expect(used.has('KDMPBack'), 'a lobby button label').toBe(true);
		expect(used.has('KDMPRefusedDeclined'), 'a bootstrap refusal — the strings this task moved').toBe(true);
		expect(used.has('KDMPModeProgKey'), 'a MODE_LABEL fallback, which is a key and not prose now').toBe(true);
	});

	it('DRIFT GUARD — every key the client asks for is declared', () => {
		const T = loadText();
		// Only the keys reached through `T(…)`: a `DrawButtonKDEx` name is an id, not a text key.
		const src = code(LOBBY_SRC) + '\n' + code(BOOTSTRAP_SRC);
		const asked = [...new Set([...src.matchAll(/\bT\(\s*'(KDMP[A-Za-z0-9]+)'/g)].map((m) => m[1]))];
		expect(asked.length, 'no T() call sites found — the reader has stopped watching').toBeGreaterThan(25);
		const undeclared = asked.filter((k) => !Object.prototype.hasOwnProperty.call(T.STRINGS, k));
		expect(undeclared,
			'the client asks for this key and coop-text.js does not declare it. `t()` answers with the '
			+ 'key itself, so this is a developer identifier painted at a player.').toEqual([]);
	});

	it('DRIFT GUARD — and every declared key is asked for', () => {
		const T = loadText();
		const used = keysUsed();
		const orphans = Object.keys(T.STRINGS).filter((k) => !used.has(k));
		expect(orphans,
			'declared in coop-text.js and asked for by nobody. Either a call site was deleted and the '
			+ 'string left behind, or the key is misspelled at the one place that wants it — and an '
			+ 'unreachable declaration guards nothing (mp-outbound-fields.spec.ts R2, same reasoning).')
			.toEqual([]);
	});
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * R3 — no hardcoded player-facing prose
 * ═════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Literals that look like a sentence rather than an identifier.
 *
 * Deliberately generous about what counts as prose — two or more space-separated words containing a
 * lowercase run of ≥2 letters — because the cost of a false positive is one line in `ALLOWED` with a
 * reason, and the cost of a false negative is the bug this whole file exists to prevent.
 */
function proseLiterals(src: string): string[] {
	const out: string[] = [];
	for (const m of src.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)) {
		const s = (m[1] !== undefined ? m[1] : m[2]) as string;
		const words = s.trim().split(/\s+/).filter((w) => /[a-z]{2}/.test(w));
		if (words.length >= 2) out.push(s);
	}
	return [...new Set(out)];
}

/**
 * Non-prose literals that the scanner cannot tell from prose. Every entry is an argument.
 *
 * Kept as an exact-match list rather than a pattern: a pattern would silently widen as the files
 * grow, which is how an allowlist stops being one.
 */
const ALLOWED = new Set<string>([
	'use strict',                    // the directive
	'[object Array]',                // an `Object.prototype.toString` tag
	'[coop lobby]',                  // a console prefix — developer output, never painted
	'[coop]',                        // the same, in the bootstrap
	'[NotFound] ',                   // KD's own missing-key marker, matched against
]);

describe('KDM-281 R3 — a new hardcoded player-facing string is a red', () => {
	it('SELF-CHECK: the scanner recognises prose, and does not flag an identifier', () => {
		// The guard is a heuristic, so what it can and cannot see is itself asserted. Without this a
		// scanner that had quietly stopped matching would read as "no hardcoded strings".
		expect(proseLiterals(`x = 'The host declined your request.'`)).toEqual(['The host declined your request.']);
		expect(proseLiterals(`x = 'That game is full.'`)).toEqual(['That game is full.']);
		expect(proseLiterals(`x = 'KDMPBack'`)).toEqual([]);
		expect(proseLiterals(`x = '#ffffff'`)).toEqual([]);
		expect(proseLiterals(`x = 'join_answer'`)).toEqual([]);
	});

	it('coop-lobby.js paints nothing it did not take from the table', () => {
		// The WHOLE file: it is fully converted, so there is no region to carve out.
		const found = proseLiterals(code(LOBBY_SRC)).filter((s) => !ALLOWED.has(s));
		expect(found,
			'a player-facing string is written inline in coop-lobby.js. Move it to STRINGS in '
			+ 'client/coop-text.js and call T(\'KDMPYourKey\') — otherwise this screen goes back to '
			+ 'being half translatable (KDM-281).').toEqual([]);
	});

	it('coop-bootstrap.js says nothing to the LOBBY that it did not take from the table', () => {
		// Scoped to `lobbySay(…)`: the `#coop-overlay` debug box is out of scope by decision, and
		// scanning the whole file would make its ~20 diagnostic lines permanent allowlist entries,
		// which is an allowlist long enough to hide a real one.
		const src = code(BOOTSTRAP_SRC);
		const calls = lobbySayCalls(src);
		expect(calls.length, 'no lobbySay() calls found — the reader has stopped watching').toBeGreaterThan(6);
		const found = [...new Set(calls.flatMap(proseLiterals))].filter((s) => !ALLOWED.has(s));
		expect(found,
			'coop-bootstrap.js puts this English straight into a lobby field. That is the exact drift '
			+ 'KDM-281 removed: the lobby screen resolves its own labels through the table, so a '
			+ 'sentence painted between them must too.').toEqual([]);
	});

	it('SELF-CHECK: the lobbySay reader really covers the calls we know carry text', () => {
		const calls = lobbySayCalls(code(BOOTSTRAP_SRC));
		const blob = calls.join(' │ ');
		// One from each of the three regions — the connect deadline, the gate, and the refusal ladder
		// — so a reader that only sees the first is caught.
		expect(blob, 'the connect-timeout message').toContain('KDMPNoAnswer');
		expect(blob, 'the approval wait').toContain('KDMPWaitingApproval');
		expect(blob, 'the refusal, which arrives through the `why` variable').toContain('why');
	});
});

/**
 * The text of every `lobbySay( … )` call, brace/quote-aware so nested objects come along.
 *
 * The refusal ladder assigns to `why` and then passes the variable, so the ladder is picked up too:
 * it sits inside the same `if (m.type === 'reject')` block, and the block is included from the
 * `var why` up to its `lobbySay`. Without that, moving a sentence one line up would evade the guard.
 */
function lobbySayCalls(src: string): string[] {
	const out: string[] = [];
	for (const m of src.matchAll(/\blobbySay\s*\(/g)) {
		let i = (m.index as number) + m[0].length;
		let depth = 1, quote = '';
		const start = i;
		for (; i < src.length && depth > 0; i++) {
			const c = src[i];
			if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
			if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
			if (c === '(') depth++;
			else if (c === ')') depth--;
		}
		let call = src.slice(start, i - 1);
		// If the call passes a bare identifier, pull in the statement that assigned it — the sentence
		// is there, not here.
		for (const id of call.matchAll(/(^|[^.\w'"])([a-z][A-Za-z0-9_]*)\s*(?:,|\}|$)/g)) {
			const decl = new RegExp(`\\bvar\\s+${id[2]}\\s*=([\\s\\S]*?);`).exec(src);
			if (decl) call += '\n' + decl[1];
		}
		out.push(call);
	}
	return out;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * KDM-289 — THE SEEDED TRANSLATIONS
 *
 * KDM-281 left the co-op client shipping English and nothing else. It is not what that task broke —
 * the lobby's `KDMP*` keys never had a translation — but it is what that task made fixable, by
 * putting every string in one table behind one helper. This block is the guard for the six language
 * tables that fill it.
 *
 * ── WHY THE SEEDS LIVE IN coop-text.js AND NOT IN KD ──────────────────────────────────────────────
 * The repo's i18n convention is `TextProvider.instance.getTranslationService('default')
 * .appendTranslation(lang, …)`. That is the MOD convention, and it does in fact work for keys nobody
 * registered (`Scripts/Text.ts:515` resolves `tagTranslationMap` BEFORE falling back to a source
 * string). It was rejected anyway: it would split the fallback chain across our `t()` and KD's
 * `getTextFromGroupStrict`, which is the exact two-owners shape KDM-281 spent a task removing, and it
 * would force this spec to build a fake `TextProvider` — a second implementation of the thing under
 * test, which is how a guard goes vacuous.
 *
 * So `coop-text.js` owns the tables and resolves them itself, reading KD's `TranslationLanguage`.
 *
 * ── WHAT THE UNIT LAYER CAN AND CANNOT PROVE ──────────────────────────────────────────────────────
 * Everything below stubs `TranslationLanguage` into a `node:vm` context. That is honest about the
 * DATA and about the RESOLUTION ORDER, and it is silent about the one real risk of the design: that
 * an injected `<script src>` can read a bundle `let` binding in a browser at all. Nothing here would
 * fail if it could not. `tests/e2e/mp-lobby-language.spec.ts` is that half, and neither file is
 * sufficient alone.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════ */

/** The six the repo supports. EN is not a member: it is the source, not a translation. */
const TARGETS = ['CN', 'DE', 'ES', 'JP', 'KR', 'RU'] as const;

/**
 * Evaluate `coop-text.js` with a chosen set of page globals.
 *
 * `loadText()` above is deliberately left alone — it is what the KDM-281 guards run on, and this
 * task must not change their subject. This is the same evaluation with the globals the new branch
 * reads. Omitting `TranslationLanguage` from `extra` is meaningful: the binding is then genuinely
 * ABSENT, and a bare read of it throws — which is the case the resolver's `try` exists for.
 */
function loadTextWith(extra: Record<string, any> = {}): any {
	const ctx: any = { window: {}, console: { warn() {}, log() {}, error() {} }, ...extra };
	createContext(ctx);
	runInContext(read(TEXT_SRC), ctx, { filename: 'coop-text.js' });
	return ctx.window.KDMPText;
}

/** The same token reader the KDM-281 templating guard uses. A token is what `fill()` substitutes. */
const TOKENS = (s: string) => [...new Set(s.match(/\b([A-Z]{4,})\b/g) || [])].sort();

/**
 * Keys a language is ALLOWED not to cover, per AC3: "every key is covered for every target, OR the
 * gap is declared". Empty, and it should stay empty — an entry here is a screen that paints two
 * languages at once, which is the failure the acceptance criterion names.
 *
 * A stale entry is itself a red (see the test): declaring a gap that is not there would let a real
 * gap open later under cover of an out-of-date exemption.
 */
const DECLARED_GAPS: Record<string, string[]> = {};

/**
 * Seeds that are legitimately WORD-FOR-WORD the English.
 *
 * Without this list, "identical to English" is the only way to catch the failure that passes every
 * other check here: a table of copied English covers every key, keeps every token, and paints
 * English at a player who asked for Russian. With it, each such string is a claim someone made on
 * purpose — a loanword that really is the word used in that language.
 */
const SAME_AS_ENGLISH: Record<string, string[]> = {
	DE: ['KDMPPerksBtn'],
	ES: [],
	CN: [],
	JP: [],
	KR: [],
	RU: [],
};

describe('KDM-289 L1 — the six language tables exist and are named the way KD names them', () => {
	it('LANGS declares exactly the six targets', () => {
		const T = loadTextWith();
		expect(T.LANGS, 'coop-text.js must export the language tables').toBeTruthy();
		expect(Object.keys(T.LANGS).sort(), 'a code we do not ship, or one we forgot')
			.toEqual([...TARGETS].sort());
		expect(Object.isFrozen(T.LANGS), 'the English table is frozen; these must be too').toBe(true);
		for (const lang of TARGETS) {
			expect(Object.isFrozen(T.LANGS[lang]), `${lang} must be frozen`).toBe(true);
		}
	});

	it('and every code is one KD can actually produce — read from KD\'s own declaration', () => {
		// The REAL list, not a copy. A table keyed `JA` instead of `JP` is data that can never be
		// reached: `activeLanguage()` would answer '' forever and every assertion about resolution
		// below would still pass, because they set the language themselves.
		const textTs = readFileSync(resolve(__dirname, '../../Scripts/Text.ts'), 'utf8');
		const m = /const\s+AvaliableLanguages\s*=\s*\[([^\]]*)\]/.exec(textTs);
		expect(m, 'AvaliableLanguages has moved or been renamed in Scripts/Text.ts').toBeTruthy();
		const available = (m as RegExpExecArray)[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
		expect(available, 'the reader found nothing usable').toContain('EN');
		for (const lang of TARGETS) {
			expect(available, `${lang} is not a language KD knows about`).toContain(lang);
		}
	});
});

describe('KDM-289 L2 — coverage: a partial table fails a test rather than painting a mixed screen', () => {
	it('every target covers every English key, and declares nothing it does not have', () => {
		const T = loadTextWith();
		const english = Object.keys(T.STRINGS);
		for (const lang of TARGETS) {
			const gaps = DECLARED_GAPS[lang] || [];
			const have = Object.keys(T.LANGS[lang]);
			const missing = english.filter((k) => !Object.prototype.hasOwnProperty.call(T.LANGS[lang], k));
			expect(missing.filter((k) => !gaps.includes(k)),
				`${lang} is missing these keys and has not declared them. Half a screen in one language `
				+ 'and half in another is the failure AC3 names.').toEqual([]);
			// The other direction: a key that no longer exists in English is dead weight that reads
			// as coverage.
			expect(have.filter((k) => !Object.prototype.hasOwnProperty.call(T.STRINGS, k)),
				`${lang} translates a key the English table no longer declares`).toEqual([]);
		}
	});

	it('SELF-CHECK: a declared gap must actually be a gap, and must name a real key', () => {
		// A stale exemption is worse than none: it silently licenses a future gap on that key.
		const T = loadTextWith();
		for (const lang of Object.keys(DECLARED_GAPS)) {
			expect(TARGETS as readonly string[], `${lang} is not a target`).toContain(lang);
			for (const k of DECLARED_GAPS[lang]) {
				expect(Object.prototype.hasOwnProperty.call(T.STRINGS, k),
					`${lang} declares a gap on ${k}, which is not an English key at all`).toBe(true);
				expect(Object.prototype.hasOwnProperty.call(T.LANGS[lang], k),
					`${lang} declares a gap on ${k} and then translates it — delete the declaration`).toBe(false);
			}
		}
	});

	it('every seed is a non-empty string, and is not just the English copied across', () => {
		const T = loadTextWith();
		for (const lang of TARGETS) {
			const allowed = SAME_AS_ENGLISH[lang] || [];
			const copied: string[] = [];
			for (const k of Object.keys(T.LANGS[lang])) {
				const v = T.LANGS[lang][k];
				expect(typeof v, `${lang}.${k} must be a string`).toBe('string');
				expect(v.trim().length, `${lang}.${k} is empty — a key with no seed says nothing`).toBeGreaterThan(0);
				if (v === T.STRINGS[k] && !allowed.includes(k)) copied.push(k);
			}
			expect(copied,
				`${lang} repeats the English verbatim for these keys. That passes coverage and token `
				+ 'parity and still paints English at a player who asked for something else — add the key '
				+ 'to SAME_AS_ENGLISH only if the English word really is the word used in that language.')
				.toEqual([]);
			// …and the control for the exemption list itself: an entry that is NOT identical is stale.
			expect(allowed.filter((k) => T.LANGS[lang][k] !== T.STRINGS[k]),
				`${lang} lists these in SAME_AS_ENGLISH and they differ from the English — stale entry`)
				.toEqual([]);
		}
	});
});

describe('KDM-289 L3 — token parity: a seed that drops a token deletes a value from a sentence', () => {
	it('every seed carries exactly the tokens its English source carries', () => {
		const T = loadTextWith();
		let checked = 0;
		for (const lang of TARGETS) {
			for (const k of Object.keys(T.LANGS[lang])) {
				const want = TOKENS(T.STRINGS[k]);
				if (!want.length) continue;
				checked++;
				expect(TOKENS(T.LANGS[lang][k]),
					`${lang}.${k} — tokens are substituted by NAME, so a translation may reorder them `
					+ 'freely and may not drop one. A missing token silently deletes the seed, the name '
					+ 'or the build number from the sentence, and the result still reads as finished.')
					.toEqual(want);
			}
		}
		// Asserted OUTSIDE the loop: a bound that never ran reads exactly like a bound that passed.
		expect(checked, 'no tokenised keys were compared — this guard has stopped watching')
			.toBeGreaterThan(6 * 5);
	});
});

describe('KDM-289 L4 — resolution: the active language wins, and English is still the floor', () => {
	it('t() answers in the active language, for every target', () => {
		for (const lang of TARGETS) {
			const T = loadTextWith({ TranslationLanguage: lang });
			expect(T.t('KDMPBack'), `${lang} did not resolve`).toBe(T.LANGS[lang].KDMPBack);
			expect(T.activeLanguage(), `${lang} is not the active language`).toBe(lang);
		}
	});

	it('and falls back to English for English, for unset, for an unknown code, and for no KD at all', () => {
		// Four different ways of "not a target", all of which a real page produces:
		//   'EN' — the initial value of TranslationLanguage (out/main.js:1274)
		//   ''   — what KD's own settings picker writes for English (KDLanguages[0], :12910)
		//   'XX' — a language KD grows and we have no seeds for
		//   absent — the script running on a page with no KD bundle, where a bare read THROWS
		for (const lang of ['EN', '', 'XX', 'en-GB']) {
			const T = loadTextWith({ TranslationLanguage: lang });
			expect(T.activeLanguage(), `${JSON.stringify(lang)} must not select a table`).toBe('');
			expect(T.t('KDMPBack'), `${JSON.stringify(lang)} must answer English`).toBe('Back');
		}
		const bare = loadTextWith();   // TranslationLanguage genuinely undeclared
		expect(bare.activeLanguage(), 'an absent bundle must degrade, not throw').toBe('');
		expect(bare.t('KDMPBack')).toBe('Back');
	});

	it('a lower-case code still selects its table — KD does not promise a case', () => {
		// GetUserPreferredLanguage (Scripts/Translation.ts:22-37) works from raw Intl locale segments.
		// Its current list makes a lower-case hit unlikely, but normalising costs one call and the
		// alternative failure is silent English for a player who chose otherwise.
		const T = loadTextWith({ TranslationLanguage: 'ru' });
		expect(T.activeLanguage()).toBe('RU');
	});

	it('KD\'s own word still beats the seed — and a [NotFound] does NOT skip past it', () => {
		// The precedence this task must not reorder. The second half is the interesting one: KD
		// answers a key it does not have with a MARKER, and `kdText` maps that to "no word". If that
		// mapping were read as "no translation either", every seed would be dead on a real page —
		// because KD does not know a single KDMP* key.
		const win = loadTextWith({ TranslationLanguage: 'RU', TextGet: (k: string) => (k === 'KDMPBack' ? 'НАЗАД-от-KD' : `[NotFound] ${k}`) });
		expect(win.t('KDMPBack'), 'a future KD that learns our keys wins').toBe('НАЗАД-от-KD');
		expect(win.t('KDMPCancel'), 'and a [NotFound] falls to the SEED, not past it to English')
			.toBe(win.LANGS.RU.KDMPCancel);

		const none = loadTextWith({ TranslationLanguage: 'RU', TextGet: () => 'MISSING' });
		expect(none.t('KDMPCancel'), 'KD\'s other missing-key marker, same treatment')
			.toBe(none.LANGS.RU.KDMPCancel);
	});

	it('an undeclared key still names itself, in every language', () => {
		// The KDM-281 behaviour the new branch must not swallow: a blank line on the Host screen is
		// the failure that looks like a layout bug, and `KDMPTypo` on screen names its own cause.
		for (const lang of TARGETS) {
			const T = loadTextWith({ TranslationLanguage: lang });
			expect(T.t('KDMPNotAKeyAtAll')).toBe('KDMPNotAKeyAtAll');
			expect(T.langText('KDMPNotAKeyAtAll'), 'and the seed lookup answers "no word"').toBe('');
		}
	});

	it('templating fills in every language and leaves no token behind', () => {
		// Ties L3's data check to behaviour: parity in the table is worth nothing if `fill` runs on
		// the English and the translated string is discarded, or vice versa.
		for (const lang of TARGETS) {
			const T = loadTextWith({ TranslationLanguage: lang });
			const out = T.t('KDMPRefusedBuild', { HOSTBUILD: '1.2.3', GUESTBUILD: '1.2.4' });
			expect(out, `${lang} lost the host build`).toContain('1.2.3');
			expect(out, `${lang} lost the guest build`).toContain('1.2.4');
			expect(out, `${lang} left a token unfilled`).not.toMatch(/\b[A-Z]{4,}\b/);
			expect(out, `${lang} answered in English`).not.toBe(T.STRINGS.KDMPRefusedBuild);
			// A value containing `$&` must survive — `fill` is split/join, not String.replace, and
			// that has to stay true on the translated string too.
			expect(T.t('KDMPModDegraded', { MODS: 'a$&b' })).toContain('a$&b');
		}
	});
});

describe('KDM-289 L5 — the seeds are marked machine-generated and unreviewed', () => {
	it('says so in the file, where a native reviewer will find it', () => {
		// AC5. In the source rather than in a task file or a commit message: the reviewer is a
		// translator reading coop-text.js, not someone with the git history open.
		const src = read(TEXT_SRC);
		expect(src, 'the seeds must be marked machine-generated').toMatch(/machine[- ]generated/i);
		expect(src, 'and marked as not yet reviewed by a native speaker').toMatch(/unreviewed|not (yet )?been reviewed|awaiting (a )?native/i);
	});
});
