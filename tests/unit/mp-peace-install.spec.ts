/**
 * KDM-229 — `client/coop-peace.js` installs its context-menu wrap synchronously, with no timer.
 *
 * WHY A UNIT SPEC AND NOT JUST THE E2E. `mp-peace-menu.spec.ts:69` already asserts the wrap is
 * installed, but it lets a whole browser boot elapse first — a re-introduced `setInterval` would
 * still pass it. The rule this pins is not "the wrap ends up installed", it is "it is installed by
 * the time the script finishes evaluating, and nothing is left ticking". That is only observable
 * with the clock in the test's hands.
 *
 * The real file is loaded — no copy, no re-implementation. It is a classic (non-module) script that
 * reads bundle globals by bare name, which is exactly what a `vm` context models: bare identifiers
 * resolve to context properties, so a hand-built context IS the bundle's global scope as the script
 * sees it.
 *
 * WHY THE TIMER STUBS RECORD RATHER THAN THROW: a throw from inside the IIFE would surface as an
 * opaque "runInContext failed", and the interesting failure ("it armed a 100 ms poll") would be
 * buried. Recording keeps both verdicts — timers armed, and wrap installed — separately assertable.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { resolve } from 'node:path';

const SRC = resolve(__dirname, '../../tools/mp-server/client/coop-peace.js');

/** A stand-in for KD's own builder — the `_prev` a cooperative wrap must call first. */
function vanillaBuilder() {
	return {
		options: ['Wait', 'Inventory'],
		optionText: {} as Record<string, string>,
		optionImages: {} as Record<string, string>,
		optionActions: {} as Record<string, () => void>,
	};
}

/**
 * Evaluate the real script against a minimal fake bundle scope.
 * `coop` seeds `KDRenderClient.lastCoop`, the server state `decorate` reads.
 */
function loadCoopPeace(coop: any = null) {
	const armed: string[] = [];
	const win: any = { KDRenderClient: coop === null ? null : { lastCoop: coop } };
	const ctx: any = {
		window: win,
		KDGetContextActions: { Game: vanillaBuilder },
		// the context menu is aimed at the player's own tile — decorate's precondition
		KDPlayer: () => ({ x: 4, y: 7 }),
		KinkyDungeonTargetX: 4,
		KinkyDungeonTargetY: 7,
		KDContextMenu: true,
		setInterval: (_fn: any, ms: number) => { armed.push(`setInterval(${ms})`); return 0; },
		setTimeout: (_fn: any, ms: number) => { armed.push(`setTimeout(${ms})`); return 0; },
		clearInterval: () => {},
		clearTimeout: () => {},
	};
	createContext(ctx);
	runInContext(readFileSync(SRC, 'utf8'), ctx, { filename: 'coop-peace.js' });
	return { ctx, win, armed };
}

describe('KDM-229 — the peace context-menu wrap installs without a timer', () => {
	it('AC3: evaluating the script arms no timer at all', () => {
		const { armed } = loadCoopPeace();
		expect(armed, `coop-peace.js armed: ${armed.join(', ')}`).toEqual([]);
	});

	it('AC1: the wrap is installed by the time the script finishes evaluating', () => {
		const { ctx } = loadCoopPeace();
		expect(ctx.KDGetContextActions.Game._kdcoop_peace_wrapped,
			'nothing may have to tick for the entry to exist').toBe(1);
	});

	/**
	 * WRAP_CONVENTION.md, checked here because this is the one spec that can see the wrap in
	 * isolation: `_prev` captured in closure and called FIRST, original stored, vanilla output
	 * preserved. A wrap that dropped the previous builder's options would still satisfy AC1.
	 */
	it('the installed wrap is cooperative — it calls the previous builder and keeps its options', () => {
		const { ctx } = loadCoopPeace({ war: ['B'], canOffer: ['B'], peaceOffer: null });
		expect(ctx.KDGetContextActions.Game._kdcoop_peace_original,
			'the original must be reachable, per WRAP_CONVENTION.md').toBe(vanillaBuilder);

		const menu = ctx.KDGetContextActions.Game(null, 0, 0, {});
		expect(menu.options, "the previous builder's entries survive").toEqual(
			expect.arrayContaining(['Wait', 'Inventory']));
		expect(menu.options, 'and ours is added on top').toContain('Peace');
		// Without explicit text the draw layer prints "[NotFound] KDContextMenu_Peace" at the player.
		expect(menu.optionText.Peace).toContain('Offer peace to');
	});

	it('with no co-op state the menu is returned untouched', () => {
		const { ctx } = loadCoopPeace();   // KDRenderClient absent → not in a session
		const menu = ctx.KDGetContextActions.Game(null, 0, 0, {});
		expect(menu.options).toEqual(['Wait', 'Inventory']);
	});
});
