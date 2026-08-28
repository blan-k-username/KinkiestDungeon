/**
 * KDM-281 — every player-facing string the co-op client can put on screen, in one table, behind one
 * helper.
 *
 * ── THE DRIFT THIS ENDS ───────────────────────────────────────────────────────────────────────────
 * Two neighbouring files answered the same question differently. `coop-lobby.js` resolved its labels
 * through a private `text(key, fallback)` that reads KD's own `TextGet` — 29 call sites, each
 * carrying its English inline. `coop-bootstrap.js` wrote plain English straight into the very same
 * lobby fields through `lobbySay`, so one screen was half translatable: the buttons could be
 * localised and the refusal painted between them could not.
 *
 * Nobody caused that. Each task followed the file it was editing, which is the right local call and
 * the wrong global one — which is exactly why the answer is a shared module plus a guard
 * (`tests/unit/mp-client-strings.spec.ts`), and not a convention.
 *
 * ── WHY THE ENGLISH LIVES HERE AND NOT AT THE CALL SITE ───────────────────────────────────────────
 * `text('KDMPBack', 'Back')` reads well and does not scale: the source string is duplicated wherever
 * the key is used (`KDMPBack` had three copies, `KDMPModMore` two), so the copies can disagree, and
 * — the part that matters — a file full of legitimate inline prose gives a drift guard nothing to
 * bite on. It cannot tell `text('K', 'Back')` from `lobbySay({ error: 'Back' })`. With the English
 * in ONE table, "a prose literal in a client file" becomes an unambiguous red, and that is the
 * acceptance criterion this task was written around.
 *
 * ── TEMPLATING ────────────────────────────────────────────────────────────────────────────────────
 * Bare UPPERCASE tokens, substituted by name: `t('KDMPWorldSeed', { SEED: seed })`. This is the
 * convention the lobby already used (`text('KDMPModMore', '…and MORE more').replace('MORE', n)`),
 * kept rather than replaced — the point of this task is to stop having two conventions.
 *
 * Substitution is `split`/`join`, not `String.replace`: a replacement value containing `$&` or `$1`
 * would otherwise be interpreted, and one of these values is a mod list a player can influence.
 *
 * Concatenation is avoided where word order is the translator's business — `NAME wants to join your
 * game` rather than `name + ' wants to join your game'` — because a language that puts the verb
 * first cannot express that as a suffix.
 *
 * ── LOAD ORDER ────────────────────────────────────────────────────────────────────────────────────
 * FIRST of the client scripts that paint (see `INJECT` in demo-server.js): both `coop-bootstrap.js`
 * and `coop-lobby.js` consume `window.KDMPText`. Nothing here touches a bundle global, so it has no
 * ordering constraint of its own — it just has to precede its two consumers, which the spec asserts.
 *
 * ── TRANSLATION ───────────────────────────────────────────────────────────────────────────────────
 * `t()` asks KD's `TextGet` first and falls back to the English below, so a localised build that
 * knows `KDMPBack` wins and one that does not is unchanged. That is the whole integration: this file
 * registers nothing and overrides nothing. No non-English strings ship today — for the lobby's own
 * 29 keys either, which is the state this task inherited rather than one it created.
 */
