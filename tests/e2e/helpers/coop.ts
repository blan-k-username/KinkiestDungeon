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
