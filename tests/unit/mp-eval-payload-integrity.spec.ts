/**
 * KDM-218 — the mp-server eval payloads must stay syntactically whole.
 *
 * `headless-host.js` and `swap-session.js` build their in-vm payloads as TEMPLATE LITERALS. A backtick
 * anywhere inside one — including inside a `//` comment written for a human reader — terminates the
 * string early. Two things then go wrong at once:
 *
 *   1. the payload is silently truncated, and
 *   2. the resulting `SyntaxError` is raised not at the offending file but at whichever module
 *      `require`s it, so the message points at the wrong line entirely.
 *
 * This has bitten twice. The second time (KDM-184) a documentation comment added inside
 * `getVitals()`'s literal quoted `typeof` and `let` in backticks — the correct convention EVERYWHERE
 * ELSE in this codebase — and surfaced as
 * `SyntaxError: missing ) after argument list at swap-session.js:26:49`, i.e. at the `require` line of
 * a file that was not at fault. Both times the cost was a red that reads as a large regression plus a
 * hunt in the wrong file.
 *
 * Discipline did not hold (there is a hand-written "no backticks in this comment" warning in
 * `getVitals()` today), so this is the guard. It has two layers, and they catch different failures:
 *
 *   - LAYER 1 — every mp-server source PARSES. This is the actual invariant rather than a textual
 *     proxy for it: zero false positives, and it names the file that is really broken.
 *   - LAYER 2 — every `eval(`…`)` payload parses ON ITS OWN. A stray backtick can leave the enclosing
 *     file syntactically valid while the payload it built is a fragment; layer 1 cannot see that.
 *
 * What it must NOT flag: the ESCAPED backticks that legitimately appear inside a payload comment
 * (`headless-host.js:1740`), and the many backticks in the JSDoc blocks OUTSIDE the literals — those
 * are correct and must stay.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vm = require('vm');

const MP_DIR = path.resolve(__dirname, '../../tools/mp-server');

/** Every JS source of the MP layer, including `client/` and `transport/`. All of it is CommonJS. */
function mpSources(dir: string = MP_DIR): string[] {
	const out: string[] = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...mpSources(p));
		else if (e.name.endsWith('.js')) out.push(p);
	}
	return out.sort();
}

/** Does `src` parse as a script? Returns the error message, or null when it is fine. */
function parseError(src: string, filename = 'payload.js'): string | null {
	try {
		new vm.Script(src, { filename });
		return null;
	} catch (e: any) {
		return String((e && e.message) || e);
	}
}

interface Literal {
	/** Offset of the opening backtick. */
	start: number;
	/** Offset of the closing backtick. */
	end: number;
	/** `${…}` ranges inside it, as [openOffset, closeOffset] of `${` … `}`. */
	subs: Array<[number, number]>;
	/** True when the literal is the direct argument of an `eval(` call. */
	evalArg: boolean;
	line: number;
}

/** A `/` here starts a REGEX rather than a division. Standard last-significant-token heuristic. */
const REGEX_PRECEDERS = new Set('([{,;:=!&|?+-*%~^<>'.split(''));
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'instanceof', 'yield', 'await']);

/**
 * Find every template literal in `src`, tracking comments, strings and regex literals so that a
 * backtick inside any of them is not mistaken for a literal boundary — and `${…}` substitutions, whose
 * contents are CODE and may hold nested literals of their own.
 */
