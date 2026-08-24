/**
 * KDM-239 — a co-op run starts like a real game.
 *
 * ── WHAT IS ACTUALLY BROKEN ───────────────────────────────────────────────────────────────────────
 * Less than the task title suggests, and the difference matters. `headless-host.js:611` already calls
 * the REAL `KinkyDungeonStartNewGame(false)`, and that function is itself the stock new-game entry —
 * it sets `KDGameData.RoomType = "JourneyFloor"`, calls `KDSetWorldSlot(0,0,0,0)` and
 * `KDInitializeJourney("")`, then generates the map (`KinkyDungeon.ts:6012-6053`). So "both players
 * land on the intended opening floor" is largely true already and is asserted here as a REGRESSION
 * (R6), not as new behaviour.
 *
 * What is genuinely missing is everything the stock start buttons do AROUND that call
 * (`KinkyDungeon.ts:2553-2565`, `:2875-2884`):
 *
 *     KDLose = false;
 *     KDUpdatePlugSettings(true, false);        <-- the game-mode toggles
 *     KinkyDungeonStartNewGame();
 *     if (!KDToggles.SkipTutorial) KDStartDialog("Tutorial");
 *     KDAddListener("SpeciesChecker");
 *
 * `KDLose`, `SpeciesChecker` and `KDUpdatePlugSettings` have ZERO call sites under
 * `tools/mp-server/**`. A co-op run therefore starts with no species listener and with whatever
 * game-mode defaults the headless bundle happens to boot with — never the host's.
 *
 * ── THE TRAP THIS SPEC EXISTS TO PIN DOWN (A3) ────────────────────────────────────────────────────
 * The obvious fix — hand the mode keys to `applyPerks` and let KDM-238's per-player channel carry
 * them — FAILS SILENTLY. `applyPerks` (`headless-host.js:1324-1339`) does
 * `KinkyDungeonStatsChoice = new Map()` and then re-adds a key only `if (KinkyDungeonStatsPresets[k])`
 * — and NOT ONE of the nine mode keys is in that table (`KinkyDungeonPerks.ts:256`); they are written
 * into `StatsChoice` by `KDUpdatePlugSettings` and are not perks. So a mode key routed that way is
 * dropped without a word, and — already true today — every mode the world established is WIPED from
 * the slot by the first `_seatPlayer`.
 *
 * `describe('the trap')` below asserts that mechanism directly, so the reason `applyWorldModes` has
 * to exist as a SEPARATE applier is checked by the suite rather than remembered from a task file.
 *
 * ── WHY THESE ARE NOT VACUOUS GREENS ──────────────────────────────────────────────────────────────
 *  1. The classification test does not compare our constant to a hand-copied list — it reads
 *     `KDUpdatePlugSettings`' OWN body out of the game source and fails when upstream adds a key we
 *     have not classified. A list-vs-list test would agree with itself for ever.
 *  2. The survival test asserts a mode key is still set AFTER `applyPerks` has run, which is the
 *     exact moment the current code loses it. Asserting only "init set it" passes today.
 *  3. Two players ride one booted world, so "the host's mode reached the world" and "the two players
 *     agree" are asserted against each other — an implementation that applies modes to nobody, or to
 *     one seat only, fails one of the pair.
 *  4. R2 is an ABSENCE assertion (no tutorial dialogue), so it is paired with a positive control that
 *     proves the same probe CAN see a dialogue — otherwise it would pass against a broken probe.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JoinGate } = require('../../tools/mp-server/join-gate');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const HH = require('../../tools/mp-server/headless-host');

const BOOT_TIMEOUT = 240_000;
const BUILD = 'kd-5.5.0-abc123';
const GAME_SRC = path.resolve(__dirname, '../../Game/src/base/KinkyDungeon.ts');

// ---------------------------------------------------------------------------------------------
// A4 — the classification, checked against upstream rather than against itself.
// ---------------------------------------------------------------------------------------------
describe('KDM-239 — world vs player game-mode keys (R3, A4)', () => {
	/** Every key `KDUpdatePlugSettings` writes, read out of the GAME SOURCE. */
	function keysUpstreamWrites(): string[] {
		const src = fs.readFileSync(GAME_SRC, 'utf8');
		const start = src.indexOf('function KDUpdatePlugSettings');
		expect(start, 'KDUpdatePlugSettings moved or was renamed upstream').toBeGreaterThan(-1);
		// The function body ends at the first line that is a lone closing brace at column 0.
		const rest = src.slice(start);
		const end = rest.search(/\n}\n/);
		const body = rest.slice(0, end);
		const out = new Set<string>();
		// Only UNCOMMENTED sets count — the body carries several commented-out arousalModePlug lines.
		for (const line of body.split('\n')) {
			if (/^\s*\/\//.test(line)) continue;
			const m = /KinkyDungeonStatsChoice\.set\(\s*"([A-Za-z0-9_]+)"/.exec(line);
			if (m) out.add(m[1]);
		}
		return [...out];
	}

	it('SELF-CHECK: the upstream reader actually finds keys, and skips commented-out ones', () => {
		const keys = keysUpstreamWrites();
		expect(keys.length, 'a reader that finds nothing would make every test below vacuous').toBeGreaterThan(5);
		expect(keys).toContain('randomMode');
		expect(keys).toContain('arousalMode');
		// `arousalModePlug` is commented out upstream (`KinkyDungeon.ts:6117`). If it ever appears
		// here, the comment-skip has broken and the drift guard is reading noise.
		expect(keys, 'commented-out sets must not be read as real').not.toContain('arousalModePlug');
	});

	it('exports the split as frozen constants beside KDGAMEDATA_WORLD_KEYS', () => {
		expect(Array.isArray(HH.MODE_WORLD_KEYS)).toBe(true);
		expect(Array.isArray(HH.MODE_PLAYER_KEYS)).toBe(true);
		expect(Object.isFrozen(HH.MODE_WORLD_KEYS)).toBe(true);
		expect(Object.isFrozen(HH.MODE_PLAYER_KEYS)).toBe(true);
	});

	it('classifies the world-level modes — the ones that describe the RUN, not the character', () => {
		// randomMode changes map generation; hard/extreme/easy change difficulty; item, save and the
		// perk-progression + escape rules are session-wide. Two players cannot disagree about any of
		// these and still be in the same game.
		expect([...HH.MODE_WORLD_KEYS].sort()).toEqual([
			'easyMode', 'escapekey', 'escaperandom', 'extremeMode', 'hardMode', 'itemMode',
			'itemPartialMode', 'noperks', 'norescueMode', 'perksdebuff', 'perksmandatory',
			'randomMode', 'saveMode',
		].sort());
	});

	it('leaves the per-character modes on KDM-238\'s per-player channel', () => {
		expect([...HH.MODE_PLAYER_KEYS].sort()).toEqual([
			'arousalMode', 'classMode', 'hardperksMode', 'hideperkbondage', 'partialhideperkbondage',
			'perkBondage', 'perkNoBondage', 'perksMode', 'vhardperksMode',
		].sort());
	});

	it('the two sets are disjoint — a key classified twice is a key nobody owns', () => {
		const w = new Set(HH.MODE_WORLD_KEYS);
		expect([...HH.MODE_PLAYER_KEYS].filter((k: string) => w.has(k))).toEqual([]);
	});

	it('DRIFT GUARD: every key upstream writes is classified, so a new one cannot arrive unowned', () => {
		const classified = new Set([...HH.MODE_WORLD_KEYS, ...HH.MODE_PLAYER_KEYS]);
		const unowned = keysUpstreamWrites().filter((k) => !classified.has(k));
		expect(unowned,
			'upstream added a game-mode key — classify it as world or player (KDM-239 A4) rather than '
			+ 'letting it silently take the headless default').toEqual([]);
	});
});

