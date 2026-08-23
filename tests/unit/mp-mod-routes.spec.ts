/**
 * KDM-249 Phase B — the gateway relays the host's mod PAYLOADS over HTTP (R6).
 *
 * ── WHY HTTP AND NOT THE SESSION SOCKET ───────────────────────────────────────────────────────────
 * The guest needs the bytes at PAGE-LOAD time, before its WebSocket exists — `coop-mods.js` runs as
 * an injected script ahead of the first frame. A plain GET fits that window; a relay over the session
 * socket would arrive too late and would have to be buffered anyway. It also sidesteps frame-size
 * limits, which matters because there is deliberately no size cap (N5: LAN-only, owner 2026-08-23).
 *
 * ── IN MEMORY, NEVER ON DISK ──────────────────────────────────────────────────────────────────────
 * The gateway must not accumulate a mod directory nobody asked it to keep, and a restarted gateway
 * must not serve a PREVIOUS host's mods to a new session. Content-addressed, so a re-upload is free.
 *
 * ── THE ROUTING TRAP THIS PINS ────────────────────────────────────────────────────────────────────
 * `demo-server.js` serves the whole repo statically, guarded by `safeJoin`'s path-traversal check.
 * The mod routes MUST be matched before that, or `/mp/mods/<hash>` becomes a filesystem lookup — and
 * a hash containing `..` would be answered by the static server. The traversal case below fails
 * loudly if the ordering is ever reversed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const http = require('http');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

let server: any, bridge: any, port: number;

beforeAll(async () => { ({ server, bridge, port } = await start(0)); });
afterAll(async () => {
	try { bridge.close(); } catch (e) { /* ignore */ }
	await new Promise((r) => server.close(r));
});

function req(method: string, path: string, body?: Buffer): Promise<{ status: number, body: Buffer, type: string }> {
	return new Promise((resolve, reject) => {
		const r = http.request({ host: '127.0.0.1', port, path, method }, (res: any) => {
			const chunks: Buffer[] = [];
			res.on('data', (c: Buffer) => chunks.push(c));
			res.on('end', () => resolve({
				status: res.statusCode,
				body: Buffer.concat(chunks),
				type: res.headers['content-type'] || '',
			}));
		});
		r.on('error', reject);
		if (body) r.write(body);
		r.end();
	});
}

/** Not a real zip — these routes are a byte pipe and must not care what is in them. */
const BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x7f, 0x80]);
const HASH = 'sha256-testhash';

describe('KDM-249 — /mp/mods routes (R6)', () => {
	it('an unknown hash is 404, not a static-file lookup', async () => {
		const r = await req('GET', '/mp/mods/never-uploaded');
		expect(r.status).toBe(404);
	});

	it('the host uploads bytes and the guest gets them back BYTE-IDENTICAL', async () => {
		// Byte-identical is the assertion that matters: a zip mangled by an encoding round-trip would
		// still be "a response", and would fail much later as an unreadable archive.
		const put = await req('POST', `/mp/mods/${HASH}`, BYTES);
		expect(put.status).toBe(200);

		const got = await req('GET', `/mp/mods/${HASH}`);
		expect(got.status).toBe(200);
		expect(Buffer.compare(got.body, BYTES), 'bytes survive the round trip').toBe(0);
		expect(got.type).toContain('zip');
	});

	it('a re-upload of the same hash is accepted and changes nothing — content-addressed', async () => {
		const before = bridge.mods.size();
		expect((await req('POST', `/mp/mods/${HASH}`, BYTES)).status).toBe(200);
		expect(bridge.mods.size(), 'still one entry').toBe(before);
	});

	it('the manifest reports the session mod set, which is the HOST\'s', async () => {
		bridge.gate.claimHost('H', { build: '', mods: [
			{ name: 'art.zip', modname: 'Art', modbuild: 'x', priority: 5, hash: 'h-art' },
		] });
		const r = await req('GET', '/mp/mods/manifest');
		expect(r.status).toBe(200);
		expect(r.type).toContain('json');
		expect(JSON.parse(r.body.toString()).mods.map((m: any) => m.hash)).toEqual(['h-art']);
	});

	it('a manifest with no host is an empty set, not an error', async () => {
		// The guest fetches this before it knows whether anyone is hosting; a 500 here would read to
		// the player as "mod sync is broken" rather than "nobody is hosting yet".
		bridge.gate.release('H');
		const r = await req('GET', '/mp/mods/manifest');
		expect(r.status).toBe(200);
		expect(JSON.parse(r.body.toString()).mods).toEqual([]);
	});

	it('a /mp/mods path is answered by the mod route, never by the static file server', async () => {
		// Route PRECEDENCE, not a security hole: this demo server serves the whole repo by design, so
		// `package.json` is readable at its own URL either way. What must not happen is a
		// `/mp/mods/<hash>` request resolving to a FILE — which is exactly what `..%2F..%2F` produces
		// if the mod routes are matched after `safeJoin` (it normalises back to REPO_ROOT/package.json,
		// inside the root, so the traversal guard correctly allows it). Handled by the mod route, an
		// unknown hash is a 404.
		const r = await req('GET', '/mp/mods/..%2F..%2Fpackage.json');
		expect(r.status, 'the mod route owns this path').toBe(404);
		expect(r.body.toString()).not.toContain('"devDependencies"');
	});
});
