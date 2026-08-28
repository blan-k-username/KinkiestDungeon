/**
 * KDM-287 — `tools/mp-server/lan-address.js`: the address a friend can actually type.
 *
 * The Host screen used to paint `location.host`, and the launcher tells a host to open
 * `http://localhost:8090/` — so what the host was shown to share was `localhost:8090`, the one
 * address that means "the friend's own machine" on the friend's machine. A browser cannot read its
 * own machine's LAN IP, so this module is the server-side answer, and it is the ONLY place that
 * decides what a shareable address is.
 *
 * ── WHY THE INTERFACE TABLE IS AN ARGUMENT ────────────────────────────────────────────────────────
 * `os.networkInterfaces()` describes whatever machine the suite happens to run on: a docker
 * container has one `eth0` on `172.17.*`, a laptop has Wi-Fi plus VPN plus two bridge adapters, and
 * CI may have neither. A spec that asserted on the live table would be asserting on the host, not on
 * this code — green or red for reasons no one changed. Every case below hands in a fixture, so the
 * ranking, the exclusions and the empty case are each reachable on demand.
 *
 * The live table is still exercised: `lanAddresses(port)` defaults to it, and the e2e sends the
 * result over a real socket. What is NOT asserted anywhere is a particular machine's addresses.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { lanAddresses, publicAddresses } = require('../../tools/mp-server/lan-address');

/** One `os.networkInterfaces()` entry, with the fields this module actually reads. */
const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal });
const v6 = (address: string, internal = false) => ({ address, family: 'IPv6', internal });

