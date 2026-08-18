/**
 * tools/mp-server/input-classifier.js  (KDM-163, KDM-197)
 *
 * Decide, WITHOUT running anything, which of KD's input types consume a shared turn.
 *
 * This is the pre-seed for `SwapSession.inputKind`. It exists because both dynamic approaches were
 * implemented and rejected by measurement (probes are in the KDM-162 task folder):
 *
 *  - probes/probe11 — apply speculatively with `KinkyDungeonAdvanceTime` blocked, then roll back if it
 *    turned out to be turn-consuming. `doattack` damages the TARGET (hp 1 → -0.575) before reaching
 *    AdvanceTime, and a player-only rollback does not undo it, so the lockstep replay applied the
 *    attack twice. A correct undo needs a whole-world rollback.
 *  - probes/probe12 — probe every type on a throwaway host with empty data. 54 of 56 turn-consuming
 *    inputs early-return or throw before reaching AdvanceTime, so they look like UI. Feeding realistic
 *    data means a per-type fixture table, i.e. the whitelist again.
 *
 * So: static reachability over the compiled bundle. `KDInputTypes[t]` is turn-consuming iff
 * `KinkyDungeonAdvanceTime` is reachable from its handler.
 *
 * SOUNDNESS DIRECTION IS THE WHOLE POINT. Over-approximating ("might advance" when it cannot) costs
 * one turn and nothing else. UNDER-approximating would apply a turn-consuming action outside lockstep.
 * So an unresolved callee counts as "might advance": a `ui` verdict means the entire resolved call
 * graph is clean AND nothing unresolved was called.
 *
 * KDM-197 — the verdict now ships with the STRENGTH of the evidence behind it, because the runtime
 * repair below is only legitimate against a guess:
 *
 *   proven-turn   a concrete call path to the target exists through RESOLVED functions only. The type
 *                 demonstrably can advance; an occurrence that did not is the game declining, not a
 *                 misclassification. Never demotable at runtime.
 *   assumed-turn  the verdict rests on an unresolved callee — the deliberate over-approximation.
 *                 probe14 measured 12 of 25 known-UI inputs landing here, so this is the bucket the
 *                 runtime exists to repair, and the only one it may demote.
 *   proven-ui     the entire resolved call graph is clean AND nothing unresolved was called.
 *
 * `SwapSession` then demotes an `assumed-turn` only after `uiDemotionEvidence` corroborating
 * non-advancing observations, and pins any type ever seen to advance. One observation decides nothing.
 *
 * ⚠️ TEXT-COUPLED to `out/main.js`, which the plugin rule allows only as a last resort and only with
 * loud drift reporting — hence `report()`: if the handler count or the target name stops matching, the
 * caller logs it and falls back to "everything is turn-consuming", which is the safe default.
 */
'use strict';

const TARGET = 'KinkyDungeonAdvanceTime';

/** Callee names that carry no risk of advancing a turn. */
const INERT = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
	'Math', 'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON', 'Map', 'Set', 'Symbol',
	'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'console', 'Error', 'Promise', 'RegExp', 'Date',
	'require', 'super', 'this', 'delete', 'new', 'void', 'await', 'yield']);

/** Body of the block whose opening `{` is at or after `from`. */
function blockAt(src, from) {
	const start = src.indexOf('{', from);
	if (start < 0) return null;
	let depth = 0;
	for (let i = start; i < src.length; i++) {
		const c = src[i];
		if (c === '{') depth++;
		else if (c === '}') { depth--; if (depth === 0) return src.slice(start + 1, i); }
	}
	return null;
}

