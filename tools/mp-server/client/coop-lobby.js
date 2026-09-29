/**
 * tools/mp-server/client/coop-lobby.js  (KDM-233)
 *
 * THE MULTIPLAYER ENTRY — Host / Continue / Join on KD's own class screen, "Host this game" on KD's
 * own in-game menu (KDM-294), "Join with this character" on KD's own save-slot screen (KDM-295), and
 * the handshake screen behind them.
 *
 * ── KDM-293: WHY THERE IS NO MULTIPLAYER MENU ─────────────────────────────────────────────────────
 * There was one, and it was the problem. It duplicated KD's own screens and — worse — a player who
 * had just built a character had to abandon it to reach co-op. The three ACTIONS now sit on `'Diff'`,
 * where the player already is; the two ROUTERS that used to send them to `'Stats'` and `'Diff'` are
 * gone, because a router to the screen you are standing on is the definition of redundant.
 *
 * What is left of ours is only what KD has no equivalent for: an address to type, a name, the host's
 * approve/decline prompt, the mod diff, the world summary, the refusals and the briefing.
 *
 * A classic (non-module) script sharing the bundle's global scope. It draws with KD's own widgets
 * and decides nothing about the session: hosting and joining are asked for through
 * `window.__coopConnect`, and the server is the authority on who is in (see `join-gate.js`).
 *
 * ── WHY A WRAPPER, AND WHY IT WORKS ───────────────────────────────────────────────────────────────
 * The prior art (`origin/feature/multiplayer`) put this entry in the game tree, editing the menu draw
 * at `KinkyDungeon.ts:1980` and adding a state case at `:3244`. The plugin rule forbids that, and it
 * turns out not to be necessary: KD's buttons are DATA, not code paths.
 *
 *   `KDButtonsCache` is wiped at the top of each frame   `KinkyDungeon.ts:1670-1671`
 *   `DrawButtonKDEx` paints AND registers {bounds, func} `KinkyDungeon.ts:3720`
 *   clicks are dispatched by iterating that cache        `KinkyDungeon.ts:4297, :4324`
 *
 * So a button drawn AFTER the stock frame is fully live. `_prev` must therefore be called FIRST —
 * not merely by convention (WRAP_CONVENTION.md) but because calling it second would wipe the cache
 * we just wrote into, and the entry would paint but never respond.
 *
 * ── THE NEW SCREEN ────────────────────────────────────────────────────────────────────────────────
 * `KinkyDungeonState = 'Multiplayer'` is a value the stock else-if chains do not match, so stock KD
 * paints nothing for it and we own the screen. `tests/e2e/mp-lobby-menu.spec.ts` asserts the button
 * set in that state is EXACTLY ours, which is what would catch a fallthrough painting the game
 * underneath the panel.
 *
 * ⚠️ MP-SPECIFIC (KDM-226's one-player test): a solo game has no lobby, no host and nobody to join.
 */
