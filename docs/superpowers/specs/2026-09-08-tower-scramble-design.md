# Tower Scramble — Design

Retro arcade multiplayer word-unscramble game. Up to 5 teams race to climb the
WoodmenLife tower by unscrambling words. First team to solve 10 words wins.

## Decisions made autonomously

The request was a complete spec; these implementation choices were made without
user input and are easy to change later:

- **Zero-dependency Node server** (built-in `http` + Server-Sent Events for
  push, `fetch` POST for actions) instead of `ws`/socket.io, so the host runs
  `node server.js` with no `npm install` (avoids corporate proxy issues).
- **Fairness rule interpretation**: "same length across each level" = at game
  start the server picks one `(difficulty, length)` word group per rung 1–10;
  every team attempting that rung gets a distinct word of that exact length
  and difficulty.
- **Difficulty ramp**: rung 1–2 → words.json level 1, 3–4 → 2, 5–6 → 3,
  7–8 → 4, 9–10 → 5 (10 rungs, 5 difficulty levels).
- **Timeout penalty**: 60 s per word; on expiry the team drops one rung
  (floor 0) and is dealt a fresh word for the new target rung.
- Wrong guesses are free retries within the timer; answers case-insensitive.

## Architecture

```
server.js  (Node, no deps)
  ├── serves static: /            → public/team.html   (players)
  │                  /board       → public/board.html  (host big screen)
  │                  background.png, tower1-3.png      (from project root)
  ├── GET  /events   → SSE stream, broadcasts full public game state
  └── POST /api/join | /api/guess | /api/start | /api/reset
```

State lives in the server process. Answers (unscrambled words) never leave the
server; broadcasts carry only scrambled words + per-team deadlines. Team
clients keep `teamId` in localStorage so a page refresh reconnects.

## Game flow

1. Host runs server, opens `/board` — it shows the LAN join URL.
2. Teams open the URL on their laptops, enter a team name, pick an avatar
   (each avatar unique). Lobby shows joined teams; host presses START.
3. Server deals each team its rung-1 word and starts its 60 s clock.
4. Correct guess → rung+1, new word, tower "shift" animation on board.
   Timeout → rung−1, new word. Board avatars move to their rung positions.
5. First team to rung 10 wins → winner overlay on board and all team screens.
   Host can RESET to play again.

## Word dealing

- Load words.json, dedupe by (level, word). Group by (level, length).
- On start with T teams: for each rung, difficulty d(rung); choose a random
  group at level d with ≥ T unused words; deal T distinct words.
- Replacement words (after a drop): same group first, then any unused word at
  that difficulty, then reuse (never a word that team has already seen if
  avoidable).

## Visuals

- Board: `background.png` full-bleed (image-rendering: pixelated), tower
  centered; tower1/2/3 stacked in the same box with staggered opacity
  keyframes for a constant subtle shimmer, plus a brief intense
  shake/flicker when any team climbs. Avatars (emoji in pixel frames) sit on
  the tower at 11 vertical rung positions, one horizontal lane per team.
  Side scoreboard, join URL, start/reset, winner marquee.
- Team page: CRT scanlines, "Press Start 2P" (Google font, monospace
  fallback), letter-tile scrambled word, draining timer bar synced to the
  server deadline, level indicator, correct/wrong/drop feedback flashes.

## Testing

Manual: launch server, open board + two simulated team tabs in the browser,
join, start, verify correct guess climbs, wrong guess rejected, timeout drops,
same-length words per rung, win at 10, reset works.
