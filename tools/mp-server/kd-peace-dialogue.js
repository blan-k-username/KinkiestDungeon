/**
 * tools/mp-server/kd-peace-dialogue.js  (KDM-230)
 *
 * THE PEACE-OFFER DIALOGUE — one definition, both runtimes.
 *
 * Exported as SOURCE TEXT for the same reason as `kd-codec.js` and `kd-delta.js`: it has TWO
 * consumers and they must not drift. The SERVER evals it into the authoritative world (that is where
 * the option's `clickFunction` actually runs, see below); the BROWSER is served the identical text as
 * a script so it can DRAW the dialogue and its buttons.
 *
 * WHY THE ANSWER IS NOT AN `mp:` ACTION, THE WAY THE OFFER IS. Clicking a dialogue option runs
 * `KDSendInput("dialogue", {dialogue, dialogueStage, click, enemy})`
 * (`KinkyDungeonDialogue.ts:187`) — a normal routed KD input. So the answer travels the path every
 * other input takes, the server applies it with that player swapped in, and KD's own `KDDoDialogue`
 * invokes the `clickFunction` SERVER-SIDE (`:502`). The gateway needs no private channel for it, and
 * the client need not know that answering means anything special.
 *
 * The click therefore records a decision through `KDCoopPeaceDecide`, a hook the SERVER installs in
 * the world. On the client that hook does not exist and the call is a guarded no-op — the client's
 * copy of this definition exists to render buttons, not to decide anything.
 */
'use strict';

const KD_PEACE_DIALOGUE = `
(function(){
	if (typeof KDDialogue === 'undefined' || !KDDialogue) return;
	if (KDDialogue.KDCoopPeace) return;                      // idempotent: served once, eval'd once

	function decide(accept) {
		// Server: records the answer for SwapSession to read. Client: absent, so nothing happens and
		// the routed input is what carries the click. Guarded rather than branched on runtime.
		if (typeof KDCoopPeaceDecide === 'function') KDCoopPeaceDecide(accept);
		return false;                                        // false = do not abort the dialogue exit
	}

	KDDialogue.KDCoopPeace = {
		response: 'KDCoopPeaceOffer',
		options: {
			Accept: { exitDialogue: true, clickFunction: function () { return decide(true); } },
			Refuse: { exitDialogue: true, clickFunction: function () { return decide(false); } },
		},
	};

	// Text keys. The dialogue body resolves as "r" + response, and each option as
	// "d" + <dialogue><stage>_<option> (KinkyDungeonDialogue.ts:132/176). A missing entry prints
	// "[NotFound] …" straight at the player — the failure this epic has already shipped twice.
	if (typeof addTextKey === 'function') {
		addTextKey('rKDCoopPeaceOffer', 'SPEAKER offers you peace. Do you accept?');
		addTextKey('dKDCoopPeace_Accept', 'Accept the truce.');
		addTextKey('dKDCoopPeace_Refuse', 'Refuse. The fight continues.');
	}
})();
`;

/** The browser-ready form — identical text, served as a script (demo-server.js INJECT). */
const KD_PEACE_DIALOGUE_BROWSER = KD_PEACE_DIALOGUE;

module.exports = { KD_PEACE_DIALOGUE, KD_PEACE_DIALOGUE_BROWSER };
