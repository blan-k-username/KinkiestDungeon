/**
 * tools/mp-server/kd-disconnect-dialogue.js  (KDM-251)
 *
 * WHAT THE SURVIVOR IS TOLD WHEN THE OTHER PLAYER GOES AWAY — one definition, both runtimes.
 * (KDM-297: and what the host is ASKED when somebody wants to come in mid-run — the same presence
 * change in the other direction, with the same two consumers. See `JOIN_ASK_DIALOGUE`.)
 *
 * Exported as SOURCE TEXT for the same reason as `kd-codec.js`, `kd-delta.js` and
 * `kd-peace-dialogue.js`: it has TWO consumers and they must not drift. The SERVER evals it into the
 * authoritative world (that is where an option's `clickFunction` actually runs); the BROWSER is
 * served the identical text as a script so it can DRAW the dialogue and its buttons.
 *
 * WHY A DIALOGUE AND NOT A BANNER. KDM-234 S3 — the survivor must be told *in the game*. A corner
 * overlay is what the co-op harness already had, and it is exactly what a player does not read while
 * wondering why their keys stopped working. It is also opened SERVER-SIDE, for the reason KDM-230
 * measured: `KDStartDialog` writes `KDGameData.CurrentDialog`, which is per-player state the client
 * re-adopts from every snapshot — so a dialogue opened on the client is erased by the next state
 * frame, and a disconnect triggers one immediately.
 *
 * ⚠️ THE TWO ROLES ARE NOT SYMMETRIC (KDM-234 D5/D7), which is why there are two definitions here
 * and not one parameterised dialogue:
 *   - a GUEST who loses the host gets ONE option, quit. Never "continue" — with the host gone there
 *     is no world to continue (KDM-244 C3);
 *   - a HOST who loses a guest gets TWO, wait or solo. The world is theirs, so the run is theirs to
 *     keep (KDM-253 S4/D1).
 * Neither has a timeout: D7 makes the wait unbounded and bounded only by the deciding player's own
 * patience.
 *
 * A click routes back through KD's own input path (`KDSendInput('dialogue', …)`,
 * `KinkyDungeonDialogue.ts:187`), so the server applies it with that player swapped in and KD's own
 * `KDDoDialogue` invokes the `clickFunction` server-side. On the client that hook does not exist and
 * the call is a guarded no-op — the client's copy exists to render buttons, not to decide anything.
 * Same shape as the peace dialogue's `KDCoopPeaceDecide`.
 */
'use strict';

/** The guest's dialogue when the host has gone. Referenced by name in the pause gate's exemption. */
const HOST_LOST_DIALOGUE = 'KDCoopHostLost';

/** The HOST's dialogue when a guest has gone. The other half of the asymmetry — see the header. */
const PEER_LOST_DIALOGUE = 'KDCoopPeerLost';

/**
 * KDM-297 — the HOST's dialogue when somebody ASKS TO JOIN a game that is already running.
 *
 * The mirror image of the two above: presence changing in the other direction. It lives in this
 * module because it has the same two consumers and the same reason to be opened server-side — a host
 * who is playing is not on the lobby screen, so the lobby's Accept/Decline (KDM-233) never reaches
 * them, and a guest waited on "Waiting for the host…" for ever.
 *
 * Who is asking is not known until run time, so the body carries a `GUESTNAME` token that KD fills
 * from `KDGameData.CurrentDialogMsgData` (`KinkyDungeonDialogue.ts:134`). A guest with no name gets
 * the `Anon` body instead of a sentence with a hole in it — chosen server-side by setting
 * `CurrentDialogMsg`, so no English word is hard-coded outside the text keys.
 */
const JOIN_ASK_DIALOGUE = 'KDCoopJoinAsk';

/**
 * KDM-303 — told to the guest who has just been made the host, because the old host did not come back
 * within the grace period. One option: it is news, not a question.
 */
const NOW_HOST_DIALOGUE = 'KDCoopNowHost';

