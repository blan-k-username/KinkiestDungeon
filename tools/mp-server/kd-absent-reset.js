/**
 * tools/mp-server/kd-absent-reset.js
 *
 * THE "absent from the bundle ⇒ back to its default" rule, for the CLIENT side of the swap.
 *
 * WHY. `_captureGlobals` records a watched global only while it DIFFERS from the post-init baseline
 * (`headless-host.js:1862` — `if (hash(s) !== base[n]) out[n] = …`). A global that returns to its
 * default therefore DROPS OUT of the bundle entirely: absence is not "unchanged", it is "back to the
 * default". The server already reads it that way (`_restoreGlobals`, `headless-host.js:2039-2048`:
 * anything the player does not carry goes back to its post-init default, and only currently-dirty
 * names are touched so a swap does not rewrite ~2300 globals).
 *
 * The browser did not. `adoptBundle` (`client/render-client.js`) iterated `b.globals` and assigned
 * only the keys that were PRESENT, so a vanished key kept the previous turn's value for the rest of
 * the session. Measured in UAT as a hard crash: after struggling free, `KinkyDungeonStruggleGroups`
 * went back to `[]` server-side (hence out of the bundle) while the client kept `["ItemHands"]`;
 * `KinkyDungeonGetRestraintItem` then returned null for that stale group and `KDDrawStruggleGroups`
 * dereferenced it unguarded on hover (`KinkyDungeonHUD.ts:3511`) —
 * "Cannot read properties of null (reading 'struggleProgress')".
 *
 * It lives here, alone and as SOURCE TEXT, for the same reason `kd-codec.js` and `kd-delta.js` do:
 * two runtimes have to agree, and a rule that is written twice drifts and corrupts state silently.
 *
 * WHERE THE CLIENT'S DEFAULTS COME FROM. Not the wire. The browser runs the same `out/main.js` and
 * the same init, so before it has ever adopted a given global that global still holds its pristine
 * post-init value — which IS the default. The client records it the first time a bundle mentions the
 * name, and that recording is what a later absence restores. Shipping ~2300 defaults at boot to say
 * the same thing would cost megabytes for a value each client already has.
 *
 * GENERIC BY CONSTRUCTION — no field names, no allowlist. `KinkyDungeonStruggleGroups` is the one
 * with an unguarded dereference behind it; every other per-player global went stale in exactly the
 * same way and is fixed by the same rule.
 */
'use strict';

const KD_ABSENT_RESET = `
/**
 * Which globals must be restored to their default because the bundle stopped carrying them.
 *
 * @param defaults {Object}  name -> pristine post-init value, recorded at first adoption
 * @param dirty    {Array}   names currently believed to hold a non-default value
 * @param globals  {Object}  this bundle's globals (null/undefined ⇒ carries nothing)
 * @returns {Array} [{name, value}] — value is the default to assign back
 *
 * Mirrors the host's two guards: only DIRTY names are considered (an untouched global needs no
 * work), and a name with no recorded default is left alone (there is nothing correct to assign).
 */
function kdAbsentResets(defaults, dirty, globals) {
	var out = [], seen = {}, i, n;
	if (!defaults || !dirty) return out;
	for (i = 0; i < dirty.length; i++) {
		n = dirty[i];
		if (seen[n]) continue;                                              // listed twice ⇒ reset once
		if (!Object.prototype.hasOwnProperty.call(defaults, n)) continue;   // no default to go back to
		if (globals && Object.prototype.hasOwnProperty.call(globals, n)) continue;  // still carried
		seen[n] = 1;
		out.push({ name: n, value: defaults[n] });
	}
	return out;
}
`;

// Node-side consumers get real functions; the browser is served KD_ABSENT_RESET as text.
const _scope = {};
// eslint-disable-next-line no-new-func
new Function('exports', KD_ABSENT_RESET + '\nexports.kdAbsentResets = kdAbsentResets;')(_scope);

/** The browser-ready form: the same source text plus the global it publishes. */
const KD_ABSENT_RESET_BROWSER = `${KD_ABSENT_RESET}\n;(typeof window !== 'undefined' ? window : globalThis).KDAbsentReset = ` +
	`{ kdAbsentResets: kdAbsentResets };\n`;

module.exports = {
	KD_ABSENT_RESET,
	KD_ABSENT_RESET_BROWSER,
	kdAbsentResets: _scope.kdAbsentResets,
};
