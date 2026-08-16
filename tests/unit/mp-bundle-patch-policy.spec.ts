/**
 * Node-layer (Vitest) tests for the BUNDLE_PATCHES *policy* (KDM-166).
 *
 * Serve-time bundle rewriting is the last resort in the plugin rule's preference order
 * (runtime wrapping > stock API/data > text rewrite). The mechanism stays — but it is the
 * kind of table that silently grows forever, so every entry must justify its existence and
 * carry its own expiry:
 *
 *   repro      — how a human reaches the crash this entry prevents
 *   upstream   — where the bug is reported (issue URL), or the on-disk draft awaiting filing
 *   removeWhen — the condition under which the entry must be DELETED
 *
 * And the expiry must be *observable*: when upstream ships the fix the patch stops matching,
 * and a zero-site entry is dead code that has to go. `auditBundlePatches` turns that into a
 * verdict a test can assert on, rather than a console line nobody reads.
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
	BUNDLE_PATCHES, PATCH_POLICY_FIELDS, validateBundlePatchPolicy, auditBundlePatches,
} = require('../../tools/mp-server/demo-server');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('BUNDLE_PATCHES policy: every entry is justified and has an expiry', () => {
	it('has at least one entry to police (guards a vacuous pass)', () => {
		expect(BUNDLE_PATCHES.length).toBeGreaterThan(0);
	});

	it('every live entry carries all policy fields, non-empty', () => {
		expect(validateBundlePatchPolicy()).toEqual([]);
	});

	it('entry ids are unique (they are how a verdict is addressed)', () => {
		const ids = BUNDLE_PATCHES.map((p: any) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('every `upstream` is a URL, or a draft file that actually exists on disk', () => {
		for (const p of BUNDLE_PATCHES) {
			if (/^https?:\/\//.test(p.upstream)) continue;
			// Not filed yet ⇒ must point at a real draft, so the report can't be vapour.
			const draft = p.upstream.replace(/^unfiled:\s*/, '');
			expect(fs.existsSync(path.join(REPO_ROOT, draft)),
				`entry "${p.id}": upstream "${p.upstream}" is neither a URL nor an existing file`).toBe(true);
		}
	});

	it('rejects an entry missing any policy field — the check is not vacuous', () => {
		for (const field of PATCH_POLICY_FIELDS) {
			const bad = { ...BUNDLE_PATCHES[0], [field]: undefined };
			const violations = validateBundlePatchPolicy([bad]);
			expect(violations.join(' ')).toContain(field);
		}
		// Present-but-blank is just as useless as absent.
		expect(validateBundlePatchPolicy([{ ...BUNDLE_PATCHES[0], repro: '   ' }]).join(' '))
			.toContain('repro');
	});
});

describe('auditBundlePatches: the expiry signal', () => {
	const entry = (over: any = {}) => ({
		id: 'probe', find: 'NEEDLE', repl: 'NEEDLE?', sites: 2,
		repro: 'r', upstream: 'https://example.invalid/1', removeWhen: 'w', ...over,
	});

	it('reports a matching count as ok', () => {
		const rows = auditBundlePatches('NEEDLE x NEEDLE', [entry()]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ id: 'probe', expected: 2, found: 2, verdict: 'ok' });
	});

	it('reports a ZERO-site entry as "delete-me" (upstream fixed it — the entry is dead code)', () => {
		const rows = auditBundlePatches('nothing to see here', [entry()]);
		expect(rows[0]).toMatchObject({ found: 0, verdict: 'delete-me' });
		expect(rows[0].message).toMatch(/delete/i);
	});

	it('reports a drifted count as "stale" (we may be missing a site)', () => {
		const rows = auditBundlePatches('NEEDLE only once', [entry()]);
		expect(rows[0]).toMatchObject({ found: 1, verdict: 'stale' });
	});
});

describe('the real bundle', () => {
	const bundle = path.join(REPO_ROOT, 'out', 'main.js');

	it('has no stale and no expired patch entries', () => {
		if (!fs.existsSync(bundle)) return;   // bundle not built in this environment
		const rows = auditBundlePatches(fs.readFileSync(bundle, 'utf8'));
		const bad = rows.filter((r: any) => r.verdict !== 'ok');
		expect(bad.map((r: any) => r.message).join('\n')).toBe('');
	});
});
