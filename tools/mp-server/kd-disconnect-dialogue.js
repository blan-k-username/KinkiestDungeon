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
 * ⚠️ THE TWO ROLES ARE NOT SYMMETRIC (KDM-234 D5/D7). A guest who loses the host gets ONE option:
 * quit. Never "continue" — with the host gone there is no world to continue (KDM-244 C3) — and never
 * a timeout, because D7 makes the wait unbounded and bounded only by the guest's own patience. The
 * host's two-option wait/solo dialogue is KDM-253 and belongs in this same file when it lands.
 *
 * The Quit click routes back through KD's own input path (`KDSendInput('dialogue', …)`,
 * `KinkyDungeonDialogue.ts:187`), so the server applies it with that player swapped in and KD's own
 * `KDDoDialogue` invokes the `clickFunction` server-side. On the client that hook does not exist and
 * the call is a guarded no-op — the client's copy exists to render buttons, not to decide anything.
 * Same shape as the peace dialogue's `KDCoopPeaceDecide`.
 */
'use strict';

/** The guest's dialogue when the host has gone. Referenced by name in the pause gate's exemption. */
const HOST_LOST_DIALOGUE = 'KDCoopHostLost';

const KD_DISCONNECT_DIALOGUE = `
(function(){
	if (typeof KDDialogue === 'undefined' || !KDDialogue) return;
	if (KDDialogue.${HOST_LOST_DIALOGUE}) return;             // idempotent: served once, eval'd once

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
	}
})();
`;

/** The browser-ready form — identical text, served as a script (demo-server.js INJECT). */
const KD_DISCONNECT_DIALOGUE_BROWSER = KD_DISCONNECT_DIALOGUE;

module.exports = {
	KD_DISCONNECT_DIALOGUE, KD_DISCONNECT_DIALOGUE_BROWSER, HOST_LOST_DIALOGUE,
};
