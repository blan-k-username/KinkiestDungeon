/**
 * Node-layer (Vitest) — KDM-277 slice 3: the flagged keys that needed a judgement call rather than a
 * mechanical criterion.
 *
 * Five of the seven are settled here on evidence. The other two are NOT, deliberately, and the reason
 * is recorded at the bottom of this file — they are a product decision about co-op, not a
 * classification.
 *
 * ── MOVED TO WORLD ────────────────────────────────────────────────────────────────────────────────
 *
 *   KDGameData.Journey                the run's journey TYPE ("Random" / "Harder" / "Explorer"),
 *                                     written at KDStairActions.ts:187 and KinkyDungeon.ts:4455. It is
 *                                     the INPUT to `KDInitializeJourney(KDGameData.Journey, level)`
 *                                     (KDStairActions.ts:188, KDMapGen.ts:681), which builds
 *                                     `KDGameData.JourneyMap` — and JourneyMap is ALREADY a declared
 *                                     world key (KDM-265). Leaving the input per-player while its
 *                                     output is world is the half-classified pair KDM-228 warns
 *                                     about: two players holding different journey types would
 *                                     generate different journey maps for one party.
 *
 *   KDGameData.PreferredJailPointTick the jail-point selection timer for ENEMIES
 *                                     (KinkyDungeonEnemies.ts:202/205/215, reset KDMapGen.ts:48).
 *                                     Decisive detail: it is compared against and assigned from
 *                                     `KinkyDungeonCurrentTick`, which is itself blacklisted world
 *                                     state. A per-player value denominated in a world clock is
 *                                     incoherent — whoever was swapped in last would move the
 *                                     party's shared jail timer.
 *
 * ── REVIEWED AND KEPT PER-PLAYER ──────────────────────────────────────────────────────────────────
 * All three turned out to be evidence questions, not judgement calls, once the whole repo was read
 * rather than just Game/src:
 *
 *   MiniGameVictory     NOT a KD global at all. It is declared in `Scripts/Patch.ts:33` — the
 *                       standalone shim that stubs out BondageClub's APIs (`StandalonePatched = true`
 *                       at :1). KD writes it at KDStairActions.ts:115/:144 for BC's arcade wrapper to
 *                       read; in standalone nothing reads it. Client-integration state, like the
 *                       canvas — not the party's world.
 *   KinkyDungeonRep     mirrors the INDIVIDUAL player's BondageClub "Gaming" reputation
 *                       (KDStairActions.ts:111-113). Its consumers `ReputationGet` and
 *                       `DialogSetReputation` are stubs in the same shim (`Patch.ts:18-19` — return 0
 *                       and do nothing). Per-player by definition: it is each human's own account
 *                       progression, not anything about the dungeon.
 *   KDRestraintsCache   declared at KinkyDungeonRestraints.ts:629, reset at KinkyDungeonGame.ts:940,
 *                       and READ NOWHERE in Game/src. Vestigial, exactly like KinkyDungeonGrid_Last
 *                       in slice 2. Blacklisting it would be speculative.
 *
 * ── THE TWO JAIL KEYS: THE FLAG WAS OVER-EAGER, AND THE SWAP MODEL IS WHY ─────────────────────────
 * KDM-273 flagged `PrisonerState` on the reasoning "the jail is world furniture". True, and beside
 * the point. The deciding read is `KinkyDungeonAggressive(enemy, player)`
 * (KinkyDungeonFactions.ts:8-16): the `PrisonerState` branches sit inside `if (!player ||
 * player.player)`, the function's own `// Player mode` branch. It answers "is this enemy aggressive
 * toward THE PLAYER", and the player's jail status is a property of that player.
 *
 * Under the swap model that is not merely acceptable, it is what you want. Each turn `restorePlayer`
 * installs the ACTING player's bundle, so enemy AI evaluates aggression against the acting player
 * using that player's jail status. Making it world would force both players into one jail state — a
 * co-op DESIGN change ("if one of us is jailed, are we both?"), not a classification fix. The jail
 * itself stays world, where it already is: `JailGuard` is a declared world key.
 *
 * `PriorJailbreaksDecay` classifies WITH `KDGameData.PriorJailbreaks`, which the audit never saw
 * because no transition site writes it. They are read together in one expression
 * (KinkyDungeonJailList.ts:149) and `PriorJailbreaks` is incremented when THIS player breaks out
 * (KinkyDungeonDialogue.ts:1625), feeding that player's reinforcement count. Both stay per-player;
 * splitting the pair is the failure KDM-228 names.
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect, beforeAll } from 'vitest';
/* eslint-disable @typescript-eslint/no-var-requires */
const { HeadlessHost, GLOBAL_BLACKLIST, KDGAMEDATA_WORLD_KEYS } =
	require('../../tools/mp-server/headless-host');

const BOOT_TIMEOUT = 240_000;

const NOW_WORLD = ['Journey', 'PreferredJailPointTick'];
const KEPT_PER_PLAYER = ['MiniGameVictory', 'KinkyDungeonRep', 'KDRestraintsCache'];

