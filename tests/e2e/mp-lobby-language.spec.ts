/**
 * E2E (KDM-289) — the co-op lobby paints the player's language, in a real browser.
 *
 * ── THE ONE THING ONLY THIS FILE CAN PROVE ────────────────────────────────────────────────────────
 * `tests/unit/mp-client-strings.spec.ts` covers the six seed tables exhaustively — coverage, token
 * parity, resolution order, fallbacks — by evaluating `coop-text.js` in a `node:vm` and putting a
 * `TranslationLanguage` into the context. Every one of those assertions would still pass if the
 * design's central premise were false.
 *
 * That premise: the co-op client is NOT a mod. It is a `<script src>` the demo server injects
 * (`demo-server.js`, `INJECT`), so it never runs inside the bundle's scope the way an eval'd mod
 * does — and `TranslationLanguage` is a bundle `let` (`out/main.js:1274`), which is not a property of
 * `globalThis` and cannot be reached through one. It is reachable anyway, because top-level
 * `let`/`const`/`class` in a classic script land in the GLOBAL LEXICAL ENVIRONMENT, which every other
 * classic script in the realm shares. `coop-lobby.js:152` already relies on the same rule from the
 * other side (`KinkyDungeonState = 'Multiplayer'`), which is what made the design safe to choose.
 *
 * A vm cannot tell those two worlds apart. A browser can. That is this file.
 *
 * ── THE ORACLE IS THE PAINT, AND THE CONTROL IS THE SAME PAGE ─────────────────────────────────────
 * `paintedText` wraps `DrawTextKD` for a settled frame, so the assertion is on what actually reached
 * the screen rather than on a getter that reports what would. And both arms — English and Russian —
 * run on ONE page, differing in nothing but the value of `TranslationLanguage`, taken in both orders.
 * Two pages would have reintroduced every difference a fresh boot can carry, and "translated" would
 * have been indistinguishable from "painted something".
 *
 * The expected strings are read out of `window.KDMPText` rather than written here: a copy of a seed
 * in a spec is a second declaration, free to go stale against the first. What makes that non-vacuous
 * is the unit layer, which proves a seed is never merely the English copied across — so
 * "painted LANGS.RU.x and not STRINGS.x" is a real distinction and not a tautology.
 *
 * ⚠️ `isolatedPage`: this spec assigns to a bundle `let` global. On a shared page that is a leak
 * which shows up much later as a message-text-only failure in an unrelated spec.
 */
import { test, expect } from '../helpers/playwright-fixtures';
import { bootKD } from '../helpers/bundle';
import { injectLobby, paintedText } from '../helpers/mp-lobby';

/** The briefing screen: one title and six rules, all painted through `DrawTextKD` (coop-lobby.js:301). */
const ABOUT_KEYS = [
	'KDMPAboutTitle', 'KDMPAboutPerks', 'KDMPAboutHost', 'KDMPAboutDescend',
	'KDMPAboutTrade', 'KDMPAboutPvP', 'KDMPAboutRejoin',
];

/** Set the language the way KD's own `TextLoad` does — a bare assignment to the bundle binding. */
async function setLanguage(page: any, lang: string) {
	await page.evaluate((l: string) => {
		// @ts-ignore — bundle `let` global, in the shared global lexical scope.
		TranslationLanguage = l;
	}, lang);
}

/** What the client believes it should paint for `keys`, in English and in `lang`. */
async function expected(page: any, lang: string, keys: string[]) {
	return page.evaluate((a: any) => {
		const T = (window as any).KDMPText;
		return a.keys.map((k: string) => ({ key: k, en: T.STRINGS[k], tr: T.LANGS[a.lang][k] }));
	}, { lang, keys });
}

test.describe('KDM-289 — the lobby speaks the player\'s language', () => {
	test('the briefing paints Russian for a Russian player and English for an English one, on one page', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await injectLobby(page);
		await page.evaluate(() => {
			// @ts-ignore — bundle `let` global.
			KinkyDungeonState = 'Multiplayer';
			(window as any).KDMPLobby.view = 'about';
		});

		const ru = await expected(page, 'RU', ABOUT_KEYS);
		expect(ru.length, 'the briefing keys have been renamed').toBe(ABOUT_KEYS.length);
		for (const row of ru) {
			expect(row.tr, `${row.key} has no Russian seed — the unit spec should have caught this`).toBeTruthy();
			expect(row.tr, `${row.key} is the English verbatim, so this spec cannot tell the arms apart`)
				.not.toBe(row.en);
		}

		// Both orders. If only one were run, "the second paint differs from the first" could be an
		// artefact of the first frame rather than of the language.
		for (const order of [['EN', 'RU'], ['RU', 'EN']]) {
			for (const lang of order) {
				await setLanguage(page, lang);
				const seen = await paintedText(page);
				expect(seen.length, `nothing was painted at all (${lang})`).toBeGreaterThan(ABOUT_KEYS.length);
				for (const row of ru) {
					const want = lang === 'RU' ? row.tr : row.en;
					const not = lang === 'RU' ? row.en : row.tr;
					expect(seen, `${lang}: ${row.key} was not painted in the active language`).toContain(want);
					expect(seen, `${lang}: ${row.key} was painted in the OTHER language`).not.toContain(not);
				}
				// KD's missing-key marker must never reach the screen through this path.
				for (const line of seen) expect(line, `${lang}: a marker reached the screen`).not.toContain('[NotFound]');
			}
		}
	});

	test('the language is read at paint time, so a change mid-session takes effect', async ({ isolatedPage: page }) => {
		// `activeLanguage()` reads `TranslationLanguage` on every call rather than caching it at
		// injection. That is not decoration: the client scripts are injected during page load, and KD
		// resolves the stored language in `TextLoad` — a cached read could be taken before it.
		await bootKD(page);
		await setLanguage(page, 'ES');
		await injectLobby(page);
		await page.evaluate(() => {
			// @ts-ignore
			KinkyDungeonState = 'Multiplayer';
			(window as any).KDMPLobby.view = 'menu';
		});

		const [title] = await expected(page, 'ES', ['KDMPLobbyTitle']);
		expect(await paintedText(page), 'a language set BEFORE injection is honoured').toContain(title.tr);

		// …and one set AFTER, which is the half a cached read would break.
		const [ja] = await expected(page, 'JP', ['KDMPLobbyTitle']);
		await setLanguage(page, 'JP');
		const seen = await paintedText(page);
		expect(seen, 'a language changed after injection is honoured too').toContain(ja.tr);
		expect(seen, 'and the previous language is gone').not.toContain(title.tr);
	});

	test('an unsupported language falls back to English rather than painting nothing', async ({ isolatedPage: page }) => {
		// KD's own settings picker writes '' for English (out/main.js:12910). A blank screen or a
		// painted key would both be regressions of the behaviour that shipped before this task.
		await bootKD(page);
		await injectLobby(page);
		await page.evaluate(() => {
			// @ts-ignore
			KinkyDungeonState = 'Multiplayer';
			(window as any).KDMPLobby.view = 'about';
		});
		const [title] = await expected(page, 'RU', ['KDMPAboutTitle']);
		for (const lang of ['', 'EN', 'XX']) {
			await setLanguage(page, lang);
			const seen = await paintedText(page);
			expect(seen, `${JSON.stringify(lang)} must paint the English source`).toContain(title.en);
			expect(seen, `${JSON.stringify(lang)} must not select a table`).not.toContain(title.tr);
			for (const line of seen) expect(line).not.toContain('[NotFound]');
		}
	});
});
