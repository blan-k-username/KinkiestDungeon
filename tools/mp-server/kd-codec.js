/**
 * tools/mp-server/kd-codec.js  (KDM-162)
 *
 * THE codec for carrying KD state as JSON — Map/Set aware, class instances refused.
 *
 * It lives here, alone, because it now has TWO consumers in two runtimes: the headless host
 * injects it into the bundle's vm scope (capture/restore of per-player globals), and the BROWSER
 * thin client needs the decode half to adopt the same bundle (KDM-162). Duplicating ~30 lines of
 * encoder across two runtimes is exactly the failure mode this epic exists to delete — the
 * `stats` block was duplicated in four places and drifted.
 *
 * Exported as SOURCE TEXT, not as functions: the host has to `eval` it inside the bundle's own
 * scope (so `x instanceof Map` is true in THAT realm), and the browser is served the same text as
 * a script. One source of truth, two injection sites.
 */
'use strict';

const KD_CODEC = `
function kdEnc(v, d){
	d = d || 0;
	if (d > 12) return null;                                  // cyclic guard — no player state is this deep
	if (v instanceof Map) { var a = []; v.forEach(function(val, k){ a.push([kdEnc(k, d+1), kdEnc(val, d+1)]); }); return { __kdT: 'Map', e: a }; }
	if (v instanceof Set) { var b = []; v.forEach(function(val){ b.push(kdEnc(val, d+1)); }); return { __kdT: 'Set', e: b }; }
	if (Array.isArray(v)) { var c = new Array(v.length); for (var i = 0; i < v.length; i++) c[i] = kdEnc(v[i], d+1); return c; }
	if (v && typeof v === 'object') {
		if (typeof v.toJSON === 'function') return v.toJSON();
		// A CLASS INSTANCE cannot be carried. JSON would happily flatten it into a plain bag, and the
		// decoder would hand that bag back to code expecting the real thing — MEASURED: kdSoundCache is
		// a Map of live Audio objects, and flattening it produced "audio.pause is not a function" in
		// four specs. Refusing outright means kdSer returns undefined and the global is dropped from the
		// watch set, exactly as the PIXI/canvas globals already are: not carried beats carried wrong.
		var p = Object.getPrototypeOf(v);
		if (p !== null && p !== Object.prototype) throw new Error('kd-nonplain');
		var o = {}; for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = kdEnc(v[k], d+1);
		return o;
	}
	return v;
}
// Non-mutating on purpose: the input belongs to the player's bundle, which must stay plain JSON and
// reusable for the next restore. Building fresh values also makes them native to THIS realm, so
// \`x instanceof Map\` inside the bundle's own code is true.
function kdDec(v){
	if (Array.isArray(v)) { var c = new Array(v.length); for (var i = 0; i < v.length; i++) c[i] = kdDec(v[i]); return c; }
	if (v && typeof v === 'object') {
		if (v.__kdT === 'Map') { var m = new Map(); for (var i = 0; i < v.e.length; i++) m.set(kdDec(v.e[i][0]), kdDec(v.e[i][1])); return m; }
		if (v.__kdT === 'Set') { var s = new Set(); for (var i = 0; i < v.e.length; i++) s.add(kdDec(v.e[i])); return s; }
		var o = {}; for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = kdDec(v[k]);
		return o;
	}
	return v;
}
// Throws 'kd-nonplain' for a Map/Set holding live objects; every caller already treats a throw as
// "not player state, skip this global", which is the correct outcome.
function kdSer(v){ return (v instanceof Map || v instanceof Set) ? JSON.stringify(kdEnc(v)) : JSON.stringify(v); }
`;

module.exports = { KD_CODEC };