(function () {
	'use strict';

	/**
	 * Key → English source string. The ONLY place a co-op UI string is written.
	 *
	 * Grouped by the screen that shows it. A key used by more than one screen (`KDMPBack`,
	 * `KDMPModMore`, `KDMPSomeone`) is listed once, under the first.
	 */
	var STRINGS = {
		// ── the menu entry and the root screen ────────────────────────────────────────────────────
		KDMPLobbyTitle:      'Multiplayer',
		KDMPHostGame:        'Host Game',
		KDMPContinueSave:    'Continue Save',
		KDMPJoinGame:        'Join Game',
		KDMPPerksBtn:        'Perks',
		KDMPCharBtn:         'Character',
		KDMPAboutBtn:        'How co-op differs',
		KDMPBack:            'Back',
		KDMPCancel:          'Cancel',
		KDMPSaveUnusable:    'That save cannot be continued.',
		// A page served without the co-op bootstrap — a status line rather than a throw, because the
		// lobby is still on screen and a blank one explains nothing.
		KDMPNoTransport:     'No transport available.',
		KDMPYourName:        'Your name',
		KDMPWorldSeedField:  'World seed (optional — the host\'s to choose)',

		// ── "How co-op differs" ───────────────────────────────────────────────────────────────────
		KDMPAboutTitle:      'Playing together is a little different',
		KDMPAboutPerks:      'Start perks are the party\'s — everyone\'s apply to everyone, debuffs included.',
		KDMPAboutHost:       'The host\'s settings and world seed govern the run.',
		KDMPAboutDescend:    'You descend together — the stairs wait for the whole party.',
		KDMPAboutTrade:      'Drop an item to hand it to your partner.',
		KDMPAboutPvP:        'PvP resets to co-op at the hub, and you can offer peace.',
		KDMPAboutRejoin:     'A dropped connection does not end the run — they can rejoin as themselves.',

		// ── the Host screen ───────────────────────────────────────────────────────────────────────
		KDMPShareAddress:    'Tell your friend to join:',
		KDMPShareLocalOnly:  'That is this machine only — your friend needs this computer\'s address on your network.',
		KDMPSomeone:         'Someone',
		KDMPWantsToJoin:     'NAME wants to join your game',
		KDMPModsToSend:      'They will be sent COUNT of your mods:',
		KDMPAcceptBtn:       'Accept',
		KDMPDeclineBtn:      'Decline',
		KDMPWaitingGuest:    'Waiting for someone to join…',

		// ── the Join screen ───────────────────────────────────────────────────────────────────────
		KDMPHostAddress:     'Host address',
		KDMPModsToGet:       'The host is running COUNT mods you don\'t have:',
		KDMPConnectBtn:      'Join',
		KDMPConnecting:      'Connecting…',

		// ── what the host's world looks like, and what it would cost to load ──────────────────────
		KDMPWorldLead:       'The host\'s game:',
		KDMPWorldSeed:       '• seed: SEED',
		KDMPModMore:         '…and MORE more',
		KDMPModConflict:     ' (a different version of yours)',
		KDMPModDegraded:     'Co-op: some of the host\'s mods could not be loaded — MODS',

		// ── OUR name for a world mode, used only when KD has none ─────────────────────────────────
		// `modeLabel` (coop-lobby.js) asks KD for its OWN word first — these are the fallback, and a
		// mode KD cannot name must never be shown to a guest as a raw identifier (KDM-283).
		KDMPModeRandom:          'Spell Choice: Random Spells',
		KDMPModeHard:            'Hard Mode',
		KDMPModeExtreme:         'Extreme Mode',
		KDMPModeSaveRogue:       'Save Mode: Roguelike',
		KDMPModeLootNone:        'Loot Recovery: Disabled',
		KDMPModeLootPartial:     'Loot Recovery: Partial',
		KDMPModePrisonEasy:      'Prison Strictness: Easy',
		KDMPModePrisonStrict:    'Prison Strictness: Strict',
		KDMPModePerksOff:        'Perk Progression: Disabled',
		KDMPModePerksMandatory:  'Perk Progression: Mandatory',
		KDMPModePerksDebuff:     'Perk Progression: Debuffs Only',
		KDMPModeProgKey:         'Progression Mode: Key Hunt',
		KDMPModeProgRandom:      'Progression Mode: Random',

		// ── KDM-281: what the CONNECTION says, previously plain English in coop-bootstrap.js ──────
		// These land in `lobby.status` / `lobby.error`, i.e. on the screens above, which is why they
		// belong in the same table rather than in a second one next to their sender.
		KDMPWaitingApproval: 'Waiting for the host to let you in…',
		KDMPStarting:        'Starting…',
		KDMPNoAnswer:        'No answer from WHERE — is the game hosting there?',
		KDMPCouldNotReach:   'Could not reach WHERE',
		// KDM-270 — a refusal that names another seat is an OFFER, not the end of the conversation.
		KDMPAlreadyHosting:  'Somebody is already hosting there — join them instead.',
		KDMPNobodyHosting:   'Nobody is hosting there yet — you can host it yourself.',
		// …and the refusals that really are final.
		KDMPRefusedDeclined: 'The host declined your request.',
		KDMPRefusedFull:     'That game is full.',
		KDMPRefusedBusy:     'The host is already answering someone else.',
		KDMPRefusedBuild:    'Different game versions — host has HOSTBUILD, you have GUESTBUILD.',
		KDMPRefusedOther:    'Refused: REASON',
	};

	/**
	 * KD's word for `key`, or `''` when it has none.
	 *
	 * One function rather than a guard per call site: `drawWorldSummary` had its own copy that tested
	 * for `'MISSING'` and let `[NotFound]` through, which is exactly how the second site drifted from
	 * the first.
	 */
	function kdText(key) {
		try {
			if (typeof TextGet !== 'function') return '';
			var s = String(TextGet(key) || '');
			if (!s || s === key) return '';
			if (s.indexOf('[NotFound]') >= 0 || s.indexOf('MISSING') >= 0) return '';
			return s;
		} catch (e) { return ''; }
	}

	/** Substitute bare UPPERCASE tokens. `split`/`join` so a `$&` in a value stays a `$&`. */
	function fill(s, params) {
		if (!params) return s;
		var out = String(s);
		for (var token in params) {
			if (!Object.prototype.hasOwnProperty.call(params, token)) continue;
			out = out.split(token).join(String(params[token] === undefined ? '' : params[token]));
		}
		return out;
	}

	/**
	 * The one helper. KD's translation if it has one, else the English source above.
	 *
	 * An undeclared key answers with the key itself rather than `''`: a blank line on the Host screen
	 * is the failure that looks like a layout bug, and `KDMPTypo` on screen names its own cause. The
	 * static guard is what stops one reaching a player.
	 */
	function t(key, params) {
		var s = kdText(key);
		if (!s) s = Object.prototype.hasOwnProperty.call(STRINGS, key) ? STRINGS[key] : key;
		return fill(s, params);
	}

	if (typeof Object.freeze === 'function') Object.freeze(STRINGS);

	var api = { t: t, fill: fill, kdText: kdText, STRINGS: STRINGS };
	if (typeof Object.freeze === 'function') Object.freeze(api);
	(typeof window !== 'undefined' ? window : globalThis).KDMPText = api;
})();
