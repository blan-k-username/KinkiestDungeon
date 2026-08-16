/**
 * tools/mp-server/demo-server.js  (KD-071 / epic mp-mvp — hands-on UAT launcher)
 *
 * One Node process that lets you PLAY the co-op MVP in two real browser windows:
 *   - serves the stock game statically from the repo root (index.html + out/main.js
 *     + all runtime assets), and
 *   - runs the local WebSocket bridge (WSBridge → SwapSession) on the SAME port, so
 *     the browser client connects same-origin (ws://<host>/).
 *
 * It injects two scripts into index.html on the fly (the stock index.html is left
 * untouched on disk): the thin-client core (render-client.js) and a co-op bootstrap
 * (coop-bootstrap.js) that reads `#coop=<id>` from the URL and wires render + input.
 *
 * UAT flow (run in Docker, port mapped to your host — see tools/coop-demo.sh):
 *   1. window 1 → http://localhost:8090/#coop=A   (creates the session, waits)
 *   2. window 2 → http://localhost:8090/#coop=B   (both in → shared dungeon starts)
 *   3. arrow keys move; BOTH must move to advance a turn (lockstep co-op). You see
 *      the other player's avatar and a shared enemy the server owns.
 *
 * Not a hardened server (no caching/range/security) — a local UAT harness only.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WSBridge } = require('./ws-bridge');
const { KD_CODEC } = require('./kd-codec');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// Default :8090 (not :8080 — that's the stock `npm run serve` / kdrunner port).
const PORT = parseInt(process.env.PORT || '8090', 10);

const MIME = {
	'.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
	'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
	'.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
	'.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
	'.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8',
};

/**
 * KDM-162: the state codec, served to the browser from the SAME source text the headless host evals
 * into the bundle's vm scope (`kd-codec.js`). The thin client needs `kdDec` to adopt a per-player
 * state bundle, and a second hand-kept copy in the browser is precisely the drift this epic deletes.
 *
 * Synthetic route — there is no such file on disk, and there must not be: a real file under `client/`
 * would be a copy that can go stale against the host's.
 */
const CODEC_ROUTE = '/mp/kd-codec.js';
const CODEC_BODY = `${KD_CODEC}\n;(typeof window !== 'undefined' ? window : globalThis).KDCodec = ` +
	`{ kdEnc: kdEnc, kdDec: kdDec, kdSer: kdSer };\n`;

// Scripts injected just before </body> in index.html (in order).
const INJECT = [
	CODEC_ROUTE,                    // must precede render-client.js — it consumes window.KDCodec
	'/tools/mp-server/client/render-client.js',
	'/tools/mp-server/client/coop-bootstrap.js',
];

/* ── Serve-time workaround for an UPSTREAM crash (see tests/unit/mp-bundle-sgroup-patch.spec.ts)
 *
 * `NPCRestrain.ts:310` / `:402` read `KDGetNPCBindingSlotForItem(...).sgroup` without a guard,
 * but that helper returns null when no binding row accepts the item on that NPC
 * (`KDGenRestraintUniform.ts:38`, `:48`). Clicking such an item in the bind menu — easy to hit in
 * PvP, where the peer is an Enemy — throws "Cannot read properties of null (reading 'sgroup')".
 * The sibling call sites are already guarded (`:877` `?.sgroup`, `:445` null-check), so `?.` is
 * the intended shape and `if (slot_temp)` on the next line already handles null: the click
 * becomes the no-op it should have been.
 *
 * Patched on the way OUT rather than on disk, so Game/src/** stays byte-identical to upstream
 * (zero game-source edits). Delete this once upstream ships the guard — the spec's site-count
 * assertion is what tells you that happened.
 * ─────────────────────────────────────────────────────────────────────────────────────────── */
// Every entry is the same defect: an unguarded lookup result (`.find()` / a helper returning null)
// dereferenced without `?.`. Optional chaining only changes behaviour where the code currently
// THROWS, so guarding is safe; the callers already handle a falsy value.
const BUNDLE_PATCHES = [
	{
		// NPCRestrain.ts:310, :402 — KDGetNPCBindingSlotForItem returns null when no binding row
		// accepts the item on that NPC (KDGenRestraintUniform.ts:38, :48). Crashes on CLICK in the
		// bind menu. Siblings :877/:445 are already guarded, so `?.` is the intended shape.
		find: 'KDGetNPCBindingSlotForItem(restraint, npcID).sgroup',
		repl: 'KDGetNPCBindingSlotForItem(restraint, npcID)?.sgroup',
		sites: 2,
	},
	{
		// KDInventoryActions.ts:424 ("Cut".show) — KinkyDungeonStruggleGroups.find(...) is undefined
		// when no struggle group matches the worn item's Group. Crashes while the Inventory screen is
		// being DRAWN, so the game dies every frame rather than on interaction.
		find: '!sg.noCut', repl: '!sg?.noCut', sites: 3,
	},
	{
		// KDInventoryActions.ts:429 ("Cut".valid) — same `sg`, same miss, one line later.
		find: '!sg.blocked', repl: '!sg?.blocked', sites: 14,
	},
];
const SGROUP_PATCH_SITES = BUNDLE_PATCHES[0].sites;   // kept for the spec's real-bundle assertion

