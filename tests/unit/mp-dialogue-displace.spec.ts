/**
 * KDM-300 — a gateway dialogue must not DESTROY the dialogue the player already had open.
 *
 * Every gateway-owned dialogue (peace offer, host-lost, peer-lost, the KDM-297 join ask) is opened by
 * `SwapSession._openOwnDialogue`, which calls `KDStartDialog` on the player's bundle unconditionally.
 * A host in the middle of a shop or an NPC conversation had it REPLACED: once our question was answered
 * the dialogue was simply gone. Now the displaced dialogue is set aside and comes back when ours closes
 * — whether the player answered it or the server withdrew it.
 *
 * ⚠️ THE ORACLE COMPARES THE WHOLE DIALOGUE STATE BY VALUE, captured before ours opened. "Some dialogue
 * is open afterwards" would pass if ours were simply left open; "CurrentDialog matches" would pass with
 * the stage or speaker lost. And the no-prior-dialogue control proves nothing is invented from thin air.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JOIN_ASK_DIALOGUE } = require('../../tools/mp-server/kd-disconnect-dialogue');

const BOOT_TIMEOUT = 300_000;
const FIELDS = ['CurrentDialog', 'CurrentDialogStage', 'CurrentDialogMsg', 'CurrentDialogMsgSpeaker',
	'CurrentDialogMsgPersonality', 'CurrentDialogMsgID', 'CurrentDialogMsgData', 'CurrentDialogMsgValue'];

/** The player's own dialogue state, by value, out of their bundle. */
function dialogueState(s: any, id: string) {
	const gd = s.snapshotFor(id).bundle.gameData || {};
	const out: any = {};
	for (const f of FIELDS) out[f] = gd[f] === undefined ? null : JSON.parse(JSON.stringify(gd[f]));
	return out;
}

/** Open a STOCK KD dialogue on A the way the game would — swap in, start it, capture back. */
function openStockDialogue(s: any) {
	s.world.restorePlayer(s.bundles.get('A'));
	const r = s.world.eval(`(function(){
		try { KDStartDialog('GenericAlly', 'RemotePlayer', true, '', undefined); }
		catch (e) { return String(e && e.message || e); }
		KDGameData.CurrentDialogStage = 'Untie';
		KDGameData.CurrentDialogMsgData = { MARKER: 'kdm-300' };
		return '';
	})()`);
	s.bundles.set('A', s.world.capturePlayer());
	s.world.parkGlobalPlayer(1, 1);
	return r;
}

const answer = (option: string) => ({
	kdType: 'dialogue', data: { dialogue: JOIN_ASK_DIALOGUE, dialogueStage: option, click: true },
});

describe('KDM-300 — our dialogue sets the player\'s own aside and gives it back', () => {
	let s: any = null;

	beforeAll(async () => {
		s = new SwapSession({ requiredPlayers: 1, seed: 'dialogue-displace', pvp: false });
		s.join('A');
		await s.ready();
	}, BOOT_TIMEOUT);

	afterAll(() => { try { s && s.close && s.close(); } catch (e) { /* noop */ } });

	it('control — with nothing open before, answering ours leaves nothing open', () => {
		const before = dialogueState(s, 'A');
		expect(before.CurrentDialog || '', 'control: nothing open to start with').toBe('');
		s.openJoinAskDialogue('A', 'Bee');
		expect(dialogueState(s, 'A').CurrentDialog).toBe(JOIN_ASK_DIALOGUE);
		const res = s.apply('A', answer('Decline'));
		expect(res.joinAnswer, 'the answer was read').toBe(false);
		expect(dialogueState(s, 'A').CurrentDialog || '', 'nothing conjured up').toBe('');
	}, BOOT_TIMEOUT);

	it('answering ours brings the displaced dialogue back — every field, by value', () => {
		expect(openStockDialogue(s), 'the stock dialogue opens headless').toBe('');
		const theirs = dialogueState(s, 'A');
		expect(theirs.CurrentDialog, 'control: the player is in a conversation').toBe('GenericAlly');

		s.openJoinAskDialogue('A', 'Bee');
		expect(dialogueState(s, 'A').CurrentDialog, 'ours is on top').toBe(JOIN_ASK_DIALOGUE);

		const res = s.apply('A', answer('Accept'));
		expect(res.joinAnswer, 'the answer was still read').toBe(true);
		expect(dialogueState(s, 'A'), 'their conversation, exactly as it was').toEqual(theirs);
	}, BOOT_TIMEOUT);

	it('a question the SERVER withdraws also gives theirs back', () => {
		const theirs = dialogueState(s, 'A');
		expect(theirs.CurrentDialog, 'still in the conversation from the previous case').toBe('GenericAlly');
		s.openJoinAskDialogue('A', 'Bee');
		s.closeJoinAskDialogue('A');
		expect(dialogueState(s, 'A')).toEqual(theirs);
	}, BOOT_TIMEOUT);

	it('re-opening ours over ours does not bury theirs under a copy of ours', () => {
		const theirs = dialogueState(s, 'A');
		s.openJoinAskDialogue('A', 'Bee');
		s.openJoinAskDialogue('A', 'Bee');           // a guest re-asking (KDM-298) re-opens it
		s.apply('A', answer('Decline'));
		expect(dialogueState(s, 'A'), 'one answer is enough to get back').toEqual(theirs);
	}, BOOT_TIMEOUT);
});
