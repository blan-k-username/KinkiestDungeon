/**
 * tools/mp-server/transport/worker-thread.js  (KD-081)
 *
 * Transport that runs each instance in its own worker_threads Worker — a separate
 * V8 isolate in the same process. Messages cross via postMessage (structured
 * clone); our payloads are plain JSON. Real isolation + a real serialization
 * boundary without a second OS process.
 *
 * Goal fit: smaller-scale multiplayer (many lightweight instances per host).
 */
'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

const ENTRY = path.join(__dirname, 'worker-entry.js');

class WorkerThreadTransport {
	constructor(opts = {}) {
		this.id = opts.id || 'worker';
		this._worker = null;
		this._seq = 0;
		this._pending = new Map();
		this._stats = { msgs: 0, bytes: 0 };
	}

	async start() {
		this._worker = new Worker(ENTRY, { name: this.id });
		this._worker.on('message', (msg) => {
			const p = this._pending.get(msg.id);
			if (!p) return;
			this._pending.delete(msg.id);
			if (msg.ok) p.resolve(msg.result);
			else p.reject(new Error(`[${this.id}] ${msg.error}`));
		});
		this._worker.on('error', (err) => {
			for (const p of this._pending.values()) p.reject(err);
			this._pending.clear();
		});
		return this;
	}

	request(cmd, args = {}) {
		const id = ++this._seq;
		const payload = { id, cmd, args };
		// Count JSON-equivalent bytes for cross-transport comparison.
		this._stats.msgs += 1;
		this._stats.bytes += Buffer.byteLength(JSON.stringify(payload));
		return new Promise((resolve, reject) => {
			this._pending.set(id, { resolve, reject });
			this._worker.postMessage(payload);
		});
	}

	async close() {
		if (this._worker) { await this._worker.terminate(); this._worker = null; }
	}

	stats() { return { ...this._stats }; }
}

module.exports = { WorkerThreadTransport };
