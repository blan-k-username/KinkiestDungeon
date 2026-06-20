/**
 * tools/mp-server/transport/worker-entry.js  (KD-081)
 *
 * Runs INSIDE a worker_threads Worker. Owns one instance (a HeadlessHost via the
 * shared `dispatch`) and relays correlated request/response messages over
 * parentPort. Identical dispatcher to every other transport — only the message
 * pipe differs.
 */
'use strict';

const { parentPort } = require('worker_threads');
const { createState, dispatch } = require('./protocol');

const state = createState();

parentPort.on('message', async (msg) => {
	const { id, cmd, args } = msg;
	try {
		const result = await dispatch(state, { cmd, args });
		parentPort.postMessage({ id, ok: true, result: result === undefined ? null : result });
	} catch (err) {
		parentPort.postMessage({ id, ok: false, error: String((err && err.message) || err) });
	}
});
