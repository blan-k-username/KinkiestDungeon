/* Measure msgs/bytes, turn time, and per-message round-trip latency per transport. */
'use strict';
const { MPSession } = require('./mp-session');
const { factory, TRANSPORTS } = require('./transport');

const MOVES = [
	{ A: { dx: 1, dy: 0 }, B: { dx: 0, dy: 1 } },
	{ A: { dx: 1, dy: 0 }, B: { dx: 0, dy: 1 } },
	{ A: { dx: 0, dy: 1 }, B: { dx: -1, dy: 0 } },
	{ A: { dx: 0, dy: 1 }, B: { dx: -1, dy: 0 } },
];

const WARMUP = 200;
const SAMPLES = 2000;

function pct(sorted, p) {
	const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
	return sorted[i];
}

/** Sequential round-trip latency of a command on one transport (ms stats). */
async function latency(transport, cmd, args = {}) {
	for (let i = 0; i < WARMUP; i++) await transport.request(cmd, { ...args, seq: i });
	const xs = new Array(SAMPLES);
	for (let i = 0; i < SAMPLES; i++) {
		const t = process.hrtime.bigint();
		await transport.request(cmd, { ...args, seq: i });
		xs[i] = Number(process.hrtime.bigint() - t) / 1e6; // ms
	}
	xs.sort((a, b) => a - b);
	const avg = xs.reduce((s, v) => s + v, 0) / xs.length;
	return { avg, p50: pct(xs, 50), p99: pct(xs, 99), min: xs[0], max: xs[xs.length - 1] };
}

async function run(name) {
	const t0 = Date.now();
	const s = new MPSession(factory(name), { seed: 'kd-poc-seed' });
	await s.setup();
	const bootMs = Date.now() - t0;

	const t1 = Date.now();
	for (const m of MOVES) { await s.submitMove('A', m.A); await s.submitMove('B', m.B); }
	const turnsMs = Date.now() - t1;

	// Pure transport round-trip (ping = no game work) vs a light real op (tick).
	const ping = await latency(s.t.world, 'ping');
	const tick = await latency(s.t.world, 'tick');

	const st = s.stats();
	await s.close();
	return { name, bootMs, turnsMs, msgs: st.msgs, bytes: st.bytes, ping, tick };
}

(async () => {
	const rows = [];
	for (const name of TRANSPORTS) rows.push(await run(name));

	console.error('\n== throughput ==');
	console.error('transport     boot(ms)  4turns(ms)  msgs   bytes');
	for (const r of rows) console.error(
		r.name.padEnd(12), String(r.bootMs).padStart(8), String(r.turnsMs).padStart(10),
		String(r.msgs).padStart(6), String(r.bytes).padStart(7));

	const fmt = (o) => `avg ${o.avg.toFixed(4)}  p50 ${o.p50.toFixed(4)}  p99 ${o.p99.toFixed(4)}  min ${o.min.toFixed(4)}  max ${o.max.toFixed(3)}`;
	console.error(`\n== per-message round-trip latency, ms (${SAMPLES} samples, ${WARMUP} warmup) ==`);
	console.error('-- ping (no game work; pure transport overhead) --');
	for (const r of rows) console.error('  ' + r.name.padEnd(12), fmt(r.ping));
	console.error('-- tick (one vm eval inside the instance) --');
	for (const r of rows) console.error('  ' + r.name.padEnd(12), fmt(r.tick));
	process.exit(0);
})();
