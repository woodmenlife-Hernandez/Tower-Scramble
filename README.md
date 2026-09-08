# ★ Tower Scramble ★

Retro arcade word game: up to 5 teams race to scale the WoodmenLife tower by
unscrambling words. First team to solve 10 words wins.

## How to run (host)

No installs needed beyond Node.js — the server has zero dependencies.

```
node server.js
```

Then:

- **Big screen / projector**: open the printed board URL, e.g.
  `http://<your-ip>:3000/board`
- **Teams**: each team opens `http://<your-ip>:3000` on their own laptop
  (the exact URL is displayed on the board), enters a team name, and picks
  an avatar. Up to 5 teams.
- Press **▶ START GAME** on the board when everyone is in.

> First launch: if Windows Firewall asks whether to allow Node.js on the
> network, click **Allow** — otherwise teammates' laptops can't connect.
> Everyone must be on the same network as the host.

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
  Server-Sent Events for live updates)
- `public/board.html` — big-screen view: animated tower (tower1/2/3
  superimposed for the shifting effect), climbing avatars, standings, join URL
- `public/team.html` — team laptop view: join screen, scrambled word, timer
- `words.json` — the word list (level 1–5, category, scrambled/unscrambled)
- `background.png`, `tower1-3.png` — art assets

## Customizing

Edit the constants at the top of `server.js`:
`WIN_RUNG` (floors to win), `WORD_SECONDS` (timer), `MAX_TEAMS`, `AVATARS`.
Add words to `words.json` (keep several words per level+length so all teams
can draw distinct same-length words).
