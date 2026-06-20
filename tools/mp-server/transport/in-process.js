/**
 * tools/mp-server/transport/in-process.js  (KD-081)
 *
 * Same-process transport with a REAL serialization boundary: the instance lives
 * in this process, but every request's args and result are JSON round-tripped
 * (`JSON.parse(JSON.stringify(...))`) before crossing. No IPC, no second process
 * — but no live object ever leaks across the boundary, so it faithfully models
 * what a networked transport must serialize.
 *
 * Goal fit: MVP / localhost (who wants to run multiplayer on one machine).
 */
'use strict';

const { createState, dispatch } = require('./protocol');

function roundTrip(v) {
	return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

class InProcessTransport {
	constructor(opts = {}) {
		this.id = opts.id || 'inproc';
		this._state = null;
		this._stats = { msgs: 0, bytes: 0 };
	}

	async start() { this._state = createState(); return this; }

	async request(cmd, args = {}) {
		// Serialize the outbound message — this is the boundary.
		const wire = JSON.stringify({ cmd, args });
		this._stats.msgs += 1;
		this._stats.bytes += Buffer.byteLength(wire);
		const msg = JSON.parse(wire);
		const result = await dispatch(this._state, msg);
		// Serialize the result back too (count it; model the response wire).
		const out = JSON.stringify(result === undefined ? null : result);
		this._stats.bytes += Buffer.byteLength(out);
		return roundTrip(result);
	}

	async close() { this._state = null; }

	stats() { return { ...this._stats }; }
}

module.exports = { InProcessTransport };
