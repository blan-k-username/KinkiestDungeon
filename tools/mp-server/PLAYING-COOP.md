# Playing Kinky Dungeon with a friend

Co-op lets **two people play one run of Kinky Dungeon together** — one dungeon, one world seed, two
characters, on the same network.

This is the player's guide: what to run, what to click, and what will surprise you. If you want to
know how any of it works underneath, that is [`README.md`](README.md) in this folder.

---

## What you need

- **Two people, two browsers.** One of you hosts; the other joins.
- **One machine runs the server.** That is the host's machine. Only the host needs the game files.
- **The same network.** There is no matchmaking service and nothing is hosted for you — the guest
  reaches the host directly, so you want a home/LAN network or something equivalent.

The guest does **not** need a copy of the game, a build step, or a server of their own. They open the
host's address in a browser and that is all.

---

## Starting the server (host only)

From the `kd-mods-src` folder next to this one:

```bash
./run-kd-game.sh --mp
```

That serves the game **and** the co-op connection together on port **8090**. When it is up you will
see:

```
→ Co-op on http://localhost:8090/ — Multiplayer then Host names the address to share
```

If you have only this game checkout and no sibling folder, this does the same job:

```bash
node tools/mp-server/demo-server.js
```

> **Port 8090, not 8080.** In co-op mode nothing is served on 8080 at all. If a browser tab is
> pointed at 8080 it will simply refuse to connect.
>
> If something else on your machine is already using 8090, move it with
> `KD_MP_PORT=8099 ./run-kd-game.sh --mp` (or `PORT=8099` for the `node` line) — and then use that
> number everywhere below instead of 8090, including in the address you send your friend.

Co-op is opt-in. Start the server the normal way and nothing is listening for a second player.

---

## Hosting a game

**1. Open the game.** Go to `http://localhost:8090/` in your browser.

**2. Choose Multiplayer** from the main menu.