const KD_DISCONNECT_DIALOGUE = `
(function(){
	if (typeof KDDialogue === 'undefined' || !KDDialogue) return;
	if (KDDialogue.${HOST_LOST_DIALOGUE}) return;             // idempotent: served once, eval'd once

	/*
	 * KDM-253 S4/D1 — the HOST's choice. Two options and no third: the run is theirs to continue, so
	 * they may keep the seat open indefinitely or give it up, and nothing else may decide for them.
	 *
	 * NO TIMEOUT, deliberately (KDM-234 D7). A dialogue that resolved itself after N minutes would be
	 * a reconnect deadline in disguise, and would end somebody's co-op run while they were away from
	 * the keyboard.
	 *
	 * "Wait" is not a no-op that could be left out: it is how the host says "I have seen this and I
	 * am choosing to wait", which is the difference between an informed wait and a stuck game. It
	 * closes the dialogue and changes nothing else — and the host can be asked again.
	 */
	KDDialogue.${PEER_LOST_DIALOGUE} = {
		response: '${PEER_LOST_DIALOGUE}',
		options: {
			Wait: { exitDialogue: true, clickFunction: function () {
				if (typeof KDCoopPeerLostDecide === 'function') KDCoopPeerLostDecide(false);
				return false;
			} },
			Solo: { exitDialogue: true, clickFunction: function () {
				if (typeof KDCoopPeerLostDecide === 'function') KDCoopPeerLostDecide(true);
				return false;
			} },
		},
	};

	/*
	 * KDM-297 — let a friend into the run, or not. Two options, both ANSWERS: the question stays open
	 * until the host picks one or the guest withdraws (the server closes it then).
	 */
	KDDialogue.${JOIN_ASK_DIALOGUE} = {
		response: '${JOIN_ASK_DIALOGUE}',
		options: {
			Accept: { exitDialogue: true, clickFunction: function () {
				if (typeof KDCoopJoinAnswer === 'function') KDCoopJoinAnswer(true);
				return false;
			} },
			Decline: { exitDialogue: true, clickFunction: function () {
				if (typeof KDCoopJoinAnswer === 'function') KDCoopJoinAnswer(false);
				return false;
			} },
		},
	};

	/*
	 * KDM-303 — the new host is TOLD. One option: nothing is being asked.
	 */
	KDDialogue.${NOW_HOST_DIALOGUE} = {
		response: '${NOW_HOST_DIALOGUE}',
		options: {
			Ok: { exitDialogue: true },
		},
	};

	KDDialogue.${HOST_LOST_DIALOGUE} = {
		response: '${HOST_LOST_DIALOGUE}',
		options: {
			// ONE option: leave. KDM-303 — the countdown in the body is what replaced "wait for ever";
			// when it runs out a guest becomes the host, so there is still no "continue" to offer here.
			Quit: { exitDialogue: true, clickFunction: function () {
				if (typeof KDCoopSessionQuit === 'function') KDCoopSessionQuit();
				return false;                                  // false = do not abort the dialogue exit
			} },
		},
	};

	// Text keys. The body resolves as "r" + response and each option as "d" + <dialogue>_<option>
	// (KinkyDungeonDialogue.ts:132/176). A missing entry prints "[NotFound] …" straight at the
	// player — the failure this epic has already shipped twice.
	if (typeof addTextKey === 'function') {
		// KDM-303 — TIME is the remaining grace as m:ss, written by the SERVER every second
		// (CurrentDialogMsgData), so every guest counts down to the same moment.
		addTextKey('r${HOST_LOST_DIALOGUE}',
			'You have lost contact with the host.|The game is paused. If they come back, you carry on where you stopped.|If they are not back in TIME, you become the host and the run goes on.');
		addTextKey('d${HOST_LOST_DIALOGUE}_Quit', 'Leave the game.');

		addTextKey('r${NOW_HOST_DIALOGUE}',
			'The host did not come back.|You are the host now: the run goes on, and you answer anyone who asks to join.');
		addTextKey('d${NOW_HOST_DIALOGUE}_Ok', 'Carry on.');

		addTextKey('r${PEER_LOST_DIALOGUE}',
			'Your partner has lost contact.|You can wait for them — the game stays paused, for as long as you like, and if they return you carry on where you stopped.|Or you can go on without them: their character leaves the dungeon, and the run becomes yours alone. That cannot be undone.');
		addTextKey('d${PEER_LOST_DIALOGUE}_Wait', 'Wait for them.');
		addTextKey('d${PEER_LOST_DIALOGUE}_Solo', 'Go on alone.');

		addTextKey('r${JOIN_ASK_DIALOGUE}',
			'GUESTNAME is asking to join your game.|If you let them in, they arrive beside you in this dungeon and the two of you play on together.');
		addTextKey('r${JOIN_ASK_DIALOGUE}Anon',
			'Somebody is asking to join your game.|If you let them in, they arrive beside you in this dungeon and the two of you play on together.');
		addTextKey('d${JOIN_ASK_DIALOGUE}_Accept', 'Let them in.');
		addTextKey('d${JOIN_ASK_DIALOGUE}_Decline', 'Not now.');
	}
})();
`;

/** The browser-ready form — identical text, served as a script (demo-server.js INJECT). */
const KD_DISCONNECT_DIALOGUE_BROWSER = KD_DISCONNECT_DIALOGUE;

module.exports = {
	KD_DISCONNECT_DIALOGUE, KD_DISCONNECT_DIALOGUE_BROWSER, HOST_LOST_DIALOGUE, PEER_LOST_DIALOGUE,
	NOW_HOST_DIALOGUE,
	JOIN_ASK_DIALOGUE,
};