const DEF_PATTERNS = [
	/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm,
	/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*function\s*\**\s*\(/gm,
	/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*=>\s*\{/gm,
	/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*async\s*\([^)]*\)\s*=>\s*\{/gm,
];

/** Kind + confidence for one analysed body (KDM-197). */
function verdict(may, proven) {
	if (proven) return { kind: 'turn', confidence: 'proven-turn' };
	if (may) return { kind: 'turn', confidence: 'assumed-turn' };
	return { kind: 'ui', confidence: 'proven-ui' };
}

/**
 * Classify every KDInputTypes handler in `bundleSource`.
 * @returns {{kinds: Object<string,'turn'|'ui'>,
 *            confidence: Object<string,'proven-turn'|'assumed-turn'|'proven-ui'>,
 *            report: object}}
 */
function classifyInputs(bundleSource) {
	const fnBody = new Map();
	for (const re of DEF_PATTERNS) {
		re.lastIndex = 0;
		let m;
		while ((m = re.exec(bundleSource))) {
			if (fnBody.has(m[1])) continue;
			const body = blockAt(bundleSource, m.index + m[0].length - 1);
			if (body != null) fnBody.set(m[1], body);
		}
	}

	// `[^.\w$]` guard keeps `x.foo(` out — a method call is not a bundle function reference.
	function calleesIn(body) {
		const resolved = new Set(); const unresolved = new Set();
		const re = /(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
		let m;
		while ((m = re.exec(body))) {
			const n = m[1];
			if (n === TARGET) { resolved.add(n); continue; }
			if (fnBody.has(n)) resolved.add(n); else unresolved.add(n);
		}
		return { resolved, unresolved };
	}

	/**
	 * Is TARGET reachable from `name`?
	 *
	 * `assumeUnresolved` picks the reading of a callee whose body this analysis cannot see:
	 *   true  — it MIGHT advance (the sound over-approximation; this produces the verdict)
	 *   false — only resolved callees count (an under-approximation, so a `true` answer is a PROOF
	 *           that a concrete call path to the target exists — KDM-197's `proven-turn`)
	 * One walk, two memo tables: the traversal is identical under both readings, so it must not be
	 * written twice — the two copies drifting apart is exactly how a "proof" stops being one.
	 */
	const memo = [new Map(), new Map()];
	function reaches(name, assumeUnresolved, seen) {
		if (name === TARGET) return true;
		const cache = memo[assumeUnresolved ? 1 : 0];
		if (cache.has(name)) return cache.get(name);
		const body = fnBody.get(name);
		if (body === undefined) return assumeUnresolved;   // no body: the reading decides
		seen = seen || new Set();
		if (seen.has(name)) return false;                  // cycle contributes nothing
		seen.add(name);
		const { resolved, unresolved } = calleesIn(body);
		let r = false;
		if (assumeUnresolved) { for (const u of unresolved) { if (!INERT.has(u)) { r = true; break; } } }
		if (!r) for (const c of resolved) { if (reaches(c, assumeUnresolved, seen)) { r = true; break; } }
		cache.set(name, r);
		return r;
	}

	/** The same two readings, for a body that is not a named function (an input handler). */
	function analyse(body) {
		if (body.indexOf(TARGET) >= 0) return { may: true, proven: true };
		const { resolved, unresolved } = calleesIn(body);
		let proven = false;
		for (const c of resolved) { if (reaches(c, false)) { proven = true; break; } }
		if (proven) return { may: true, proven: true };
		let may = false;
		for (const u of unresolved) { if (!INERT.has(u)) { may = true; break; } }
		if (!may) for (const c of resolved) { if (reaches(c, true)) { may = true; break; } }
		return { may, proven: false };
	}

	const anchor = bundleSource.search(/KDInputTypes\s*=\s*\{/);
	const kinds = {};
	const confidence = {};
	const report = {
		found: anchor >= 0, handlers: 0, ui: 0, turn: 0,
		provenTurn: 0, assumedTurn: 0, functions: fnBody.size, target: TARGET,
	};
	if (anchor < 0) return { kinds, confidence, report };

	const lit = blockAt(bundleSource, anchor);
	if (lit == null) return { kinds, confidence, report };

	const re = /"([A-Za-z0-9_]+)"\s*:\s*\([^)]*\)\s*=>\s*\{/g;
	let m;
	while ((m = re.exec(lit))) {
		const name = m[1];
		const body = blockAt(lit, m.index + m[0].length - 1);
		if (body == null) continue;
		report.handlers++;
		const { may, proven } = analyse(body);
		const v = verdict(may, proven);
		kinds[name] = v.kind;
		confidence[name] = v.confidence;
		if (v.kind === 'turn') {
			report.turn++;
			if (v.confidence === 'proven-turn') report.provenTurn++; else report.assumedTurn++;
		} else report.ui++;
	}
	return { kinds, confidence, report };
}

module.exports = { classifyInputs, TARGET };
