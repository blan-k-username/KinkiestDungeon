/* Measure msgs/bytes + wall time per transport over the same scenario. */
'use strict';
const { MPSession } = require('./mp-session');
const { factory, TRANSPORTS } = require('./transport');

const MOVES = [
	{ A: { dx: 1, dy: 0 }, B: { dx: 0, dy: 1 } },
	{ A: { dx: 1, dy: 0 }, B: { dx: 0, dy: 1 } },
	{ A: { dx: 0, dy: 1 }, B: { dx: -1, dy: 0 } },
	{ A: { dx: 0, dy: 1 }, B: { dx: -1, dy: 0 } },
];

async function run(name) {
	const t0 = Date.now();
	const s = new MPSession(factory(name), { seed: 'kd-poc-seed' });
	await s.setup();
	const bootMs = Date.now() - t0;
	const t1 = Date.now();
	for (const m of MOVES) { await s.submitMove('A', m.A); await s.submitMove('B', m.B); }
	const turnsMs = Date.now() - t1;
	const st = s.stats();
	await s.close();
	return { name, bootMs, turnsMs, msgs: st.msgs, bytes: st.bytes };
}

(async () => {
	const rows = [];
	for (const name of TRANSPORTS) rows.push(await run(name));
	console.error('transport     boot(ms)  turns(ms)  msgs   bytes');
	for (const r of rows) {
		console.error(
			r.name.padEnd(12),
			String(r.bootMs).padStart(8),
			String(r.turnsMs).padStart(9),
			String(r.msgs).padStart(6),
			String(r.bytes).padStart(7),
		);
	}
	process.exit(0);
})();
