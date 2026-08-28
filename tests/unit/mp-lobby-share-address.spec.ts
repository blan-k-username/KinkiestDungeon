/**
 * KDM-287 — the Host screen paints an address a friend can actually use.
 *
 * The real `client/coop-lobby.js` is loaded into a `vm` context, which IS the bundle's global scope
 * as a classic script sees it (same harness and same reasoning as `mp-chat-client.spec.ts` /
 * `mp-peace-install.spec.ts`). The frame is then driven through the file's OWN wrap of
 * `KinkyDungeonRun` — not through a seam — so what these cases read is what a player would see.
 *
 * ── WHY THE ORACLE IS THE PAINT, NOT `lobby.share` ────────────────────────────────────────────────
 * `lobby.share` holding the server's list would prove the wire works, which is `ws-bridge`'s claim
 * and is asserted in `mp-outbound-fields.spec.ts`. THE BUG WAS THAT THE SCREEN SHOWED THE WRONG
 * STRING, and the only layer that can see that is the one that decides which string is drawn.
 *
 * ── WHY THIS IS NOT A VACUOUS GREEN ───────────────────────────────────────────────────────────────
 *  1. THE LAN-ORIGIN HOST IS A CONTROL (AC5). A host that browsed by its own `192.168.*` must still
 *     see exactly that. Without this case, "always paint the server's list" and "paint the right
 *     thing" are the same green — and the control also happens to be a requirement.
 *  2. THE FALLBACK IS ASSERTED POSITIVELY (AC4). "Does not paint localhost" is satisfied by painting
 *     nothing at all, which is the blank screen AC4 forbids; so the fallback case asserts the
 *     address IS drawn, and that the screen says what it is.
 *  3. THE ADDRESSES ARE THE ASSERTION — the actual strings, in order, not a count and not "something
 *     was drawn".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { resolve } from 'node:path';

const SRC = resolve(__dirname, '../../tools/mp-server/client/coop-lobby.js');
// KDM-281 — the lobby takes its strings from the shared table now, and holds a HARD reference to it
// (window.KDMPText). It is injected ahead of the lobby in demo-server.js, so the rig loads it first
// for the same reason: without it the file throws and this spec would be testing nothing.
const TEXT_SRC = resolve(__dirname, '../../tools/mp-server/client/coop-text.js');

type Painted = { text: string; y: number };

/**
 * Evaluate the lobby against a fake bundle scope and draw ONE frame of the host view.
 *
 * `locHost` is the origin the host's browser is actually on — the whole input to AC5 — and `share`
 * is what the server told us on `joined`.
 */
function drawHostFrame(locHost: string, share?: string[] | null) {
	const painted: Painted[] = [];
	const buttons: any[] = [];
	const ctx: any = {
		window: {},
		document: { getElementById: () => null },
		location: { host: locHost, hostname: locHost.split(':')[0], protocol: 'http:' },
		KinkyDungeonRun: function () { return 'vanilla'; },
		KinkyDungeonState: 'Multiplayer',
		DrawTextKD: (text: string, _x: number, y: number) => { painted.push({ text: String(text), y }); },
		DrawButtonKDEx: (name: string, _fn: any, _en: any, _l: any, top: number, ..._rest: any[]) => {
			buttons.push({ name, top }); return true;
		},
		// KD answers a key it does not have with `[NotFound] <key>`, which `kdText` treats as "no
		// translation" — so every label here falls back to its English source, exactly as it does in
		// an English game. See the `kdText` note in coop-lobby.js.
		TextGet: (k: string) => `[NotFound] ${k}`,
		addTextKey: () => {},
		setTimeout: () => 0, clearTimeout: () => {},
		console: { warn: () => {}, log: () => {}, error: () => {} },
	};
	createContext(ctx);
	runInContext(readFileSync(TEXT_SRC, 'utf8'), ctx, { filename: 'coop-text.js' });
	runInContext(readFileSync(SRC, 'utf8'), ctx, { filename: 'coop-lobby.js' });

	const lobby = ctx.window.KDMPLobby;
	lobby.view = 'host';
	if (share !== undefined) lobby.share = share as any;
	ctx.KinkyDungeonRun();

	return { painted, buttons, lobby, lines: painted.map((p) => p.text) };
}

/** Everything painted this frame as one searchable blob. */
const blob = (painted: Painted[]) => painted.map((p) => p.text).join(' │ ');

const LAN = ['192.168.1.24:8090', '10.0.0.9:8090', '172.17.0.1:8090', '100.64.0.2:8090'];