The first time you ever open it you are shown **"Playing together is a little different"** — the
short version of [How co-op differs](#how-co-op-differs) below. You can come back to it any time
with **How co-op differs**.

**3. Type your name** in *Your name*. Your friend sees this when you ask to join, and it labels your
messages in the log.

**4. Set up your run.** On the Multiplayer menu, before you host:

- **Character** — build the character *you* will play. (Your friend builds their own.)
- **Perks** — pick *your* starting perks. Note that they apply to both of you — see
  [Start perks are the party's](#start-perks-are-the-partys--everyones-apply-to-everyone-debuffs-included).
- **Continue Save** — carry on an existing single-player run in co-op instead of starting fresh.
- a **world seed**, if you want a specific dungeon rather than a random one.

The seed, the game mode and the difficulty settings are the **host's** and govern the whole run. The
character and perks are **per player** — see
[The host's settings and world seed govern the run](#the-hosts-settings-and-world-seed-govern-the-run).

Choose these **before** you press Host Game: they are sent when the connection is made.

**5. Press Host Game.** The screen names the address to send your friend:

```
Tell your friend to join:
        192.168.1.24:8090
```

Send them that, exactly as written. If your machine is on more than one network you may see two or
three lines — try the first, and fall back to the others if it does not reach you.

**6. If it says "this machine only".** That means the game could not work out your address on the
network, and what it is showing is only good on this computer. Find it by hand:

| Your system | Run this | Look for |
|---|---|---|
| macOS | `ipconfig getifaddr en0` (Wi‑Fi) or `ipconfig getifaddr en1` | one address, e.g. `192.168.1.24` |
| Linux | `hostname -I` | the first address listed |
| Windows | `ipconfig` | *IPv4 Address* under your active adapter |

Send your friend that address with `:8090` on the end — for example `192.168.1.24:8090`. To make the
screen show it next time, start the game with it set:

```bash
KD_MP_PUBLIC_HOST=192.168.1.24 ./run-kd-game.sh --mp
```

**7. Wait.** The screen says *Waiting for someone to join…* until they do.

**8. Approve them.** When your friend asks, you get:

```
Ada wants to join your game
        [ Accept ]   [ Decline ]
```

**You approve every join yourself.** There is no join code, no password and no account — that prompt
is the entire admission decision, and their name is what you have to judge by. If they are sending
you any mods, those are listed with the question, so you can see what you are agreeing to before you
accept.

Only one person can be asking at a time. If someone else tries while a prompt is open they are
turned away rather than queued, so you can never accidentally answer a question about one person and
admit another.

---

## Joining a game

**1. Open the host's address** in your browser — the one they sent you, like
`http://192.168.1.24:8090/`.

**2. Choose Multiplayer.**

**3. Build your character and pick your perks** — **Character** and **Perks** are on this menu for
you too, not just for the host. You play your own character, and your perks apply to both of you, so
choose them **before** you join: they are sent along with your request.

You do not choose the seed, the game mode or the difficulty — those are the host's.

**4. Press Join Game, then check the address.** *Host address* is already filled in with wherever
this page came from — so if you opened the host's link, it is **already correct** and you can leave
it alone. (It also remembers the last host you successfully reached, so a second session is usually
one click.)

**5. Type your name** and press **Join**. You will see *Connecting…* while the host is asked.

**6. Wait for them to accept.** If they decline, or something is wrong, the screen tells you in
words rather than just failing.

Because you loaded the game from the host, you are automatically running the same version they are.
If you host your own server and type an address by hand instead, a version mismatch is refused
before the host is even asked — the host's build defines the run.

---

## How co-op differs

These are the six things the game tells you on the way in, at greater length.

### "Start perks are the party's — everyone's apply to everyone, debuffs included."

Whatever perks either of you starts with apply to **both** of you. That includes the ones that make
the run harder: a debuff your partner picked is a debuff you are playing with.

Nothing is taken away when someone leaves, so within a single run the set of perks only ever grows.
Worth a conversation before you start.

### "The host's settings and world seed govern the run."

The dungeon, the game mode, the difficulty settings and the seed all come from the host. The guest's
own settings do not apply to this run. The join screen shows the mode and the seed so the guest can
see what they are agreeing to.

### "You descend together — the stairs wait for the whole party."

Neither of you can outrun the other between floors. When one of you takes the stairs, the floor
change waits for both. Between floors you reach the hub together, and you agree on the route out of
it rather than one of you choosing for both.

### "Drop an item to hand it to your partner."

There is no trade window. **Drop the item on the floor and your partner picks it up.** That is the
whole mechanism.

### "PvP resets to co-op at the hub, and you can offer peace."

**Normally you cannot hurt each other at all** — you are allies, and this only comes up if the host
started the session with player-vs-player turned on.

If you are hostile to each other, that does not have to be permanent:

- **Reaching the between-floors hub puts you back to co-op automatically.**
- Before that, either of you can **offer peace**: open the context menu on your partner and choose
  *Offer peace to* + their name. They are asked directly —

  > *Ada offers you peace. Do you accept?*
  > **Accept the truce.** / **Refuse. The fight continues.**

  It takes both of you. Offering does not impose it.

### "A dropped connection does not end the run — they can rejoin as themselves."

Losing a connection is recoverable and is not the end of your run. See
[When something goes wrong](#when-something-goes-wrong) for exactly what each of you sees.

---

## Playing together

### Talking

| Key | What it does |
|---|---|
| `Y` | Opens a text box. Type, press **Enter** to send, **Escape** to cancel. |
| `U` | Opens the quick-emoji picker. |
| `1`–`8` | With the picker open, sends that reaction straight away. |
| `Escape` | Closes the picker without sending. |

Both land in the game's own message log under a **Chat** tab, which you can show and hide like any
other log filter. The picker keeps the emoji you actually use at the front, and remembers them for
next time.

While you are typing, the keys type letters instead of moving you — and neither talking nor reacting
costs you a turn.

### Helping each other out of bondage

If your partner is tied up, you can free them. Stand next to them and use the untie action.

One honest caveat: **if everything they are wearing is locked or cursed, untying spends your turn and
frees nothing.** Protected restraints still count toward what the game offers to untie, so the action
looks available when it cannot help. If they are in locked gear, look for the key rather than
spending turns.

### Keeping the run

The run belongs to the host's session, and the host can save it for single player at any time from
the context menu: **Save this run for single player**.

It also **saves itself**, on whatever cadence the host's own save setting promises:

| Host's save mode | Saved on every floor change | Saved on a timer |
|---|---|---|
| Save Codes (the default) | yes | no |
| Roguelike | yes | yes |

Automatic saves are quiet when they work and loud when they fail — the host can check the
context-menu entry, which reads *saved N min ago*. This is what makes closing the tab survivable.

---

## When something goes wrong

**A dropped partner is noticed and named within seconds**, and the run **pauses** rather than
freezing. You will be told what happened instead of being left to guess at a game that stopped
responding.

**If you are waiting on someone**, you are asked what you want to do:

> **Wait for them.** — hold the run open until they come back.
> **Go on alone.** — continue by yourself; the run carries on as a single-player game.

**If the host disappears**, the guest is offered **Give up waiting and leave.**

**Coming back:** someone who reconnects **resumes their own character** — same gear, same inventory,
same state. They do not come back as a copy or a fresh start.

---

## What does not work

Stated plainly so you find out here rather than mid-run:

- **Two players.** One host, one guest. There is no third seat.
- **Local network only.** No matchmaking, no lobby list, no relay server. The guest connects to the
  host directly, so you need to be reachable from each other.
- **The run belongs to the host.** A guest cannot take the run away with them; saving it for single
  player is the host's.
- **Untying a partner in locked or cursed gear costs a turn and frees nothing** (above).
- **Emoji may not appear correctly on every machine.** They are drawn with your system's emoji font;
  if yours has none, reactions may show as empty boxes. The message still reaches your partner
  either way.

---

## For developers

Architecture, the transport comparison, the upstream bug write-ups and everything about how this is
built are in [`README.md`](README.md), [`TRANSPORTS.md`](TRANSPORTS.md) and
[`UPSTREAM_ISSUES.md`](UPSTREAM_ISSUES.md) in this folder.
