/* =========================================================================
 * MP wire protocol.
 *
 * Tiny module: encoders / parsers. No state, no I/O.
 * Pairs with `tools/mp-server.js`.
 * ========================================================================= */

interface MPActionMessage {
	type: 'action';
	turn: number;
	action: { type: string; data: any };
}
interface MPStateHashMessage {
	type: 'state_hash';
	turn: number;
	hash: string;
}

/**
 * Build an `action` envelope, returning the JSON string ready to send. Returns
 * `null` if the action payload isn't JSON-serializable (circular refs etc.) —
 * the caller is expected to fall back to a local-only apply with a warning.
 */
function MPEncodeAction(turn: number, type: string, data: any): string | null {
	try {
		return JSON.stringify({ type: 'action', turn, action: { type, data } } as MPActionMessage);
	} catch (_) {
		return null;
	}
}

/** Build a `state_hash` envelope. The hash string is computed by KDComputeStateHash. */
function MPEncodeStateHash(turn: number, hash: string): string {
	return JSON.stringify({ type: 'state_hash', turn, hash } as MPStateHashMessage);
}

type MPConnectOpts =
	| { role: 'host' }
	| { code: string }
	| { session: string; player: number };

/**
 * Build the `/mp` WebSocket URL for a connect intent. The server classifies the
 * connection from these query params: `?role=host` (host claim), `?code=NNNN`
 * (guest join), or `?session=&player=` (code-free rejoin).
 */
function MPBuildConnectURL(host: string, port: number, opts: MPConnectOpts): string {
	const base = 'ws://' + host + ':' + port + '/mp';
	if ('role' in opts) return base + '?role=host';
	if ('code' in opts) return base + '?code=' + encodeURIComponent(opts.code);
	return base + '?session=' + encodeURIComponent(opts.session) + '&player=' + opts.player;
}

/** Build a `session_init` envelope: host → guest start-state sync. */
function MPEncodeSessionInit(seed: string, todayDate: number): string {
	return JSON.stringify({ type: 'session_init', seed, todayDate });
}

/**
 * Build a `state_sync` envelope: host → guest full-state broadcast under the
 * host-authoritative model. `state` is the LZString-compressed save string
 * (`KinkyDungeonGenerateSaveData` → JSON → `LZString.compressToBase64`); the guest
 * adopts it verbatim via `KinkyDungeonLoadGame` instead of simulating.
 */
function MPEncodeStateSync(turn: number, state: string): string {
	return JSON.stringify({ type: 'state_sync', turn, state });
}

/** Parse a wire message. Returns `null` on malformed input. */
function MPParseMessage(raw: string): { type: string;[k: string]: any } | null {
	try {
		const m = JSON.parse(raw);
		if (!m || typeof m.type !== 'string') return null;
		return m;
	} catch (_) {
		return null;
	}
}
