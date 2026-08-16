/**
 * tools/mp-server/input-classifier.js  (KDM-163)
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
 * The residual conservatism is repaired at runtime, not here: `SwapSession` demotes a seeded `turn` to
 * `ui` the first time a real application is observed not to advance (probe14 measured 12 of 25 known
 * UI inputs landing in that bucket).
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

/**
 * Classify every KDInputTypes handler in `bundleSource`.
 * @returns {{kinds: Object<string,'turn'|'ui'>, report: object}}
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

	const memo = new Map();
	function reaches(name, seen) {
		if (name === TARGET) return true;
		if (memo.has(name)) return memo.get(name);
		const body = fnBody.get(name);
		if (body === undefined) return true;            // unresolved ⇒ assume it might advance
		seen = seen || new Set();
		if (seen.has(name)) return false;               // cycle contributes nothing
		seen.add(name);
		const { resolved, unresolved } = calleesIn(body);
		let r = false;
		for (const u of unresolved) { if (!INERT.has(u)) { r = true; break; } }
		if (!r) for (const c of resolved) { if (reaches(c, seen)) { r = true; break; } }
		memo.set(name, r);
		return r;
	}

	const anchor = bundleSource.search(/KDInputTypes\s*=\s*\{/);
	const kinds = {};
	const report = { found: anchor >= 0, handlers: 0, ui: 0, turn: 0, functions: fnBody.size, target: TARGET };
	if (anchor < 0) return { kinds, report };

	const lit = blockAt(bundleSource, anchor);
	if (lit == null) return { kinds, report };

	const re = /"([A-Za-z0-9_]+)"\s*:\s*\([^)]*\)\s*=>\s*\{/g;
	let m;
	while ((m = re.exec(lit))) {
		const name = m[1];
		const body = blockAt(lit, m.index + m[0].length - 1);
		if (body == null) continue;
		report.handlers++;
		let turn = body.indexOf(TARGET) >= 0;
		if (!turn) {
			const { resolved, unresolved } = calleesIn(body);
			for (const u of unresolved) { if (!INERT.has(u)) { turn = true; break; } }
			if (!turn) for (const c of resolved) { if (reaches(c)) { turn = true; break; } }
		}
		kinds[name] = turn ? 'turn' : 'ui';
		if (turn) report.turn++; else report.ui++;
	}
	return { kinds, report };
}

module.exports = { classifyInputs, TARGET };
