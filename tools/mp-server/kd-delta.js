/**
 * tools/mp-server/kd-delta.js  (KDM-206)
 *
 * THE structural diff/merge for carrying a render snapshot as a DELTA instead of a whole capture.
 *
 * WHY. `ws-bridge` answered every changed `ui` input with `snapshotFor(clientId)` — a whole capture.
 * Measured (`tests/unit/mp-ui-reply-size-profile.spec.ts`): a mouse-direction change moves ONE global
 * of 13-15 bytes, of which 2-4 bytes actually differ, and the reply carrying it is 38.3 KB. That is a
 * ~10,000x amplification, and it is what puts `mp-real-input.spec.ts:112` at 195-273 KB against a
 * 100 KB budget. Within one reply, "map" (11.7 KB, ~31%) is bit-identical every time and re-sent
 * anyway.
 *
 * It lives here, alone, for the same reason `kd-codec.js` does: TWO consumers in two runtimes. The
 * server diffs, the browser merges, and a diff/merge pair that drifts apart corrupts state silently.
 * Exported as SOURCE TEXT so the browser can be served the identical text as a script.
 *
 * GENERIC BY CONSTRUCTION — it walks whatever the capture produced. No field names, no allowlist, no
 * knowledge of what any value means, exactly like the capture and the codec. A mod's new field is
 * covered with no registration.
 *
 * SHAPE OF A PATCH. A patch mirrors the object's structure; only changed paths appear.
 *   - a nested plain object          =  recurse into it
 *   - { __kdSet: v }                 =  replace this key with v wholesale (primitives, arrays, and
 *                                       any type change; the wrapper is what makes a replaced OBJECT
 *                                       distinguishable from a nested patch)
 *   - { __kdDel: 1 }                 =  the key is gone
 *
 * ARRAYS ARE ATOMIC. An array that changed is replaced whole rather than index-diffed. Index diffs of
 * an entity list are where this class of code goes wrong (an insert shifts every later index and the
 * patch becomes larger than the array), and the arrays here are small next to the 26 KB that a
 * per-frame reply was actually wasting.
 *
 * ⚠️ CONSUME-ONCE CHANNELS MUST NOT BE DIFFED. `snapshotFor` DRAINS pending events
 * (`_takePendingEvents`), so a one-shot event exists in exactly one snapshot. If such a channel were
 * diffed and the delta carrying it were lost, the event would be gone for good — the anti-deletion
 * trap KDM-196 documents. The caller passes those paths in `opts.verbatim`; they are copied whole into
 * every patch. This module refuses to guess which they are: naming them is the caller's job.
 */
'use strict';

const KD_DELTA = `
function kdIsPlainObj(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Structural diff. Returns undefined when nothing changed, else a patch (see the shape above).
 * verbatim: array of TOP-LEVEL key names copied whole into every patch (consume-once channels).
 */
function kdDiff(prev, next, verbatim, depth) {
	depth = depth || 0;
	if (depth > 12) return { __kdSet: next };              // cyclic guard, mirrors kdEnc
	if (!kdIsPlainObj(prev) || !kdIsPlainObj(next)) {
		return JSON.stringify(prev) === JSON.stringify(next) ? undefined : { __kdSet: next };
	}
	var patch = {};
	var touched = false;
	var k;
	for (k in next) {
		if (!Object.prototype.hasOwnProperty.call(next, k)) continue;
		if (verbatim && depth === 0 && verbatim.indexOf(k) >= 0) {
			patch[k] = { __kdSet: next[k] };               // consume-once: always carried in full
			touched = true;
			continue;
		}
		var a = prev[k], b = next[k];
		if (kdIsPlainObj(a) && kdIsPlainObj(b)) {
			var sub = kdDiff(a, b, verbatim, depth + 1);
			if (sub !== undefined) { patch[k] = sub; touched = true; }
		} else if (JSON.stringify(a) !== JSON.stringify(b)) {
			patch[k] = { __kdSet: b };
			touched = true;
		}
	}
	for (k in prev) {
		if (!Object.prototype.hasOwnProperty.call(prev, k)) continue;
		if (!Object.prototype.hasOwnProperty.call(next, k)) { patch[k] = { __kdDel: 1 }; touched = true; }
	}
	return touched ? patch : undefined;
}

/** Apply a patch in place and return the target. Inverse of kdDiff. */
function kdMerge(target, patch) {
	if (!kdIsPlainObj(patch)) return target;
	if (!kdIsPlainObj(target)) target = {};
	for (var k in patch) {
		if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
		var p = patch[k];
		if (kdIsPlainObj(p) && Object.prototype.hasOwnProperty.call(p, '__kdDel')) { delete target[k]; continue; }
		if (kdIsPlainObj(p) && Object.prototype.hasOwnProperty.call(p, '__kdSet')) { target[k] = p.__kdSet; continue; }
		target[k] = kdMerge(kdIsPlainObj(target[k]) ? target[k] : {}, p);
	}
	return target;
}
`;

// Node-side consumers get real functions; the browser is served KD_DELTA as text.
// eslint-disable-next-line no-eval
const _scope = {};
// eslint-disable-next-line no-new-func
new Function('exports', KD_DELTA + '\nexports.kdDiff = kdDiff; exports.kdMerge = kdMerge; exports.kdIsPlainObj = kdIsPlainObj;')(_scope);

/**
 * The browser-ready form: the same source text plus the global it publishes.
 *
 * Exported (rather than assembled at each call site) because it has TWO injection sites — the
 * demo-server serves it as a script route, and e2e specs that build their own thin client inject it
 * with `addScriptTag`. Two hand-written wrappers is exactly the drift this module exists to avoid.
 */
const KD_DELTA_BROWSER = `${KD_DELTA}\n;(typeof window !== 'undefined' ? window : globalThis).KDDelta = ` +
	`{ kdDiff: kdDiff, kdMerge: kdMerge };\n`;

module.exports = { KD_DELTA, KD_DELTA_BROWSER, kdDiff: _scope.kdDiff, kdMerge: _scope.kdMerge };
