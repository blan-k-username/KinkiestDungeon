/**
 * KDM-164 AC3 / epic invariant **I6** — the MP layer owns NO gameplay rules.
 *
 * The gateway's job is to route a player's real action into the game and route the result back. Every
 * time it grew a number of its own — a defeat threshold, a recovery fraction, a damage gauge, a
 * "subdued at half Will" line — that number was a game rule invented in the wrong place, and it drifted
 * from KD's behaviour. KDM-156 (a downed player pinned at 0 Will, healing silently wiped) was caused by
 * exactly one of them.
 *
 * This guard is deliberately NAME-BLIND: it scans for the SHAPE of a gameplay constant rather than for
 * the specific names KDM-164 deleted, so re-introducing the same mistake under a new name still fails.
 *
 * What it must NOT flag (and why these are not gameplay rules):
 *   - protocol / transport / diagnostics sizes: log caps, buffer limits, ports, timeouts;
 *   - representation details: the park tile, avatar def fields;
 *   - anything the GAME hands us — a value read from KD is by definition not ours.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');

const MP_DIR = path.resolve(__dirname, '../../tools/mp-server');

/** Source files of the MP layer (not tests, not the browser client's render plumbing). */
function mpSources(): string[] {
	return fs.readdirSync(MP_DIR)
		.filter((f: string) => f.endsWith('.js'))
		.map((f: string) => path.join(MP_DIR, f));
}

/** Strip comments and strings so prose about a deleted constant cannot trip the guard. */
function codeOnly(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/(^|[^:])\/\/.*$/gm, '$1 ')
		.replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
		.replace(/'(?:\\.|[^'\\])*'/g, "''")
		.replace(/"(?:\\.|[^"\\])*"/g, '""');
}

/**
 * Gameplay-rule shapes: a named constant whose name talks about a COMBAT/PROGRESSION concept, or a
 * bare numeric comparison against one of KD's own player stats. Both are "we decided the rule".
 */
const RULE_NAME = /\b(?:const|let|var|this)\s*\.?\s*([A-Za-z_$][\w$]*)\s*=\s*-?\d+(?:\.\d+)?\b/g;
const STAT_COMPARISON = /\b(?:will|hp|stamina|distraction|boundLevel)\s*(?:<=|>=|<|>)\s*-?\d+(?:\.\d+)?/i;

/**
 * Gameplay vocabulary, matched WHOLE-WORD against the parts of an identifier — not as a substring.
 * `WARMUP` (a benchmark iteration count) contains "arm" and is not a combat rule; matching substrings
 * makes the guard cry wolf, and a guard that cries wolf gets deleted.
 */
const GAMEPLAY_WORDS = new Set([
	'will', 'health', 'hp', 'stamina', 'damage', 'dmg', 'defeat', 'revive', 'subdued', 'subdue',
	'stun', 'bind', 'bondage', 'arm', 'armhp', 'threshold', 'fraction',
]);

/** Split `DEFEAT_WILL`, `_armHp`, `reviveFraction` into lowercase word parts. */
function identifierWords(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.split(/[^A-Za-z0-9]+|\s+/)
		.filter(Boolean)
		.map((w) => w.toLowerCase());
}

const namesARule = (name: string) => identifierWords(name).some((w) => GAMEPLAY_WORDS.has(w));

describe('I6: the MP layer contains no gameplay constants (KDM-164 AC3)', () => {
	/**
	 * The guard must be able to FAIL. A green that comes from matching nothing is worthless — and this
	 * one greps source, which is exactly the kind of check that quietly stops working when a regex or a
	 * path drifts. So prove the detector still recognises the rules it was written to catch, using the
	 * real deleted code as the sample.
	 */
	it('SELF-CHECK: the detector still catches a reintroduced rule', () => {
		const reintroduced = `
			const DEFEAT_WILL = 0.52;
			const REVIVE_WILL_FRACTION = 0.25;
			this._armHp = 100;
			if (v.will <= 0.5 * willMax) subdue();
			if (cur.will <= 0.52) markDefeated();
		`;
		const code = codeOnly(reintroduced);

		const flagged: string[] = [];
		let m: RegExpExecArray | null;
		RULE_NAME.lastIndex = 0;
		while ((m = RULE_NAME.exec(code)) !== null) if (namesARule(m[1])) flagged.push(m[1]);
		expect(flagged, 'named combat constants must be detected').toEqual(
			expect.arrayContaining(['DEFEAT_WILL', 'REVIVE_WILL_FRACTION', '_armHp']));

		expect(code, "a stat compared against a number we chose must be detectable").toMatch(STAT_COMPARISON);
		// …and the floor itself must NOT look like a rule, or the guard would forbid the correct code.
		expect(namesARule('maxLog'), 'a log cap is not a gameplay rule').toBe(false);
		expect(namesARule('WARMUP'), 'a benchmark warmup count is not a gameplay rule').toBe(false);
	});

	it('no named numeric constant describes a combat/progression rule', () => {
		const offenders: string[] = [];
		for (const file of mpSources()) {
			const code = codeOnly(fs.readFileSync(file, 'utf8'));
			let m: RegExpExecArray | null;
			RULE_NAME.lastIndex = 0;
			while ((m = RULE_NAME.exec(code)) !== null) {
				if (namesARule(m[1])) offenders.push(`${path.basename(file)}: ${m[0].trim()}`);
			}
		}
		expect(offenders, 'a gameplay threshold belongs to the GAME, not to the gateway').toEqual([]);
	});

	it("no bare numeric comparison against one of KD's player stats", () => {
		const offenders: string[] = [];
		for (const file of mpSources()) {
			const code = codeOnly(fs.readFileSync(file, 'utf8'));
			for (const line of code.split('\n')) {
				const hit = line.match(STAT_COMPARISON);
				// `<= 0` is KD's own floor, not a rule of ours — zero is where the game itself bottoms out.
				if (hit && !/(?:<=|<)\s*0(?:\.0+)?\s*$/.test(hit[0]) && !/[<>]=?\s*0(?:\.0+)?\b/.test(hit[0])) {
					offenders.push(`${path.basename(file)}: ${hit[0].trim()}`);
				}
			}
		}
		expect(offenders, 'comparing a player stat to a number we chose IS a gameplay rule').toEqual([]);
	});

	/** The specific rules KDM-164 removed — kept as a named regression on top of the shape guard. */
	it('the KDM-164 constants stay deleted', () => {
		const all = mpSources().map((f: string) => codeOnly(fs.readFileSync(f, 'utf8'))).join('\n');
		for (const name of ['DEFEAT_WILL', 'REVIVE_WILL_FRACTION', '_armHp', '_applyPvP']) {
			expect(all, `${name} was an invented rule — it must not come back`).not.toMatch(new RegExp(`\\b${name}\\b`));
		}
	});
});
