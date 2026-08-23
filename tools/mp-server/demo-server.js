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
const { KD_DELTA_BROWSER } = require('./kd-delta');
const { KD_PEACE_DIALOGUE_BROWSER } = require('./kd-peace-dialogue');
const { KD_DISCONNECT_DIALOGUE_BROWSER } = require('./kd-disconnect-dialogue');
const { KD_ABSENT_RESET_BROWSER } = require('./kd-absent-reset');

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
// KDM-206: the delta merge half, served from the SAME source the server diffs with — a diff/merge
// pair that drifts apart corrupts state silently, so there is exactly one definition.
const DELTA_ROUTE = '/mp/kd-delta.js';
// KDM-230: the peace-offer DIALOGUE definition. Same two-runtime rule as the codec and the delta —
// the server evals this exact text into the world, the browser is served it as a script.
const PEACE_DLG_ROUTE = '/mp/kd-peace-dialogue.js';
// The "absent from the bundle ⇒ back to its default" rule, shared with the host for the same reason.
// KDM-251: the disconnect dialogues, on the same two-runtime terms as the peace one.
const DISCONNECT_DLG_ROUTE = '/mp/kd-disconnect-dialogue.js';
const ABSENT_RESET_ROUTE = '/mp/kd-absent-reset.js';
const CODEC_BODY = `${KD_CODEC}\n;(typeof window !== 'undefined' ? window : globalThis).KDCodec = ` +
	`{ kdEnc: kdEnc, kdDec: kdDec, kdSer: kdSer };\n`;

/**
 * The synthetic script routes: generated from the server's own source text, never files on disk (a
 * real file under `client/` would be a second copy, free to go stale against the host's).
 *
 * One table rather than a route-const + body-const + handler-block per entry — that shape was
 * repeated verbatim three times and every new shared module cloned it again.
 */
const SYNTHETIC_ROUTES = {};
SYNTHETIC_ROUTES[CODEC_ROUTE] = CODEC_BODY;
SYNTHETIC_ROUTES[DELTA_ROUTE] = KD_DELTA_BROWSER;
SYNTHETIC_ROUTES[PEACE_DLG_ROUTE] = KD_PEACE_DIALOGUE_BROWSER;
SYNTHETIC_ROUTES[DISCONNECT_DLG_ROUTE] = KD_DISCONNECT_DIALOGUE_BROWSER;
SYNTHETIC_ROUTES[ABSENT_RESET_ROUTE] = KD_ABSENT_RESET_BROWSER;

// Scripts injected just before </body> in index.html (in order).
const INJECT = [
	CODEC_ROUTE,                    // must precede render-client.js — it consumes window.KDCodec
	ABSENT_RESET_ROUTE,             // must precede render-client.js — it consumes window.KDAbsentReset
	DELTA_ROUTE,                    // must precede coop-bootstrap.js — it consumes window.KDDelta
	'/tools/mp-server/client/render-client.js',
	'/tools/mp-server/client/coop-bootstrap.js',
	// KDM-225: the peace submenu. AFTER coop-bootstrap — it sends through `window.__coop.sendAction`.
	'/tools/mp-server/client/coop-peace.js',
	// KDM-233: the main-menu Multiplayer entry + host/join screens. AFTER coop-bootstrap — it drives
	// `window.__coopConnect` / `window.__coopAnswerJoin`.
	'/tools/mp-server/client/coop-lobby.js',
	PEACE_DLG_ROUTE,                // KDM-230: needs KDDialogue, so after the bundle is in scope
	DISCONNECT_DLG_ROUTE,           // KDM-251: same — needs KDDialogue in scope
];

