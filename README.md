# ★ Tower Scramble ★

Retro arcade word game: up to 5 teams race to scale the WoodmenLife tower by
unscrambling words. First team to solve 10 words wins.

## How to run (host)

No installs needed beyond Node.js — the server has zero dependencies.

### 1. Check you have Node.js

```
node --version
```

Any recent version works (developed on v24). If this errors, install Node.js
from https://nodejs.org and reopen your terminal.

### 2. Start the server

From the project folder:

```
cd path/to/Tower_Scramble
node server.js
```

It prints the two URLs you need — already filled in with your machine's IP:

```
  ████ TOWER SCRAMBLE ████

  Big screen (host):  http://10.0.0.5:3000/board
  Teams join at:      http://10.0.0.5:3000
```

Leave this terminal window open — closing it stops the game.

### 3. Open the board and let teams join

- **Big screen / projector**: open the printed **board** URL
  (`http://<your-ip>:3000/board`).
- **Teams**: each team opens the **join** URL (`http://<your-ip>:3000`) on
  their own laptop — it's displayed in the top-right of the board — then
  enters a team name and picks an avatar. Up to 5 teams.
- Press **▶ START GAME** on the board when everyone is in.

### 4. Stop the server

Press **Ctrl+C** in the terminal running `node server.js`.

### Changing the port

Port 3000 is the default. If something else is already using it, set `PORT`:

```
# macOS / Linux / Git Bash
PORT=3100 node server.js

# Windows PowerShell
$env:PORT = "3100"; node server.js

# Windows cmd.exe
set PORT=3100 && node server.js
```

The printed URLs update to match.

### Running on a shared or hosted server

`server.js` runs anywhere Node does: a spare desktop, an internal VM, a
container, or a free Node host. The board automatically advertises whatever
address it was opened with, so usually nothing else is needed. If the server
sits behind a reverse proxy or has a friendlier public name, pin the join URL
explicitly:

```
PUBLIC_URL=https://tower.example.com node server.js
```

> **Home / personal network:** if Windows Firewall asks whether to allow
> Node.js on the network, click **Allow**.
>
> **Corporate laptop (WoodmenLife or similar):** that prompt either never
> appears or does nothing, and teammates get "This site can't be reached".
> See **Troubleshooting** below before game day.

## Troubleshooting: teammates can't open the join link

**Symptom.** The board works on the host laptop, but anyone else opening
`http://<host-ip>:3000` gets "This site can't be reached" / a spinner.

**Cause on managed corporate laptops.** Group Policy sets Windows Firewall to
*block all inbound connections* and *ignore locally created rules*. On this
fleet the effective policy is:

```
Firewall Policy       BlockInbound,AllowOutbound
LocalFirewallRules    N/A (GPO-store only)
```

So the host laptop can reach everything, but nothing can reach it. Clicking
**Allow** on the Windows Firewall prompt creates a *local* rule, which the
policy ignores. This is not something the game can fix from code; it is a
choice about where the server runs.

**Confirm it in 10 seconds** from a teammate's laptop (PowerShell), with the
game running on the host:

```
Test-NetConnection <host-ip> -Port 3000
```

| Result | Meaning |
|---|---|
| `PingSucceeded: True`, `TcpTestSucceeded: False` | Host is reachable but port 3000 is firewalled. This is the case above. |
| `PingSucceeded: False` | Different subnet / VLAN or Wi-Fi client isolation. Both laptops need to be on the same network segment (same SSID, same floor, both Wi-Fi or both wired). |
| `TcpTestSucceeded: True` | Network is fine. Re-check the URL on the board (it shows the address the board itself was opened with). |

**Fixes, in order of preference**

1. **Run the server somewhere inbound connections are allowed.** Any machine
   the team's laptops can reach on port 3000 works: an internal VM or dev
   server, a container host, or a free Node hosting tier if IT allows
   outbound access to it. Copy the folder, run `node server.js` (set
   `PUBLIC_URL` if there is a proxy in front), open `/board` on the big
   screen from anywhere. This needs no firewall change on any laptop.