/** A key no game code writes, so its arrival can only mean "this bundle really was restored". */
const CONTROL_GAMEDATA = '__kdm277JourneyProbe';

describe('KDM-277 · slice 3 classifications are declared in production code', () => {
	it('the journey type and the enemy jail timer are declared world', () => {
		for (const k of NOW_WORLD) {
			expect(KDGAMEDATA_WORLD_KEYS, `KDGameData.${k}`).toContain(k);
		}
	});

	it('Journey classifies WITH JourneyMap, which it generates', () => {
		// The pair argument, pinned. If someone removes JourneyMap from the world list, Journey being
		// there alone is just as half-classified as the reverse.
		expect(KDGAMEDATA_WORLD_KEYS, 'JourneyMap is built from Journey').toContain('JourneyMap');
	});

	it('PreferredJailPointTick is denominated in a clock that is itself world state', () => {
		// The whole argument for that key in one assertion: it is compared against and assigned from
		// KinkyDungeonCurrentTick. If that clock were per-player this classification would need
		// rethinking, so the coupling is pinned rather than left in a comment.
		expect(GLOBAL_BLACKLIST, 'the tick this key is measured in').toContain('KinkyDungeonCurrentTick');
	});

	it('the three BC-shim / vestigial globals stay per-player', () => {
		// Negative decisions, pinned so nobody later "completes the set" by blacklisting them.
		for (const g of KEPT_PER_PLAYER) {
			expect(GLOBAL_BLACKLIST, `${g} was reviewed and deliberately left per-player`).not.toContain(g);
		}
	});

	it('the jail keys stay per-player, and the jail itself stays world', () => {
		// The two halves of the jail decision, pinned together because either one alone reads as an
		// oversight. Prisoner status is a property of a player (KinkyDungeonFactions.ts "Player mode");
		// the jail's own furniture is the party's.
		expect(KDGAMEDATA_WORLD_KEYS, 'a player\'s jail status is per-player under the swap model')
			.not.toContain('PrisonerState');
		expect(KDGAMEDATA_WORLD_KEYS, '…and its jailbreak-count pair with it')
			.not.toContain('PriorJailbreaksDecay');
		expect(KDGAMEDATA_WORLD_KEYS, '…while the jail itself is world, as it already was')
			.toContain('JailGuard');
	});

	it('PriorJailbreaksDecay is not split from the counter it is read with', () => {
		// KDM-228's rule: a pair written/read together classifies together. PriorJailbreaks is outside
		// the audit's reach (no transition site writes it), so this is the only place the coupling is
		// recorded — if someone moves one, this says the other must move too.
		const decayIsWorld = KDGAMEDATA_WORLD_KEYS.includes('PriorJailbreaksDecay');
		const counterIsWorld = KDGAMEDATA_WORLD_KEYS.includes('PriorJailbreaks');
		expect(decayIsWorld,
			'PriorJailbreaks and PriorJailbreaksDecay are read in one expression '
			+ '(KinkyDungeonJailList.ts:149) and must share a classification')
			.toBe(counterIsWorld);
	});
});

describe('KDM-277 · a stale bundle does not rewrite the journey type or the jail timer', () => {
	let h: any;

	beforeAll(() => {
		h = new HeadlessHost({ id: 'kdm277-journey-jail' });
		h.boot();
		h.init({ seed: 'kdm277-journey-jail' });
	}, BOOT_TIMEOUT);

	/** Distinct, recognisable values per key — nothing the game itself produces. */
	const WORLD_VALUE: Record<string, unknown> = { Journey: 'kdm277World', PreferredJailPointTick: 277001 };
	const STALE_VALUE: Record<string, unknown> = { Journey: 'kdm277Stale', PreferredJailPointTick: 277999 };

	it.each(NOW_WORLD)(
		'KDGameData.%s keeps the world\'s value when a player bundle disagrees',
		(key) => {
			h.eval(`KDGameData[${JSON.stringify(key)}] = ${JSON.stringify(WORLD_VALUE[key])};`);

			const bundle = h.capturePlayer();
			bundle.gameData[key] = STALE_VALUE[key];
			bundle.gameData[CONTROL_GAMEDATA] = 'restored';

			// Precondition, asserted rather than assumed: the two really do disagree, or the check
			// below would pass on any build at all.
			expect(bundle.gameData[key], 'the fixture must actually diverge from the world')
				.not.toEqual(WORLD_VALUE[key]);

			h.restorePlayer(bundle);

			const after = h.eval(`({
				subject: KDGameData[${JSON.stringify(key)}],
				probe: KDGameData[${JSON.stringify(CONTROL_GAMEDATA)}]
			})`);

			expect(after.probe,
				'CONTROL: an ordinary KDGameData key on the SAME bundle must be installed — without it '
				+ 'this proves only that restorePlayer did nothing')
				.toBe('restored');
			expect(after.subject,
				`KDGameData.${key} is world state; a player's stale copy must not overwrite it`)
				.toEqual(WORLD_VALUE[key]);
		}, BOOT_TIMEOUT);
});