describe('KDM-287 — lanAddresses', () => {
	it('AC1 — loopback is never offered, however it is spelled', () => {
		const out = lanAddresses(8090, {
			lo0: [v4('127.0.0.1', true), v6('::1', true)],
			en0: [v4('192.168.1.24')],
		});
		expect(out).toEqual(['192.168.1.24:8090']);
	});

	it('AC2 — the port is the one that was passed, not a default', () => {
		expect(lanAddresses(41337, { en0: [v4('10.0.0.9')] })).toEqual(['10.0.0.9:41337']);
	});

	it('AC3 — every plausible address is offered, best guess first', () => {
		// Deliberately worst-first on the way in, so the order out is this module's and not the
		// table's. A docker bridge and a VPN carrier are real addresses — demoted, never hidden,
		// because "showing several beats showing the wrong one".
		const out = lanAddresses(8090, {
			docker0: [v4('172.17.0.1')],
			utun3: [v4('100.64.0.2')],
			en1: [v4('10.0.0.9')],
			en0: [v4('192.168.1.24')],
		});
		expect(out).toEqual([
			'192.168.1.24:8090',
			'10.0.0.9:8090',
			'172.17.0.1:8090',
			'100.64.0.2:8090',
		]);
	});

	it('two addresses in the same class keep the table\'s own order', () => {
		const out = lanAddresses(8090, { en0: [v4('192.168.1.24'), v4('192.168.1.99')] });
		expect(out).toEqual(['192.168.1.24:8090', '192.168.1.99:8090']);
	});

	it('an APIPA address is not offered — it is what a machine picks when DHCP failed', () => {
		expect(lanAddresses(8090, { en0: [v4('169.254.7.7')] })).toEqual([]);
	});

	it('IPv6 is not offered — the host has to read this off a screen and type it to a friend', () => {
		expect(lanAddresses(8090, { en0: [v6('fe80::1c2b'), v6('2001:db8::5')] })).toEqual([]);
	});

	it('AC4 — a machine with nothing to offer answers with nothing, and does not throw', () => {
		expect(lanAddresses(8090, {})).toEqual([]);
		expect(lanAddresses(8090, { lo0: [v4('127.0.0.1', true)] })).toEqual([]);
	});

	it('AC4 — an unusable port answers with nothing rather than "192.168.1.24:undefined"', () => {
		// The port comes from a live socket (`socket.localPort`). A closed or faked one has none, and
		// half an address is worse than no address: a host would type it in good faith.
		for (const bad of [undefined, null, 0, NaN, 'x']) {
			expect(lanAddresses(bad as any, { en0: [v4('192.168.1.24')] }), `port=${String(bad)}`).toEqual([]);
		}
	});

	it('defaults to the real machine, and whatever it says is well-formed', () => {
		// NOT "there is at least one address" — a CI box with only loopback is a legitimate machine
		// and the empty answer is the correct one. The claim is about SHAPE, which holds either way.
		for (const a of lanAddresses(8090)) {
			expect(a).toMatch(/^\d{1,3}(\.\d{1,3}){3}:8090$/);
			expect(a).not.toMatch(/^(127\.|169\.254\.)/);
		}
	});
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * publicAddresses — the same question, asked from inside a container
 *
 * This is the half that decides whether co-op's SHIPPING path works. `--mp` runs the gateway behind
 * `-p ${KD_MP_PORT:-8090}:8090`, so its own interfaces are the docker bridge and its own port is the
 * container's. Detection there produces a plausible address that routes nowhere — which is a worse
 * answer than the `localhost` this task removes, because the host has no way to tell it is wrong.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════ */
describe('KDM-287 — publicAddresses', () => {
	const CONTAINER = { eth0: [v4('192.168.215.2')] };   // what a docker gateway sees of itself

	it('a declared public host wins, and takes the PUBLISHED port', () => {
		// The launcher looked at the real machine and found 192.168.1.24; the container is on 8090
		// but the world reaches it on 9000. Both halves come from the launcher, and neither is
		// anything the gateway could have worked out.
		const out = publicAddresses(8090, { KD_MP_PUBLIC_HOST: '192.168.1.24', KD_MP_HOST_PORT: '9000' }, CONTAINER);
		expect(out).toEqual(['192.168.1.24:9000']);
	});

	it('a declaration that names its own port keeps it', () => {
		// A host behind a router forwarding 7777 → 8090 knows something the launcher does not.
		const out = publicAddresses(8090, { KD_MP_PUBLIC_HOST: 'kd.example.net:7777', KD_MP_HOST_PORT: '9000' }, CONTAINER);
		expect(out).toEqual(['kd.example.net:7777']);
	});

	it('several declared hosts are all offered, in the order they were given', () => {
		const out = publicAddresses(8090, { KD_MP_PUBLIC_HOST: '192.168.1.24, 10.0.0.9', KD_MP_HOST_PORT: '8090' }, CONTAINER);
		expect(out).toEqual(['192.168.1.24:8090', '10.0.0.9:8090']);
	});

	it('THE CONTAINER TRAP — published but nothing declared answers NOTHING, not the bridge address', () => {
		// The launcher looked and could not find an address. Our own interfaces are then KNOWN to be
		// the wrong answer, so the honest reply is none — the screen says "this machine only" and the
		// player looks it up, exactly as they did before. `192.168.215.2` would look right and fail.
		const out = publicAddresses(8090, { KD_MP_HOST_PORT: '8090', KD_MP_PUBLIC_HOST: '' }, CONTAINER);
		expect(out).toEqual([]);
	});

	it('CONTROL — a gateway run directly, with nothing published, still detects its own machine', () => {
		// Without this the rule above is indistinguishable from "publicAddresses always answers
		// nothing", which would pass every other case here and ship a screen that never names one.
		const out = publicAddresses(8090, {}, { en0: [v4('192.168.1.24')] });
		expect(out).toEqual(['192.168.1.24:8090']);
	});

	it('junk in the declaration is dropped rather than painted at the host', () => {
		const out = publicAddresses(8090, { KD_MP_PUBLIC_HOST: 'not a host,192.168.1.24,,http://x' }, CONTAINER);
		expect(out).toEqual(['192.168.1.24:8090']);
	});

	it('an unusable port answers nothing, declaration or not', () => {
		expect(publicAddresses(0, { KD_MP_PUBLIC_HOST: '192.168.1.24' }, CONTAINER)).toEqual([]);
	});
});