2. **Ask IT for a firewall rule on the host laptop.** Paste-ready request:

   > Please add a Windows Defender Firewall inbound **Allow** rule via Group
   > Policy for my laptop, Domain profile, protocol **TCP**, local port
   > **3000**, program `C:\Program Files\nodejs\node.exe`, remote address
   > scope **local subnet** only. Purpose: hosting an internal team game
   > (Tower Scramble, a zero-dependency Node.js server) for a one-off event.
   > Local rules are currently ignored ("GPO-store only"), so this has to be
   > pushed by policy.

   If IT prefers a different port, start the game with `PORT=<n>`.

3. **Tunnel services (ngrok, cloudflared, etc.)** expose the local port via an
   outbound connection, which deliberately bypasses the inbound block. Do not
   use these on a corporate network without IT sign-off.

**Also check the join URL itself.** The board shows the address it was opened
with. Open the board using the printed LAN URL (`http://10.x.x.x:3000/board`),
not `localhost`, so the displayed join URL is one the room can use. If the
printed IP looks wrong (a `172.x` Hyper-V/WSL address, a `169.254.x`
address, or a VPN tunnel address), open the board via the correct IP from
`ipconfig` and the board will advertise that one instead, or set
`PUBLIC_URL`.

**Hosted version loads but shows no avatars / the board never updates.**
A TLS-inspecting corporate proxy (Netskope, Zscaler and similar clients)
buffers the live event stream until it ends, so the browser never receives
an update. The pages handle this automatically: if no event arrives within
2.5 seconds they switch to polling `/state` every 0.7 seconds, which passes
through any proxy. Verified working through Netskope on the Render deployment.
If a page still looks frozen, hard-refresh it (Ctrl+F5) so it picks up the
current `live.js`.

## Hosting on Render

The repo contains a `render.yaml` blueprint. In the Render dashboard choose
**New → Blueprint**, pick the repo, **Apply**. The free instance sleeps after
15 idle minutes and takes about a minute to wake, so open the board a couple of
minutes before you start. The URL is public: anyone with the link can join.

## Tests

```
npm test        # or: node --test
```

Zero-dependency tests using Node's built-in runner: join-URL derivation
(Host header, `PUBLIC_URL`, proxy headers, never `localhost`), LAN-IP
adapter filtering, and an HTTP smoke test of the join page, board and event
stream.

## Rules

- Each correct unscramble climbs your avatar **one floor** (10 floors to win).
- You get **60 seconds** per word. Time runs out → you **drop a floor** and
  get a new word. Wrong guesses are free — keep trying until the clock hits 0.
- Words get harder as you climb (difficulty levels 1–5 from `words.json`,
  two floors per level), and every team gets a word of the **same length**
  at the same floor, so the race is fair.
- First team to floor 10 wins. The board's **↺ RESET / PLAY AGAIN** starts a
  fresh game (teams rejoin).

## Files

- `server.js` — zero-dependency Node server (game state, timers, word dealing,
  Server-Sent Events for live updates, join-URL detection)
- `test/server.test.js` — tests (`npm test`)
- `package.json` — scripts only; there are no dependencies to install
- `public/board.html` — big-screen view: animated tower (tower1/2/3
  superimposed for the shifting effect), climbing avatars, standings, join URL
- `public/team.html` — team laptop view: join screen, scrambled word, timer
- `words.json` — the word list (level 1–5, category, unscrambled). The
  server shuffles the letters itself each time a word is dealt; the legacy
  `scrambled` field in the file is ignored.
- `background.png`, `tower1-3.png` — art assets

## Customizing

Edit the constants at the top of `server.js`:
`WIN_RUNG` (floors to win), `WORD_SECONDS` (timer), `MAX_TEAMS`, `AVATARS`.
Add words to `words.json` (keep several words per level+length so all teams
can draw distinct same-length words). Only `level`, `category` and
`unscrambled` are needed; scrambling happens at deal time.
