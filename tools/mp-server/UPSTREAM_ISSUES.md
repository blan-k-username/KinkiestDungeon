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
