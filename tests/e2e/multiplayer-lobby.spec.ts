/**
 * E2E: the multiplayer lobby renders real, interactive DOM.
 *
 * Drives the lobby into its Join view through the actual per-frame draw loop
 * (KDDrawLobbyPanel runs from KinkyDungeonRun), then asserts the KDTextField
 * inputs were created in the DOM and the 4-digit code filter works. The lobby
 * state machine itself is covered by tests/integration/mp-lobby.spec.ts.
 *
 * The menu Multiplayer button is a one-line state transition identical to the
 * existing Load button; reaching it by pixel-click is left to manual UAT (KD's
 * letterboxed canvas mapping makes coordinate clicks brittle).
 */
import { test, expect } from '../helpers/playwright-fixtures';

test('lobby Join view creates host/code inputs and filters the code to 4 digits', async ({ kdPage }) => {
	await kdPage.evaluate(() => {
		// @ts-ignore — KD bundle globals (lexical, reachable by bare name)
		KinkyDungeonState = 'Multiplayer';
		// @ts-ignore
		KDLobbyView = 'join';
	});

	// The draw loop creates the overlaid <input> elements within a frame or two.
	await kdPage.waitForFunction(
		() => !!document.getElementById('KDLobbyIP') && !!document.getElementById('KDLobbyCode'),
		null,
		{ timeout: 5000 },
	);

	const ip = kdPage.locator('#KDLobbyIP');
	const code = kdPage.locator('#KDLobbyCode');
	await expect(ip).toBeVisible();
	await expect(code).toBeVisible();

	// Host field is prefilled with a default.
	expect((await ip.inputValue()).length).toBeGreaterThan(0);

	// Code field caps at 4 digits (maxlength) …
	expect(await code.getAttribute('maxlength')).toBe('4');
	await code.fill('123456');
	expect(await code.inputValue()).toBe('1234');
	// … and the oninput filter strips non-digits.
	await code.fill('12ab');
	expect(await code.inputValue()).toBe('12');
});
