/**
 * Node-layer (Vitest) — code installed in BOTH runtimes (the headless world and the browser client)
 * comes from ONE source: `tools/mp-server/kd-peer-shared.js` (KDM-335).
 *
 * Before this, five pieces lived as a server copy and a client copy, and two had already drifted:
 * the client's RemotePlayer def kept `evasion: -100` (the value the server removed because it made
 * every PvP hit land), and the client's entity field list lacked `specialBoundLevel`, `stun`, `freeze`,
 * `vulnerable`. A copy can only drift if it exists, so this spec fails if any of them comes back.
 *
 * Same two-runtime shape as `kd-peace-dialogue.js`: the server evals the text into the world, the
 * browser is served the identical text as a script listed before the files that use it.
 */
import { describe, it, expect } from 'vitest';
import * as vm from 'vm';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');

const MP = path.resolve(__dirname, '../../tools/mp-server');
const SHARED = path.join(MP, 'kd-peer-shared.js');

/** Every runtime JS file of the co-op server and client, except the shared module itself. */
function runtimeFiles(): string[] {
	const out: string[] = [];
	for (const dir of [MP, path.join(MP, 'client')]) {
		for (const f of fs.readdirSync(dir)) {
			const p = path.join(dir, f);
			if (f.endsWith('.js') && p !== SHARED && fs.statSync(p).isFile()) out.push(p);
		}
	}
	return out;
}

/** Strip comments, so prose NAMING a marker neither counts as a copy nor hides one. */
const code = (p: string) => fs.readFileSync(p, 'utf8')
	.replace(/\/\*[\s\S]*?\*\//g, ' ')
	.replace(/(^|[^:\\'"])\/\/.*$/gm, '$1 ');

/** One distinctive line of each piece — present in the shared file, absent everywhere else. */
const MARKERS: Array<{ piece: string, re: RegExp }> = [
	{ piece: 'RemotePlayer avatar def', re: /name:\s*'RemotePlayer'\s*,/ },
	{ piece: 'ally-dialogue guard hide list', re: /'HelpMeCommandWord'/ },
	{ piece: 'entity snapshot field list', re: /'specialBoundLevel'|ENT_FIELDS\s*=/ },
	{ piece: 'start-restraint list parse', re: /split\(\/\[,\\s\]\+\/\)/ },
	{ piece: 'avatar-name prefix test', re: /indexOf\('RemotePlayer'\)\s*===\s*0/ },
];

describe('one source for code installed on both server and client', () => {
	it('the shared module exists and carries every piece', () => {
		expect(fs.existsSync(SHARED), 'tools/mp-server/kd-peer-shared.js').toBe(true);
		const shared = code(SHARED);
		for (const m of MARKERS) expect(shared, `kd-peer-shared.js has the ${m.piece}`).toMatch(m.re);
	});

	it('no runtime file keeps a second copy of any piece', () => {
		const files = runtimeFiles();
		expect(files.length, 'sanity: found the server and client files').toBeGreaterThan(10);
		const copies: string[] = [];
		for (const p of files) {
			const c = code(p);
			for (const m of MARKERS) if (m.re.test(c)) copies.push(`${path.relative(MP, p)}: ${m.piece}`);
		}
		expect(copies).toEqual([]);
	});

	it('the source text is safe to eval and defines KDPeerShared', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { KD_PEER_SHARED, KD_PEER_SHARED_BROWSER, kdParseStartRestraints } = require(SHARED);
		expect(KD_PEER_SHARED).not.toMatch(/`/);             // a backtick ends the host's eval template
		expect(KD_PEER_SHARED_BROWSER).toBe(KD_PEER_SHARED);  // the browser runs the identical text
		const ctx = vm.createContext({});
		vm.runInContext(KD_PEER_SHARED, ctx);
		const names = vm.runInContext('Object.keys(globalThis.KDPeerShared).sort()', ctx);
		expect(names).toEqual(['ENT_FIELDS', 'clone', 'ensureRemotePlayerDef', 'entSnap',
			'installAllyDialogueGuard', 'isPeerAvatarName', 'parseStartRestraints'].sort());
		// node-side consumers (swap-session) get the same function
		expect(kdParseStartRestraints('MasterworkHeels, HighsecShackles  DuctTapeFeet')).toEqual(
			['MasterworkHeels', 'HighsecShackles', 'DuctTapeFeet']);
		expect(kdParseStartRestraints('')).toEqual([]);
		expect(vm.runInContext('KDPeerShared.isPeerAvatarName("RemotePlayer_PlayerB")', ctx)).toBe(true);
		expect(vm.runInContext('KDPeerShared.isPeerAvatarName("Rat")', ctx)).toBe(false);
	});

	it('no test loads render-client.js without its precursors (tests/helpers/client-sandbox.ts)', () => {
		// A spec that adds render-client.js by hand skips the served precursors, and the client dies on
		// load the day a new one appears — exactly how four e2e specs broke when this module was added.
		const roots = ['tests/unit', 'tests/e2e', 'tests/e2e/helpers', 'tests/helpers'].map((d) => path.resolve(__dirname, '../..', d));
		const offenders: string[] = [];
		for (const dir of roots) {
			for (const f of fs.readdirSync(dir)) {
				if (!f.endsWith('.ts') || f === 'client-sandbox.ts') continue;
				const c = code(path.join(dir, f));
				if (/client\/render-client\.js['"]\s*\}\s*\)/.test(c) || /readFileSync\([^)]*render-client\.js/.test(c)) offenders.push(f);
			}
		}
		expect(offenders).toEqual([]);
	});

	it('the browser is served it before the scripts that use it', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { INJECT, SYNTHETIC_ROUTES } = require(path.join(MP, 'demo-server'));
		const route = '/mp/kd-peer-shared.js';
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		expect(SYNTHETIC_ROUTES[route]).toBe(require(SHARED).KD_PEER_SHARED_BROWSER);
		const at = INJECT.indexOf(route);
		expect(at, 'injected').toBeGreaterThanOrEqual(0);
		expect(at).toBeLessThan(INJECT.indexOf('/tools/mp-server/client/render-client.js'));
		expect(at).toBeLessThan(INJECT.indexOf('/tools/mp-server/client/coop-bootstrap.js'));
	});
});
