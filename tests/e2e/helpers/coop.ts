/**
 * KDM-167: booting the two-browser co-op pair — the ONE place that waits for a session to start.
 *
 * Every MP e2e opens two windows against the demo server and waits for `__coop.connected` then
 * `__coop.started` on each. That block was copy-pasted into 17 specs (51 `waitForFunction` sites), so
 * the two knobs this suite actually needs — the timeout, and a failure message you can act on — had
 * 51 homes and were never turned.
 *
 * WHY IT MATTERS: a boot timeout here is the suite's dominant failure, and it is almost always HOST
 * CONTENTION, not a product bug. Each MP e2e runs two full game bundles (~600 preloaded assets each)
 * plus a node host with three headless instances, on a machine that also carries other projects'
 * containers. Measured across four runs: on a loaded host the suite takes ~1 h and boot times out; on
 * a quiet one it takes ~20 min and the same specs pass first try. A bare Playwright timeout reads like
 * a product failure and costs an hour to disprove, so `bootCoopPair` fails with the stage, the client,
 * the elapsed time and the host's container count instead.
 */
import type { Page } from '@playwright/test';
import { execSync } from 'child_process';

/**
 * Boot timeout for one wait stage. Override with KD_COOP_BOOT_TIMEOUT (ms) rather than editing specs.
 *
 * RAISED 150 s → 240 s (KDM-167). Every boot timeout ever recorded on this suite sat right on the old
 * ceiling — 150 062 ms, 151 091 ms, 151 670 ms against a 150 000 ms limit. Not one failed by a wide
 * margin, which is the signature of a budget set too tight rather than a session that is genuinely
 * stuck: boot was still progressing and simply ran out of room.
 *
 * This is a cold-start allowance for infrastructure (two full game bundles, ~600 preloaded assets
 * each, plus a node host running three headless instances) — NOT an assertion being relaxed. A real
 * hang still surfaces, and distinctly: a wait that dies early is reported as ABORTED (page died), for
 * which raising this number explicitly does nothing.
 */
export const COOP_BOOT_TIMEOUT = Number(process.env.KD_COOP_BOOT_TIMEOUT || 240_000);

/**
 * Per-test cap for the two-browser MP specs, previously copy-pasted as `test.setTimeout(300_000)`
 * into 16 of them.
 *
 * It MUST move together with COOP_BOOT_TIMEOUT: boot sits *inside* this budget, so raising the boot
 * allowance under a 300 s cap would just relocate the failure from the boot wait to the test timeout
 * and lose the diagnostic message in the process.
 */
export const MP_TEST_TIMEOUT = Number(process.env.KD_MP_TEST_TIMEOUT || 600_000);

/** Render-settle pause after both clients report started — preserved from the original inline block. */
const SETTLE_MS = 1500;

/**
 * How busy is the HOST? Best-effort and never fatal: it only ever decorates an error message.
 *
 * ⚠️ These tests run INSIDE the playwright container, which has no docker CLI and could not see the
 * host's containers anyway — so the number must come from the host. `tools/run-tests.sh` measures it
 * before launching and passes it in as KD_HOST_LOAD.
 *
 * The direct probe is only a fallback for someone running playwright outside the wrapper. It counts
 * lines in JS rather than shelling out to `docker ps -q | wc -l`, because in a pipeline a missing
 * `docker` still exits 0 through `wc` and reports "0" — which reads as "the host was idle" and would
 * send you hunting for a product bug. Reporting nothing beats reporting a comfortable lie.
 */
