/* =========================================================================
 * MP mod-list compatibility.
 *
 * Mod mismatches between the two clients (or between a save and the loaded
 * clients) cause divergent behaviour. Under the host-authoritative model we
 * *warn* but never block: the host compares mod sets and surfaces the
 * differences so the players can decide to proceed or cancel.
 *
 * The comparator (KDCompareModLists) is pure — it takes two explicit lists and
 * is exercised directly by integration tests. The snapshot (KDGetLocalModList)
 * reads the loader's KDModInfo (Scripts/KDMods.ts). A mod-list "fingerprint" is
 * the ordered list of {name, version}; order matters because load order is
 * semantically significant in KD (mods monkey-patch each other).
 * ========================================================================= */

interface KDModEntry { name: string; version: string; }
interface KDModDiff {
	match: boolean;
	missing: string[];          // present in the reference set, absent locally
	extra: string[];            // present locally, absent in the reference set
	versionMismatch: string[];  // same mod name, different version
	orderMismatch: boolean;     // shared mods load in a different relative order
}

/**
 * Snapshot the locally-loaded mod set as an ordered fingerprint. Empty when no
 * mods are loaded (vanilla) — two vanilla clients therefore always match.
 */
function KDGetLocalModList(): KDModEntry[] {
	if (typeof KDModInfo === 'undefined' || !KDModInfo) return [];
	return Object.keys(KDModInfo).map((k) => ({
		name: (KDModInfo[k] && KDModInfo[k].modname) || k,
		version: (KDModInfo[k] && KDModInfo[k].modbuild) || '',
	}));
}

/**
 * Pure comparison of a reference mod set (`ref` — the host's or the save's)
 * against another (`other` — the guest's or the loaded client's). Returns a diff
 * bucketing every kind of mismatch; `match` is true only when the sets are
 * identical in membership, version, and relative load order.
 */
function KDCompareModLists(ref: KDModEntry[], other: KDModEntry[]): KDModDiff {
	ref = Array.isArray(ref) ? ref : [];
	other = Array.isArray(other) ? other : [];
	const refByName = new Map(ref.map((m) => [m.name, m.version]));
	const otherByName = new Map(other.map((m) => [m.name, m.version]));
	const missing = ref.filter((m) => !otherByName.has(m.name)).map((m) => m.name);
	const extra = other.filter((m) => !refByName.has(m.name)).map((m) => m.name);
	const versionMismatch = ref
		.filter((m) => otherByName.has(m.name) && otherByName.get(m.name) !== m.version)
		.map((m) => m.name);
	// Relative order of the mods both sides share.
	const refShared = ref.filter((m) => otherByName.has(m.name)).map((m) => m.name);
	const otherShared = other.filter((m) => refByName.has(m.name)).map((m) => m.name);
	const orderMismatch = JSON.stringify(refShared) !== JSON.stringify(otherShared);
	const match = missing.length === 0 && extra.length === 0 && versionMismatch.length === 0 && !orderMismatch;
	return { match, missing, extra, versionMismatch, orderMismatch };
}

/** Build a short human-readable summary of a diff (empty string when matched). */
function KDModDiffSummary(diff: KDModDiff): string {
	if (!diff || diff.match) return '';
	const parts: string[] = [];
	if (diff.missing.length) parts.push('Missing: ' + diff.missing.join(', '));
	if (diff.extra.length) parts.push('Extra: ' + diff.extra.join(', '));
	if (diff.versionMismatch.length) parts.push('Version differs: ' + diff.versionMismatch.join(', '));
	if (diff.orderMismatch) parts.push('Load order differs');
	return parts.join(' · ');
}

/**
 * Compare a loaded save's recorded mod set (`save.modList`, written by
 * KinkyDungeonGenerateSaveData) against the locally-loaded set. Returns the diff,
 * or a matched diff when the save predates mod recording (no list ⇒ no warning).
 */
function KDSaveModWarning(saveData: any): KDModDiff {
	const recorded: KDModEntry[] = (saveData && Array.isArray(saveData.modList)) ? saveData.modList : [];
	if (!recorded.length) return { match: true, missing: [], extra: [], versionMismatch: [], orderMismatch: false };
	return KDCompareModLists(recorded, KDGetLocalModList());
}

/** Build a `mod_list` envelope: a client announces its mod fingerprint. */
function MPEncodeModList(list: KDModEntry[]): string {
	return JSON.stringify({ type: 'mod_list', list });
}

/**
 * Guest-side handler for the host's `mod_list` announcement: compare against the
 * local set and stash a non-blocking warning string on MPState (null when they
 * match). The lobby screen renders it with proceed/cancel.
 */
function KDReceiveHostModList(list: KDModEntry[]): void {
	if (typeof MPState === 'undefined') return;
	const diff = KDCompareModLists(Array.isArray(list) ? list : [], KDGetLocalModList());
	MPState.modWarning = diff.match ? null : KDModDiffSummary(diff);
}
