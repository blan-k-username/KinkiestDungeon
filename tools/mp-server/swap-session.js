/**
 * tools/mp-server/swap-session.js  (KD-085 — uniform action model)
 *
 * Server-authoritative co-op on the SWAP model (replaces the per-instance action
 * routing): ONE authoritative world; each player is a STATE BUNDLE; per turn each
 * player is swapped into the world's player globals, their action runs through KD's
 * REAL dispatcher (applyInput → KDSendInput/KDProcessInput — full fidelity, ANY
 * action incl. future ones), then swapped back out. The client uses KD's DEFAULT
 * controls and just forwards `{kdType, data}`.
 *
 * Lockstep (R8): the turn advances only when every player has submitted.
 * Conflict (R9): players are applied in RANDOM order on the shared world, so the
 * first-mover wins a contested tile/target (KD's own collision blocks the rest) —
 * random conflict resolution falls out of the model, no special-casing.
 *
 * Other players are shown as avatar entities (KD-082) for rendering; the acting
 * player's avatar is parked while they're swapped in (they ARE the global player).
 */
'use strict';

const { HeadlessHost } = require('./headless-host');

const PARK = { x: 1, y: 1 };

class SwapSession {
	/** @param {object} opts { requiredPlayers=2, seed, enemyType='Rat' } */
	constructor(opts = {}) {
		this.required = opts.requiredPlayers || 2;
		this.seed = opts.seed || 'swap-session-seed';
		this.enemyType = opts.enemyType || 'Rat';
		this.maxLog = opts.maxLog || 100;
		this.pvp = !!opts.pvp;        // global PvP toggle (KD-092) — OFF by default (co-op)
		this.pvpPairs = new Set();    // per-pair PvP relationships (KD-094) — "A|B" sorted keys
		this.friendlyFire = !!opts.friendlyFire; // incidental AOE hits partners (KD-096) — OFF by default
		// KD-098: a routed bind (Truss/Bondage spell) only succeeds once the peer is "subdued" —
		// their Will fraction at/below this threshold — mirroring the base game's bind-when-helpless
		// (low-HP) rule. The low-level pvpBind PRIMITIVE stays ungated (PoC/tests use it directly).
		this.bindWillThresh = (opts.bindWillThresh != null) ? opts.bindWillThresh : 0.5;
		this.mods = Array.isArray(opts.mods) ? opts.mods.slice() : []; // server-side mod code (KD-074)
		this.world = new HeadlessHost({ id: 'world' });
		this.bundles = new Map();     // id -> player-state bundle
		this.avatars = new Map();     // id -> world avatar entity id
		this.startOf = new Map();     // id -> {x,y}
		this.logs = new Map();        // id -> per-player message log (KD-090)
		this.actionMsgOf = new Map(); // id -> {text,color} transient floating combat text (KD-098)
		this.vitalsOf = new Map();    // id -> {will,willMax,...} last-known vitals (KD-098 HP bar)
		this.defeated = new Set();    // ids whose Will hit 0 — incapacitated (KD-099)
		this._joined = [];
		this._pending = new Map();    // id -> { kdType, data }
		this.started = false;
		this.turn = 0;
		this.enemyId = null;
		this.lastTurn = null;         // debug/assert record of the last resolution
		// KD-098 diagnostics: set KD_MP_DEBUG=1 (or opts.debug) to trace action resolution
		// per turn to the server console — what each player submitted, how it was classified
		// (move/wait/sneak/peer-attack/plain), the PvP adjacency, and the applied result.
		this.debug = !!opts.debug || (typeof process !== 'undefined' && process.env && process.env.KD_MP_DEBUG === '1');
		this._dbgBuf = [];            // server diagnostics buffered for piping to the browser
	}

	/** Has this player been defeated (Will hit 0)? Sticky until freed (freeing = future work). */
	isDefeated(id) { return this.defeated.has(id); }