// ---------------------------------------------------------------------------------------------
// The gate half: the HOST declares the world, and only the host.
// ---------------------------------------------------------------------------------------------
describe('KDM-239 — the world declaration rides the host\'s seat (R3, R5, A5)', () => {
	it('a host declares the world modes and the seed with its claim', () => {
		const g = new JoinGate({ build: BUILD });
		g.claimHost('H', { build: BUILD, world: { modes: ['randomMode'], seed: 'run-42' } });
		expect(g.worldOf('H')).toEqual({ modes: ['randomMode'], seed: 'run-42' });
	});

	it('a host that declares nothing is not refused, and yields an empty world', () => {
		const g = new JoinGate({ build: BUILD });
		expect(g.claimHost('H', { build: BUILD }).accept).toBe(true);
		expect(g.worldOf('H')).toEqual({ modes: [], seed: '' });
	});

	it('a GUEST\'s world declaration is ignored — one host, no silent blending (A5)', () => {
		const g = new JoinGate({ build: BUILD });
		g.claimHost('H', { build: BUILD, world: { modes: ['randomMode'], seed: 'host-seed' } });
		g.requestJoin('G', { build: BUILD, world: { modes: ['hardMode'], seed: 'guest-seed' } });
		g.accept();
		expect(g.worldOf('G'), 'a guest holds no world declaration at all').toEqual({ modes: [], seed: '' });
		expect(g.worldOf('H'), 'and the host\'s is untouched by the attempt')
			.toEqual({ modes: ['randomMode'], seed: 'host-seed' });
	});

	it('drops an unclassified key rather than passing it through to an eval', () => {
		const g = new JoinGate({ build: BUILD });
		g.claimHost('H', { build: BUILD, world: { modes: ['randomMode', 'NotAMode', 'arousalMode'] } });
		// `arousalMode` is real but PLAYER-level — it is not the host's to set for the party.
		expect(g.worldOf('H').modes).toEqual(['randomMode']);
	});

	it('caps the seed, so a malformed message cannot wedge the session (LAN-only posture)', () => {
		const g = new JoinGate({ build: BUILD });
		g.claimHost('H', { build: BUILD, world: { seed: 'S'.repeat(5000) } });
		expect(g.worldOf('H').seed.length).toBeLessThanOrEqual(64);
	});

	it('R4 — the pending reply tells the GUEST what world it is about to join', () => {
		// The guest can still walk away at this point (it is waiting for approval and the session does
		// not exist yet), which is why the world rides this message and not the admission.
		const g = new JoinGate({ build: BUILD });
		g.claimHost('H', { build: BUILD, world: { modes: ['randomMode'], seed: 'run-42' } });
		const r = g.requestJoin('G', { build: BUILD });
		expect(r.pending).toBe(true);
		expect(r.world).toEqual({ modes: ['randomMode'], seed: 'run-42' });
	});

	it('R4 — and says so honestly when the host declared nothing', () => {
		const g = new JoinGate({ build: BUILD });
		g.claimHost('H', { build: BUILD });
		expect(g.requestJoin('G', { build: BUILD }).world).toEqual({ modes: [], seed: '' });
	});

	it('worldOf hands back a COPY — a caller cannot edit what the gate believes', () => {
		const g = new JoinGate({ build: BUILD });
		g.claimHost('H', { build: BUILD, world: { modes: ['randomMode'] } });
		g.worldOf('H').modes.push('hardMode');
		expect(g.worldOf('H').modes).toEqual(['randomMode']);
	});
});

