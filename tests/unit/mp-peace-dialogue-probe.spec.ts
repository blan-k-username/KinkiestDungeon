/**
 * PROBE (KDM-230) — can the gateway open a KD DIALOGUE on a peer's bundle, and does it survive?
 *
 * The owner wants the peace offer to arrive as KD's modal dialogue rather than an entry on the
 * peer's own context menu. `KDStartDialog` stores the open dialogue in `KDGameData.CurrentDialog`,
 * which is per-player state the client re-adopts from every snapshot — so a client-only dialogue
 * would be closed by the next state frame. This measures the server-side route instead:
 * swap the peer in, open the dialogue, capture, and see whether it reaches their snapshot.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 300_000;

describe('PROBE — a server-opened dialogue on a peer bundle', () => {
	it('reaches that peer snapshot, and only that peer', async () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'peace-dialogue-probe', pvp: false });
		s.join('A'); s.join('B');
		await s.ready();

		const before = s.snapshotFor('B').bundle.gameData.CurrentDialog;

		// The pattern `apply()` uses for a ui action: swap in, act, capture back.
		s.world.restorePlayer(s.bundles.get('B'));
		const opened = s.world.eval(`(function(){
			if (typeof KDStartDialog !== 'function') return { err: 'no KDStartDialog' };
			try { KDStartDialog('GenericAlly', 'RemotePlayer', true, '', undefined); }
			catch (e) { return { err: String(e && e.message || e) }; }
			return {
				CurrentDialog: KDGameData.CurrentDialog,
				stage: KDGameData.CurrentDialogStage,
				speaker: KDGameData.CurrentDialogMsgSpeaker,
				drawState: (typeof KinkyDungeonDrawState !== 'undefined') ? KinkyDungeonDrawState : null,
			};
		})()`);
		s.bundles.set('B', s.world.capturePlayer());
		s.world.parkGlobalPlayer(1, 1);

		const forB = s.snapshotFor('B').bundle.gameData.CurrentDialog;
		const forA = s.snapshotFor('A').bundle.gameData.CurrentDialog;

		// eslint-disable-next-line no-console
		console.log('\nDIALOGUE PROBE: ' + JSON.stringify({ before, opened, forB, forA }, null, 2) + '\n');

		expect(opened.err, 'KDStartDialog must run headless').toBeUndefined();
		expect(forB, "the dialogue must reach B's own snapshot as state").toBeTruthy();
		expect(forA, 'and must NOT leak to A').toBeFalsy();

		// …and it must survive a turn, or a blocking prompt would vanish the moment anyone acts.
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });
		const afterTurn = s.snapshotFor('B').bundle.gameData.CurrentDialog;
		// eslint-disable-next-line no-console
		console.log('after a resolved turn: ' + JSON.stringify(afterTurn) + '\n');
		expect(afterTurn, 'a dialogue must not be wiped by the turn machinery').toBeTruthy();
	}, BOOT_TIMEOUT);
});