	/**
	 * KD-099: flag a player defeated the first time their Will hits 0, and broadcast it to ALL
	 * players (shared event). Called with the player swapped in (so the real KD message API runs).
	 * A defeated player is then incapacitated in _advanceTurn (their action becomes a no-op).
	 */
	_checkDefeat(id, v) {
		if (!v || v.will == null || v.will > 0) return;
		if (this.defeated.has(id)) return;
		this.defeated.add(id);
		const txt = `Player ${id} has been defeated!`;
		const fb = this.world.sendFeedback(txt, '#ff3333', 12);
		const entries = (fb && fb.entries) || [];
		for (const pid of this._joined) this._pushLog(pid, entries);
		this.actionMsgOf.set(id, { text: 'Defeated!', color: '#ff3333' });
		this._dbg(`DEFEAT ${id} (will<=0)`);
	}

	/** Server-side diagnostic log (gated by this.debug / KD_MP_DEBUG). Also buffered so the
	 *  WS bridge can ship it to the browser console (no need to read the Docker terminal). */
	_dbg(msg) { if (this.debug) { try { console.error('[mp] ' + msg); } catch (e) { /* ignore */ } this._dbgBuf.push(msg); if (this._dbgBuf.length > 200) this._dbgBuf.shift(); } }

	/** Drain the buffered server diagnostics (the WS bridge forwards these to clients). */
	takeDbg() { const b = this._dbgBuf; this._dbgBuf = []; return b; }

	get players() { return [...this._joined]; }

	join(clientId) {
		if (this.started) throw new Error(`session already started — cannot join ${clientId}`);
		if (this._joined.includes(clientId)) throw new Error(`duplicate join: ${clientId}`);
		this._joined.push(clientId);
		if (this._joined.length >= this.required) this._start();
		return { clientId, joined: [...this._joined], started: this.started };
	}

	_start() {
		this.world.boot();
		this.world.init({ seed: this.seed });
		this.world.setServerMode('world');
		// KD-074: load server-side mods into the ONE authoritative world (players are state
		// bundles — no per-instance engine, so "all instances agree" is automatic). Same eval
		// path as the browser loader (KDMods.ts) — mods push to KD globals / reassign functions.
		for (const code of this.mods) { try { this.world.loadMod(code); } catch (e) { /* keep going */ } }
		const base = this.world.findOpenTile();
		let i = 0;
		for (const id of this._joined) {
			const pos = { x: base.x + i, y: base.y };
			// give each player a starting bundle at a distinct position
			this.world.placePlayer(pos.x, pos.y);
			this.bundles.set(id, this.world.capturePlayer());
			this.vitalsOf.set(id, this.world.getVitals());   // KD-098: seed for the HP bar
			const av = this.world.spawnAvatar(pos.x, pos.y, 'Player ' + id);
			this.avatars.set(id, av.entityId);
			this.startOf.set(id, pos);
			i++;
		}
		// one shared enemy near the players; park the global player between turns
		this.world.placePlayer(base.x, base.y);
		const enemy = this.world.summonEnemy(base.x + this._joined.length, base.y, this.enemyType, { rad: 6 });
		this.enemyId = enemy ? enemy.id : null;
		this.world.parkGlobalPlayer(PARK.x, PARK.y);
		// KD-090: seed every player's personal log with the shared intro log; per-turn
		// deltas are appended in _advanceTurn so each client sees only its own messages.
		const intro = this.world.messageLog();
		for (const id of this._joined) this.logs.set(id, intro.slice());
		this.started = true;
	}

	/**
	 * Submit a player's action ({kdType, data} — KD's real input, or a {kind} for the
	 * built-in move/wait helpers). Returns { advanced, waitingOn } / { advanced, turn }.
	 */
	submit(clientId, action = {}) {
		if (!this.started) throw new Error('session not started');
		if (!this._joined.includes(clientId)) throw new Error(`unknown player ${clientId}`);
		this._pending.set(clientId, action);
		this._dbg(`submit turn=${this.turn} ${clientId} action=${JSON.stringify(action)}`);
		const waitingOn = this._joined.filter((id) => !this._pending.has(id));
		if (waitingOn.length > 0) return { advanced: false, waitingOn };
		return { advanced: true, turn: this._advanceTurn() };
	}