function patchServedBundle(js) {
	let out = js;
	for (const p of BUNDLE_PATCHES) out = out.split(p.find).join(p.repl);
	return out;
}

// Patched bundle cache, invalidated by mtime so a rebuild is picked up without a restart.
let bundleCache = null;   // { mtimeMs, body }

function serveBundle(filePath, stat) {
	if (!bundleCache || bundleCache.mtimeMs !== stat.mtimeMs) {
		const raw = fs.readFileSync(filePath, 'utf8');
		for (const p of BUNDLE_PATCHES) {
			const found = raw.split(p.find).length - 1;
			if (found !== p.sites) {
				console.log(`  [patch] "${p.find}": expected ${p.sites} site(s), found ${found}` +
					(found === 0 ? ' — upstream may have fixed it; drop this entry.' : ' — COUNT IS STALE, check the bundle.'));
			}
		}
		bundleCache = { mtimeMs: stat.mtimeMs, body: patchServedBundle(raw) };
	}
	return bundleCache.body;
}

function safeJoin(root, urlPath) {
	const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
	const p = path.normalize(path.join(root, clean));
	if (!p.startsWith(root)) return null;     // path-traversal guard
	return p;
}

function serveStatic(req, res) {
	let urlPath = req.url.split('?')[0].split('#')[0];
	if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
	if (urlPath === CODEC_ROUTE) {                       // KDM-162: generated, not on disk
		res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' });
		res.end(CODEC_BODY);
		return;
	}
	const filePath = safeJoin(REPO_ROOT, urlPath);
	if (!filePath) { res.writeHead(400); res.end('bad path'); return; }

	fs.readFile(filePath, (err, data) => {
		if (err) { res.writeHead(404); res.end('not found: ' + urlPath); return; }
		const ext = path.extname(filePath).toLowerCase();
		const type = MIME[ext] || 'application/octet-stream';
		if (urlPath === '/index.html') {
			let html = data.toString('utf8');
			const tags = INJECT.map((s) => `<script src="${s}"></script>`).join('\n');
			html = html.replace('</body>', `${tags}\n</body>`);
			res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
			res.end(html);
			return;
		}
		if (urlPath === '/out/main.js') {
			let body;
			try {
				body = serveBundle(filePath, fs.statSync(filePath));
			} catch (e) {
				// Never let the workaround take the game down — serve the bundle unpatched.
				console.log('  [patch] bundle patch failed, serving unpatched: ' + e.message);
				body = data.toString('utf8');
			}
			res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
			res.end(body);
			return;
		}
		res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
		res.end(data);
	});
}

function start(port = PORT) {
	// True lockstep (KD-085 R8): the shared turn advances only when BOTH players have
	// acted — required for random conflict resolution (need all actions in hand). So
	// act in BOTH windows each turn (move/attack/wait). (autoAdvance is left available
	// on WSBridge as a no-conflict solo-testing shortcut, but off here.)
	// idleGraceMs (KD-087): if a player is idle/finished (e.g. their click-to-move route
	// ended) the server auto-"wait"s them after this delay so a partner who is still
	// walking isn't deadlocked. A `wait` is never a contested action (R9 safe).
	// DEFAULT 0 = strict lockstep — the turn ALWAYS waits for both humans (a 2s grace
	// felt like "it didn't wait for me" when a player paused to think). Set a positive
	// KD_IDLE_GRACE_MS (e.g. 30000) to re-enable auto-pass / self-heal from a stuck client.
	const graceMs = parseInt(process.env.KD_IDLE_GRACE_MS || '0', 10);
	// KD_PVP=1 starts the session in global PvP (peers see each other as Enemy — KD-094).
	const pvp = /^(1|true|on)$/i.test(process.env.KD_PVP || '');
	// KD_START_RESTRAINT=<name> equips every player with that worn restraint at start (UAT aid, KD-101).
	const startRestraint = process.env.KD_START_RESTRAINT || '';
	// KD_WEAR_RESTRAINT=<Name[,Name]> puts items straight ON every player at start. Self-equipping
	// from the inventory is a delayed action that cannot complete in co-op (see SwapSession), so this
	// is the way to UAT anything about being bound — e.g. movement speed in heels + ankle shackles.
	const wearRestraint = process.env.KD_WEAR_RESTRAINT || '';
	const bridge = new WSBridge({ requiredPlayers: 2, seed: 'coop-demo-seed', idleGraceMs: graceMs, pvp, startRestraint, wearRestraint });
	const server = http.createServer(serveStatic);
	bridge.attach(server);
	return new Promise((resolve) => {
		server.listen(port, () => {
			const addr = server.address();
			resolve({ server, bridge, port: addr.port });
		});
	});
}

module.exports = { start, patchServedBundle, SGROUP_PATCH_SITES };

// Bump this when server-side MP code changes, so a stale-process restart is obvious.
const MP_BUILD = 'KD-101 stun-gate + real-tie';

// Run directly: node tools/mp-server/demo-server.js
if (require.main === module) {
	// eslint-disable-next-line no-console
	console.log(`\n  [mp-server] BUILD: ${MP_BUILD}\n`);
	start(PORT).then(({ port }) => {
		// eslint-disable-next-line no-console
		console.log(`\n  Co-op demo running:  http://localhost:${port}/#coop=A   (window 1)`);
		console.log(`                       http://localhost:${port}/#coop=B   (window 2)\n`);
	});
}
