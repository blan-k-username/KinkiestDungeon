/**
 * tools/mp-server/transport/socket.js  (KD-081)
 *
 * Transport that runs each instance in a SEPARATE OS process (child_process) and
 * talks to it over a real TCP socket (127.0.0.1, newline-delimited JSON). This is
 * the closest PoC analogue to a true remote game server: real process isolation,
 * real serialization, real network framing.
 *
 * Goal fit: true multiplayer / lobby (a world server other machines connect to).
 */
'use strict';

const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ENTRY = path.join(__dirname, 'child-entry.js');

class SocketTransport {
	constructor(opts = {}) {
		this.id = opts.id || 'socket';
		this._child = null;
		this._sock = null;
		this._seq = 0;
		this._pending = new Map();
		this._buf = '';
		this._stats = { msgs: 0, bytes: 0 };
	}

	async start() {
		// 1) spawn the child server, read the OS-assigned port from its stdout
		const port = await new Promise((resolve, reject) => {
			const child = spawn(process.execPath, [ENTRY], { stdio: ['ignore', 'pipe', 'pipe'] });
			this._child = child;
			let out = '';
			const onData = (d) => {
				out += d.toString();
				const m = out.match(/PORT (\d+)/);
				if (m) { child.stdout.off('data', onData); resolve(parseInt(m[1], 10)); }
			};
			child.stdout.on('data', onData);
			child.stderr.on('data', () => {});
			child.on('error', reject);
			child.on('exit', (code) => {
				if (this._pending.size) {
					for (const p of this._pending.values()) p.reject(new Error(`child exited (${code})`));
					this._pending.clear();
				}
			});
		});

		// 2) connect to it over TCP
		await new Promise((resolve, reject) => {
			const sock = net.connect(port, '127.0.0.1', () => resolve(undefined));
			sock.setEncoding('utf8');
			sock.on('data', (chunk) => this._onData(chunk));
			sock.on('error', reject);
			this._sock = sock;
		});
		return this;
	}

	_onData(chunk) {
		this._buf += chunk;
		let nl;
		while ((nl = this._buf.indexOf('\n')) >= 0) {
			const line = this._buf.slice(0, nl);
			this._buf = this._buf.slice(nl + 1);
			if (!line.trim()) continue;
			let msg;
			try { msg = JSON.parse(line); } catch (e) { continue; }
			const p = this._pending.get(msg.id);
			if (!p) continue;
			this._pending.delete(msg.id);
			if (msg.ok) p.resolve(msg.result);
			else p.reject(new Error(`[${this.id}] ${msg.error}`));
		}
	}

	request(cmd, args = {}) {
		const id = ++this._seq;
		const line = JSON.stringify({ id, cmd, args }) + '\n';
		this._stats.msgs += 1;
		this._stats.bytes += Buffer.byteLength(line);   // real wire bytes
		return new Promise((resolve, reject) => {
			this._pending.set(id, { resolve, reject });
			this._sock.write(line);
		});
	}

	async close() {
		try { if (this._sock) this._sock.end(); } catch (e) {}
		if (this._child) {
			const child = this._child;
			await new Promise((resolve) => {
				const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} resolve(undefined); }, 2000);
				child.on('exit', () => { clearTimeout(t); resolve(undefined); });
				try { child.kill('SIGTERM'); } catch (e) { clearTimeout(t); resolve(undefined); }
			});
			this._child = null;
		}
		this._sock = null;
	}

	stats() { return { ...this._stats }; }
}

module.exports = { SocketTransport };