	/** Apply every player's action on the shared world, in random order (R8/R9). */
	_advanceTurn() {
		const order = this._shuffle(this._joined.slice());
		const applied = [];
		this.actionMsgOf.clear();   // floating combat text is per-turn transient (KD-098)
		for (const id of order) {
			let action = this._pending.get(id) || { kind: 'wait' };
			// KD-099: a defeated player is incapacitated — their move/attack is a no-op (wait).
			if (this.defeated.has(id) && action.kind !== 'wait') action = { kind: 'wait' };
			const { kdType, data } = this._toInput(id, action);
			// swap this player in; park their avatar so it doesn't block their own move
			this.world.restorePlayer(this.bundles.get(id));
			const avId = this.avatars.get(id);
			if (avId != null) this.world.moveAvatar(avId, PARK.x, PARK.y);
			// KD-090: capture this player's message-log delta (messages pushed while THEY
			// are the swapped-in player are theirs — incl. enemy-AI lines aimed at them).
			const logLen0 = this.world.messageLogLength();
			const lvl0 = this.world.getLevel();
			let result = null;
			if (action && (action.kind === 'pvpAttack' || action.kind === 'pvpBind')) {
				// PvP (KD-092/093): A is swapped in now; route A's attack/bind onto target B's bundle.
				result = this._applyPvP(id, action);
			} else {
				// KD-095: a stock `doaggro` (sneak attack) on a peer STARTS PvP for that pair, then
				// applies the first hit (co-op → PvP transition; nothing new in mechanics).
				const sneakPeer = this._sneakTargetOf(id, kdType, data);
				// KD-094: a stock `doattack` aimed at a PvP-active peer's avatar becomes a PvP hit.
				const peer = this._pvpTargetOf(id, action, kdType, data);
				// KD-098: a stock `move` INTO a PvP peer's tile is a melee bump-attack.
				const bumpPeer = (!sneakPeer && !peer) ? this._bumpTargetOf(id, kdType, data) : null;
				// KD-098: the Truss/Bondage spell aimed at a PvP peer is a bind (WP-gated below).
				const bindPeer = (!sneakPeer && !peer && !bumpPeer) ? this._bindTargetOf(id, kdType, data) : null;
				this._dbg(`resolve ${id}: kdType=${kdType} dataId=${data && data.id} sneakPeer=${sneakPeer || '-'} pvpPeer=${peer || '-'} bumpPeer=${bumpPeer || '-'} bindPeer=${bindPeer || '-'} branch=${sneakPeer ? 'sneak' : peer ? 'peer-attack' : bumpPeer ? 'bump-attack' : bindPeer ? 'bind' : 'plain'}`);
				if (sneakPeer) {
					this.setPvPPair(id, sneakPeer, true);
					result = this._applyPvP(id, { kind: 'pvpAttack', target: sneakPeer });
				} else if (peer) {
					result = this._applyPvP(id, { kind: 'pvpAttack', target: peer });
				} else if (bumpPeer) {
					result = this._applyPvP(id, { kind: 'pvpAttack', target: bumpPeer });
				} else if (bindPeer) {
					// WP gate: only bind a SUBDUED peer (low Will), like the base game's bind-when-helpless.
					const v = this.vitalsOf.get(bindPeer);
					const frac = (v && v.willMax) ? (v.will / v.willMax) : 1;
					if (frac <= this.bindWillThresh) {
						result = this._applyPvP(id, { kind: 'pvpBind', target: bindPeer, restraint: 'DuctTapeFeet' });
					} else {
						const txt = `Player ${bindPeer} resists — wear their WP down before binding!`;
						const fb = this.world.sendFeedback(txt, '#ffcc55', 8);
						this._pushLog(id, fb && fb.entries);
						this.actionMsgOf.set(id, { text: txt, color: '#ffcc55' });
						result = { applied: false, reason: 'not-subdued', willFrac: frac, feedbackRouted: true };
						this._dbg(`bind ${id}->${bindPeer}: REJECT not-subdued willFrac=${frac.toFixed(2)} thresh=${this.bindWillThresh}`);
					}
				} else if (kdType) {
					result = this.world.applyInput(kdType, data);
					// KD-096: an AOE cast whose footprint covers a partner splashes them (co-op
					// friendly-fire), even without intentional PvP.
					const ff = this._applyFriendlyFire(id, kdType, data);
					if (ff && ff.length) result = { cast: result, friendlyFire: ff };
				}
			}
			// Capture the delta; if the log was reset this turn (e.g. a floor transition
			// clears it), take the whole new log as the delta.
			const newLen = this.world.messageLogLength();
			const added = (newLen >= logLen0) ? this.world.messagesSince(logLen0) : this.world.messageLog();
			if (added && added.length && !(result && result.feedbackRouted)) {
				// KD-098: PvP feedback is generated + routed inside _applyPvP (to the victim and
				// attacker explicitly); skip the generic delta here so it isn't re-credited to the
				// acting player (the KD-097 misroute that left the victim with no message).
				// KD-097: messages are SHARED with all players by default (world/enemy/tutorial
				// events everyone should see); only the acting player's PERSONAL 2nd-person lines
				// ("You …"/"Your …") stay private to them. A floor change forces all-broadcast.
				const floorEvent = this.world.getLevel() !== lvl0;
				for (const m of added) {
					const personal = !floorEvent && this._isPersonalMessage(m);
					const targets = personal ? [id] : this._joined;
					for (const tid of targets) {
						const lg = this.logs.get(tid) || [];
						lg.push(m);
						while (lg.length > this.maxLog) lg.shift();
						this.logs.set(tid, lg);
					}
				}
			}
			// swap out: persist this player's new state + move their avatar to its new spot
			this.bundles.set(id, this.world.capturePlayer());
			this.vitalsOf.set(id, this.world.getVitals());   // KD-098: refresh for the HP bar
			this._checkDefeat(id, this.vitalsOf.get(id));    // KD-099: defeat if this player's Will hit 0
			const p = this.world.getPlayerPos();
			if (avId != null) this.world.moveAvatar(avId, p.x, p.y);
			applied.push({ id, kdType, result, pos: p });
		}
		this.world.parkGlobalPlayer(PARK.x, PARK.y);
		this.turn += 1;
		this._pending.clear();
		this.lastTurn = { order, applied };
		return { turn: this.turn, applied };
	}

