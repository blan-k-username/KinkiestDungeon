/**
 * Session resume (restore-from-save + reconnect backoff).
 *
 * Single-page tests for the testable core: the backoff schedule and restoring
 * MPState from a save's `multiplayer` snapshot into a rejoin descriptor. The live
 * reconnect path itself (re-open the same slot) reuses the server rejoin route
 * already proven end-to-end by mp-coop-mvp's "disconnect and reconnect".
 */
import { test, expect } from '../helpers/playwright-fixtures';

test('reconnect backoff follows the 1/2/4/8/16s schedule capped at 30s', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore
		return [0, 1, 2, 3, 4, 5, 6].map((a) => KDMPBackoffDelay(a));
	});
	expect(r).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test('restore-from-save rebuilds MPState + a rejoin descriptor for an active session', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		const save = { multiplayer: { active: true, sessionId: 'sess-xyz', playerId: 1, host: '10.0.0.5', port: 8080, currentTurn: 7 } };
		// @ts-ignore
		const desc = KDMPRestoreFromSave(save);
		const out = {
			desc,
			// @ts-ignore — MPState adopted the saved identity, in a pre-connect state
			active: MPState.active, sessionId: MPState.sessionId, playerId: MPState.playerId,
			// @ts-ignore
			wsState: MPState.wsState, peerConnected: MPState.peerConnected, currentTurn: MPState.currentTurn,
		};
		// @ts-ignore
		MPResetState();
		return out;
	});
	expect(r.desc).toEqual({ host: '10.0.0.5', port: 8080, session: 'sess-xyz', player: 1 });
	expect(r.active).toBe(true);
	expect(r.sessionId).toBe('sess-xyz');
	expect(r.playerId).toBe(1);
	expect(r.currentTurn).toBe(7);
	expect(r.wsState).toBe('closed');      // pre-connect: about to re-open
	expect(r.peerConnected).toBe(false);
});

test('restore-from-save returns null for a single-player save (nothing to resume)', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore — no multiplayer block, and an inactive block
		const none = KDMPRestoreFromSave({});
		// @ts-ignore
		const inactive = KDMPRestoreFromSave({ multiplayer: { active: false, sessionId: 'x' } });
		return { none, inactive };
	});
	expect(r.none).toBeNull();
	expect(r.inactive).toBeNull();
});
