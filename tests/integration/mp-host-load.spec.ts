/**
 * Co-op host start-mode: with a guest connected the host chooses how to begin the
 * shared session — a fresh New Game (the existing deterministic path) OR Continue
 * from an existing save. MPHostStartSessionFromSave loads the host's localStorage
 * save locally, then broadcasts it; the guest adopts it via the existing state_sync
 * path. Single-page tests drive the start functions directly (the lobby buttons are
 * a thin draw/click layer verified manually).
 */
import { test, expect } from '../helpers/playwright-fixtures';

test('host Continue loads the existing save (not a fresh new game) and reaches Game', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// Build a recognizable save: a distinctive player name lives in KDGameData and
		// is restored from the save on Load (the !Load branch would reset it instead).
		// @ts-ignore
		KDGameData.PlayerName = 'LoadMarker';
		// @ts-ignore
		const saveStr = LZString.compressToBase64(JSON.stringify(KinkyDungeonGenerateSaveData()));
		// @ts-ignore
		localStorage.setItem('KinkyDungeonSave', saveStr);
		// Perturb the LIVE state so a fresh new-game (or no load) would look different.
		// @ts-ignore
		KDGameData.PlayerName = 'PerturbedXXX';

		// @ts-ignore
		const wasActive = MPState.active, wasPlayer = MPState.playerId, wasPeer = MPState.peerConnected;
		// @ts-ignore
		MPState.active = true; MPState.playerId = 0; MPState.peerConnected = true;
		// @ts-ignore
		MPSessionStarted = false;
		// @ts-ignore
		KDLobbyStatus = { phase: 'waiting' };

		// @ts-ignore
		MPHostStartSessionFromSave();

		const out = {
			// @ts-ignore
			state: KinkyDungeonState,
			// @ts-ignore
			started: MPSessionStarted,
			// @ts-ignore
			name: KDGameData.PlayerName,
		};
		// restore
		// @ts-ignore
		MPState.active = wasActive; MPState.playerId = wasPlayer; MPState.peerConnected = wasPeer;
		// @ts-ignore
		MPSessionStarted = false;
		// @ts-ignore
		localStorage.removeItem('KinkyDungeonSave');
		return out;
	});
	expect(r.state).toBe('Game');
	expect(r.started).toBe(true);
	expect(r.name).toBe('LoadMarker');   // loaded the save, not the perturbed live state
});

test('host New Game start still reaches Game (regression — deterministic path unchanged)', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore
		const wasActive = MPState.active, wasPlayer = MPState.playerId, wasPeer = MPState.peerConnected;
		// @ts-ignore
		MPState.active = true; MPState.playerId = 0; MPState.peerConnected = true;
		// @ts-ignore
		MPSessionStarted = false;
		// @ts-ignore
		MPHostStartSession();
		const out = {
			// @ts-ignore
			state: KinkyDungeonState,
			// @ts-ignore
			started: MPSessionStarted,
		};
		// @ts-ignore
		MPState.active = wasActive; MPState.playerId = wasPlayer; MPState.peerConnected = wasPeer;
		// @ts-ignore
		MPSessionStarted = false;
		return out;
	});
	expect(r.state).toBe('Game');
	expect(r.started).toBe(true);
});

test('MPHostStartSessionFromSave is a no-op for the guest / when already started', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore
		const wasActive = MPState.active, wasPlayer = MPState.playerId;
		// @ts-ignore — guest role must not start a session
		MPState.active = true; MPState.playerId = 1;
		// @ts-ignore
		MPSessionStarted = false;
		// @ts-ignore
		KinkyDungeonState = 'Multiplayer';
		// @ts-ignore
		MPHostStartSessionFromSave();
		const out = {
			// @ts-ignore
			startedAfterGuest: MPSessionStarted,
			// @ts-ignore
			state: KinkyDungeonState,
		};
		// @ts-ignore
		MPState.active = wasActive; MPState.playerId = wasPlayer;
		return out;
	});
	expect(r.startedAfterGuest).toBe(false);   // guest never starts the shared session
	expect(r.state).toBe('Multiplayer');
});