	/** Enable/disable GLOBAL player-vs-player damage for this session (KD-092). */
	setPvP(on) { this.pvp = !!on; return this.pvp; }

	/** A message is "personal" to the acting player if it is 2nd-person feedback ("You …"/"Your …").
	 *  Everything else (enemy/world/tutorial lines) is shared with all players (KD-097). Heuristic. */
	_isPersonalMessage(m) {
		const t = (m && m.text != null) ? String(m.text).trim() : '';
		return /^you\b|^your\b|^you'/i.test(t);
	}

	/** Enable/disable incidental AOE friendly-fire between partners (KD-096). */
	setFriendlyFire(on) { this.friendlyFire = !!on; return this.friendlyFire; }

	/**
	 * Load a mod's code server-side (KD-074). Before the session starts it's queued and loaded at
	 * `_start`; after start it's eval'd into the live world immediately. One world ⇒ one load.
	 */
	loadMod(code) {
		if (this.started) return this.world.loadMod(code);
		this.mods.push(code);
		return { ok: true, queued: true };
	}

	/** Look up an enemy def by name in the authoritative world (verify a mod took effect). */
	getEnemyByName(name) { return this.world.getEnemyByName(name); }

	/**
	 * If `id` cast an AOE spell whose footprint covers a partner's position, apply splash to that
	 * partner's bundle (KD-096). The caster is swapped in; we save it, apply to each covered peer
	 * (swap in / applyEnemyHit / capture), then restore the caster. Returns [{id,before,after}].
	 * Approximate (Chebyshev radius around the target tile; ignores walls/LoS/the real bullet).
	 */
	_applyFriendlyFire(id, kdType, data) {
		if (!this.friendlyFire || kdType !== 'tryCastSpell') return [];
		const d = data || {};
		const info = (d.spellname != null) ? this.world.getSpellInfo(d.spellname) : null;
		if (!info || !(info.aoe > 0)) return [];
		const tx = d.tx, ty = d.ty;
		if (tx == null || ty == null) return [];
		const ents = this.world.listEntities();
		const caster = this.world.capturePlayer();
		const splashed = [];
		for (const pid of this._joined) {
			if (pid === id) continue;
			const av = ents.find((e) => e.id === this.avatars.get(pid));
			if (!av) continue;
			if (Math.max(Math.abs(av.x - tx), Math.abs(av.y - ty)) > info.aoe) continue;
			this.world.restorePlayer(this.bundles.get(pid));
			const before = this.world.getVitals();
			this.world.applyEnemyHit({ damage: info.power, type: info.type });
			const after = this.world.getVitals();
			this.bundles.set(pid, this.world.capturePlayer());
			splashed.push({ id: pid, before, after });
		}
		this.world.restorePlayer(caster);
		return splashed;
	}

