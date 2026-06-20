/**
 * tools/mp-server/transport/child-entry.js  (KD-081)
 *
 * Runs as a SEPARATE OS process (spawned via child_process). Owns one instance
 * and serves it over a TCP socket on 127.0.0.1, newline-delimited JSON framing —
 * the closest PoC analogue to a real remote game server. Prints the OS-assigned
 * port as `PORT <n>` on stdout so the parent can connect.
 *
 * Same `dispatch` as every other transport; only the pipe (a real socket) differs.
 */
'use strict';

const net = require('net');
const { createState, dispatch } = require('./protocol');

const state = createState();

const server = net.createServer((socket) => {
	socket.setEncoding('utf8');
	let buf = '';
	socket.on('data', async (chunk) => {
		buf += chunk;
		let nl;
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (!line.trim()) continue;
			let msg;
			try { msg = JSON.parse(line); } catch (e) { continue; }
			try {
				const result = await dispatch(state, { cmd: msg.cmd, args: msg.args });
				socket.write(JSON.stringify({ id: msg.id, ok: true, result: result === undefined ? null : result }) + '\n');
			} catch (err) {
				socket.write(JSON.stringify({ id: msg.id, ok: false, error: String((err && err.message) || err) }) + '\n');
			}
		}
	});
	socket.on('error', () => {});
	socket.on('close', () => { server.close(); process.exit(0); });
});

server.listen(0, '127.0.0.1', () => {
	const { port } = server.address();
	process.stdout.write(`PORT ${port}\n`);
});

process.on('SIGTERM', () => { try { server.close(); } catch (e) {} process.exit(0); });
