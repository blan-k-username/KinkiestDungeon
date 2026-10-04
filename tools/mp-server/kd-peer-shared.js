/**
 * tools/mp-server/kd-peer-shared.js
 *
 * ONE SOURCE for the co-op code that BOTH runtimes install: the headless world (the server evals this
 * text into it) and the browser client (served the identical text as `/mp/kd-peer-shared.js`, before
 * `render-client.js` and `coop-bootstrap.js`). Same two-runtime terms as `kd-peace-dialogue.js`.
 *
 * WHY. Each piece below used to exist twice — a server copy and a client copy — and two of the five
 * had already drifted when they were merged here (KDM-335): the client's RemotePlayer def still had
 * `evasion: -100`, the value the server removed because KinkyDungeonMultiplicativeStat(-100) is 101 and
 * made every PvP hit land; and the client's entity field list lacked `specialBoundLevel`, `stun`,
 * `freeze` and `vulnerable`, whose absence the server had already found to be a bug. Both now take the
 * server's value. `tests/unit/mp-peer-shared-single-source.spec.ts` fails if a second copy returns.
 *
 * Single-player parity: none of this changes how KD itself behaves. The avatar def is a co-op-only
 * entity (another player has no single-player counterpart), and the ally-dialogue guard only acts when
 * the dialogue target IS such an avatar.
 *
 * Everything is exposed as `globalThis.KDPeerShared` (one name, like `KDCodec` / `KDDelta`): a
 * function declared at the top of eval'd text is not reliably a global on the server, and an explicit
 * namespace reads the same way on both sides.
 *
 * The text is String.raw so its regexes keep their backslashes, and it must never contain a backtick
 * (it would end this template; the server's eval payloads have the same rule).
 */
'use strict';

