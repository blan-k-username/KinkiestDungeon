/**
 * tools/mp-server/transport/protocol.js  (KD-081)
 *
 * The message protocol + the transport-agnostic instance dispatcher.
 *
 * An "instance" (world or player) is driven ENTIRELY by serialized JSON messages
 * — `{ cmd, args }` in, a JSON-serializable result out. The same `dispatch`
 * function runs behind every transport (in-process, worker thread, child
 * process), so the only thing that differs between transports is the thin
 * adapter that moves bytes — never the game code, never this handler.
 *
 * Each command maps 1:1 to a HeadlessHost method (the same surface the KD-079
 * reconciler already used). All args and results are plain JSON.
 */
'use strict';

const { HeadlessHost } = require('../headless-host');

/** Create a fresh per-instance state object (one HeadlessHost, lazily booted). */
function createState() {
	return { host: null };
}

/**
 * Handle one protocol message against an instance state. Async so every
 * transport (incl. the async ones) shares one code path.
 * @param {object} state  from createState()
 * @param {{cmd:string, args?:object}} msg
 * @returns {Promise<any>} JSON-serializable result
 */
async function dispatch(state, msg) {
	const cmd = msg && msg.cmd;
	const a = (msg && msg.args) || {};
	const h = state.host;

	switch (cmd) {
		case 'init': {
			// Boot + init + role in one round-trip (instances are created on demand).
			state.host = new HeadlessHost({ id: a.id || 'instance' });
			state.host.boot();
			state.host.init({ seed: a.seed, level: a.level });
			state.host.setServerMode(a.mode || 'world');
			return { ok: true, mode: state.host.serverMode };
		}
		case 'ping':           return { pong: a.seq };   // no host work — isolates transport RTT
		case 'pid':            return { pid: process.pid };
		case 'findOpenTile':   return h.findOpenTile();
		case 'placePlayer':    return h.placePlayer(a.x, a.y);
		case 'applyMove':      return h.applyMove(a.dx, a.dy);
		case 'summonEnemy':    return h.summonEnemy(a.x, a.y, a.type, a.opts || {});
		case 'getRealEnemy':   return h.getRealEnemy(a.index || 0);
		case 'setEnemyTarget': { h.setEnemyTarget(a.x, a.y); return { ok: true }; }
		case 'injectEnemyState': return h.injectEnemyState(a.snapshot);
		case 'upsertAvatar':   return h.upsertAvatar(a.id, a.x, a.y);
		case 'getAvatar':      return h.getAvatar(a.id);
		case 'getPlayerPos':   return h.getPlayerPos();
		case 'getEnemyView':   return h.getEnemyView();
		case 'setServerMode':  return { mode: h.setServerMode(a.mode) };
		case 'runsEnemyAI':    return { value: h.runsEnemyAI() };
		case 'step':           return { tick: h.step(a.n || 1) };
		case 'tick':           return { tick: h.tick() };
		// --- KD-080 features: PvP + server-side mods ---
		case 'loadMod':        return h.loadMod(a.code);
		case 'getEnemyByName': return h.getEnemyByName(a.name);
		case 'getVitals':      return h.getVitals();
		case 'dealDamage':     return h.dealDamage(a.amount, a.type);
		case 'addRestraint':   return h.addRestraint(a.name);
		default:
			throw new Error(`unknown protocol cmd: ${JSON.stringify(cmd)}`);
	}
}

// Commands whose result is a bare value vs an envelope — documented for adapters.
const COMMANDS = [
	'init', 'ping', 'pid', 'findOpenTile', 'placePlayer', 'applyMove', 'summonEnemy',
	'getRealEnemy', 'setEnemyTarget', 'injectEnemyState', 'upsertAvatar', 'getAvatar',
	'getPlayerPos', 'getEnemyView', 'setServerMode', 'runsEnemyAI', 'step', 'tick',
	'loadMod', 'getEnemyByName', 'getVitals', 'dealDamage', 'addRestraint',
];

module.exports = { createState, dispatch, COMMANDS };