describe('KDM-287 — the address the Host screen offers to share', () => {
	it('AC1 — a host on localhost is NOT shown localhost', () => {
		const { painted } = drawHostFrame('localhost:8090', LAN);
		expect(blob(painted)).not.toMatch(/localhost/);
		expect(blob(painted)).not.toMatch(/127\.0\.0\.1/);
		expect(blob(painted)).toContain('192.168.1.24:8090');
	});

	it('AC1 — and neither is 127.0.0.1, which is the same machine by another name', () => {
		const { painted } = drawHostFrame('127.0.0.1:8090', LAN);
		expect(blob(painted)).not.toMatch(/127\.0\.0\.1/);
		expect(blob(painted)).toContain('192.168.1.24:8090');
	});

	it('AC3 — several plausible addresses are offered, best first and capped at three', () => {
		// Capped so the list cannot grow down the screen into the Cancel button; ordering is the
		// server's (`lan-address.js`), and this asserts the screen does not reorder or drop the best.
		const { painted } = drawHostFrame('localhost:8090', LAN);
		const shown = painted.filter((p) => /^\d/.test(p.text)).map((p) => p.text);
		expect(shown).toEqual(LAN.slice(0, 3));
	});

	it('AC3 — each address is on its own line, in reading order down the screen', () => {
		const { painted } = drawHostFrame('localhost:8090', LAN);
		const ys = painted.filter((p) => /^\d/.test(p.text)).map((p) => p.y);
		expect(ys).toHaveLength(3);
		expect([...ys].sort((a, b) => a - b)).toEqual(ys);
		expect(new Set(ys).size).toBe(3);
	});

	it('AC4 — nothing to offer: the address is still shown, and the screen says what it is', () => {
		for (const nothing of [[], null, undefined]) {
			const { painted } = drawHostFrame('localhost:8090', nothing as any);
			const what = blob(painted);
			// Positively drawn — "no localhost" is also satisfied by a blank screen, which is the
			// failure this case exists to exclude.
			expect(what, `share=${JSON.stringify(nothing)}`).toContain('localhost:8090');
			expect(what, `share=${JSON.stringify(nothing)}`).toMatch(/this machine only/i);
		}
	});

	it('AC5 — a host that browsed by its LAN address sees that, unchanged', () => {
		// THE CONTROL. Same server list, same code path, opposite origin: the screen must show where
		// the host actually is and must not start offering the list.
		const { painted } = drawHostFrame('192.168.1.24:8090', LAN);
		const shown = painted.filter((p) => /^\d/.test(p.text)).map((p) => p.text);
		expect(shown).toEqual(['192.168.1.24:8090']);
		expect(blob(painted)).not.toMatch(/this machine only/i);
		expect(blob(painted)).not.toContain('10.0.0.9');
	});

	it('AC5 — and so does a host reached by hostname, which is shareable as it stands', () => {
		const { painted } = drawHostFrame('kd-desktop.local:8090', LAN);
		const shown = painted.filter((p) => /desktop|^\d/.test(p.text)).map((p) => p.text);
		expect(shown).toEqual(['kd-desktop.local:8090']);
	});

	it('the "tell your friend" prompt is still there, above the address', () => {
		const { painted } = drawHostFrame('localhost:8090', LAN);
		const prompt = painted.find((p) => /Tell your friend/i.test(p.text));
		const first = painted.find((p) => /^\d/.test(p.text));
		expect(prompt).toBeTruthy();
		expect(prompt!.y).toBeLessThan(first!.y);
	});

	it('the waiting line and Cancel stay clear of the addresses, however many there are', () => {
		// One line or three, nothing may be painted on top of anything else — the layout moves down
		// with the list rather than the list growing into it.
		for (const share of [[LAN[0]], LAN]) {
			const { painted, buttons } = drawHostFrame('localhost:8090', share);
			const lowestText = Math.max(...painted.map((p) => p.y));
			const cancel = buttons.find((b) => b.name === 'KDMPBack');
			expect(cancel, `share=${share.length}`).toBeTruthy();
			expect(cancel.top, `share=${share.length}`).toBeGreaterThan(lowestText);
		}
	});

	it('a junk `share` from the wire cannot blank the screen or paint "undefined"', () => {
		// The field crosses a socket; a client must not trust its shape. Anything unusable is the
		// AC4 case, not a crash and not a line reading `undefined`.
		for (const junk of ['192.168.1.24:8090', 42, {}, [null, undefined, ''], [{ a: 1 }]]) {
			const { painted } = drawHostFrame('localhost:8090', junk as any);
			const what = blob(painted);
			expect(what, `share=${JSON.stringify(junk)}`).not.toMatch(/undefined|null|\[object/);
			expect(what, `share=${JSON.stringify(junk)}`).toContain('localhost:8090');
		}
	});
});