	/** Enable/disable PvP between a specific PAIR of players (KD-094, "PvP starts between A and B"). */
	setPvPPair(a, b, on) {
		const key = [a, b].sort().join('|');
		if (on === false) this.pvpPairs.delete(key); else this.pvpPairs.add(key);
		return this._isPvP(a, b);
	}

	/** Are players `a` and `b` in a PvP relationship? (global toggle OR a per-pair relationship.) */
	_isPvP(a, b) {
		if (this.pvp) return true;
		return this.pvpPairs.has([a, b].sort().join('|'));
	}

	/** Reverse-map an action's target entity id to a PEER clientId (or null). Shared by the
	 *  doattack (KD-094) and doaggro (KD-095) routing. */
	_peerTargetOf(id, data) {
		const d = data || {};
		let targetEnt = (d.id != null) ? d.id : null;
		if (targetEnt == null && d.enemy && typeof d.enemy === 'object' && d.enemy.__kdEnt != null && d.enemy.__kdEnt !== 'player') {
			targetEnt = d.enemy.__kdEnt;
		}
		if (targetEnt == null) return null;
		for (const [cid, eid] of this.avatars.entries()) { if (eid === targetEnt && cid !== id) return cid; }
		return null;
	}

	/**
	 * If `id`'s action is a stock attack aimed at a PvP-active PEER's avatar, return that peer's
	 * clientId (so the turn loop routes it to `_applyPvP` — the "peers-as-Enemy" model: a normal
	 * `doattack` on a peer becomes a PvP hit). Else null. KD-094.
	 */
	_pvpTargetOf(id, action, kdType, data) {
		if (kdType !== 'doattack') return null; // spell-PvP is a later extension
		const peer = this._peerTargetOf(id, data || (action && action.data));
		return (peer && this._isPvP(id, peer)) ? peer : null;
	}

	/**
	 * If `id`'s action is a stock `doaggro` (sneak attack) aimed at a PEER's avatar, return that
	 * peer's clientId — REGARDLESS of current PvP state (this is what STARTS PvP). Else null. KD-095.
	 */
	_sneakTargetOf(id, kdType, data) {
		if (kdType !== 'doaggro') return null;
		return this._peerTargetOf(id, data);
	}

