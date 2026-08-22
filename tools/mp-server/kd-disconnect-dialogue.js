/**
 * tools/mp-server/kd-disconnect-dialogue.js  (KDM-251)
 *
 * WHAT THE SURVIVOR IS TOLD WHEN THE OTHER PLAYER GOES AWAY — one definition, both runtimes.
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

	KDDialogue.${HOST_LOST_DIALOGUE} = {
		response: '${HOST_LOST_DIALOGUE}',
		options: {
			// ONE option. See the header: no continue, no timeout.
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
		addTextKey('r${HOST_LOST_DIALOGUE}',
			'You have lost contact with the host.|The game cannot go on without them — it is their world you are both in.|You can wait here as long as you like; if they come back, you carry on where you stopped.');
		addTextKey('d${HOST_LOST_DIALOGUE}_Quit', 'Give up waiting and leave.');

		addTextKey('r${PEER_LOST_DIALOGUE}',
			'Your partner has lost contact.|You can wait for them — the game stays paused, for as long as you like, and if they return you carry on where you stopped.|Or you can go on without them: their character leaves the dungeon, and the run becomes yours alone. That cannot be undone.');
		addTextKey('d${PEER_LOST_DIALOGUE}_Wait', 'Wait for them.');
		addTextKey('d${PEER_LOST_DIALOGUE}_Solo', 'Go on alone.');
	}
})();
`;

/** The browser-ready form — identical text, served as a script (demo-server.js INJECT). */
const KD_DISCONNECT_DIALOGUE_BROWSER = KD_DISCONNECT_DIALOGUE;

module.exports = {
	KD_DISCONNECT_DIALOGUE, KD_DISCONNECT_DIALOGUE_BROWSER, HOST_LOST_DIALOGUE, PEER_LOST_DIALOGUE,
};
