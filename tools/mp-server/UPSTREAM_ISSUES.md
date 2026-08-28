# Upstream bug reports backing `BUNDLE_PATCHES`

Every serve-time bundle patch in `demo-server.js` works around a bug in the **game itself**, not in
our MP layer. Per the branch's hard rule we never edit `Game/**` — so each patch owes an *analysis of
whose bug it is*, and the patch is deleted once the bug goes away upstream. This file holds those
reports, written report-ready so they can be handed upstream if and when the owner chooses.

**Nothing here is published.** These reports live in this repo; filing them on the upstream tracker is
the owner's decision, not a step of the patch workflow. An entry's `upstream:` field therefore reads
`unfiled: tools/mp-server/UPSTREAM_ISSUES.md` and stays that way — that is a *pointer to this file*,
which the policy spec verifies exists. If a report is ever filed, replace that entry's field with the
issue URL and note it in the table.

Upstream source of truth for these line numbers: `upstream/5.5` (`git remote upstream`).

| Patch id | Report | Filed upstream |
|---|---|---|
| `npcrestrain-null-slot-sgroup` | [#1](#1-npcrestraints-unguarded-kdgetnpcbindingslotforitem-sgroup) | no — local only |
| `kdinventoryactions-sg-nocut`, `kdinventoryactions-sg-blocked` | [#2](#2-kdinventoryactionsts-unguarded-struggle-group-lookup-in-the-cut-action) | no — local only |

Both files were verified byte-identical to `upstream/5.5` (KDM-156), i.e. these are genuine upstream
bugs, not artefacts of our fork.

---

## 1. `NPCRestrain.ts`: unguarded `KDGetNPCBindingSlotForItem(...).sgroup`

**Version:** 5.5 (`upstream/5.5`, verified byte-identical to our checkout)

**Summary**

`NPCRestrain.ts:310` and `:402` do

```ts
slot || KDGetNPCBindingSlotForItem(restraint, npcID).sgroup
```

but `KDGetNPCBindingSlotForItem` returns `null` when no binding row/subgroup on that NPC accepts the
item (`KDGenRestraintUniform.ts:38`, `:48`). Clicking such an item in the bind menu throws

```
TypeError: Cannot read properties of null (reading 'sgroup')
```

**Reproduction**

1. Open the bind menu on an NPC.
2. Click a restraint that no binding row on that NPC accepts.
3. The click throws instead of being ignored.

**Why `?.` is the intended shape**

The two sibling call sites in the same file are already guarded — `:877` uses `?.sgroup` and `:445`
null-checks — and the very next line after each unguarded read is `if (slot_temp)`, which already
handles a null. With the guard the click becomes the no-op it was evidently meant to be.

**Suggested fix**

```diff
-	slot || KDGetNPCBindingSlotForItem(restraint, npcID).sgroup
+	slot || KDGetNPCBindingSlotForItem(restraint, npcID)?.sgroup
```

at both `:310` and `:402`.

---

## 2. `KDInventoryActions.ts`: unguarded struggle-group lookup in the "Cut" action

**Version:** 5.5 (`upstream/5.5`, verified byte-identical to our checkout)

**Summary**

The `"Cut"` action's `show` (`:424`) and `valid` (`:429`) read `sg.noCut` / `sg.blocked`, where `sg`
comes from `KinkyDungeonStruggleGroups.find(...)`. That `find` returns `undefined` when no struggle
group matches the worn item's `Group`, and the read then throws.

This one is worse than a click crash: the read happens while the **Inventory screen is being drawn**,
so the game throws every frame rather than on interaction.

**Reproduction**

Open the Inventory screen while a worn item's `Group` has no entry in `KinkyDungeonStruggleGroups`
(reachable whenever the per-turn struggle-group rebuild has not run for the current restraint set).

**Suggested fix**

```diff
-	… && !sg.noCut …
+	… && !sg?.noCut …
-	… && !sg.blocked …
+	… && !sg?.blocked …
```

A missing struggle group means the item has nothing to cut, so the falsy path is the correct answer;
optional chaining only changes behaviour where the code currently throws.

---

## 3. `KinkyDungeonHUD.ts`: unguarded restraint item in `KDDrawStruggleGroups`

**Version:** 5.5.1

**Summary**

`KinkyDungeonStruggleGroups` is a cache, rebuilt by `KinkyDungeonUpdateStruggleGroups` (`:2103`) and
holding only groups whose `KinkyDungeonGetRestraintItem(Group)` is truthy. The draw path re-reads
that item per frame (`:3335`) but, in the no-dynamic-link branch, dereferences it with no guard:

```js
if (dynamicList.length == 0) {
    let d = item;
    if ((d.struggleProgress > 0 || d.cutProgress > 0)) {   // :3511 — throws when item is null
```

So a cached group whose restraint has since been removed takes the whole renderer down as soon as the
pointer crosses that group's row — `KinkyDungeonRun` → `DrawProcess` → every frame:

```
Uncaught TypeError: Cannot read properties of null (reading 'struggleProgress')
    at KDDrawStruggleGroups
```

This is the mirror of issue 2 above: that one is a worn item with no struggle group, this one is a
struggle group with no worn item. Both are the same stale-cache window, and both are one-word fixes.

**Reproduction**

Let the struggle-group cache fall behind the worn set — remove the last restraint in a group without
a rebuild — then hover that group's row in the HUD.

**Suggested fix**

```diff
-	let d = item;
-	if ((d.struggleProgress > 0 || d.cutProgress > 0)) {
+	let d = item;
+	if (d && (d.struggleProgress > 0 || d.cutProgress > 0)) {
```

A group with no item has no progress to draw, so the falsy path is the correct answer; the guard only
changes behaviour where the code currently throws.

**Note for this repo:** the MP-side cause of the stale cache is fixed in `kd-absent-reset.js` — a
per-player global whose key vanishes from the capture now goes back to its default on the client, as
it already did on the host. This entry is defence in depth: a stale cache should not kill the renderer.

---

## `KinkyDungeonVision.ts:158` — operator precedence dereferences an undefined `Enemy`

**Found by** KDM-244 (exporting a co-op run as a single-player save), bisected across five arms.

**Symptom**

`KinkyDungeonLoadGame` throws `TypeError: Cannot read properties of undefined (reading
'blockVisionWhileStationary')` and returns nothing usable, whenever the loaded map contains an entity
whose `Enemy.name` the loading world does not know. If the loader happens to get past it, the same
dereference kills the first turn instead, from `KDUnPackEnemy`.

**Cause**

```js
// KinkyDungeonVision.ts:158
if (Enemy && Enemy.blockVision || (Enemy.blockVisionWhileStationary && !EE.moved && EE.idle))
```

`&&` binds tighter than `||`, so this parses as

```js
(Enemy && Enemy.blockVision) || (Enemy.blockVisionWhileStationary && !EE.moved && EE.idle)
```

When `Enemy` is `undefined` the first term is falsy, so evaluation falls through to the second — which
dereferences the very value the first term was guarding. The `Enemy &&` guard therefore protects
nothing.

`Enemy` is `undefined` here whenever `KDUnPackEnemies` (`KinkyDungeonGame.ts:734-739`) could not
resolve the entity's def: it does `enemy.Enemy = KinkyDungeonGetEnemyByName(enemy.Enemy.name)` for
every entity not marked `modified`, and answers `undefined` for a name the world has never heard of.

**The sibling 195 lines later has it right**

```js
// KinkyDungeonVision.ts:353 — correct
if (Enemy && (Enemy.blockVision || (Enemy.blockVisionWhileStationary && !EE.moved && EE.idle)))
```

Same expression, same intent, parentheses in the right place. That asymmetry is what makes this a
typo rather than a design.

**Reproduction**

Take any save, rename one entity's `Enemy.name` to a string no enemy definition uses
(`ThisEnemyDoesNotExistAnywhere` will do — it need not be a mod entity), and load it. Measured: one
such entity is enough; it is not a threshold effect.

**Suggested fix**

```diff
-	if (Enemy && Enemy.blockVision || (Enemy.blockVisionWhileStationary && !EE.moved && EE.idle))
+	if (Enemy && (Enemy.blockVision || (Enemy.blockVisionWhileStationary && !EE.moved && EE.idle)))
```

i.e. make `:158` match `:353`.

**Note for this repo:** the practical consequence is that a save carrying entities whose definitions
were created at runtime is unopenable, because definitions are not part of the save format. Our peer
avatars (`RemotePlayer_<name>`, pushed into `KinkyDungeonEnemies` by `spawnAvatar`) are exactly that,
so `HeadlessHost.exportSave` strips them before compressing —
`tests/unit/mp-save-export.spec.ts` → "THE STRIP IS LOAD-BEARING" pins it. Marking such entities
`modified` also works (measured) by carrying the def inline, but that keeps the ghosts, which is not
what a single-player save should contain.

---

## `KinkyDungeonShrine.ts:521` — the shop's only cursor guard is off by one, and its body is empty

**Backs no bundle patch.** Recorded here because it constrains our own code: it is why KDM-266 clamps
a stale shop selection to a real row instead of pointing it at nothing.

The shop draw dereferences the selected item unguarded, on every frame:

```js
// KinkyDungeonShrine.ts:560, :563, :566, :586, :588
… KDMapData.ShopItems[KinkyDungeonShopIndex].name …
```

The one place that tries to protect them is:

```js
// KinkyDungeonShrine.ts:520-524
// Wrap around shop index to prevent errors
if (KinkyDungeonShopIndex > KDMapData.ShopItems.length) {
    KinkyDungeonShopIndex = 0;
} else if (KDMapData.ShopItems.length > 0 && KDMapData.ShopItems[KinkyDungeonShopIndex]) {
    // Draw the item and cost
}
```

Two problems in five lines:

1. **`>` where it means `>=`.** An index equal to `length` — the value KD itself can leave behind
   after the last row is spliced out — passes the guard and reaches `ShopItems[length].name`.
2. **The `else if` branch is empty.** It computes the exact condition that would tell the caller the
   selection is valid and then does nothing with it, so the unguarded dereferences below run either
   way. The comment ("Draw the item and cost") suggests the body was moved out and the test left
   behind.

**Reproduction.** Open a Commerce shrine, select the last row, and remove that item from
`KDMapData.ShopItems` by any means other than buying it (an event, a mod, or a second player in a
shared world). The next drawn frame throws `Cannot read properties of undefined (reading 'name')` and
keeps throwing for as long as the shop is open.

**Suggested fix**

```diff
-	if (KinkyDungeonShopIndex > KDMapData.ShopItems.length) {
+	if (KinkyDungeonShopIndex >= KDMapData.ShopItems.length) {
 		KinkyDungeonShopIndex = 0;
 	}
```

…and either restore the `else if` body or delete the dead branch.

**Note for this repo:** single-player never hits it, because KD's own splice
(`KinkyDungeonShrine.ts:423-424`) decrements the cursor in the same breath as removing the item. Co-op
does: the stock is shared world state and the cursor is per-player, so a partner's purchase can remove
the item under a cursor that nothing decremented. Our client-side re-point (`kd-shop-buy.js` section 3)
therefore always clamps into `[0, length-1]` rather than using an out-of-range value to mean "nothing
selected", and `tests/e2e/mp-shop-identity.spec.ts` asserts that range directly.
