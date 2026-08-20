/**
 * PROBE (KDM-225) — why can a player open the interaction submenu on an NPC they attacked, but not
 * on a peer avatar they are at war with?
 *
 * MEASURED, not reasoned. `KDInteract` (KinkyDungeonInput.ts:1727-1741) opens the "GenericAlly"
 * dialogue on an adjacent entity when:
 *
 *     KDIsImprisoned(E) || ((!KinkyDungeonAggressive(E) || KDAllied(E)) && !(E.playWithPlayer && KDCanDom(E)))
 *
 * The gate runs in the BROWSER, against the entity the SNAPSHOT gave it — so it is evaluated here on
 * exactly that object, not on the world entity (the KDM-200 lesson: a wire whitelist / a wire STAMP
 * is what the client's predicates actually see).
 *
 * Three subjects, so the answer is a comparison and not an assertion about one case:
 *   wireAvatar   — B's avatar as A receives it, at war
 *   worldNpc     — a plain non-avatar entity on the map
 *   avatarNoStamp— the same avatar object with our `hostile` stamp removed
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 300_000;

describe('PROBE — the interaction-menu gate, on the object the client evaluates', () => {
	it('reports the gate for a peer avatar vs a real NPC', async () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'peace-menu-probe', pvp: true });
		s.join('A'); s.join('B');
		await s.ready();
		s._armPeerEnemies('A');

		const snap = s.snapshotFor('A');
		const ents = (snap.map && snap.map.Entities) || [];
		const wireAvatar = ents.find((e: any) => e.id === s.avatars.get('B'));
		const worldNpc = ents.find((e: any) => e.Enemy && String(e.Enemy.name).indexOf('RemotePlayer') !== 0);

		const noStamp = wireAvatar ? Object.assign({}, wireAvatar, { hostile: 0 }) : null;

		s.world.restorePlayer(s.bundles.get('A'));
		const report = s.world.eval('(function(){'
			+ ' function gate(e) {'
			+ '   if (!e) return { missing: true };'
			+ '   var aggressive = KinkyDungeonAggressive(e);'
			+ '   var allied = KDAllied(e);'
			+ '   var imprisoned = !!KDIsImprisoned(e);'
			+ '   var domBlock = !!(e.playWithPlayer && KDCanDom(e));'
			+ '   var opens = imprisoned || ((!aggressive || allied) && !domBlock);'
			+ '   return { name: e.Enemy && e.Enemy.name, faction: e.faction, hostile: e.hostile || 0,'
			+ '     rage: e.rage || 0, hp: e.hp, hostileFn: KDHostile(e),'
			+ '     aggressive: aggressive, allied: allied, imprisoned: imprisoned, domBlock: domBlock,'
			+ '     notalk: !!(e.Enemy && e.Enemy.tags && e.Enemy.tags.notalk),'
			+ '     dialogue: (e.Enemy && e.Enemy.specialdialogue) || "GenericAlly",'
			+ '     MENU_OPENS: opens };'
			+ ' }'
			+ ' return { wireAvatar: gate(' + JSON.stringify(wireAvatar || null) + '),'
			+ '   avatarNoStamp: gate(' + JSON.stringify(noStamp) + '),'
			+ '   worldNpc: gate(' + JSON.stringify(worldNpc || null) + ') };'
			+ '})()');

		// eslint-disable-next-line no-console
		console.log('\n=== KDInteract gate, evaluated on the CLIENT-side object ===\n'
			+ JSON.stringify(report, null, 2) + '\n');
		expect(report).toBeTruthy();
	}, BOOT_TIMEOUT);
	it('mutates one field at a time on a hostile NPC', async () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'peace-menu-probe2', pvp: true });
		s.join('A'); s.join('B');
		await s.ready();
		s.world.restorePlayer(s.bundles.get('A'));

		const report = s.world.eval('(function(){'
			+ ' function gate(e) {'
			+ '   var aggressive = KinkyDungeonAggressive(e);'
			+ '   var allied = KDAllied(e);'
			+ '   var imprisoned = !!KDIsImprisoned(e);'
			+ '   var domBlock = !!(e.playWithPlayer && KDCanDom(e));'
			+ '   return { aggressive: aggressive, allied: allied, imprisoned: imprisoned,'
			+ '     hostileFn: KDHostile(e), MENU_OPENS: imprisoned || ((!aggressive || allied) && !domBlock) };'
			+ ' }'
			+ ' var base = KDMapData.Entities.find(function(e){'
			+ '   return e.Enemy && String(e.Enemy.name).indexOf("RemotePlayer") !== 0; });'
			+ ' if (!base) return { missing: true };'
			+ ' function variant(name, mutate) {'
			+ '   var e = JSON.parse(JSON.stringify(base));'
			+ '   mutate(e);'
			+ '   var g = gate(e); g.variant = name; return g;'
			+ ' }'
			+ ' return { subject: base.Enemy.name, faction: KDGetFaction(base), results: ['
			+ '   variant("as-is (hostile NPC)", function(e){}),'
			+ '   variant("hostile = 0", function(e){ e.hostile = 0; }),'
			+ '   variant("ceasefire = 50", function(e){ e.ceasefire = 50; }),'
			+ '   variant("hostile = 0 + ceasefire = 50", function(e){ e.hostile = 0; e.ceasefire = 50; }),'
			+ '   variant("bound to the hilt", function(e){ e.hostile = 0; e.boundLevel = 9999;'
			+ '     e.specialBoundLevel = { Rope: 9999 }; e.hp = 0.1; }),'
			+ '   variant("flag: imprisoned", function(e){ e.flags = e.flags || {}; e.flags.imprisoned = 9999; }),'
			+ '   variant("faction Player", function(e){ e.hostile = 0; e.faction = "Player"; }),'
			+ ' ] };'
			+ '})()');

		// eslint-disable-next-line no-console
		console.log('\n=== which state opens the menu ===\n' + JSON.stringify(report, null, 2) + '\n');
		expect(report).toBeTruthy();
	}, BOOT_TIMEOUT);

	/**
	 * PROBE 3 (owner's alternative) — what does the context menu offer on YOUR OWN tile?
	 *
	 * `KDGetGameContextActionsVanilla` has an explicit player branch:
	 * `else if (entity == KDPlayer() || !entity || …)` (KDContextMenu.ts:293) — reached with NO
	 * hostility test anywhere on the path, unlike the `entity && !entity.player` branch above it.
	 * If the self-menu is real, an offer entry hosted there needs no gate fight at all.
	 */
	it('lists the options on the player\'s own tile', async () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'peace-selfmenu-probe', pvp: true });
		s.join('A'); s.join('B');
		await s.ready();
		s.world.restorePlayer(s.bundles.get('A'));

		const report = s.world.eval('(function(){'
			+ ' var p = KDPlayer();'
			+ ' function build(tx, ty) {'
			+ '   KinkyDungeonTargetX = tx; KinkyDungeonTargetY = ty;'
			+ '   var options = [], images = {}, actions = {}, grey = {}, text = {}, color = {}, filter = [];'
			+ '   KDGetGameContextActionsVanilla(false, options, images, actions, grey, text, color, filter);'
			+ '   return { options: options, grey: grey };'
			+ ' }'
			+ ' var self = build(p.x, p.y);'
			+ ' var avatar = KDMapData.Entities.find(function(e){'
			+ '   return e.Enemy && String(e.Enemy.name).indexOf("RemotePlayer") === 0; });'
			+ ' return {'
			+ '   playerAt: { x: p.x, y: p.y },'
			+ '   registryKeys: Object.keys(KDGetContextActions),'
			+ '   selfTile: self,'
			+ '   peerTile: avatar ? build(avatar.x, avatar.y) : { missing: true },'
			+ ' };'
			+ '})()');

		// eslint-disable-next-line no-console
		console.log('\n=== context-menu options: own tile vs peer tile ===\n'
			+ JSON.stringify(report, null, 2) + '\n');
		expect(report).toBeTruthy();
	}, BOOT_TIMEOUT);
});
