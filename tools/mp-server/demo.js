/**
 * tools/mp-server/demo.js  (KD-075)
 *
 * The PoC integration capstone: ONE scripted end-to-end run that exercises every
 * pillar of the server-authoritative MP concept (epic KD-078) and prints a
 * human-readable report. Pure assembly of the pieces built in KD-079/081/080/082.
 *
 * Run (in Docker, per project rules):
 *   docker run --rm -v "$PWD":/usr/src/app -w /usr/src/app node:23-slim \
 *     node -e "setTimeout(()=>process.exit(2),200000).unref(); require('./tools/mp-server/demo.js')"
 *   (build out/main.js first with `npx tsc`, or use the playwright image)
 */
'use strict';

const { IntegratedSession } = require('./integration');

const log = (...a) => console.error(...a);
const hr = () => log('─'.repeat(64));

async function main() {
	const PLAYERS = ['A', 'B', 'C'];          // 3 players (the 2–4 range)
	const MOD_ENEMY = 'AngrySkeleton';

	hr(); log('  KD MULTIPLAYER PoC — INTEGRATION CAPSTONE (KD-075)'); hr();

	const s = new IntegratedSession({ seed: 'capstone-seed' });

	// 1) LOBBY ----------------------------------------------------------------
	await s.start();
	const before = await s.getEnemyEverywhere(MOD_ENEMY);
	for (const id of PLAYERS) await s.join(id);
	await s.ready();
	log(`\n[1] LOBBY: ${PLAYERS.length} players joined one session → instances ${PLAYERS.map((p) => `player-${p}`).join(', ')} + world`);
	log(`    world holds ${Object.keys(s.avatarEntities.world).length} player-avatar entities; world player parked off-field`);

	// 2) SERVER-SIDE MOD ------------------------------------------------------
	const mod = await s.loadMod();             // Mods/example_enemy/init.ks
	const present = Object.entries(mod.result).every(([, v]) => v && v.name === MOD_ENEMY);
	log(`\n[2] MOD: loaded Mods/example_enemy/init.ks server-side → '${MOD_ENEMY}' now resolves in ${Object.keys(mod.result).join(', ')} (was absent: world=${before.world === null})  [${present ? 'OK' : 'FAIL'}]`);

	// 3) SHARED WORLD + GLOBAL TURN CLOCK + REACTING ENEMY --------------------
	log('\n[3] SHARED WORLD + TURN CLOCK + ENEMY (players hold position; enemy closes in):');
	let enemyHits = 0;
	for (let t = 0; t < 6; t++) {
		let snap;
		for (const id of PLAYERS) snap = (await s.submitMove(id, { dx: 0, dy: 0 })).turn || snap;
		const ticks = snap.ticks;
		const lock = new Set([ticks.world, ...PLAYERS.map((p) => ticks[p])]).size === 1;
		const e = snap.enemyView.world;
		const hit = snap.enemyHit && snap.enemyHit.applied
			? `enemy hit ${snap.enemyHit.targetClient} (Will→${snap.enemyHit.applied.will})` : '—';
		if (snap.enemyHit && snap.enemyHit.applied) enemyHits++;
		log(`    turn ${t + 1}: ticks=${ticks.world}${lock ? ' (lockstep ✓)' : ' (DESYNC!)'}  enemy@(${e.x},${e.y})  ${hit}`);
	}
	log(`    → ${enemyHits} routed enemy hit(s) landed on the targeted player's own instance`);

	// 4) PvP (world-adjudicated, routed) --------------------------------------
	await s.forceAdjacentInWorld('A', 'B');
	const pvp = await s.routedPvp('A', 'B', { restraint: 'DuctTapeHands', damage: 3 });
	const aSame = JSON.stringify(pvp.before.attacker) === JSON.stringify(pvp.after.attacker);
	log(`\n[4] PvP: A→B  world-authorized=${pvp.authorized} (${pvp.reason})`);
	log(`    B: Will ${pvp.before.target.will}→${pvp.after.target.will}, restraints ${pvp.before.target.restraints}→${pvp.after.target.restraints}  |  A unchanged=${aSame}`);

	// 5) INDEPENDENT PARAMS ---------------------------------------------------
	const params = await s.paramsSnapshot();
	log('\n[5] INDEPENDENT PARAMS (each player = own instance):');
	log('    player  will  restraints  pos      seed');
	for (const id of PLAYERS) {
		const p = params[id];
		log(`    ${id}       ${String(p.will).padEnd(4)}  ${String(p.restraints).padEnd(10)}  (${p.x},${p.y})   ${p.seed}`);
	}
	const seeds = new Set(PLAYERS.map((id) => params[id].seed));
	log(`    → shared map seed identical across all (${seeds.size === 1 ? 'OK' : 'FAIL'}); vitals diverge per-instance`);

	// 6) LOAD READ-OUT --------------------------------------------------------
	const transports = [s.world, ...s.clients.map((c) => c.transport)];
	const st = transports.reduce((acc, tr) => {
		const x = tr.stats ? tr.stats() : { msgs: 0, bytes: 0 };
		return { msgs: acc.msgs + (x.msgs || 0), bytes: acc.bytes + (x.bytes || 0) };
	}, { msgs: 0, bytes: 0 });
	log(`\n[6] TRANSPORT LOAD (in-process): ${st.msgs} messages, ${st.bytes} bytes across the run`);

	await s.close();

	// final verdict
	const ok = present && enemyHits > 0 && pvp.authorized && aSame && seeds.size === 1;
	hr();
	log(ok ? '  ✓ CAPSTONE OK — lobby + shared world + enemy + PvP + mod, all end-to-end' : '  ✗ CAPSTONE FAILED');
	hr();
	process.exit(ok ? 0 : 1);
}

main().catch((e) => { log('CAPSTONE ERROR:', e && e.stack || e); process.exit(1); });
