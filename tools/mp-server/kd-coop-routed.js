/**
 * tools/mp-server/kd-coop-routed.js  (KDM-307)
 *
 * ROUTE ONLY WHEN THERE IS SOMEWHERE TO ROUTE TO — the one rule, shared by every routed wrap.
 *
 * `kd-perk-choice.js` and `kd-journey-choice.js` swap what a click MEANS: instead of KD writing the
 * choice, it is routed to the party and arbitrated server-side. Both are served to EVERY page the
 * co-op server serves, and both used to swap unconditionally — so a SOLO game on that server lost its
 * perk orb's Accept and its journey pick to a server that was not there (owner's UAT, 2026-09-30).
 *
 * There are exactly two places where routing means something:
 *   - the SERVER's headless world, where the session installs the proposal hook the routed input
 *     calls (`swap-session.js` — `KDCoopPerkPropose` / `KDCoopJourneyPropose`). The headless host
 *     DRAWS too, so its own draw must keep being reverted and routed; "is a render client" alone
 *     would get this half wrong.
 *   - a BROWSER that has entered a session: `KDRenderClient.isClientMode()`, set by `disableLocalSim()`.
 * Anywhere else — a solo page, a page still in the lobby — the wrap stands aside and KD's own button
 * does what KD's own button does.
 *
 * SOURCE TEXT, interpolated as a CONSTANT into both wraps' source (it never varies per call, so the
 * eval compilation cache is unaffected). A function defined in each IIFE from the ONE string, rather
 * than a global, because the two texts must work in either load order and in both runtimes.
 * Expects `g` (the global object) in scope, which both wraps already define.
 */
'use strict';

const ROUTED_HERE = `
	function routedHere(hook) {
		if (typeof g[hook] === 'function') return true;
		var rc = g.KDRenderClient;
		return !!(rc && typeof rc.isClientMode === 'function' && rc.isClientMode());
	}
`;

module.exports = { ROUTED_HERE };