(function () {
	'use strict';

	if (typeof KinkyDungeonRun !== 'function') return;          // not in a KD page
	if (KinkyDungeonRun._kdmp_lobby_wrapped) return;            // WRAP_CONVENTION sentinel

	var W = 1000, MID = W - 350 / 2;

	var lobby = {
		// KDM-293 — 'connect' (address + name) | 'waiting' (a request is out, or we are hosting) |
		// 'about' (the briefing). The host's approval prompt is not a fourth phase: `drawHost` already
		// branches on `lobby.pending`, so "somebody is asking" is data, not navigation.
		phase: 'connect',
		// The KD screen this was opened from, so Back is a route back and not a dead end.
		returnTo: 'Menu',
		// Where the briefing hands off to once it has been read.
		next: 'connect',
		status: '',              // a line of prose for the player — never a code
		error: '',
		_drawCount: 0,           // observed by the double-wrap test
		pending: null,           // { clientId, name } — someone asking to join OUR game
		/**
		 * KDM-257 — `{hostOnly, guestOnly, conflict}` from KDM-249's `diffDeclarations`, as it arrives
		 * on `awaiting_approval` (guest) and `join_pending` (host). Null until one of those lands.
		 *
		 * Read-only here: this task RENDERS the diff and changes nothing about how it is computed or
		 * carried. If anything under `tools/mp-server/*.js` needed editing to make this paint, the
		 * scope had drifted.
		 */
		modDiff: null,
		// KDM-239 R4 — the host's world declaration (`{ modes, seed }`), shown to a guest that is
		// waiting for approval. null = not told / nothing declared, which paints nothing.
		world: null,
		/**
		 * KDM-287 — the addresses the SERVER says a friend could type, as they arrive on the host's
		 * own `joined` (`coop-bootstrap.js`). Empty until then, and empty forever on a machine that
		 * has only loopback — which is a real answer, not a missing one (see `shareLines`).
		 *
		 * Carried, never trusted: it crossed a socket, so `shareLines` re-checks its shape.
		 */
		share: [],
		/** Whatever is currently typed as the host's address. */
		address: function () {
			var el = document.getElementById('KDMPAddress');
			return el ? String(el.value || '') : '';
		},
		/**
		 * KDM-237 — the name this player will be known by, cached from the field every frame it is
		 * drawn.
		 *
		 * ⚠️ CACHED, not read on demand. `KDCullTempElements` destroys any field not drawn this
		 * frame, so by the time a button handler runs on a different view the element may be gone —
		 * and the host's is exactly that case: `KDMPHost` connects from the ROOT view, and a DOM read
		 * at that moment used to find nothing because the field only ever existed on the Join view.
		 * The cache is what lets one field serve both flows.
		 */
		name: '',
		playerName: function () { return lobby.name; },
		/**
		 * KDM-259 — the world seed this host is naming, cached from the field on the same terms as
		 * `name` above (and destroyed/re-created by `KDCullTempElements` for the same reason).
		 *
		 * ⚠️ `''` IS NOT "an empty seed" — it is "whatever the server was configured with", which is
		 * what every session meant before there was a field at all (`swap-session.js`:
		 * `hostWorld.seed || this.seed`). That is why nothing here ever substitutes a default of its
		 * own: the only two states are "the host named one" and "the host named nothing".
		 *
		 * Host-only by construction — it is passed by `hostConnect` and by nothing else, and the gate
		 * drops a guest's copy anyway (KDM-239 A5).
		 */
		seed: '',
		/**
		 * KDM-293 — the ONE declaration this lobby sends: class, outfit and perks, read from KD's own
		 * globals at the moment of declaring.
		 *
		 * ⚠️ THERE IS NOTHING TO CACHE ANY MORE, and that is the whole shape of this slice. The lobby
		 * used to send the player to KD's perk and character screens and BORROW their buttons to get
		 * a value back; now the player is already standing on `'Diff'` when they press Host or Join,
		 * so the true value is simply what KD's globals say, right now. `lobby.character`,
		 * `lobby.perks`, `charPick` and `perkPick` all existed only to carry a value across a screen
		 * change that no longer happens.
		 *
		 * Answers `null` when nothing was chosen, because "declared nothing" has exactly one meaning
		 * all the way down (`SwapSession.characterOf` → KD's own default): a player who built nothing
		 * is seated on KD's defaults.
		 *
		 * ⚠️ THE PERK LIST LEGITIMATELY CONTAINS WORLD KEYS. `KDUpdatePlugSettings`
		 * (`KinkyDungeon.ts:6116-6146`) writes 21 game-mode keys into the SAME `KinkyDungeonStatsChoice`
		 * Map the perk grid uses, so a guest who toggled Random Mode sends `randomMode` here. That is
		 * expected and is refused server-side, twice: `applyPerks` re-adds only keys KD's own
		 * `KinkyDungeonStatsPresets` knows (`join-gate.js:223`), and `applyModes` re-asserts the host's
		 * modes afterwards (`headless-host.js:1793`). Do not "fix" it by filtering here — the server is
		 * the authority, and a second filter would be a second thing to keep in step.
		 */
		playerCharacter: function () {
			try {
				return characterPackage(KinkyDungeonClassMode, KinkyDungeonCurrentDress,
					(typeof KinkyDungeonStatsChoice !== 'undefined' && KinkyDungeonStatsChoice)
						? Array.from(KinkyDungeonStatsChoice) : []);
			} catch (e) { return null; }
		},
		/**
		 * KDM-295 — `{character, name}` extracted from the save a player chose on KD's save-slot
		 * screen, or `null` for every other entry. Set by `open()`'s third argument and RESET by every
		 * `open()`, so it is per-entry and can never go stale: a player who backs out of a save-slot
		 * join and then joins from the class screen declares the class screen's character (R7).
		 */
		fromSave: null,
		/** What this entry declares: the chosen save's character, else KD's live globals. */
		declaration: function () {
			return lobby.fromSave ? lobby.fromSave.character : lobby.playerCharacter();
		},
		/**
		 * KDM-293 — open the handshake screen, remembering the screen we came from.
		 *
		 * `returnTo` is what makes Back a real route back rather than a dead end, and it is what lets
		 * KDM-272's briefing keep meaning something: the player can always return to the class grid
		 * and revise a choice they made before they were told the co-op rules. The old road showed the
		 * briefing once, upstream of the perk grid; that ordering is gone with the root menu, and this
		 * is what replaces it.
		 *
		 * `briefingSeen()` is the bootstrap's — the lobby asks, it does not own storage. Absent (a
		 * bundle-only test page) reads as "not seen", which shows the briefing rather than silently
		 * swallowing it.
		 */
		/**
		 * ⚠️ `action` RUNS AFTER THE BRIEFING, NEVER BEHIND IT. Host and Continue ask for a seat the
		 * moment they are pressed, and a first-ever player is shown the briefing on the way in — so
		 * passing the connect as a callback is what stops us advertising a session while the player is
		 * still reading the rules that govern it. KDM-272 put the briefing upstream of every
		 * declaration; the root menu used to guarantee that by being upstream of the buttons, and this
		 * is what guarantees it now that the buttons are on KD's screen.
		 */
		open: function (phase, action, source) {
			lobby.returnTo = KinkyDungeonState;
			lobby.fromSave = source || null;
			KinkyDungeonState = 'Multiplayer';
			lobby.next = phase || 'connect';
			lobby.error = '';
			lobby.status = '';
			if (briefingSeen()) {
				lobby.phase = lobby.next;
				if (action) action();
				return;
			}
			lobby.phase = 'about';
			lobby.pendingAction = action || null;
		},
		/** Whatever the briefing is holding back; consumed by its Back button. */
		pendingAction: null,
		/** Back to the screen the player came from. Never to a menu of ours — there isn't one. */
		close: function () { lobby.leave(); KinkyDungeonState = lobby.returnTo || 'Menu'; },
		/**
		 * KDM-236 T — the ONE way back to the lobby root.
		 *
		 * The Host view's Cancel, the Join view's Back and the root's own Back all come here. Three
		 * copies of "drop the socket, clear the screen" is exactly the duplication to avoid, and the
		 * root Back genuinely needs it too: it is reachable with a host socket open, by way of
		 * Host → Cancel → Back.
		 *
		 * `__coopDisconnect` is the bootstrap's — the lobby asks, it does not own the socket.
		 */
		leave: function () {
			if (typeof window.__coopDisconnect === 'function') {
				try { window.__coopDisconnect(); } catch (e) { /* nothing to drop */ }
			}
			lobby.phase = 'connect';
			lobby.pending = null;
			lobby.status = '';
			lobby.error = '';
			lobby.modDiff = null;
			lobby.world = null;   // KDM-239 R4 — cleared with the diff; both describe one join attempt
			// KDM-287 — cleared for the same reason: it describes the session we just left, and the
			// next one may be on a different port. A stale list would be a plausible-looking address
			// nobody is listening on, which is worse than the honest fallback.
			lobby.share = [];
		},
	};
	window.KDMPLobby = lobby;

	/**
	 * Ask the transport to connect. Supplied by the bootstrap (stage 4); absent in a bundle-only test
	 * page, which is why this degrades to a status line instead of throwing.
	 */
	function connect(opts) {
		if (typeof window.__coopConnect === 'function') {
			try { return window.__coopConnect(opts); } catch (e) { lobby.error = String(e && e.message || e); }
		} else {
			lobby.status = T('KDMPNoTransport');
		}
		return null;
	}

	/**
	 * KDM-272 — the two questions the briefing asks of storage, both answered by the bootstrap.
	 *
	 * Bridged here for the same reason `connect()` is bridged above: the lobby is a screen, and the
	 * one file that owns `kdcoop.` keys is `coop-bootstrap.js`. Absent — a bundle-only test page that
	 * injects the lobby script alone — degrades to "never seen, cannot remember", which shows the
	 * briefing every time. That is the safe direction: worst case the player is told twice.
	 */
	function briefingSeen() {
		if (typeof window.__coopBriefingSeen !== 'function') return false;
		try { return !!window.__coopBriefingSeen(); } catch (e) { return false; }
	}

	function markBriefingSeen() {
		if (typeof window.__coopMarkBriefingSeen !== 'function') return;
		try { window.__coopMarkBriefingSeen(); } catch (e) { /* storage disabled */ }
	}

	/**
	 * KDM-281 — the one text helper, shared with `coop-bootstrap.js`.
	 *
	 * `T(key[, params])` is KD's translation for `key` where it has one, else the English source in
	 * `client/coop-text.js`. `kdText(key)` is the raw ask, `''` when KD has no word — `modeLabel`
	 * needs that distinction, because a mode KD cannot name must fall back to OUR name and never to
	 * the raw identifier.
	 *
	 * ⚠️ KD ANSWERS A MISSING KEY WITH A MARKER, NOT WITH NOTHING. `TextGet` returns the literal
	 * string `"[NotFound] <key>"` — the failure `kd-peace-dialogue.js:46` records this epic as having
	 * shipped twice already. The old guard was `t !== key`, which that marker passes, so EVERY label
	 * in this lobby painted `"[NotFound] KDMPYourName"` at the player instead of its English. That
	 * guard now lives in `coop-text.js`; this comment stays because the trap is KD's, not ours.
	 *
	 * Hard dependency, deliberately: `coop-text.js` is injected before this file (demo-server.js
	 * `INJECT`, asserted by `mp-client-strings.spec.ts`). A local fallback here would be a second
	 * copy of the thing this task exists to remove.
	 */
	var KDMPT = (typeof window !== 'undefined' ? window : globalThis).KDMPText;
	var T = KDMPT.t;
	var kdText = KDMPT.kdText;

	// ---- the entries on KD's own class/start screen -----------------------------------------

	/**
	 * KDM-293 — Host / Continue Save / Join, on the screen the player is already standing on.
	 *
	 * ── WHY HERE AND NOT ON A MENU OF OURS ────────────────────────────────────────────────────────
	 * The root menu these three used to live on duplicated KD's own screens and, worse, forced a
	 * player who had just built a character to leave it behind. KD's road is `Menu → Name → Diff`;
	 * by the time you are here you have picked a class and (one stock button away) your perks. So
	 * these are actions on a character that already exists, and nothing has to be carried anywhere.
	 *
	 * The two buttons that are NOT here are the point: `KDMPPerks` and `KDMPChar` were routers to
	 * `'Stats'` and `'Diff'`, and a router to the screen you are on is the definition of redundant.
	 *
	 * ── GEOMETRY IS CORRECTNESS HERE, NOT LAYOUT ──────────────────────────────────────────────────
	 * `KinkyDungeonHandleClick` runs `KDProcessButtons()` before its `MouseIn` chain and returns on a
	 * hit (`KinkyDungeon.ts:6225`), so a button of ours that overlaps a stock one STEALS its clicks
	 * with both still painted. A right-hand column at x=1650 was chosen after a full-width row at
	 * y=860 was found to cover `backButton` at (1075, 900, 350, 64) — KD's own way off this screen,
	 * drawn by the setup-tab helper (`:7628`) rather than by the `'Diff'` branch, which is exactly why
	 * reading the branch did not reveal it.
	 *
	 * Clear of: the class grid (ends x=1622), `backButton` (x 1075-1425), `GoToWardrobe`
	 * (x 30-470, y 942) and the setup tabs (y 10-50). `mp-entry-diff.spec.ts` #11 asserts this by
	 * computing the rectangles rather than trusting this comment.
	 */
	var COL = 1650, COLW = 300;

	function drawDiffEntries() {
		// Asked BEFORE either action, because both connect straight from this screen — anything that
		// rides the handshake has to exist before the button is pressed. Same reason the root asked.
		drawField('KDMPSeed', T('KDMPWorldSeedField'), 'seed', 400, COL, COLW);
		drawField('KDMPName', T('KDMPYourName'), 'name', 500, COL, COLW);

		DrawButtonKDEx('KDMPHost', function () {
			lobby.open('waiting', function () { hostConnect(); });
			return true;
		}, true, COL, 650, COLW, 64, T('KDMPHostGame'), '#ffffff', '');

		// KDM-243 A5 — hosting a run that is ALREADY IN PROGRESS. Drawn only when there is a save to
		// continue, so a player who has never played is not offered a button that can only disappoint
		// them. The save is read at the PRESS, not at draw time — they may have been playing seconds
		// ago, and the freshest save is the one they mean.
		var saved = localSave();
		if (saved) {
			DrawButtonKDEx('KDMPContinue', function () {
				// A6 — the save is read at the PRESS and again inside the action, because the briefing
				// may sit between the two and the freshest save is still the one they mean.
				lobby.open('waiting', function () { hostSave(localSave()); });
				return true;
			}, true, COL, 720, COLW, 64, T('KDMPContinueSave'), '#ffffff', '');
		}

		DrawButtonKDEx('KDMPJoin', function () { lobby.open('connect'); return true; },
			true, COL, saved ? 790 : 720, COLW, 64, T('KDMPJoinGame'), '#ffffff', '');
	}

	// ---- the entry on KD's in-game menu -----------------------------------------------------

	/**
	 * KDM-294 — "Host this game": the run the player is ALREADY PLAYING becomes the session.
	 *
	 * The owner's brief was "let the Host start the game as usual SP, no difference", so hosting is
	 * reached from inside a solo game, on KD's own in-game menu (`KinkyDungeonDrawState === 'Restart'`),
	 * without a trip back to the main menu. `lobby.open` captures `returnTo = 'Game'`, so Cancel lands
	 * the player back on the menu they pressed this from, their run untouched and still solo — the
	 * page only becomes a co-op client once a guest is admitted (`enterGame` on a started `joined`).
	 *
	 * ── GEOMETRY IS CORRECTNESS, AND HERE THE CACHE CANNOT SEE THE RISK ───────────────────────────
	 * Three of this menu's controls are hand-rolled `MouseIn` hit-tests, not cache buttons (Save &
	 * Quit 975,650 · Capture 975,800 · Check Perks 1650,900 — `KinkyDungeonHUD.ts`, Restart branch),
	 * and `KDProcessButtons()` runs before them and returns on a hit. So a rectangle of ours over one
	 * of them silently steals it. (975, 900, 550, 64) is the vacated slot of KD's own commented-out
	 * `KinkyDungeonRestartYes` button: the menu's column, the row after Capture, clear of all of them.
	 * `mp-entry-game.spec.ts` #2/#3 prove it by geometry AND by real clicks.
	 *
	 * Not drawn inside a session (`__coop._entered`): a guest cannot host the host's game, and a host
	 * is already hosting it.
	 */
	function drawGameEntry() {
		if (KinkyDungeonDrawState !== 'Restart') return;
		if (window.__coop && window.__coop._entered) return;
		DrawButtonKDEx('KDMPHostRun', function () {
			// Read inside the action, after any briefing: the game is paused on our screen, so this is
			// still the run as the player left it — and it is the freshest save there is.
			lobby.open('waiting', function () {
				nameDefault(KDGameData && KDGameData.PlayerName);
				hostSave(currentRunSave());
			});
			return true;
		}, true, 975, 900, 550, 64, T('KDMPHostRun'), '#ffffff', '');
	}

	/**
	 * KDM-294 D294-2 — the run as it is RIGHT NOW, in the form KD itself saves it.
	 *
	 * KD's own recipe, verbatim from its "Get save code" (`KinkyDungeonHUD.ts`, Restart branch):
	 * `KinkyDungeonSaveGame(true)` + `LZString.compressToBase64`. `true` means "to a string only" —
	 * nothing is queued to storage, so pressing the entry and then cancelling leaves the player's own
	 * save exactly as it was. Not `localStorage.KinkyDungeonSave`: that is up to one autosave stale.
	 *
	 * `''` on any throw, which `hostSave` refuses in words rather than advertising a broken session.
	 */
	function currentRunSave() {
		try { return LZString.compressToBase64(JSON.stringify(KinkyDungeonSaveGame(true))); }
		catch (e) { return ''; }
	}

	/**
	 * KDM-243 A6 / KDM-294 D294-3 — host with a save, or refuse it in words and do NOT connect.
	 *
	 * The ONE judge-then-host, shared by Continue Save (the stored save) and Host this game (the live
	 * run): they differ only in where the string comes from.
	 */
	function hostSave(str) {
		if (!saveIsUsable(str)) {
			lobby.error = T('KDMPSaveUnusable');
			return;
		}
		hostConnect(str);
	}

	/**
	 * KDM-294 R7 — a player who typed no name is known by their character's, never by a blank.
	 * A name they DID type always wins. Shared with KDM-295, which takes it from a save slot.
	 */
	function nameDefault(n) {
		if (!lobby.name && n) lobby.name = String(n);
	}

	// ---- the entry on KD's save-slot screen -------------------------------------------------

	/**
	 * KDM-295 — "Join with this character": bring a character you already made, from a save slot.
	 *
	 * ── WHAT TRAVELS (owner's decision, 2026-09-29) ───────────────────────────────────────────────
	 * The CHARACTER: class, outfit, perk choices, and its name as the default name. NOT the run —
	 * floor, items, spells and gold stay in the slot, and the slot is never written. The connect
	 * phase says so before Connect is pressed (`KDMPSaveCharacterOnly`), because discarding progress
	 * SILENTLY was the trap this slice was filed to avoid. Carrying the run would need wire fields
	 * and server seating this epic ruled out.
	 *
	 * Added, not borrowed: every control on this screen stays KD's. Live exactly when KD's own
	 * "Play Slot" is — the same `LoadMenuCurrentSave` test `KDLoadGame` applies to itself. Placed
	 * directly above it, same column and width (1570, 832, 350, 44): in the gap between the
	 * preview panel (which ends at y=830 — 64 tall would sit on its border) and `KDLoadGame` at y=880.
	 * `mp-entry-slots.spec.ts` #2 checks every cache button — which on this screen is every control.
	 *
	 * An unreadable save does nothing when pressed: KD's own preview already says "Invalid" for it.
	 */
	function drawSlotsEntry() {
		var selected = (typeof LoadMenuCurrentSave === 'string' && LoadMenuCurrentSave !== '');
		DrawButtonKDEx('KDMPJoinSave', function () {
			var src = selected ? saveCharacter(LoadMenuCurrentSave) : null;
			if (!src) return true;
			lobby.open('connect', function () { nameDefault(src.name); }, src);
			return true;
		}, selected, 1570, 832, 350, 44, T('KDMPJoinSave'), selected ? '#ffffff' : '#888888', '');
	}

	/**
	 * KDM-295 — a save string → `{character, name}`, or `null` if it cannot be read.
	 *
	 * The three fields are the SAME three globals `playerCharacter()` reads live, as KD's own
	 * `KinkyDungeonGenerateSaveData` stored them: `startingClass` ← `KinkyDungeonClassMode`, `dress`
	 * ← `KinkyDungeonCurrentDress`, `statchoice` ← `Array.from(KinkyDungeonStatsChoice)`. So one
	 * builder serves both, and the class screen and the save slot cannot declare differently shaped
	 * packages. Decompressed with KD's own `DecompressB64`, the one `saveIsUsable` uses.
	 */
	function saveCharacter(str) {
		try {
			var d = JSON.parse(DecompressB64(String(str).trim()));
			if (!d || typeof d !== 'object') return null;
			var name = (d.KDGameData && d.KDGameData.PlayerName) || (d.saveStat && d.saveStat.name) || '';
			return {
				character: characterPackage(d.startingClass, d.dress, Array.isArray(d.statchoice) ? d.statchoice : []),
				name: String(name || ''),
			};
		} catch (e) { return null; }
	}

	/**
	 * KDM-295 D295-1 — the ONE character package: `{class?, outfit?, perks?}`, or `null` for "declared
	 * nothing" (never `{}` — see `playerCharacter`'s note on what `null` means downstream).
	 * `entries` are `[key, on]` pairs, which is what both `Array.from(KinkyDungeonStatsChoice)` and a
	 * save's `statchoice` are.
	 */
	function characterPackage(klass, outfit, entries) {
		var pkg = {};
		if (typeof klass === 'string' && klass) pkg.class = klass;
		if (typeof outfit === 'string' && outfit) pkg.outfit = outfit;
		var chosen = [];
		for (var i = 0; i < entries.length; i++) {
			var e = entries[i];
			if (e && e[1]) chosen.push(String(e[0]));
		}
		if (chosen.length) pkg.perks = chosen;
		return Object.keys(pkg).length ? pkg : null;
	}

	// ---- the handshake screen ---------------------------------------------------------------

	function drawLobby() {
		lobby._drawCount++;
		hideStockTextArea();
		DrawTextKD(T('KDMPLobbyTitle'), W, 120, '#ffffff', '#000000', 48);
		if (lobby.phase === 'waiting') return drawHost();
		if (lobby.phase === 'connect') return drawJoin();
		if (lobby.phase === 'about') return drawAbout();
	}

	/**
	 * KDM-295 — keep KD's save-slot paste box off OUR screen.
	 *
	 * ⚠️ A dedicated screen does NOT hide every stock field for free (a correction to KDM-291 §2).
	 * `saveInputField` is made by `ElementCreateTextArea`, not the per-frame `KDTextField`, so
	 * `KDCullTempElements` never removes it; KD removes it by hand in each of its own exits from
	 * `LoadSlots`, and ours is not one of them. Hidden, not removed: `ElementPosition` sets
	 * `display: inline` on every `LoadSlots` frame, so Back brings it back by KD's own hand, with
	 * whatever the player pasted still in it. A no-op on every other road, where it does not exist.
	 */
	function hideStockTextArea() {
		var el = document.getElementById('saveInputField');
		if (el && el.style.display !== 'none') el.style.display = 'none';
	}

	// ---- KDM-272: how co-op differs, said once ---------------------------------------------

	/**
	 * The six rules a co-op player cannot learn by dying.
	 *
	 * One array rather than six `DrawTextKD` calls, because the layout is a loop over it and a
	 * seventh rule should cost one line here and nothing else. Order is the Content list's: the perk
	 * rule first, because it is the only one that changes a decision the player cannot take back.
	 *
	 * ⚠️ RULES, NOT VALUES (epic AC2 / KDM-272 AC5). No perk is named, no cost, no floor count, no
	 * threshold — nothing that would put a gameplay constant in `tools/mp-server/**` or that would
	 * quietly go stale when the game rebalances. "Everyone's apply to everyone" stays true whatever
	 * the perk list is.
	 */
	var ABOUT_LINES = [
		'KDMPAboutPerks', 'KDMPAboutHost', 'KDMPAboutDescend',
		'KDMPAboutTrade', 'KDMPAboutPvP', 'KDMPAboutRejoin',
	];

	/**
	 * KDM-272 A2 — the briefing itself.
	 *
	 * A VIEW, not an overlay. It replaces the root rather than painting over it, which is the whole
	 * point: an overlay would leave `KDMPPerks` registered in `KDButtonsCache` underneath, and a
	 * player could press straight through the words explaining what pressing it costs their partner.
	 *
	 * ⚠️ MARKED SEEN HERE, IN THE DRAW, NOT ON `Back`. A player who closes the tab looking at this
	 * screen has been shown it, and hanging "once" off a button press makes it depend on an action we
	 * cannot require. The write is idempotent and the guard is the bootstrap's, so repeating it every
	 * frame the screen is up costs a `setItem` of the same value.
	 */
	function drawAbout() {
		markBriefingSeen();
		DrawTextKD(T('KDMPAboutTitle'),
			W, 200, '#ffd98a', '#000000', 30);
		for (var i = 0; i < ABOUT_LINES.length; i++) {
			DrawTextKD(T(ABOUT_LINES[i]),
				W, 280 + i * 62, '#ffffff', '#000000', 24);
		}
		// Straight to the phase this entry was headed for, NOT `lobby.leave()`: reading the briefing is
		// not cancelling anything, and `leave()` would drop a host socket that a Cancel→About detour
		// may already have left open.
		DrawButtonKDEx('KDMPBack', function () {
			lobby.phase = lobby.next || 'connect';
			var act = lobby.pendingAction;
			lobby.pendingAction = null;
			if (act) act();
			return true;
		}, true, MID, 700, 350, 64, T('KDMPBack'), '#ffffff', '');
	}

	/**
	 * KDM-237 N1 — "Your name", drawn by KD's class screen AND the connect phase from one function.
	 *
	 * Two call sites, one field: the host is asked on `'Diff'` (they connect straight from there, so
	 * the field has to exist before Host is pressed), and the guest keeps theirs beside the address
	 * where it already was. Writing it twice is how the two would drift apart.
	 *
	 * Seeded from `lobby.name` on creation, and caching back into it every frame, for the same reason
	 * `addressDefault()` exists: `KDTextField` honours `Value` only when it CREATES the element, and
	 * `KDCullTempElements` destroys any field not drawn this frame — so moving between screens
	 * destroys and re-creates this input, and the cache is what carries what the player typed across.
	 */
	function drawNameField(y) { drawField('KDMPName', T('KDMPYourName'), 'name', y); }

	/**
	 * KDM-259 — a labelled text field whose value lives in `lobby[key]`.
	 *
	 * One function because the name field and the seed field are the same widget with a different
	 * label: both are drawn on a screen the player leaves and comes back to, both are therefore
	 * destroyed by `KDCullTempElements`, and both survive only because of the cache-back on the last
	 * line. Writing that mechanic twice is how the second copy would forget it.
	 *
	 * KDM-293 — `x`/`w` default to the handshake screen's centred column; `drawDiffEntries` passes
	 * its own so the same widget can sit in the right-hand column on KD's class screen.
	 */
	function drawField(id, label, key, y, x, w) {
		var left = (x === undefined) ? MID : x;
		var width = (w === undefined) ? 350 : w;
		DrawTextKD(label, left + width / 2, y, '#ffffff', '#000000', 28);
		KDTextField(id, left, y + 30, width, 56, 'text', lobby[key], '24');
		var el = document.getElementById(id);
		if (el) lobby[key] = String(el.value || '');
	}

	/**
	 * KDM-259 — the ONE way this lobby asks for the host seat.
	 *
	 * Host and Continue Save differ by exactly one argument (the save) and were already two copies of
	 * the same declaration; the seed would have been the third field to keep in step across both.
	 * `save` is passed only when there is one, so pressing Host still starts a new game for a player
	 * who has a save sitting right there — the e2e control that KDM-243 pinned.
	 */
	function hostConnect(save) {
		var opts = {
			role: 'host',
			name: lobby.playerName(),
			character: lobby.declaration(),
			seed: lobby.seed,
		};
		if (save) opts.save = save;
		connect(opts);
	}

	/**
	 * KDM-243 D1 — the save this player would continue: KD's own current slot, and nothing else.
	 *
	 * One read of the one key KD's async save loop writes (`KinkyDungeon.ts:1520-1525`). No slot
	 * picker and no `KinkyDungeonDBSave`/indexedDB path — "continue the run I was playing" is the
	 * whole feature, and a second source would be a second thing to keep in step.
	 */
	function localSave() {
		try { return String(window.localStorage.getItem('KinkyDungeonSave') || ''); }
		catch (e) { return ''; }              // storage disabled: the button simply never appears
	}

	/**
	 * KDM-243 A6 — the courtesy check, run before the host advertises a session at all.
	 *
	 * Applies KD's OWN acceptance rule (`KinkyDungeon.ts:7079-7086`: a save is usable only if all
	 * seven of these are present) rather than a rule of our own, so this cannot refuse something the
	 * server would have loaded. It is NOT trusted — `_start` repeats it authoritatively, because a
	 * client can be old, lying, or somebody else's. What it buys is that the failure arrives
	 * privately and immediately, instead of after a friend has already been invited.
	 */
	function saveIsUsable(str) {
		if (!str) return false;
		try {
			var raw = DecompressB64(String(str).trim());
			if (!raw) return false;
			var d = JSON.parse(raw);
			return !!(d && d.spells && d.level !== undefined && d.checkpoint
				&& d.inventory && d.costs && d.rep && d.dress);
		} catch (e) { return false; }
	}

	/** At most three addresses, so the list cannot grow down the screen into the Cancel button. */
	var SHARE_SHOWN = 3;

	/** `host:port` → `host`. IPv6 arrives bracketed (`[::1]:8090`), which a bare split would mangle. */
	function hostOnly(hostport) {
		return String(hostport || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
	}

	/** Every spelling of "this machine", which is the one answer a friend cannot use. */
	var LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1|0\.0\.0\.0)$/i;

	/**
	 * KDM-287 — WHAT THE HOST SHOULD BE TOLD TO SHARE. The whole decision, in one pure function.
	 *
	 * The screen used to paint `location.host` unconditionally, under a comment that was candid about
	 * its assumption: "where THIS page came from … is exactly the thing to share", true only if the
	 * host browsed by their LAN IP — which is not what the launcher tells them to do. It tells them
	 * to open `http://localhost:8090/`, so the address they were handed to give a friend was
	 * `localhost:8090`, which on the friend's machine names the friend's machine.
	 *
	 * @param {string} here   the host's own origin (`location.host`)
	 * @param {string[]} share  what the server offered on `joined` (`lan-address.js`)
	 * @returns {{addresses: string[], note: string}}
	 *
	 * Three cases, and the middle one is the bug being fixed:
	 *   - `here` is NOT loopback ⇒ it, alone, unchanged. A host who DID browse by `192.168.1.24` is
	 *     looking at a shareable address already, and replacing it with the server's guess would be
	 *     this bug pointing the other way.
	 *   - `here` is loopback and the server named addresses ⇒ those. Several rather than one: the
	 *     server ranks them, but a multi-homed machine (VPN, docker, two NICs) can be ranked wrongly,
	 *     and showing three beats showing the wrong one with no alternative.
	 *   - nothing usable ⇒ `here` anyway, WITH a note saying what it is. Silence would be a screen
	 *     that looks correct and is not; a blank one would be worse than the bug.
	 *
	 * ⚠️ `share` CROSSED A SOCKET, so its shape is re-checked here rather than trusted. Anything that
	 * is not a plain `host:port` is dropped, which lands junk in the third case — a note the host can
	 * act on — instead of painting `undefined` at them.
	 */
	function shareLines(here, share) {
		var mine = String(here || '');
		var list = [];
		if (Object.prototype.toString.call(share) === '[object Array]') {
			for (var i = 0; i < share.length && list.length < SHARE_SHOWN; i++) {
				var s = (typeof share[i] === 'string') ? share[i] : '';
				if (/^[A-Za-z0-9.\-]+:\d+$/.test(s) && !LOOPBACK.test(hostOnly(s))) list.push(s);
			}
		}
		if (mine && !LOOPBACK.test(hostOnly(mine))) return { addresses: [mine], note: '' };
		if (list.length) return { addresses: list, note: '' };
		return {
			addresses: mine ? [mine] : [],
			note: T('KDMPShareLocalOnly'),
		};
	}

	function drawHost() {
		// KDM-287 — the address a friend types, which is NOT necessarily where this page came from.
		// See `shareLines` for which of the three it is; everything below moves down by `drop` so a
		// second and third line have somewhere to go, and `drop` is 0 for the one-line case this
		// screen has always had.
		DrawTextKD(T('KDMPShareAddress'), W, 260, '#ffffff', '#000000', 28);
		var share = shareLines(location.host, lobby.share);
		for (var i = 0; i < share.addresses.length; i++) {
			DrawTextKD(share.addresses[i], W, 320 + i * 46, '#fff6bc', '#000000', 40);
		}
		var y = 320 + share.addresses.length * 46;
		if (share.note) { DrawTextKD(share.note, W, y - 6, '#ffd0a0', '#000000', 22); y += 28; }
		var drop = Math.max(0, y - 366);          // 366 = one address, no note: today's layout exactly

		// THE GATE (E1-E3). With approval-only there is no code and no password — this prompt is the
		// entire admission decision, and the name is all the host has to judge by.
		if (lobby.pending) {
			DrawTextKD(T('KDMPWantsToJoin', { NAME: lobby.pending.name || T('KDMPSomeone') }),
				W, 410 + drop, '#ffffff', '#000000', 30);
			// KDM-257 R2 — what the host is agreeing to SEND. Between the question and the buttons,
			// because it is part of the question. The buttons move down by whatever it painted, so a
			// long list never lands on top of Accept.
			var below = drawModDiff(455 + drop, 'KDMPModsToSend');
			var btnY = below ? below + 30 : 470 + drop;   // R4: nothing painted => the stock layout, unchanged
			DrawButtonKDEx('KDMPAccept', function () { answer(true); return true; },
				true, MID - 190, btnY, 350, 64, T('KDMPAcceptBtn'), '#ffffff', '');
			DrawButtonKDEx('KDMPDecline', function () { answer(false); return true; },
				true, MID + 190, btnY, 350, 64, T('KDMPDeclineBtn'), '#ffffff', '');
			return;
		}

		DrawTextKD(lobby.status || T('KDMPWaitingGuest'),
			W, 400 + drop, '#ffffff', '#000000', 24);
		if (lobby.error) DrawTextKD(lobby.error, W, 440 + drop, '#ff8080', '#000000', 24);
		DrawButtonKDEx('KDMPBack', function () { lobby.close(); return true; },
			true, MID, 480 + drop, 350, 64, T('KDMPCancel'), '#ffffff', '');
	}

	function answer(accept) {
		lobby.pending = null;
		if (typeof window.__coopAnswerJoin === 'function') window.__coopAnswerJoin(accept);
	}

	/**
	 * KDM-236 A1/A3 — what the address field is pre-filled with.
	 *
	 * The address you last actually reached a host at, else this page's own origin. The memory lives
	 * in the bootstrap (`__coopLastAddress`), which is the only place that knows an address WORKED;
	 * the lobby just asks, and falls back cleanly on a page where the transport was never injected.
	 *
	 * This is read on every frame, but `KDTextField` honours `Value` only when it CREATES the element
	 * (`KinkyDungeonDraw.ts:5679`) and `KDCullTempElements` destroys any field not drawn this frame —
	 * so what the player types survives while the view is open, and leaving and returning genuinely
	 * re-offers the remembered value. No extra plumbing needed for either half.
	 */
	function addressDefault() {
		var remembered = '';
		if (typeof window.__coopLastAddress === 'function') {
			try { remembered = String(window.__coopLastAddress() || ''); } catch (e) { /* no storage */ }
		}
		return remembered || String(location.host || 'localhost:8090');
	}

	function drawJoin() {
		// KDM-295 R4 — said BEFORE Connect, every frame this phase is up: joining from a save brings
		// the character and leaves the run in the slot. Between the title (120) and the address (250).
		if (lobby.fromSave) {
			// Two lines, not one: a single sentence long enough to say both halves ran into KD's art
			// column (x<500) at a readable size — seen on a screenshot, not guessed.
			DrawTextKD(T('KDMPSaveCharacterOnly', { NAME: lobby.fromSave.name || T('KDMPSomeone') }),
				W, 172, '#ffd98a', '#000000', 22);
			DrawTextKD(T('KDMPSaveRunStays'), W, 204, '#ffd98a', '#000000', 22);
		}
		DrawTextKD(T('KDMPHostAddress'), W, 250, '#ffffff', '#000000', 28);
		KDTextField('KDMPAddress', MID, 280, 350, 56, 'text', addressDefault(), '64');
		drawNameField(370);

		if (lobby.error) DrawTextKD(lobby.error, W, 480, '#ff8080', '#000000', 24);
		else if (lobby.status) DrawTextKD(lobby.status, W, 480, '#ffffff', '#000000', 24);

		// KDM-257 R1 — what this guest is about to load, named BEFORE it is in. The diff only exists
		// once the host has been asked, so in practice this paints while the "waiting for the host"
		// status is up — which is exactly the window in which the guest can still walk away.
		var below = drawModDiff(510, 'KDMPModsToGet');
		// KDM-239 R4 — and the WORLD, under the mods, in the same window and for the same reason.
		// Laid out from whatever the mod list left behind so the two stack instead of overlapping,
		// and each is independently silent when it has nothing to say.
		below = drawWorldSummary(below ? below + 12 : 510) || below;
		var joinY = below ? below + 30 : 540;   // R4: nothing painted => the stock layout, unchanged

		DrawButtonKDEx('KDMPConnect', function () {
			lobby.error = '';
			lobby.status = T('KDMPConnecting');
			connect({ role: 'guest', address: lobby.address(), name: lobby.playerName(), character: lobby.declaration() });
			return true;
		}, true, MID, joinY, 350, 64, T('KDMPConnectBtn'), '#ffffff', '');

		DrawButtonKDEx('KDMPBack', function () { lobby.close(); return true; },
			true, MID, joinY + 80, 350, 64, T('KDMPBack'), '#ffffff', '');

		/*
		 * KDM-272 A3 / KDM-293 R4.5 — the way back INTO the briefing, so it is not lost after the
		 * first run. It used to live on the lobby root; when that was deleted this button went with
		 * it and nothing noticed, because every screen still painted and every e2e still passed.
		 *
		 * What noticed was `mp-client-strings.spec.ts`'s drift guard: `KDMPAboutBtn` was declared and
		 * asked for by nobody. That is the guard earning its keep — an unreachable briefing is a
		 * feature silently removed, and no assertion about the screens themselves would see it.
		 *
		 * `next` is set so Back from the briefing returns HERE rather than to whatever phase the
		 * player last opened, and no action is stashed: re-reading is not a request for a seat.
		 */
		DrawButtonKDEx('KDMPAbout', function () {
			lobby.error = '';
			lobby.next = 'connect';
			lobby.phase = 'about';
			return true;
		}, true, MID, joinY + 160, 350, 64, T('KDMPAboutBtn'), '#ffffff', '');
	}

	// ---- KDM-257: what the two sides are about to exchange, in words -----------------------

	/** How many mods to name before collapsing the rest into a count. Screen space, not policy. */
	var MODLIST_SHOWN = 4;

	/**
	 * KDM-283 — KD's OWN name for each world mode.
	 *
	 * ── WHY A TABLE AND NOT A PREFIX ────────────────────────────────────────────────────────────
	 * This used to be `kdText('KinkyDungeonStat' + key)`. That prefix is wrong for EVERY one of the
	 * thirteen world keys, because KD does not name its `KinkyDungeonStatsChoice` entries at all.
	 * Those entries are DERIVED (`KDUpdatePlugSettings`, `KinkyDungeon.ts:6144`); what KD names is the
	 * SOURCE GLOBAL and the OPTION INDEX the player actually clicked on the Diff screen:
	 *
	 *     escapekey  ← KinkyDungeonProgressionMode === "Key"  → `KinkyDungeonProgressionMode0`  "Key Hunt"
	 *     saveMode   ← KinkyDungeonSaveMode === true          → `KinkyDungeonSaveMode1`         "Roguelike"
	 *
	 * So every lookup missed and the `|| key` fallback painted a developer identifier at the guest —
	 * and because `KinkyDungeonProgressionMode` DEFAULTS to `"Key"`, every host on earth showed one.
	 * The value→index step is not mechanical (`"Key"`→0, `true`→1, and `extremeMode` has no index at
	 * all), so it is written down once here rather than derived from a rule KD does not follow.
	 *
	 * ── WHY THE CATEGORY IS PART OF THE LABEL ───────────────────────────────────────────────────
	 * Not decoration: KD's value words are ambiguous on their own. `KinkyDungeonItemMode1` and
	 * `KinkyDungeonPerkProgressionMode0` are BOTH the word "Disabled", so a bare "• Disabled" tells a
	 * guest nothing about which rule was disabled. `cat` is KD's own heading for the option group and
	 * already carries its trailing colon.
	 *
	 * `cat: null` for the two difficulty rows on purpose — `KDHardMode` is defined TWICE in KD's own
	 * `Text_KinkyDungeon.csv` (" (HARD MODE ENABLED)" and "Difficulty:"), so which one `TextGet`
	 * answers with is not ours to rely on. Their value words are self-describing anyway.
	 *
	 * `en` is OUR English, used only when KD answers nothing for the value key — the honest fallback
	 * for our own banner, and never the raw key. A mode absent from this table is not painted at all:
	 * see `modeLabel`.
	 *
	 * ⚠️ Mirrors `MODE_WORLD_KEYS` / `MODE_SOURCE` in `game-modes.js`, which is server-side and cannot
	 * be required from a plain browser script. `tests/e2e/mp-lobby-world.spec.ts` pins the pair.
	 */
	var MODE_LABEL = {
		randomMode:      { cat: 'KDRandomMode',          val: 'KinkyDungeonRandomMode1',          ours: 'KDMPModeRandom' },
		hardMode:        { cat: null,                    val: 'KinkyDungeonHardMode1',            ours: 'KDMPModeHard' },
		extremeMode:     { cat: null,                    val: 'KinkyDungeonExtremeMode',          ours: 'KDMPModeExtreme' },
		saveMode:        { cat: 'KDSaveMode',            val: 'KinkyDungeonSaveMode1',            ours: 'KDMPModeSaveRogue' },
		itemMode:        { cat: 'KDItemMode',            val: 'KinkyDungeonItemMode1',            ours: 'KDMPModeLootNone' },
		itemPartialMode: { cat: 'KDItemMode',            val: 'KinkyDungeonItemMode2',            ours: 'KDMPModeLootPartial' },
		easyMode:        { cat: 'KDEasyMode',            val: 'KinkyDungeonEasyMode1',            ours: 'KDMPModePrisonEasy' },
		norescueMode:    { cat: 'KDEasyMode',            val: 'KinkyDungeonEasyMode2',            ours: 'KDMPModePrisonStrict' },
		noperks:         { cat: 'KDPerkProgressionMode', val: 'KinkyDungeonPerkProgressionMode0', ours: 'KDMPModePerksOff' },
		perksmandatory:  { cat: 'KDPerkProgressionMode', val: 'KinkyDungeonPerkProgressionMode2', ours: 'KDMPModePerksMandatory' },
		perksdebuff:     { cat: 'KDPerkProgressionMode', val: 'KinkyDungeonPerkProgressionMode3', ours: 'KDMPModePerksDebuff' },
		escapekey:       { cat: 'KDProgressionMode',     val: 'KinkyDungeonProgressionMode0',     ours: 'KDMPModeProgKey' },
		escaperandom:    { cat: 'KDProgressionMode',     val: 'KinkyDungeonProgressionMode1',     ours: 'KDMPModeProgRandom' },
	};

	/**
	 * One world key → the line a player reads, or `''` for "do not paint this".
	 *
	 * The empty answer is the point: a key we have no name for is a key the GUEST has no name for
	 * either, and showing them our identifier is worse than showing them nothing. A host running a
	 * newer build than ours declares modes this table has never heard of, and that is the case this
	 * silently and correctly drops.
	 */
	function modeLabel(key) {
		var m = MODE_LABEL[key];
		if (!m) return '';
		var val = kdText(m.val);
		if (!val) return T(m.ours);                  // KD has no word for it: ours, never the raw key
		var cat = m.cat ? kdText(m.cat) : '';
		return cat ? (cat + ' ' + val) : val;
	}

	/**
	 * KDM-257 R1/R2/R6 — the host-only mod list, painted from ONE function for BOTH sides.
	 *
	 * The guest and the host are looking at the same list from opposite ends: these are the mods the
	 * guest lacks, which is identical to the mods the host will send. Only the sentence above the
	 * list differs, so only the sentence is a parameter. Two copies of "list the mods" would drift in
	 * wording, and the two screens disagreeing about what is being transferred is exactly the
	 * confusion this task exists to remove.
	 *
	 * ⚠️ R4 — SILENCE IS THE CORRECT OUTPUT for an empty list, and returning early is how that is
	 * guaranteed rather than remembered. A banner on every join trains players to ignore banners.
	 *
	 * `hostOnly` is already in install order and already deduplicated (`mod-sync.js:61-73`,
	 * priority-DESC to match `KDMods.ts:311`), so it is painted in the order it arrives — the player
	 * sees what the game will actually do. `conflict` is a documented STRICT SUBSET of `hostOnly`
	 * (`mod-sync.js:81-86`), so a row in it is LABELLED rather than listed a second time.
	 *
	 * @returns the y below the last line drawn, or 0 if it painted NOTHING — so a caller lays out
	 * under it when there is something, and keeps its own stock layout byte-for-byte when there is not.
	 */
	/**
	 * KDM-239 R4 — the world the guest is about to join, in words, before it commits.
	 *
	 * Deliberately built on `drawModDiff`'s shape rather than beside it: same "silence is the correct
	 * output for nothing to say" contract (return 0, caller keeps its stock layout byte-for-byte),
	 * same collapse-after-N, same window. A guest deciding whether to join is answering one question
	 * — "what am I joining?" — and the mods and the world are two halves of that answer.
	 *
	 * The mode keys are printed as KD's own text keys where they exist, falling back to the raw key.
	 * We do not invent prose for a mode: what each one MEANS is the game's to say, and a hand-written
	 * description here would be a gameplay claim this layer is not allowed to make (epic AC2).
	 *
	 * @returns the y below the last line drawn, or 0 if it painted NOTHING.
	 */
	function drawWorldSummary(y) {
		var w = lobby.world;
		if (!w) return 0;
		var modes = Array.isArray(w.modes) ? w.modes : [];
		var seed = w.seed || '';
		// KDM-283: resolve to WORDS first, because an unnameable mode is not painted at all — so
		// "is there anything worth a banner?" and the `…and N more` count must both be asked of the
		// nameable list, not of the raw declaration. Asking the raw list is what put a bullet on
		// screen with a developer string in it.
		var named = [];
		for (var i = 0; i < modes.length; i++) {
			var label = modeLabel(String(modes[i]));
			if (label) named.push(label);
		}
		if (!named.length && !seed) return 0;     // nothing sayable: R4's stock layout, unchanged
		DrawTextKD(T('KDMPWorldLead'), W, y, '#ffd98a', '#000000', 24);
		var line = y + 28;
		if (seed) {
			DrawTextKD(T('KDMPWorldSeed', { SEED: seed }), W, line, '#ffffff', '#000000', 22);
			line += 26;
		}
		var shown = Math.min(named.length, MODLIST_SHOWN);
		for (var j = 0; j < shown; j++) {
			DrawTextKD('• ' + named[j], W, line, '#ffffff', '#000000', 22);
			line += 26;
		}
		if (named.length > shown) {
			DrawTextKD(T('KDMPModMore', { MORE: named.length - shown }),
				W, line, '#cccccc', '#000000', 22);
			line += 26;
		}
		return line;
	}

	function drawModDiff(y, leadKey) {
		var diff = lobby.modDiff;
		var rows = (diff && Array.isArray(diff.hostOnly)) ? diff.hostOnly : [];
		if (!rows.length) return 0;                                   // R4
		var conflicts = {};
		if (diff && Array.isArray(diff.conflict)) {
			for (var c = 0; c < diff.conflict.length; c++) conflicts[diff.conflict[c].hash] = true;
		}
		// KDM-281 — the COUNT is filled HERE, where the number is known, so the key travels rather than
		// a half-resolved sentence. A caller that resolved it first would be a second templating road.
		DrawTextKD(T(leadKey, { COUNT: rows.length }), W, y, '#ffd98a', '#000000', 24);
		var shown = Math.min(rows.length, MODLIST_SHOWN);
		for (var i = 0; i < shown; i++) {
			var r = rows[i];
			// `modname` is what a player recognises; `name` (the file) is the fallback for a mod whose
			// manifest gave none, so a row is never painted as an empty bullet.
			var label = String(r.modname || r.name || '?');
			if (conflicts[r.hash]) label += T('KDMPModConflict');
			DrawTextKD('• ' + label, W, y + 28 + i * 26, '#ffffff', '#000000', 22);
		}
		if (rows.length > shown) {
			DrawTextKD(T('KDMPModMore', { MORE: rows.length - shown }),
				W, y + 28 + shown * 26, '#cccccc', '#000000', 22);
			shown += 1;
		}
		return y + 28 + shown * 26;
	}

	/**
	 * KDM-257 R3 — a degraded mod sync, named while the game runs.
	 *
	 * The owner's 2026-08-23 decision is that a degraded sync PROCEEDS rather than refusing the
	 * session; this notice is what keeps that honest, and it is KDM-249's R9 ("a degraded or refused
	 * sync SHALL be visible, not mysterious") finally reaching a screen.
	 *
	 * ⚠️ IT LIVES ON THIS FILE'S WRAP, NOT A NEW ONE. The notice paints during `KinkyDungeonState ===
	 * 'Game'`, which is a fourth branch of the SINGLE `KinkyDungeonRun` wrap at the bottom of this
	 * file — a second wrap of the same global from another client script is the bug [[KDM-229]] was
	 * raised for. One global, one wrap.
	 *
	 * Persistent BY CONSTRUCTION: it re-reads live state every frame, so it lasts exactly as long as
	 * the condition does and needs no dismissal, no timer and no latch. And it is silent for every
	 * other status (`executed` / `nothing-to-do` / `off` / `pending`) — R4 again.
	 *
	 * ⚠️ EXPOSED AS `KDMPLobby.drawModWarning` — a deliberate test seam, and the reason is worth
	 * knowing before anyone "cleans it up". KD's in-game draw THROWS in the headless harness
	 * (`Cannot set properties of null (setting 'fillStyle')`, from a canvas context that does not
	 * exist there) and that kills the PIXI ticker: MEASURED on both the host and the guest page of a
	 * real started co-op session, `KinkyDungeonRun` runs 388 times and then zero, from the frame
	 * `KinkyDungeonState` becomes `'Game'`. So the FRAME PATH into this function cannot be exercised
	 * by any e2e in this repo today, and the spec calls it directly instead. See KDM-257's task notes
	 * and the follow-up filed there.
	 */
	function drawModWarning() {
		if (!window.__coopMods || typeof window.__coopMods.state !== 'function') return;
		var st;
		try { st = window.__coopMods.state(); } catch (e) { return; }
		if (!st || st.status !== 'degraded') return;                  // R4
		var missing = Array.isArray(st.missing) ? st.missing : [];
		var names = [];
		for (var i = 0; i < missing.length && i < MODLIST_SHOWN; i++) {
			var m = missing[i];
			names.push(String((m && (m.modname || m.name)) || m || '?'));
		}
		if (missing.length > names.length) names.push('+' + (missing.length - names.length));
		DrawTextKD(T('KDMPModDegraded', { MODS: names.join(', ') }),
			W, 60, '#ffb060', '#000000', 22);
	}

	// ---- the wrap ---------------------------------------------------------------------------

	var _prev = KinkyDungeonRun;
	KinkyDungeonRun = function () {
		// FIRST — see the header: `_prev` clears KDButtonsCache, so anything we register before it
		// would be erased and our button would paint but never click.
		var r = _prev.apply(this, arguments);
		try {
			// KDM-293 — the co-op entries live on KD's class/start screen. Nothing is drawn on 'Menu'
			// and nothing is borrowed on 'Stats' any more: the player reaches both by KD's own road,
			// so there is no journey of ours to send them on and none to bring them back from.
			if (KinkyDungeonState === 'Diff') drawDiffEntries();
			// KDM-295 — "Join with this character" beside KD's own "Play Slot".
			else if (KinkyDungeonState === 'LoadSlots') drawSlotsEntry();
			else if (KinkyDungeonState === 'Multiplayer') drawLobby();
			// KDM-257 R3 — the degraded-sync notice, on THIS wrap. A second wrap of KinkyDungeonRun
			// from another client script is the duplication [[KDM-229]] was raised for; one global,
			// one wrap, and the branch that needs it lives here with the others.
			// KDM-294 — and "Host this game" on KD's in-game menu, on the same branch for the same reason.
			else if (KinkyDungeonState === 'Game') { drawModWarning(); drawGameEntry(); }
		} catch (e) {
			if (window.__KDMP_DEBUG) { try { console.error('[coop lobby]', e); } catch (_) { /* noop */ } }
		}
		return r;
	};
	KinkyDungeonRun._kdmp_lobby_wrapped = true;
	KinkyDungeonRun._kdmp_lobby_original = _prev;
	// KDM-257 — the test seam for the notice; see drawModWarning's own note for why it exists.
	lobby.drawModWarning = drawModWarning;
	// KDM-244 — KD's own seven-field save rule, shared with the EXPORT direction's guarded write in
	// coop-bootstrap.js. One definition of "is this save loadable", used on the way in and the way
	// out; a second copy over there would be the one that drifts from upstream.
	lobby.saveIsUsable = saveIsUsable;
})();