/* ── Serve-time workarounds for UPSTREAM crashes ──────────────────────────────────────────────
 *
 * Rewriting the compiled bundle on the way out is the LAST resort in the plugin rule's preference
 * order (runtime wrapping > stock API/data > text rewrite). It stays, but it is not open-ended:
 * every entry is governed by the policy in `README.md` → "Bundle-patch policy", enforced by
 * `tests/unit/mp-bundle-patch-policy.spec.ts`.
 *
 *   id          stable handle a verdict is reported against
 *   find/repl   the rewrite (`split`/`join`, so it must be idempotent)
 *   sites       expected match count in the bundle — drift is reported loudly
 *   repro       how a human reaches the crash this entry prevents
 *   upstream    issue URL, or `unfiled: <path>` pointing at the drafted report in this repo
 *   removeWhen  the condition under which this entry MUST be deleted
 *
 * Patched on the way OUT rather than on disk, so `Game/src/**` stays byte-identical to upstream
 * (zero game-source edits). Every entry below is the same defect shape: an unguarded lookup result
 * (`.find()` / a helper returning null) dereferenced without `?.`. Optional chaining only changes
 * behaviour where the code currently THROWS, so guarding is safe; the callers already handle a
 * falsy value.
 * ─────────────────────────────────────────────────────────────────────────────────────────── */
const UPSTREAM_DRAFTS = 'unfiled: tools/mp-server/UPSTREAM_ISSUES.md';

const BUNDLE_PATCHES = [
	{
		id: 'npcrestrain-null-slot-sgroup',
		// NPCRestrain.ts:310, :402 — KDGetNPCBindingSlotForItem returns null when no binding row
		// accepts the item on that NPC (KDGenRestraintUniform.ts:38, :48). Siblings :877/:445 are
		// already guarded, so `?.` is the intended shape, and the next line's `if (slot_temp)`
		// already handles null: the click becomes the no-op it should have been.
		find: 'KDGetNPCBindingSlotForItem(restraint, npcID).sgroup',
		repl: 'KDGetNPCBindingSlotForItem(restraint, npcID)?.sgroup',
		sites: 2,
		repro: 'PvP: open the bind menu on the peer (an Enemy) and CLICK an item no binding row on ' +
			'that NPC accepts → "Cannot read properties of null (reading \'sgroup\')".',
		upstream: UPSTREAM_DRAFTS,
		removeWhen: 'NPCRestrain.ts guards both reads with `?.` — observable here as this entry ' +
			'matching 0 sites in out/main.js (audit verdict "delete-me").',
	},
	{
		id: 'kdinventoryactions-sg-nocut',
		// KDInventoryActions.ts:424 ("Cut".show) — KinkyDungeonStruggleGroups.find(...) is undefined
		// when no struggle group matches the worn item's Group.
		find: '!sg.noCut', repl: '!sg?.noCut', sites: 3,
		repro: 'Open the Inventory screen while a worn item has no matching struggle group → throws ' +
			'while the screen is being DRAWN, so the game dies every frame, not just on interaction.',
		upstream: UPSTREAM_DRAFTS,
		removeWhen: 'KDInventoryActions.ts guards the find() result — this entry matches 0 sites. ' +
			'Our own trigger (a client that never rebuilt KinkyDungeonStruggleGroups) was fixed in ' +
			'KDM-156; this remains only as belt-and-braces for the genuine upstream hole.',
	},
	{
		id: 'kdinventoryactions-sg-blocked',
		// KDInventoryActions.ts:429 ("Cut".valid) — same `sg`, same miss, one line later.
		find: '!sg.blocked', repl: '!sg?.blocked', sites: 14,
		repro: 'Same screen and same missing struggle group as `kdinventoryactions-sg-nocut`, one ' +
			'line later in the same action definition.',
		upstream: UPSTREAM_DRAFTS,
		removeWhen: 'Same as `kdinventoryactions-sg-nocut` — deleted together when upstream guards ' +
			'the lookup and this entry matches 0 sites.',
	},
];

// The policy, as data: an entry missing any of these is not a patch, it is a mystery.
const PATCH_POLICY_FIELDS = ['id', 'find', 'repl', 'sites', 'repro', 'upstream', 'removeWhen'];

/**
 * Policy check — returns a list of human-readable violations ([] means compliant).
 * Called at boot (`start`) and asserted by the policy spec, so a new entry cannot be added
 * without its repro, upstream report and removal condition.
 */
function validateBundlePatchPolicy(patches = BUNDLE_PATCHES) {
	const out = [];
	for (const [i, p] of patches.entries()) {
		const id = p && p.id ? `"${p.id}"` : `#${i}`;
		for (const field of PATCH_POLICY_FIELDS) {
			const v = p ? p[field] : undefined;
			const blank = v === undefined || v === null ||
				(typeof v === 'string' && v.trim() === '');
			if (blank) out.push(`patch ${id}: missing or blank required field "${field}"`);
		}
	}
	return out;
}

