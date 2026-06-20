/* Throwaway smoke driver — boots one HeadlessHost, inits, steps. Run in Docker. */
'use strict';
const { HeadlessHost } = require('./headless-host');

function main() {
	const h = new HeadlessHost({ id: 'smoke' });
	console.error('booting…');
	h.boot();
	console.error('booted OK. tick=', h.tick());
	console.error('init…');
	h.init({ level: 1 });
	console.error('after init: tick=', h.tick(), 'state=', JSON.stringify(h.getState()));
	const t = h.step(3);
	console.error('after step(3): tick=', t, 'state=', JSON.stringify(h.getState()));
	if (h.errors.length) console.error('bundle console.errors:', h.errors.slice(0, 10));
	console.error('SMOKE OK');
}

try { main(); console.error('exiting'); process.exit(0); }
catch (e) { console.error('SMOKE FAIL:', e && e.stack || e); process.exit(1); }