// ---------------------------------------------------------------------------------------------
// The session half, on ONE real booted world carrying both players.
// ---------------------------------------------------------------------------------------------
describe('KDM-239 — the start ritual runs, and the world modes survive seating (R1, R2, R3, R6)', () => {
	let s: any = null;

	beforeAll(async () => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'kdm239-ritual' });
		// The host asks for a world-level mode; nobody asks for a player-level one.
		s.setWorldOptions('A', { modes: ['hardMode'], seed: 'kdm239-ritual' });
		s.join('A');
		s.join('B');
	}, BOOT_TIMEOUT);

	afterAll(() => { try { s && s.close && s.close(); } catch (e) { /* noop */ } });

	it('A3 — none of the mode keys is in KD\'s perk table, so applyPerks would drop every one', () => {
		// The reason `applyWorldModes` has to be a SEPARATE applier, checked by the suite rather than
		// remembered from a task file. If upstream ever promotes one of these to a real perk, this
		// fails and the design assumption gets revisited instead of being quietly violated.
		const all = [...HH.MODE_WORLD_KEYS, ...HH.MODE_PLAYER_KEYS];
		const absent = s.world.eval(`(function(){
			var keys = ${JSON.stringify(all)};
			return keys.filter(function(k){ return !KinkyDungeonStatsPresets[k]; });
		})()`);
		expect(absent.slice().sort()).toEqual(all.slice().sort());
	});

	it('R1 — KDLose is cleared, as the stock start buttons do', () => {
		expect(s.world.eval('KDLose')).toBe(false);
	});

	it('R1 — the SpeciesChecker listener is registered', () => {
		const types = s.world.eval(
			'(KDGameData.ListenerList || []).map(function(l){ return l.type; })');
		expect(types).toContain('SpeciesChecker');
	});

	it('R1 — KDUpdatePlugSettings ran, so the mode keys exist in StatsChoice at all', () => {
		// Before this task nothing calls it, so `hardMode` is simply absent rather than false.
		const seen = s.world.eval('KinkyDungeonStatsChoice.has("hardMode")');
		expect(seen).toBe(true);
	});

	it('R3/A3 — the host\'s world mode SURVIVES the applyPerks wipe in _seatPlayer', () => {
		// The load-bearing assertion. `applyPerks` resets StatsChoice on every seating, so a mode
		// applied only at init() is gone by now. Asserted for BOTH players, since the failure this
		// prevents is the two of them disagreeing about the world they are in.
		for (const id of ['A', 'B']) {
			s.world.restorePlayer(s.bundles.get(id));
			expect(s.world.eval('KinkyDungeonStatsChoice.get("hardMode") === true'),
				`player ${id} lost the world mode`).toBe(true);
		}
	});

	it('R3 — the host cannot make the two players disagree about ANY mode key', () => {
		/*
		 * The property R3 actually buys, asserted directly rather than via one hand-picked key.
		 *
		 * An earlier version of this test asserted `arousalMode === false` for the unperked player,
		 * on the assumption that "nobody declared it" meant "off". That was wrong about KD, not about
		 * the code: `KinkyDungeonSexyMode` DEFAULTS TO TRUE (`KinkyDungeon.ts:7939` — the localStorage
		 * read falls back to `true`, not `false`), so the honest expectation is "both players get
		 * KD's default", which is what this now checks.
		 */
		const modesFor = (id: string) => {
			s.world.restorePlayer(s.bundles.get(id));
			return (s.world.eval(`(function(){
				var out = [];
				KinkyDungeonStatsChoice.forEach(function(v, k){ if (v) out.push(k); });
				return out.sort();
			})()`) as string[]);
		};
		const a = modesFor('A');
		const b = modesFor('B');
		expect(a.length, 'a seat with no modes at all would make this comparison vacuous').toBeGreaterThan(0);
		expect(b).toEqual(a);
	});

	it('R6 — the run opens on the journey hub, and both players are on that one floor', () => {
		expect(s.world.getRoomType()).toBe('JourneyFloor');
		const grid = s.world.eval('KDMapData.Grid.length');
		expect(grid, 'a generated map, not the empty Grid the fixtures leave behind').toBeGreaterThan(0);
		const level = s.world.eval('MiniGameKinkyDungeonLevel');
		expect(level).toBe(0);
	});

	it('R2 — no tutorial dialogue is open, and the probe can actually see one (control)', () => {
		const open = s.world.eval(
			'(typeof KDGameData !== "undefined" && KDGameData.CurrentDialog) ? String(KDGameData.CurrentDialog) : ""');
		expect(open, 'the tutorial is suppressed on purpose in co-op — R2').not.toBe('Tutorial');
		// POSITIVE CONTROL: the same probe must be able to report a dialogue, or the line above is
		// asserting nothing. Open one, read it, put it back.
		const before = open;
		s.world.eval('KDGameData.CurrentDialog = "Tutorial"');
		expect(s.world.eval('String(KDGameData.CurrentDialog || "")')).toBe('Tutorial');
		s.world.eval(`KDGameData.CurrentDialog = ${JSON.stringify(before)}`);
	});
});

