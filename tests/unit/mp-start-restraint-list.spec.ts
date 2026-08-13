/**
 * Node-layer (Vitest) tests for KD_START_RESTRAINT accepting a LIST of items.
 *
 * UAT needs more than one seeded item at a time (e.g. extreme heels + metal ankle shackles, to
 * feel the slow level stack). The parser is shared shape-for-shape with the browser copy in
 * coop-bootstrap.js — keep the two in sync.
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { KDParseStartRestraints } = require('../../tools/mp-server/swap-session');

describe('KD_START_RESTRAINT parsing', () => {
	it('accepts a single name (the original behaviour)', () => {
		expect(KDParseStartRestraints('MasterworkHeels')).toEqual(['MasterworkHeels']);
	});

	it('accepts a comma-separated list', () => {
		expect(KDParseStartRestraints('MasterworkHeels,HighsecShackles'))
			.toEqual(['MasterworkHeels', 'HighsecShackles']);
	});

	it('tolerates spaces and stray separators', () => {
		expect(KDParseStartRestraints('  MasterworkHeels ,, HighsecShackles  '))
			.toEqual(['MasterworkHeels', 'HighsecShackles']);
		expect(KDParseStartRestraints('A B')).toEqual(['A', 'B']);
	});

	it('returns nothing for empty/undefined input', () => {
		expect(KDParseStartRestraints('')).toEqual([]);
		expect(KDParseStartRestraints(undefined)).toEqual([]);
		expect(KDParseStartRestraints('   ')).toEqual([]);
	});
});
