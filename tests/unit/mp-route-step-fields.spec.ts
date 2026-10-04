/**
 * Node-layer (Vitest) — co-op's click-to-move route step sends EVERY field KD's own fast-move step
 * sends (KDM-315).
 *
 * KD's `move` input handler writes the player's toggles from the input (`KinkyDungeonToggleAutoPass =
 * data.AutoPass`, …), so a field co-op leaves out does not fall back to a default — it becomes
 * `undefined` on the server. Missing `AutoPass` turned every route bump into a peaceful NPC into a
 * dialogue (behaviour pinned by `tests/e2e/mp-click-move-pass-npc.spec.ts`). This is the drift guard:
 * read both sources and compare the field NAMES, so a field upstream adds to its fast-move step later
 * fails here instead of in a UAT.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');

const KD_SRC = path.resolve(__dirname, '../../Game/src/base/KinkyDungeon.ts');
const BOOTSTRAP = path.resolve(__dirname, '../../tools/mp-server/client/coop-bootstrap.js');

/** Top-level keys of the object literal starting at `src[open]` (`{`), nested braces skipped. */
function topLevelKeys(src: string, open: number): string[] {
	let depth = 0; let body = '';
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === '{') { depth++; if (depth === 1) continue; }
		if (c === '}') { depth--; if (depth === 0) break; }
		body += depth === 1 ? c : (c === '\n' ? ' ' : '');
	}
	return [...body.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1]).sort();
}

describe("co-op's route step mirrors KD's fast-move step", () => {
	it('sends the same input fields', () => {
		const kd = fs.readFileSync(KD_SRC, 'utf8');
		// The fast-move step: the only `move` input built from the next tile of KinkyDungeonFastMovePath.
		const sites = [...kd.matchAll(/KDSendInput\("move",\s*\{dir:\s*\{x:\s*next\.x/g)];
		expect(sites.length, 'text-coupled: exactly one fast-move step in KinkyDungeon.ts').toBe(1);
		const kdKeys = topLevelKeys(kd, kd.indexOf('{', sites[0].index!));

		const co = fs.readFileSync(BOOTSTRAP, 'utf8');
		const fn = co.indexOf('function fastMoveStepData(');
		expect(fn, 'coop-bootstrap.js defines fastMoveStepData').toBeGreaterThan(0);
		const coKeys = topLevelKeys(co, co.indexOf('{', co.indexOf('return', fn)));

		expect(kdKeys, 'sanity: the parse found the known fields').toEqual(
			expect.arrayContaining(['AllowInteract', 'AutoPass', 'dir']));
		expect(coKeys).toEqual(kdKeys);
	});

	it('the route driver submits through fastMoveStepData, not a hand-built literal', () => {
		const co = fs.readFileSync(BOOTSTRAP, 'utf8');
		const body = co.slice(co.indexOf('function stepRoute('), co.indexOf('function fastMoveStepData('));
		expect(body).toMatch(/submit\(\{\s*kdType:\s*'move',\s*data:\s*fastMoveStepData\(/);
	});
});