// ---------------------------------------------------------------------------------------------
// R2 / R7 as SOURCE guards — the decisions that are only visible in the code.
// ---------------------------------------------------------------------------------------------
describe('KDM-239 — the deliberate decisions are recorded where they are made (R2, R7)', () => {
	const MP_DIR = path.resolve(__dirname, '../../tools/mp-server');
	const read = (p: string) => fs.readFileSync(path.join(MP_DIR, p), 'utf8');

	/**
	 * Strip comments, so PROSE describing the removed pin cannot keep the R7 guard red for ever.
	 * (It did exactly that on the first green run — the replacement code carries a comment quoting
	 * the old `KinkyDungeonState = 'Game'` line to explain what it replaced.)
	 */
	function codeOnly(src: string): string {
		return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');
	}

	it('R2 — the tutorial skip is explicit, not an omission', () => {
		// An omission and a decision look identical in a diff. This is the difference.
		expect(read('headless-host.js')).toMatch(/Tutorial/);
	});

	it('R7 — the client no longer stamps the Game screen unconditionally', () => {
		const src = codeOnly(read('client/coop-bootstrap.js'));
		// The pin was `KinkyDungeonState = 'Game'` with no session state behind it. After R7 the
		// screen comes from the session; this asserts the bare assignment is gone from pinGameScreen.
		const fn = /function pinGameScreen\(\)[\s\S]*?\n\t\}/.exec(src);
		expect(fn, 'pinGameScreen moved or was renamed').not.toBeNull();
		expect(fn![0], 'R7 — the unconditional screen stamp must be gone')
			.not.toMatch(/KinkyDungeonState\s*=\s*'Game'/);
		// …and it genuinely adopts something, rather than simply having deleted the line.
		expect(fn![0], 'R7 — the screen must come from the session').toMatch(/coop\.screen/);
	});

	it('R8 — but the KDM-258 context guard and its error reporting are KEPT', () => {
		const src = read('client/coop-bootstrap.js');
		expect(src, 'the null-context refusal is what stops a permanently frozen frame')
			.toMatch(/KinkyDungeonContext/);
		expect(src, 'the start error must stay visible — its silence hid KDM-258').toMatch(/_startError/);
	});
});