/**
 * Expiry check — count each entry's sites in the given bundle text and return a verdict per entry:
 *   'ok'        the expected number of sites is present
 *   'delete-me' ZERO sites — upstream fixed it (or the emitted text changed shape); the entry is
 *               dead code and must be removed, along with its workaround docs
 *   'stale'     some other count — our number is wrong and we may be missing a site
 * Structured on purpose: a console line is not a signal, a verdict a test can assert on is.
 */
function auditBundlePatches(js, patches = BUNDLE_PATCHES) {
	return patches.map((p) => {
		const found = js.split(p.find).length - 1;
		const verdict = found === 0 ? 'delete-me' : (found === p.sites ? 'ok' : 'stale');
		const tail = verdict === 'delete-me'
			? ' — upstream fixed it; DELETE this entry (see its removeWhen).'
			: (verdict === 'stale' ? ' — COUNT IS STALE, check the bundle.' : '');
		return {
			id: p.id, find: p.find, expected: p.sites, found, verdict,
			message: verdict === 'ok' ? ''
				: `[patch] ${p.id}: expected ${p.sites} site(s), found ${found}${tail}`,
		};
	});
}

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
		for (const row of auditBundlePatches(raw)) {
			// eslint-disable-next-line no-console
			if (row.message) console.log(`  ${row.message}`);
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
	if (Object.prototype.hasOwnProperty.call(SYNTHETIC_ROUTES, urlPath)) {   // generated, not on disk
		res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' });
		res.end(SYNTHETIC_ROUTES[urlPath]);
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

function start(port = PORT, overrides = null) {
	// Boot-time policy gate: a BUNDLE_PATCHES entry without its repro/upstream report/removal
	// condition is a patch nobody can ever retire. Loud, not fatal — the demo must still start.
	for (const v of validateBundlePatchPolicy()) {
		// eslint-disable-next-line no-console
		console.log(`  [patch] POLICY VIOLATION — ${v}`);
	}
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
	// KDM-164: KD_CLASSIC_HEELS=1 turns on the stock ClassicHeels perk, which is what makes
	// `heelpower` count toward slow (KinkyDungeonCalculateSlowLevel ignores it otherwise). Seeding a
	// restraint used to switch this on implicitly — the MP layer choosing a perk for the player. Now
	// you ask for it, or it stays off.
	const classicHeels = /^(1|true|on)$/i.test(process.env.KD_CLASSIC_HEELS || '');
	// KDM-250: the heartbeat. ON by default — a safety mechanism that ships off is the mistake
	// `idleGraceMs` above made, and "one dead tab freezes the game" is the bug this epic is fixing.
	// KD_HB_INTERVAL_MS=0 turns it off for a UAT session that wants the old behaviour; the timeout is
	// deliberately generous because a peer whose JS loop is merely BUSY is indistinguishable from one
	// that is wedged, and a tight window would declare a live player dead for a slow frame.
	const hbIntervalMs = parseInt(process.env.KD_HB_INTERVAL_MS || '5000', 10);
	const hbTimeoutMs = parseInt(process.env.KD_HB_TIMEOUT_MS || '30000', 10);
	// KDM-235: `overrides` lets a caller (a spec) change a session knob without an env var. The
	// default is unchanged — two players, as every existing caller expects — and the one this exists
	// for is `requiredPlayers: 1`, a host who starts playing ALONE and is joined later.
	const bridge = new WSBridge(Object.assign({
		requiredPlayers: 2, seed: 'coop-demo-seed', idleGraceMs: graceMs,
		hbIntervalMs, hbTimeoutMs,
		pvp, startRestraint, wearRestraint, classicHeels,
	}, overrides || {}));
	const server = http.createServer(serveStatic);
	bridge.attach(server);
	return new Promise((resolve) => {
		server.listen(port, () => {
			const addr = server.address();
			resolve({ server, bridge, port: addr.port });
		});
	});
}

module.exports = {
	start, patchServedBundle,
	BUNDLE_PATCHES, PATCH_POLICY_FIELDS, validateBundlePatchPolicy, auditBundlePatches,
};

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
