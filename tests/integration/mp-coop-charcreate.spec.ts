/**
 * Co-op guest character transfer: the guest client runs the game's core
 * character-creation locally (delegated activity — the guest app is a full client),
 * packages the result (class + outfit/dress + appearance + starting stats), and sends
 * it to the host via a `player_character` message. The host validates it (server-side
 * compliance check) and installs it as the P2 entity. P2's resulting appearance then
 * rides the existing host→guest state_sync round-trip.
 *
 * Single-page tests drive the extract/apply/encode data path directly. The guest
 * char-creation SCREEN (canvas draw + click) is a thin layer verified manually/e2e.
 */
import { test, expect } from '../helpers/playwright-fixtures';

test('MPEncodePlayerCharacter round-trips through MPParseMessage', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		const pkg = { class: 'Rogue', dress: 'Default', charAppearance: [{ Name: 'Body' }], stats: { stamina: 7 } };
		// @ts-ignore
		const wire = MPEncodePlayerCharacter(1, pkg);
		// @ts-ignore
		const parsed = MPParseMessage(wire);
		return { type: parsed.type, slot: parsed.playerSlot, cls: parsed.pkg.class, dress: parsed.pkg.dress, stam: parsed.pkg.stats.stamina };
	});
	expect(r.type).toBe('player_character');
	expect(r.slot).toBe(1);
	expect(r.cls).toBe('Rogue');
	expect(r.dress).toBe('Default');
	expect(r.stam).toBe(7);
});

test('KDExtractLocalCharacterPackage captures class, dress, appearance and stats', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore — stage a local character choice the way core char-creation would
		KinkyDungeonClassMode = 'Rogue';
		// @ts-ignore
		const pkg = KDExtractLocalCharacterPackage();
		return {
			cls: pkg.class,
			hasDress: typeof pkg.dress === 'string',
			hasAppearance: pkg.charAppearance !== undefined,
			hasStats: pkg.stats && typeof pkg.stats === 'object' && typeof pkg.stats.stamina === 'number',
		};
	});
	expect(r.cls).toBe('Rogue');
	expect(r.hasDress).toBe(true);
	expect(r.hasAppearance).toBe(true);
	expect(r.hasStats).toBe(true);
});

test('host installs a transferred character onto P2 at spawn; P1 untouched', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore — host session with a peer connected
		const wasActive = MPState.active, wasPlayer = MPState.playerId, wasPeer = MPState.peerConnected;
		// @ts-ignore
		MPState.active = true; MPState.playerId = 0; MPState.peerConnected = true;
		// @ts-ignore — P1's baseline (must not change)
		const p1ClassBefore = (typeof KinkyDungeonClassMode === 'string') ? KinkyDungeonClassMode : null;
		// @ts-ignore
		const p1StamBefore = KinkyDungeonStatStamina;

		// guest's transferred package staged on the host (as the dispatcher would)
		// @ts-ignore
		KDCoopSlotConfig[1] = { class: 'Rogue', dress: 'Default', charAppearance: [{ Name: 'Body' }], stats: { stamina: 7 } };
		// @ts-ignore
		const ent = KDSpawnPlayer2();
		const out = {
			spawned: !!ent,
			// @ts-ignore — P2 reflects the transferred character
			p2Class: ent ? ent.class : null,
			// @ts-ignore
			p2HasAppearance: ent ? ent.charAppearance !== undefined : false,
			// @ts-ignore
			p2Stam: KDGetPlayerStat(1, 'stamina'),
			// @ts-ignore — P1 untouched
			p1ClassAfter: (typeof KinkyDungeonClassMode === 'string') ? KinkyDungeonClassMode : null,
			p1ClassBefore,
			// @ts-ignore
			p1StamAfter: KinkyDungeonStatStamina, p1StamBefore,
		};
		// cleanup
		// @ts-ignore
		KDCoopSlotConfig[1] = undefined;
		// @ts-ignore
		if (ent) { KDMapData.Entities = KDMapData.Entities.filter((e: any) => e !== ent); }
		// @ts-ignore
		KDUnregisterPlayer(1);
		// @ts-ignore
		MPState.active = wasActive; MPState.playerId = wasPlayer; MPState.peerConnected = wasPeer;
		return out;
	});
	expect(r.spawned).toBe(true);
	expect(r.p2Class).toBe('Rogue');           // transferred class recorded on P2
	expect(r.p2HasAppearance).toBe(true);      // transferred appearance stamped on P2
	expect(r.p2Stam).toBe(7);                  // transferred stat applied to P2's own block
	expect(r.p1ClassAfter).toBe(r.p1ClassBefore); // P1's class never touched
	expect(r.p1StamAfter).toBe(r.p1StamBefore);   // P1's stamina never touched
});

test('no transferred package → P2 spawns with defaults (co-op-new-game path unchanged)', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore
		const wasActive = MPState.active, wasPlayer = MPState.playerId, wasPeer = MPState.peerConnected;
		// @ts-ignore
		MPState.active = true; MPState.playerId = 0; MPState.peerConnected = true;
		// @ts-ignore — ensure no config
		KDCoopSlotConfig[1] = undefined;
		// @ts-ignore
		const ent = KDSpawnPlayer2();
		const out = { spawned: !!ent, p2Class: ent ? (ent.class || null) : 'no-ent' };
		// @ts-ignore
		if (ent) { KDMapData.Entities = KDMapData.Entities.filter((e: any) => e !== ent); }
		// @ts-ignore
		KDUnregisterPlayer(1);
		// @ts-ignore
		MPState.active = wasActive; MPState.playerId = wasPlayer; MPState.peerConnected = wasPeer;
		return out;
	});
	expect(r.spawned).toBe(true);
	expect(r.p2Class).toBe(null);   // no class forced when no package — default spawn
});

test('guest config confirm transfers the built character and returns to the waiting screen', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// capture outgoing wire messages (no socket in a single-page test)
		const sent: string[] = [];
		// @ts-ignore
		const origSend = MPSendRaw;
		// @ts-ignore
		MPSendRaw = (json: string) => { sent.push(json); };
		// @ts-ignore — the guest staged a class via the reused core picker
		KinkyDungeonClassMode = 'Rogue';
		// @ts-ignore
		KDLobbyStatus = { phase: 'waiting_host' };
		// @ts-ignore
		KDLobbyView = 'guestConfig';
		// @ts-ignore
		KDGuestConfigConfirm();
		const out = {
			// @ts-ignore
			view: KDLobbyView,
			types: sent.map((j) => { try { return JSON.parse(j).type; } catch { return null; } }),
			cls: sent.length ? ((JSON.parse(sent[0]).pkg) || {}).class : null,
		};
		// @ts-ignore
		MPSendRaw = origSend;
		return out;
	});
	expect(r.types).toContain('player_character');   // the built character was transferred
	expect(r.cls).toBe('Rogue');
	expect(r.view).toBe('join');                     // dropped to the waiting-for-host screen
});

test('the guest config view draws without error (reuses the core class picker)', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore — render the lobby in the guest-config view; must not throw
		KDLobbyStatus = { phase: 'waiting_host' };
		// @ts-ignore
		KDLobbyView = 'guestConfig';
		let threw = false;
		try {
			// @ts-ignore
			KDDrawGuestConfigPanel();
		} catch (e) { threw = true; }
		// @ts-ignore
		KDLobbyView = 'menu';
		return { threw, hasConfirm: typeof (globalThis as any).KDGuestConfigConfirm === 'function' };
	});
	expect(r.threw).toBe(false);             // the reduced char-creation screen renders
});