	/**
	 * Bump-to-attack (KD-098): if `id`'s action is a stock `move` whose DESTINATION tile is a
	 * PvP-active peer's avatar, return that peer's clientId so the turn loop routes it to
	 * _applyPvP — walking into your enemy melees them. Far more reliable than right-clicking a
	 * moving peer's exact tile. MUST be called AFTER `id` is swapped in (uses getPlayerPos).
	 * Gated by _isPvP so bumping a co-op ally is still a normal (blocked) move, not an attack.
	 */
	/**
	 * Bind routing (KD-098): if `id`'s action is the stock Bondage spell (the context-menu Truss
	 * option → `tryCastSpell` with spellname "Bondage") aimed at a PvP peer's avatar tile, return
	 * that peer's clientId. The turn loop then WP-gates it and routes to _applyPvP('pvpBind'). Else
	 * null. Must be called AFTER `id` is swapped in (peer avatars are at their real world tiles).
	 */
	_bindTargetOf(id, kdType, data) {
		if (kdType !== 'tryCastSpell') return null;
		const d = data || {};
		if (d.spellname !== 'Bondage') return null;     // only the bondage/truss spell
		if (d.tx == null || d.ty == null) return null;
		const ents = this.world.listEntities();
		for (const [cid, eid] of this.avatars.entries()) {
			if (cid === id || !this._isPvP(id, cid)) continue;
			const ent = ents.find((e) => e.id === eid);
			if (ent && ent.x === d.tx && ent.y === d.ty) return cid;
		}
		return null;
	}

	_bumpTargetOf(id, kdType, data) {
		if (kdType !== 'move') return null;
		const dir = data && data.dir;
		if (!dir || ((dir.x | 0) === 0 && (dir.y | 0) === 0)) return null;
		const p = this.world.getPlayerPos();
		const tx = p.x + (dir.x | 0), ty = p.y + (dir.y | 0);
		const ents = this.world.listEntities();
		for (const [cid, eid] of this.avatars.entries()) {
			if (cid === id || !this._isPvP(id, cid)) continue;
			const ent = ents.find((e) => e.id === eid);
			if (ent && ent.x === tx && ent.y === ty) return cid;
		}
		return null;
	}

