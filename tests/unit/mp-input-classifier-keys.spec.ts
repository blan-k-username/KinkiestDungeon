/**
 * The apply/commit input classifier must see every `KDInputTypes` handler, whatever key spelling upstream uses.
 *
 * MEASURED producer (2026-09-26 upstream merge): upstream added `setAutoSprint: (data) => {…}` —
 * the first UNQUOTED key in a registry that was otherwise all `"name": …`. The parser only matched
 * double-quoted keys, so the new type went unseeded and `mp-apply-commit`'s drift guard went red.
 *
 * Synthetic bundles keep this deterministic: no game boot, no dependence on what upstream ships today.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { classifyInputs } = require('../../tools/mp-server/input-classifier');

const bundle = (entries: string) => `let KDInputTypes = {\n${entries}\n};\n`;

describe('input-classifier handler keys', () => {
	it('parses double-quoted, single-quoted and unquoted keys alike', () => {
		const { kinds, report } = classifyInputs(bundle([
			'\t"dq": (data) => { return ""; },',
			'\t\'sq\': (data) => { return ""; },',
			'\tbare: (data) => { return ""; },',
		].join('\n')));
		expect(Object.keys(kinds).sort()).toEqual(['bare', 'dq', 'sq']);
		expect(report.handlers).toBe(3);
	});

	it('does not mistake an arrow-valued property INSIDE a handler body for a handler', () => {
		const { kinds, report } = classifyInputs(bundle([
			'\t"outer": (data) => {',
			'\t\tlet o = { inner: (x) => { return x; } };',
			'\t\treturn "";',
			'\t},',
			'\tnext: (data) => { return ""; },',
		].join('\n')));
		expect(Object.keys(kinds).sort()).toEqual(['next', 'outer']);
		expect(report.handlers).toBe(2);
	});
});