const KD_PEER_SHARED = String.raw`
(function () {
	var root = globalThis;   // === window in a browser; the KD context's global on the server
	if (root.KDPeerShared) return;                                   // idempotent: installed once per runtime

	/** A JSON deep copy; undefined stays undefined, an unserialisable value becomes null. */
	function clone(o) { try { return (o === undefined) ? undefined : JSON.parse(JSON.stringify(o)); } catch (e) { return null; } }

	/** Is this enemy-def name another PLAYER's avatar (RemotePlayer, or RemotePlayer_<label>)? */
	function isPeerAvatarName(nm) {
		return typeof nm === 'string' && nm.indexOf('RemotePlayer') === 0;
	}

	/*
	 * The entity fields a render-state snapshot carries. The tie submenu evaluates its gate on the
	 * CLIENT, so the bind state (specialBoundLevel, stun, freeze, vulnerable) has to be here or no
	 * server-side fix can take effect.
	 */
	var ENT_FIELDS = ['id', 'x', 'y', 'visual_x', 'visual_y', 'offX', 'offY', 'scaleX', 'scaleY', 'flip', 'hp',
		'visual_hp', 'boundLevel', 'specialBoundLevel', 'stun', 'freeze', 'vulnerable', 'distraction', 'revealed',
		'player', 'CustomSprite', 'CustomName', 'CustomNameColor', 'style', 'outfit', 'outfitBound', 'appearance'];

	function entSnap(e) {
		var o = {};
		for (var i = 0; i < ENT_FIELDS.length; i++) { var k = ENT_FIELDS[i]; if (e[k] !== undefined) o[k] = e[k]; }
		o.enemyName = (e.Enemy && e.Enemy.name) || undefined;
		var b = clone(e.buffs); if (b) o.buffs = b;
		return o;
	}

	/**
	 * KD_START_RESTRAINT / #startitem accept ONE name or a comma/space-separated list
	 * (e.g. "MasterworkHeels,HighsecShackles").
	 */
	function parseStartRestraints(spec) {
		return String(spec || '').split(/[,\s]+/).filter(Boolean);
	}

	/**
	 * The RemotePlayer enemy-def (pushed mod-style, once): an ally-faction, inert definition used to
	 * represent another player as a real KD entity. faction 'Player' = ally; noAttack falsy so a hostile
	 * enemy still treats it as a valid target; immobile + visionRadius 0 so it never acts on its own.
	 */
	function ensureRemotePlayerDef() {
		if (typeof KinkyDungeonEnemies === 'undefined' || typeof KinkyDungeonGetEnemyByName !== 'function') return false;
		if (!KinkyDungeonGetEnemyByName('RemotePlayer')) {
			KinkyDungeonEnemies.push({
				name: 'RemotePlayer', faction: 'Player', tags: KDMapInit(['peaceful']),
				bound: 'Apprentice', // sprite name; presence makes KDCanBind true so the Truss/bind option appears
				AI: 'guard', immobile: true, visionRadius: 0, maxhp: 100, minLevel: 0, weight: -1000,
				movePoints: 1000, attackPoints: 0, attack: '', attackRange: 0,
				// Evasion 0 = NEUTRAL, and it must stay neutral. It used to be -100, and
				// KinkyDungeonMultiplicativeStat(-100) is 101 — a x101 hit chance that made every PvP
				// attack land unconditionally. The peer's real evasion arrives on the entity's buff list
				// instead (setAvatarDefenses); a non-zero value here would silently cancel it again.
				evasion: 0, armor: 0, followRange: 100, lowpriority: true,
				// style → the client renders the avatar as a full character (NPC path, KDQuickGenNPC +
				// DrawCharacter) so the other player is VISIBLE, not just an HP bar.
				style: 'BlueHair',
				terrainTags: {}, floors: KDMapInit([]),
			});
			if (typeof KinkyDungeonRefreshEnemiesCache === 'function') KinkyDungeonRefreshEnemiesCache();
		}
		// The def's display-name key, so combat text reads a real name ("Your attack hits the Rival")
		// instead of "[NotFound] NameRemotePlayer".
		if (typeof addTextKey === 'function') addTextKey('NameRemotePlayer', 'Rival');
		return true;
	}

	/**
	 * A peer avatar IS a talk target (the ally dialogue is how a partner gets untied), but most of the
	 * ally dialogue's OTHER options are NPC-only. Hide them the KD-native way: wrap each one's own
	 * prerequisiteFunction (the gate KD's dialogue renderer already calls per entry,
	 * KDCheckDialoguePrereq) so it reports false while the dialogue's entity is a peer avatar.
	 * Untie and Leave are untouched. Idempotent per entry, so it can run after every bundle adoption.
	 */
	function installAllyDialogueGuard() {
		if (typeof KDDialogue === 'undefined' || !KDDialogue.GenericAlly || !KDDialogue.GenericAlly.options) {
			return { ok: false, error: 'no GenericAlly dialogue' };
		}
		var opts = KDDialogue.GenericAlly.options;
		var hide = ['Leash', 'ReleaseLeash', 'Shop', 'ShopBuy', 'Attack', 'AttackPlay',
			'AttackUnaware', 'Food', 'JoinParty', 'Flirt', 'LetMePass', 'StopFollowingMe',
			'FollowMe', 'DontStayHere', 'StayHere', 'Aggressive', 'Defensive', 'HelpMe',
			'HelpMeCommandWord', 'HelpMeKey', 'DontHelpMe', 'RemoveParty'];
		function isPeerAvatarTarget() {
			var enemy = (typeof KinkyDungeonFindID === 'function') ? KinkyDungeonFindID(KDGameData.CurrentDialogMsgID) : null;
			return isPeerAvatarName(enemy && enemy.Enemy && enemy.Enemy.name);
		}
		function wrapEntry(entry) {
			var _prereq = entry.prerequisiteFunction;
			entry.prerequisiteFunction = function (gagged, player) {
				if (isPeerAvatarTarget()) return false;
				return _prereq ? _prereq(gagged, player) : true;
			};
			entry.__kdPeerAllyGuard = 1;
		}
		var hidden = [];
		for (var i = 0; i < hide.length; i++) {
			var entry = opts[hide[i]];
			if (!entry || entry.__kdPeerAllyGuard) continue;
			wrapEntry(entry);
			hidden.push(hide[i]);
		}
		return { ok: true, hidden: hidden };
	}

	root.KDPeerShared = {
		clone: clone, isPeerAvatarName: isPeerAvatarName, ENT_FIELDS: ENT_FIELDS, entSnap: entSnap,
		parseStartRestraints: parseStartRestraints, ensureRemotePlayerDef: ensureRemotePlayerDef,
		installAllyDialogueGuard: installAllyDialogueGuard,
	};
})();
`;

/** The browser-ready form — identical text, served as a script (demo-server.js INJECT). */
const KD_PEER_SHARED_BROWSER = KD_PEER_SHARED;

// Node-side consumers (swap-session) get the real functions from the same text.
const _scope = {};
new Function('globalThis', KD_PEER_SHARED)(_scope);

module.exports = {
	KD_PEER_SHARED,
	KD_PEER_SHARED_BROWSER,
	kdParseStartRestraints: _scope.KDPeerShared.parseStartRestraints,
	kdIsPeerAvatarName: _scope.KDPeerShared.isPeerAvatarName,
};
