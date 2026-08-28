/**
 * tools/mp-server/lan-address.js  (KDM-287)
 *
 * THE ONE ANSWER TO "what address can my friend type?"
 *
 * The co-op Host screen used to paint `location.host`, which is where the host's own browser came
 * from — and the launcher tells a host to open `http://localhost:8090/`. So the address a first-time
 * host was told to share was `localhost:8090`: the one string that, on the friend's machine, names
 * the friend's machine. A browser cannot read its own host's LAN IP, so the answer has to come from
 * here and ride a frame the client already receives (`joined`, see `ws-bridge.js`).
 *
 * ⚠️ THE PORT IS AN ARGUMENT, NOT AN ENV READ. `ws-bridge` passes the LIVE socket's `localPort`, so
 * this follows `KD_MP_PORT` / `PORT` / `listen(0)` without knowing any of them exist — and it cannot
 * drift from the port the guest will actually dial, which a second reading of the env could.
 *
 * ⚠️ IPv4 ONLY, ON PURPOSE. A host reads this off a screen and says it out loud to a friend, who
 * types it. `fe80::1c2b:4f2a:...%en0` fails that test even when it would route.
 */
'use strict';

const os = require('os');

/**
 * How likely an address is to be the one a friend on the same network can reach, best first.
 *
 * A private-range address is what a home or office LAN hands out, so those rank above anything else;
 * `172.16/12` sits below `10/8` because in practice a `172.17.*` is a docker bridge far more often
 * than it is somebody's LAN. Nothing is EXCLUDED by rank, though — a demoted address is still shown
 * (see AC3: showing several beats showing the wrong one), and the host knows their own network
 * better than this table does.
 */
const CLASSES = [
	/^192\.168\./,
	/^10\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
];

/** 169.254/16 — what a machine gives itself when DHCP failed. It reaches nobody. */
const APIPA = /^169\.254\./;

function rank(ip) {
	for (let i = 0; i < CLASSES.length; i++) if (CLASSES[i].test(ip)) return i;
	return CLASSES.length;
}

/**
 * Every address a friend could plausibly type to reach this machine, best guess first.
 *
 * @param {number} port  the port the gateway is actually listening on
 * @param {object} [ifaces]  an `os.networkInterfaces()` table; defaults to this machine's.
 *        A parameter so specs can drive the ranking and the exclusions from a fixture instead of
 *        asserting on whichever interfaces the test host happens to have.
 * @returns {string[]}  e.g. `['192.168.1.24:8090']`. EMPTY IS A REAL ANSWER — a machine with only
 *        loopback has nothing to share, and the caller must say so rather than invent something.
 */
function lanAddresses(port, ifaces) {
	// Half an address is worse than none: a host would read `192.168.1.24:undefined` off the screen
	// and give it to a friend in good faith.
	const p = Number(port);
	if (!Number.isInteger(p) || p <= 0) return [];

	const table = ifaces || os.networkInterfaces();
	const found = [];
	for (const name of Object.keys(table)) {
		for (const info of table[name] || []) {
			if (!info || info.internal) continue;                 // loopback, by the OS's own word
			if (String(info.family) !== 'IPv4' && info.family !== 4) continue;
			const ip = String(info.address || '');
			if (!ip || APIPA.test(ip)) continue;
			found.push(ip);
		}
	}
	// Stable within a class: two addresses the table lists in an order the OS chose keep it, rather
	// than being reordered by something this file made up.
	return found
		.map((ip, i) => ({ ip, i, r: rank(ip) }))
		.sort((a, b) => (a.r - b.r) || (a.i - b.i))
		.map((e) => `${e.ip}:${p}`);
}

/**
 * KDM-287 — the address to publish, once the CONTAINER is taken into account.
 *
 * ⚠️ `lanAddresses` ALONE IS WRONG FOR THE WAY CO-OP ACTUALLY SHIPS, and quietly so. `--mp` runs the
 * gateway in docker with `-p ${KD_MP_PORT:-8090}:8090`, so inside the container both halves of the
 * answer are the container's own: `os.networkInterfaces()` reports a bridge address like
 * `192.168.215.2` that nothing outside the machine can route to, and `localPort` is the CONTAINER
 * port, not the published one. Auto-detection would have swapped `localhost:8090` — obviously
 * useless — for something that looks right and is not, which is a worse bug than the one being fixed.
 *
 * Only the launcher can see the real machine, so it tells us: `KD_MP_PUBLIC_HOST` is the host's own
 * LAN address (discovered on the host, in `kd-mods-src/tools/lib/kd-game.sh`) and `KD_MP_HOST_PORT`
 * is the port it published. `tools/check-launcher-env.sh` fails the commit if the launcher stops
 * forwarding either — this file being read by that scan is the point of naming them here.
 *
 * THE THIRD CASE IS THE CAREFUL ONE: published (`KD_MP_HOST_PORT` set) but nothing declared means
 * the launcher looked and could not find one. Our own interfaces are then known to be the wrong
 * answer, so the honest reply is none at all — the screen says "this machine only" and the player
 * looks it up, exactly as before. Guessing would be the failure this whole function exists to avoid.
 *
 * @param {number} port  the port the socket actually arrived on — used when nothing is published
 * @param {object} [env]  defaults to `process.env`; a parameter so specs need no global mutation
 * @param {object} [ifaces]  passed through to `lanAddresses`
 */
function publicAddresses(port, env, ifaces) {
	const declared = String((env ? env.KD_MP_PUBLIC_HOST : process.env.KD_MP_PUBLIC_HOST) || '').trim();
	const published = String((env ? env.KD_MP_HOST_PORT : process.env.KD_MP_HOST_PORT) || '').trim();
	const p = Number(published || port);
	if (!Number.isInteger(p) || p <= 0) return [];

	if (declared) {
		return declared.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
			// A declaration may name its own port (a host behind a router forwarding 9000→8090 knows
			// something we do not); otherwise it takes the published one.
			.map((h) => (/:\d+$/.test(h) ? h : `${h}:${p}`))
			.filter((a) => /^[A-Za-z0-9.\-]+:\d+$/.test(a));
	}
	if (published) return [];
	return lanAddresses(p, ifaces);
}

module.exports = { lanAddresses, publicAddresses };