	/**
	 * Route attacker `id`'s attack/bind onto target `action.target` (KD-092/093, Strategy B). The
	 * attacker is ALREADY swapped in. Gated by the session PvP toggle and world adjacency. For
	 * `pvpAttack`: computes the attacker's weapon attack and applies damage via the player path
	 * (applyEnemyHit → KinkyDungeonDealDamage). For `pvpBind`: applies a restraint via the player
	 * path (addRestraint → KinkyDungeonAddRestraint). Either way: swap the target in, apply,
	 * capture the target, then restore the attacker (so the turn loop's capture stays correct).
	 * The target's restraint-derived locks (slow/blind/tags) self-heal from the captured inventory
	 * on the target's next turn (KD-073 §B) — see HeadlessHost.playerSlowLevel.
	 */
	_applyPvP(id, action) {
		const targetId = action.target;
		if (!this._joined.includes(targetId) || targetId === id) {
			return { applied: false, reason: 'bad-target' };
		}
		if (!this._isPvP(id, targetId)) return { applied: false, reason: 'pvp-off' };
		// adjacency: attacker (swapped in) vs the target's avatar entity
		const a = this.world.getPlayerPos();
		const bEnt = this.world.listEntities().find((e) => e.id === this.avatars.get(targetId));
		if (!bEnt) { this._dbg(`pvp ${id}->${targetId}: REJECT no-target-avatar`); return { applied: false, reason: 'no-target-avatar' }; }
		const dist = Math.max(Math.abs(a.x - bEnt.x), Math.abs(a.y - bEnt.y));
		this._dbg(`pvp ${id}->${targetId}: aPos=${a.x},${a.y} bAvatar=${bEnt.x},${bEnt.y} dist=${dist}`);
		if (dist > 1) return { applied: false, reason: 'out-of-range', dist };

		// compute the attacker's outgoing attack while they are swapped in
		const atk = this.world.computePlayerAttack();
		// swap the attacker out, the target in, apply, capture target, swap attacker back in
		const aBundle = this.world.capturePlayer();
		this.world.restorePlayer(this.bundles.get(targetId));
		const before = this.world.getVitals();
		let restraint = null;
		if (action.kind === 'pvpBind') {
			restraint = this.world.addRestraint(action.restraint || atk.bindType || 'DuctTapeFeet');
		} else {
			this.world.applyEnemyHit({ damage: atk.damage, type: atk.type });
		}
		const after = this.world.getVitals();
		this.vitalsOf.set(targetId, after);   // KD-098: refresh victim's HP bar immediately on hit
		this._checkDefeat(targetId, after);   // KD-099: a PvP hit that empties Will defeats the victim
		// KD-098: emit REAL combat feedback (KinkyDungeonSendTextMessage via host.sendFeedback)
		// for the VICTIM while they are still swapped in, and route it straight to the victim's
		// personal log + floating text — the silent KinkyDungeonDealDamage path emits nothing.
		const dmgN = Math.round((atk.damage || 0) * 10) / 10;
		const victimText = (action.kind === 'pvpBind')
			? `Player ${id} restrains you! (${restraint || atk.bindType || 'bondage'})`
			: `Player ${id} attacks you for ${dmgN} ${atk.type}!`;
		const vfb = this.world.sendFeedback(victimText, '#ff5555', 10);
		this._pushLog(targetId, vfb && vfb.entries);
		this.actionMsgOf.set(targetId, { text: victimText, color: '#ff5555' });
		this.bundles.set(targetId, this.world.capturePlayer());
		this.world.restorePlayer(aBundle);
		// attacker-facing line, generated while the attacker is swapped back in
		const attackerText = (action.kind === 'pvpBind')
			? `You restrain Player ${targetId}.`
			: `You attack Player ${targetId} for ${dmgN} ${atk.type}.`;
		const afb = this.world.sendFeedback(attackerText, '#ffcc55', 10);
		this._pushLog(id, afb && afb.entries);
		this.actionMsgOf.set(id, { text: attackerText, color: '#ffcc55' });
		return { applied: true, kind: action.kind, dist, atk, before, after, restraint, feedbackRouted: true };
	}

	/** Append message-log entries to a player's personal log, trimmed to maxLog (KD-098). */
	_pushLog(id, entries) {
		if (!entries || !entries.length) return;
		const lg = this.logs.get(id) || [];
		for (const m of entries) { lg.push(m); while (lg.length > this.maxLog) lg.shift(); }
		this.logs.set(id, lg);
	}

	/** Map a submitted action to a KD input {kdType, data}. */
	_toInput(id, action) {
		if (action.kdType) return { kdType: action.kdType, data: action.data || {} };
		// built-in helpers
		if (action.kind === 'move') {
			return { kdType: 'move', data: { dir: { x: action.dx | 0, y: action.dy | 0 }, delta: 1, AllowInteract: true } };
		}
		if (action.kind === 'wait') return { kdType: 'tick', data: { delta: 1 } };
		// legacy {dx,dy}
		if ((action.dx | 0) !== 0 || (action.dy | 0) !== 0) {
			return { kdType: 'move', data: { dir: { x: action.dx | 0, y: action.dy | 0 }, delta: 1, AllowInteract: true } };
		}
		return { kdType: 'tick', data: { delta: 1 } };
	}

	/** Fisher–Yates (plain Math.random — node side, not the bundle's seeded RNG). */
	_shuffle(a) {
		for (let i = a.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			const t = a[i]; a[i] = a[j]; a[j] = t;
		}
		return a;
	}

	/** Players who have NOT yet submitted an action for the current turn. */
	waitingOn() { return this._joined.filter((id) => !this._pending.has(id)); }

	/** Current world tick (lockstep marker). */
	tick() { return this.world.tick(); }

	/** A player's current position (from their bundle's avatar in the world). */
	posOf(id) {
		const e = this.world.listEntities().find((x) => x.id === this.avatars.get(id));
		return e ? { x: e.x, y: e.y } : null;
	}