function templateLiterals(src: string): Literal[] {
	const found: Literal[] = [];
	// A frame is either code (possibly the inside of a `${…}`) or an open template literal.
	type Frame =
		| { kind: 'code'; depth: number; sub: null | { tpl: Frame & { kind: 'tpl' }; open: number } }
		| { kind: 'tpl'; start: number; subs: Array<[number, number]>; evalArg: boolean };
	const stack: Frame[] = [{ kind: 'code', depth: 0, sub: null }];

	let prevSig = '';   // last significant character of code
	let prevWord = '';  // last identifier read in code
	let i = 0;

	const lineOf = (off: number) => src.slice(0, off).split('\n').length;

	while (i < src.length) {
		const top = stack[stack.length - 1];
		const c = src[i];

		if (top.kind === 'tpl') {
			if (c === '\\') { i += 2; continue; }
			if (c === '`') {
				stack.pop();
				found.push({ start: top.start, end: i, subs: top.subs, evalArg: top.evalArg, line: lineOf(top.start) });
				prevSig = '`'; prevWord = ''; i++; continue;
			}
			if (c === '$' && src[i + 1] === '{') {
				stack.push({ kind: 'code', depth: 0, sub: { tpl: top, open: i } });
				i += 2; prevSig = '{'; prevWord = ''; continue;
			}
			i++; continue;
		}

		// --- code state ---
		if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
		if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; continue; }
		if (c === "'" || c === '"') {
			i++;
			while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
			i++; prevSig = c; prevWord = ''; continue;
		}
		if (c === '/' && (prevSig === '' || REGEX_PRECEDERS.has(prevSig) || REGEX_KEYWORDS.has(prevWord))) {
			i++;
			let inClass = false;
			while (i < src.length) {
				const r = src[i];
				if (r === '\\') { i += 2; continue; }
				if (r === '[') inClass = true;
				else if (r === ']') inClass = false;
				else if (r === '/' && !inClass) break;
				else if (r === '\n') break; // unterminated — bail rather than run away
				i++;
			}
			i++;
			while (i < src.length && /[a-z]/.test(src[i])) i++; // flags
			prevSig = '/'; prevWord = ''; continue;
		}
		if (c === '`') {
			const before = src.slice(Math.max(0, i - 40), i);
			stack.push({ kind: 'tpl', start: i, subs: [], evalArg: /\beval\s*\(\s*$/.test(before) });
			i++; continue;
		}
		if (c === '{') { top.depth++; i++; prevSig = '{'; prevWord = ''; continue; }
		if (c === '}') {
			if (top.depth === 0 && top.sub) {
				top.sub.tpl.subs.push([top.sub.open, i]);
				stack.pop();
				i++; prevSig = '}'; prevWord = ''; continue;
			}
			top.depth = Math.max(0, top.depth - 1);
			i++; prevSig = '}'; prevWord = ''; continue;
		}
		if (/\s/.test(c)) { i++; continue; }
		if (/[A-Za-z_$]/.test(c)) {
			let j = i;
			while (j < src.length && /[\w$]/.test(src[j])) j++;
			prevWord = src.slice(i, j); prevSig = src[j - 1]; i = j; continue;
		}
		prevSig = c; prevWord = ''; i++;
	}
	return found;
}

/**
 * The code a payload literal actually builds: substitutions stand in as `(0)` (their runtime value is
 * irrelevant to whether the surrounding code is whole), and the two TEMPLATE-ONLY escapes are undone so
 * that a legitimately escaped backtick reads as the backtick it is. Every other escape is left alone —
 * `'\n'` inside the payload is a two-character escape belonging to the payload's own string, and
 * "cooking" it would corrupt code that is perfectly fine.
 */