function hostLoad(): string | null {
	const injected = process.env.KD_HOST_LOAD;
	if (injected) return injected;
	try {
		const out = execSync('docker ps -q', { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
		const running = out.split('\n').filter(Boolean).length;
		return `${running} containers running`;
	} catch {
		return null;   // no docker here — say nothing rather than imply an idle host
	}
}

async function waitForCoop(page: Page, label: string, stage: 'connected' | 'started', timeout: number) {
	const t0 = Date.now();
	try {
		await page.waitForFunction(
			(s) => {
				const c = (window as any).__coop;
				return !!c && !!c[s];
			},
			stage,
			{ timeout },
		);
	} catch (e) {
		const load = hostLoad();
		// Ask the page what it DID reach — distinguishes "never connected" from "connected but the
		// session never started", which point at different halves of the stack.
		let state = 'unreadable';
		try {
			state = JSON.stringify(await page.evaluate(() => {
				const c = (window as any).__coop;
				return c ? { connected: !!c.connected, started: !!c.started, lastTick: c.lastTick } : null;
			}));
		} catch { /* page may be gone */ }
		// Distinguish "boot was too slow" from "the page died", because they need OPPOSITE remedies.
		//
		// The reliable signal is whether the page can still be read, NOT how long we waited. Measured:
		// a page that crashes mid-wait keeps the poller running until the full budget expires, so
		// elapsed time alone reported `TIMEOUT after 240 105 ms` for what was actually a crash — and
		// sent us to raise a budget that could never have helped. (Raising 150 s → 240 s duly bought
		// nothing but 90 s of extra waiting.) `state === 'unreadable'` means the page is gone.
		const elapsed = Date.now() - t0;
		const died = state === 'unreadable' || elapsed < timeout * 0.5;
		throw new Error(
			`[KDM-167] co-op boot ${died ? 'ABORTED (page died)' : 'TIMEOUT'}: client ${label} never ` +
			`reached "${stage}" after ${elapsed} ms (limit ${timeout} ms). Observed __coop = ${state}.\n` +
			(died
				? 'Failing this fast against that limit means the PAGE WENT AWAY (crash / context ' +
				  'disposed), not that boot was slow. Same contention family, different remedy: raising ' +
				  'KD_COOP_BOOT_TIMEOUT will NOT help — reduce concurrent load instead.\n'
				: 'It used the FULL budget, so boot was genuinely too slow — raising ' +
				  'KD_COOP_BOOT_TIMEOUT is the lever that applies here.\n') +
			(load ? `Host at failure: ${load}.\n` : '') +
			'Sibling contention signatures worth recognising: "Target crashed" / "Target page closed" ' +
			'(the browser process died outright), and a retry that fails EARLIER or slower than the ' +
			'first attempt.\n' +
			'This signature is USUALLY HOST CONTENTION, not a product bug — measured four times: on a ' +
			'loaded host the suite takes ~1 h and boot times out; on a quiet host the same specs pass ' +
			'first try in ~20 min. Before treating this as a regression, re-run this ONE spec:\n' +
			'    tools/run-tests.sh e2e <this-spec-path>\n' +
			'If it passes alone, it was contention. Raise KD_COOP_BOOT_TIMEOUT to give a known-loaded ' +
			'host more room.',
		);
	}
}

/**
 * Open both co-op clients and wait until the shared session is live in each.
 *
 * Order is load-bearing and preserved from the original inline block: A connects FIRST (it creates
 * the session), then B joins, and only then does the server start the shared world — so `started` is
 * awaited on both only after B has navigated.
 */
export async function bootCoopPair(
	A: Page,
	B: Page,
	port: number,
	opts: { timeout?: number; settleMs?: number } = {},
): Promise<void> {
	const timeout = opts.timeout ?? COOP_BOOT_TIMEOUT;
	await A.goto(`http://127.0.0.1:${port}/#coop=A`);
	await waitForCoop(A, 'A', 'connected', timeout);

	await B.goto(`http://127.0.0.1:${port}/#coop=B`);
	// both joined → server starts the shared world → both receive their first state
	await waitForCoop(A, 'A', 'started', timeout);
	await waitForCoop(B, 'B', 'started', timeout);

	await A.waitForTimeout(opts.settleMs ?? SETTLE_MS); // let render frames settle
}

/** The player's tile, read from the live entity. Shared so every spec reads position the same way. */
export async function coopPos(P: Page): Promise<{ x: number; y: number }> {
	// @ts-ignore bare let-global
	return P.evaluate(() => ({ x: KinkyDungeonPlayerEntity.x, y: KinkyDungeonPlayerEntity.y }));
}

/**
 * Move A by one tile, trying directions until one is actually OPEN, with B waiting so the turn can
 * resolve. Returns whether A ended up somewhere new.
 *
 * WHY this exists (KDM-204). A and B spawn ADJACENT, so the peer avatar — an ally under PvP-off —
 * blocks one neighbouring tile, and walls block others. A move into a blocked tile still RESOLVES a
 * turn (the input routed fine, lockstep worked, the tick advances) but the position does not change.
 * So a spec that hardcodes ONE direction and reads "did the position change?" is a map-dependent
 * oracle: it reports "input was lost" for a perfectly delivered input that simply hit a wall.
 *
 * `mp-input-matrix` hardcoded `sendMove(1, 0)` and did exactly that; `mp-coop-demo` had already paid
 * for the lesson and walks a direction list inline. This is that walk, owned in one place — a second
 * copy is how the two would drift.
 *
 * The direction order deliberately starts away from B. Callers that need the per-turn invariants of
 * the demo spec (B's view of A staying in sync) keep their own loop; this is the plain "get A to
 * move" primitive.
 */
export async function coopMoveAnyDirection(
	A: Page,
	B: Page,
	opts: { timeout?: number; dirs?: Array<[number, number]> } = {},
): Promise<{ moved: boolean; advanced: boolean; dir: [number, number] | null; from: { x: number; y: number }; to: { x: number; y: number } }> {
	const timeout = opts.timeout ?? 30_000;
	const dirs = opts.dirs ?? ([[-1, 0], [0, -1], [0, 1], [1, 0], [-1, -1], [-1, 1]] as Array<[number, number]>);
	const from = await coopPos(A);
	let advanced = false;
	let last = from;

	for (const [dx, dy] of dirs) {
		const t0 = await A.evaluate(() => (window as any).__coop.lastTick);
		await A.evaluate((d) => (window as any).__coop.sendMove(d.dx, d.dy), { dx, dy });
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		const turned = await A.waitForFunction((t) => (window as any).__coop.lastTick !== t, t0, { timeout })
			.then(() => true).catch(() => false);
		advanced = advanced || turned;
		if (!turned) break;          // routing/lockstep is broken — trying more directions proves nothing
		last = await coopPos(A);
		if (last.x !== from.x || last.y !== from.y) return { moved: true, advanced, dir: [dx, dy], from, to: last };
	}
	return { moved: false, advanced, dir: null, from, to: last };
}

/**
 * The keyboard key the GAME is currently bound to for one movement direction, as a Playwright key.
 *
 * WHY read it instead of typing a key literal (KDM-204). KD's movement bindings are `KinkyDungeonKey`
 * / `KinkyDungeonKeybindings` — a roguelike layout, NOT the arrows (`Game/src/base/KinkyDungeon.ts:162`
 * defaults to W/A/S/D, and the string "ArrowRight" appears nowhere in the game source). Specs that
 * pressed `ArrowRight` were pressing a key the game never listens to, then recording "a real keypress
 * produces no input at all" as a FACT about the transport. It was a fact about the keyboard layout.
 *
 * This is the same coupling `mp-uat-repro` proved against the overlay text: the answer is never to
 * hardcode the right key — that just drifts again on the next rebind — but to ask the live table.
 */
export async function coopMovementKey(P: Page, dir: 'Up' | 'Down' | 'Left' | 'Right'): Promise<string> {
	const key = await P.evaluate((d) => {
		// @ts-ignore bare let-globals — the game's live binding table and its derived array
		const kb = (typeof KinkyDungeonKeybindings !== 'undefined' && KinkyDungeonKeybindings) || null;
		// @ts-ignore
		const arr = (typeof KinkyDungeonKey !== 'undefined' && KinkyDungeonKey) || null;
		const byIndex: any = { Up: 0, Left: 1, Down: 2, Right: 3 };
		return (kb && kb[d]) || (arr && arr[byIndex[d]]) || null;
	}, dir);

	if (!key) {
		throw new Error(
			`the game exposes no movement binding for "${dir}" — KinkyDungeonKeybindings and ` +
			'KinkyDungeonKey were both unreadable. Refusing to guess a key: guessing is what made the ' +
			'"real input is lost" reading wrong in the first place (KDM-204).',
		);
	}
	// KD stores either a bare letter ('D') or a KeyboardEvent.code ('KeyD'); Playwright wants the
	// letter for both. Anything else (e.g. 'Space') is already a Playwright key name.
	const s = String(key);
	return /^Key[A-Z]$/.test(s) ? s.slice(3) : s;
}

/**
 * Move A by one tile using a REAL held keypress — the human input path, end to end, with no test hook
 * anywhere in the move itself.
 *
 * WHY it is shaped like this (KDM-204 / KDM-211). Two independent traps have to be dodged at once, and
 * dodging only one of them produces a confident, wrong reading about the transport:
 *
 *  1. THE KEY. KD binds a roguelike layout (`KinkyDungeonKeybindings` / `KinkyDungeonKey`, defaulting
 *     to W/A/S/D at `Game/src/base/KinkyDungeon.ts:162`); the arrow keys are bound to NOTHING and the
 *     string "ArrowRight" does not occur in the game source. Specs that pressed an arrow recorded "a
 *     real keypress produces no `move` input at all" as a fact about the proxy. It was a fact about
 *     the keyboard layout. So the key is read from the live table via `coopMovementKey` — never typed
 *     as a literal, because a literal is the same coupling repainted and drifts on the next rebind.
 *  2. THE DIRECTION. A and B spawn ADJACENT and the peer avatar is an ALLY under PvP-off, so it blocks
 *     its tile; walls block others. A blocked move still RESOLVES a turn — the input routed, lockstep
 *     worked, the tick advanced — while the position does not change. A hardcoded direction therefore
 *     makes `moved` a coin-flip on spawn geometry.
 *
 * The dodge for (2) is to establish an open tile by DOING it first: `coopMoveAnyDirection` walks the
 * direction list with the synthetic hook until A actually relocates, which means the tile A just LEFT
 * is provably open. The real keypress then goes back the way A came.
 *
 * HELD, not pressed: this harness renders at ~4 fps and KD samples transient key state once per frame,
 * so a normal keydown+keyup can land entirely between two polls. Holding spans several frames at any
 * frame rate. A real browser (~85 fps) does not need this.
 *
 * Returns the synthetic control leg as well as the real-key leg, so a caller can tell "the whole
 * session is broken" apart from "only the human path is broken" — the distinction the diagnostic
 * matrix in `mp-input-matrix` is built on.
 */
export async function coopRealKeyMove(
	A: Page,
	B: Page,
	opts: { timeout?: number; holdMs?: number } = {},
): Promise<{
	control: Awaited<ReturnType<typeof coopMoveAnyDirection>>;
	dir: 'Up' | 'Down' | 'Left' | 'Right';
	key: string;
	advanced: boolean;
	moved: boolean;
	from: { x: number; y: number };
	to: { x: number; y: number };
}> {
	const timeout = opts.timeout ?? 20_000;
	const control = await coopMoveAnyDirection(A, B, { timeout });

	// Back the way A came — that tile is open because A was standing on it a moment ago. With no
	// control move to invert (the session never resolved a turn), any direction is a guess; pick one
	// and let the caller read `control` to see that the guess was never the interesting part.
	const dir: 'Up' | 'Down' | 'Left' | 'Right' = control.dir
		? (control.dir[0] > 0 ? 'Left' : control.dir[0] < 0 ? 'Right' : control.dir[1] > 0 ? 'Up' : 'Down')
		: 'Right';
	const key = await coopMovementKey(A, dir);

	const from = await coopPos(A);
	const t0 = await A.evaluate(() => (window as any).__coop.lastTick);
	// Raw `page.mouse`, never `locator.click()`: KD draws into a canvas that Playwright's actionability
	// checks can wait on forever, and that hang looks exactly like a product red.
	await A.mouse.click(200, 200);
	await A.keyboard.down(key);
	await A.waitForTimeout(opts.holdMs ?? 2000);
	await A.keyboard.up(key);
	// Lockstep: the turn cannot resolve until B acts too.
	await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));

	const advanced = await A.waitForFunction((t) => (window as any).__coop.lastTick !== t, t0, { timeout })
		.then(() => true).catch(() => false);
	const to = await coopPos(A);
	return { control, dir, key, advanced, moved: to.x !== from.x || to.y !== from.y, from, to };
}