	/** The shared enemy's authoritative state. */
	enemyView() {
		return this.world.listEntities().find((e) => e.id === this.enemyId) || null;
	}

	/**
	 * Compose a client's render-state snapshot from the ONE authoritative world plus
	 * that client's state bundle: swap the client in (so player entity + stats are
	 * theirs), serialize the world's render-state, then drop the client's OWN avatar
	 * from the Entities list — they render as the global player, not as an avatar
	 * (the other players' avatars stay). Re-park the global player afterwards so the
	 * world is clean between turns. Snapshot shape === HeadlessHost.serializeRenderState
	 * (render-state v1) — exactly what KDRenderClient.apply() consumes in the browser.
	 */
	snapshotFor(clientId) {
		if (!this.started) throw new Error('session not started');
		const bundle = this.bundles.get(clientId);
		if (!bundle) throw new Error(`unknown player ${clientId}`);
		this.world.restorePlayer(bundle);
		const snap = this.world.serializeRenderState();
		// KD-098: the headless world never runs the draw-ease loop, so entities' visual_x/visual_y
		// stay stuck near spawn while x/y jump via AI — the client then re-eases from the stale
		// spot each turn (the "Rat teleports from its initial tile through several tiles"). Snap
		// visual→real so every entity renders at its authoritative position. Turn-based ⇒ snapping
		// is correct (peer avatars already snap via moveAvatar).
		if (snap.map && Array.isArray(snap.map.Entities)) {
			for (const e of snap.map.Entities) { e.visual_x = e.x; e.visual_y = e.y; }
		}
		if (snap.player) { snap.player.visual_x = snap.player.x; snap.player.visual_y = snap.player.y; }
		const ownAvatar = this.avatars.get(clientId);
		if (snap.map && Array.isArray(snap.map.Entities) && ownAvatar != null) {
			snap.map.Entities = snap.map.Entities.filter((e) => e.id !== ownAvatar);
		}
		// KD-090: replace the shared world log with THIS client's personal log so each
		// player sees only their own relevant messages (not the other player's actions).
		if (snap.messages) snap.messages.log = (this.logs.get(clientId) || []).slice(-this.maxLog);
		// KD-098: this turn's PvP floating combat text, scoped to this client (victim or attacker).
		const am = this.actionMsgOf.get(clientId);
		if (am && snap.messages) { snap.messages.action = am.text; snap.messages.actionColor = am.color; snap.messages.actionTime = 2; }
		// KD-094: peers in a PvP relationship with this client render+target as Enemy faction
		// (stock attack mechanics then "just work" — the client originates a normal doattack).
		if (snap.map && Array.isArray(snap.map.Entities)) {
			for (const [cid, eid] of this.avatars.entries()) {
				if (cid === clientId) continue;
				const ent = snap.map.Entities.find((e) => e.id === eid);
				if (!ent) continue;
				// KD-098: drive the peer's HP bar from their REAL defeat meter (Will). The avatar's
				// own hp is a meaningless static 100; map Will→hp so the bar shows how close this
				// player is to defeat (matches their WP corner gauge). Snapshot ent is a deep clone,
				// so mutating it is per-client and safe.
				const v = this.vitalsOf.get(cid);
				if (v && v.will != null && v.willMax) {
					const maxhp = (ent.Enemy && ent.Enemy.maxhp) || 100;
					ent.hp = Math.max(0, Math.round((v.will / v.willMax) * maxhp));
					ent.visual_hp = ent.hp;
				}
				// KD-094: PvP peers render+target as Enemy faction (red bar; stock attack mechanics).
				if (this._isPvP(clientId, cid)) { ent.faction = 'Enemy'; ent.hostile = 9999; }
			}
		}
		// KD-099: expose the defeated players so the client HUD can mark them (down/incapacitated).
		snap.defeatedPlayers = [...this.defeated];
		this.world.parkGlobalPlayer(PARK.x, PARK.y);
		return snap;
	}
}

module.exports = { SwapSession };
