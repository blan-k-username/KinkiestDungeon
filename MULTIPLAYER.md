# Co-op multiplayer (fork)

This fork adds **two-player co-op** to Kinky Dungeon: two people play one run together — one dungeon,
two characters — from two browsers on the same network. One machine runs a small Node server; the
other player only needs a browser.

**No game source is changed.** The fork is the upstream game plus new files: the co-op server and
browser client in [`tools/mp-server/`](tools/mp-server/), the tests in [`tests/`](tests/), and the
test tooling. Co-op runs the stock compiled `out/main.js` and extends it at runtime, the way a mod
does. The game itself builds, serves and plays exactly as before; co-op is opt-in.

## Try it

1. Build the game as described in [`README.md`](README.md#build).
2. Start the co-op server from this folder:
   ```bash
   node tools/mp-server/demo-server.js
   ```
   (a Docker command is in the developer guide below).
3. Open `http://localhost:8090/`, start a new game, and press **Host Game** on the class screen.
   Your friend opens the address the screen shows, presses **Join Game**, and you approve them.

## Read more

| | |
|---|---|
| [`tools/mp-server/PLAYING-COOP.md`](tools/mp-server/PLAYING-COOP.md) | the player's guide: hosting, joining, keys, what to do when a connection drops |
| [`tools/mp-server/README.md`](tools/mp-server/README.md) | the developer guide: architecture, request flow, every file, configuration, tests |
| [`tools/mp-server/DESIGN-NOTES.md`](tools/mp-server/DESIGN-NOTES.md) | deep dives, one area at a time |
| [`tools/mp-server/UPSTREAM_ISSUES.md`](tools/mp-server/UPSTREAM_ISSUES.md) | game bugs that co-op reaches and works around, each with a suggested fix |
