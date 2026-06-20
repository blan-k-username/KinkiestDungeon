/**
 * tools/mp-server/transport/index.js  (KD-081)
 *
 * Resolve a transport name → a `makeTransport(role)` factory that MPSession uses.
 * One place to register adapters; the spec parametrizes over TRANSPORTS.
 */
'use strict';

// Lazy requires — a transport module is only loaded when its name is used, so
// the in-process path doesn't pull in worker/child entry points.
const REGISTRY = {
	'in-process': (role) => new (require('./in-process').InProcessTransport)({ id: role }),
	'worker': (role) => new (require('./worker-thread').WorkerThreadTransport)({ id: role }),
	'socket': (role) => new (require('./socket').SocketTransport)({ id: role }),
};

/** All registered transport names. */
const TRANSPORTS = Object.keys(REGISTRY);

/** Get a `makeTransport(role)` factory for a named transport. */
function factory(name) {
	const f = REGISTRY[name];
	if (!f) throw new Error(`unknown transport: ${name}`);
	return f;
}

module.exports = { factory, TRANSPORTS };