function payloadSource(src: string, lit: Literal): string {
	let out = '';
	let cursor = lit.start + 1;
	for (const [open, close] of lit.subs) {
		out += src.slice(cursor, open);
		out += '(0)';
		cursor = close + 1;
	}
	out += src.slice(cursor, lit.end);
	return out.replace(/\\([`$])/g, '$1');
}

function evalPayloads(src: string): Literal[] {
	return templateLiterals(src).filter((l) => l.evalArg);
}

describe('KDM-218: mp-server eval payloads stay syntactically whole', () => {
	/**
	 * A guard that greps source is exactly the kind of check that quietly stops working when a regex or
	 * a path drifts, and a green that comes from matching nothing is worthless. So prove the detector
	 * still recognises the breakage it was written to catch, using the REAL KDM-184 mistake as the
	 * sample: a doc comment inside `getVitals()`'s literal that quotes identifiers in backticks.
	 */
	it('SELF-CHECK: the detector still flags the real KDM-184 breakage', () => {
		const good = [
			'class H {',
			'	getVitals() {',
			'		return this.eval(`(function(){ return {',
			'			// typeof on BOTH: these are bundle let-globals, not properties of globalThis, so a bare',
			'			// reference before init is a TDZ throw that would take the whole getVitals read down.',
			'			will: (typeof KinkyDungeonStatWill !== "undefined") ? KinkyDungeonStatWill : null,',
			'		}; })()`);',
			'	}',
			'}',
		].join('\n');
		// The one-character-class change that broke every MP spec: `let` quoted, as prose convention says.
		const broken = good.replace('bundle let-globals', 'bundle `let`-globals');

		// LAYER 1 sees it, and — the whole point — names THIS source, not the module that requires it.
		expect(parseError(good, 'headless-host.js'), 'the correct source must parse').toBeNull();
		expect(parseError(broken, 'headless-host.js'), 'a backtick in a payload comment must be caught').not.toBeNull();

		// …and on the correct source the extractor really does find the payload (not zero literals,
		// which would make the layer-2 sweep below vacuously green).
		const lits = evalPayloads(good);
		expect(lits, 'the eval payload must be extracted').toHaveLength(1);
		expect(parseError(payloadSource(good, lits[0])), 'the extracted payload must parse').toBeNull();

		// LAYER 2 catches the variant layer 1 cannot: a stray backtick that truncates the payload while
		// leaving the enclosing file valid. Here the literal ends at the comment's backtick and the rest
		// is concatenated back on, so the FILE is fine and only the payload is a fragment.
		const silent = 'h.eval(`(function(){ // uses `+`typeof` + `\n return 1; })()`);';
		expect(parseError(silent, 'headless-host.js'), 'this variant leaves the file parseable').toBeNull();
		const truncated = evalPayloads(silent);
		expect(truncated, 'the truncated payload is still extracted').toHaveLength(1);
		expect(parseError(payloadSource(silent, truncated[0])), 'a truncated payload must be caught').not.toBeNull();

		// And the escape that is LEGITIMATE inside a payload comment must stay green — flagging it would
		// forbid correct code, and a guard that cries wolf gets deleted.
		const escaped = 'h.eval(`(function(){ // COPY, never alias. \\`g\\` is the stored bundle.\n return 1; })()`);';
		const esc = evalPayloads(escaped);
		expect(esc, 'the escaped-backtick payload is one whole literal').toHaveLength(1);
		expect(parseError(payloadSource(escaped, esc[0])), 'an escaped backtick is correct code').toBeNull();
	});

	it('LAYER 1: every mp-server source parses', () => {
		const offenders: string[] = [];
		for (const file of mpSources()) {
			const err = parseError(fs.readFileSync(file, 'utf8'), file);
			if (err) offenders.push(`${path.relative(MP_DIR, file)}: ${err}`);
		}
		expect(offenders, 'a SyntaxError here is reported at the REQUIRING file — fix it at the source named above').toEqual([]);
	});

	it('LAYER 2: every eval() payload parses on its own', () => {
		const offenders: string[] = [];
		const skipped: string[] = [];
		let checked = 0;
		for (const file of mpSources()) {
			const src = fs.readFileSync(file, 'utf8');
			// Layer 1 owns a file that does not parse; do not double-report it here.
			if (parseError(src, file)) { skipped.push(path.relative(MP_DIR, file)); continue; }
			for (const lit of evalPayloads(src)) {
				checked++;
				const err = parseError(payloadSource(src, lit));
				if (err) offenders.push(`${path.relative(MP_DIR, file)}:${lit.line}: ${err}`);
			}
		}
		expect(offenders, 'a payload that does not parse was truncated — look for a backtick inside it').toEqual([]);
		// Guard the guard: if the extractor ever stops finding payloads, the sweep above is vacuous.
		// Only meaningful when layer 1 left nothing out — otherwise one broken file would raise a
		// second, misleading red on top of the real one.
		if (skipped.length === 0) expect(checked, 'the eval payloads must actually be found').toBeGreaterThan(50);
	});
});
