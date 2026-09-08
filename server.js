// Tower Scramble — retro arcade multiplayer word game server.
// Zero dependencies: static files + Server-Sent Events + JSON POST API.
// Run:  node server.js   then open the printed URLs.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');

const MAX_TEAMS = 5;
const WIN_RUNG = 10;
const WORD_SECONDS = 60;
const AVATARS = ['🚀', '👾', '🤖', '🦖', '🐙', '⚡', '🔥', '🌟', '🎮', '🛸'];

// ---------------------------------------------------------------- word pool

function loadWords() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'words.json'), 'utf8'));
  const seen = new Set();
  const pool = [];
  for (const w of raw) {
    const key = w.level + '|' + w.unscrambled.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push({
      level: w.level,
      answer: w.unscrambled.toLowerCase(),
      scrambled: w.scrambled.toLowerCase(),
      category: w.category,
      length: w.unscrambled.length,
    });
  }
  return pool;
}

const WORD_POOL = loadWords();

// Difficulty for the word that takes a team onto `targetRung` (1..10).
function difficultyFor(targetRung) {
  return Math.min(5, Math.floor((targetRung - 1) / 2) + 1);
}

// ---------------------------------------------------------------- game state

let game;

function newGame() {
  game = {
    phase: 'lobby', // lobby | playing | won
    teams: new Map(), // id -> team
    winnerId: null,
    rungGroups: [], // per rung 1..10: {level, length}
    usedWords: new Set(), // answers already dealt this game
    seq: 0, // bumps on every state change, lets clients animate diffs
  };
}
newGame();

function makeTeam(name, avatar) {
  return {
    id: crypto.randomBytes(8).toString('hex'),
    name,
    avatar,
    rung: 0, // words solved so far == floor reached
    word: null, // {answer, scrambled, level, length, category}
    deadline: null, // ms epoch when current word expires
    seenAnswers: new Set(),
    lastEvent: null, // {type: climb|drop|win, seq}
  };
}

// Pick one (level,length) group per rung so every team gets the same length
// word at the same rung. Two rungs share a difficulty level, so track how many
// words each pick consumes and never promise the same group more than it holds.
function pickRungGroups(teamCount) {
  const remaining = new Map(); // "level|length" -> words not yet promised
  for (const w of WORD_POOL) {
    const k = w.level + '|' + w.length;
    remaining.set(k, (remaining.get(k) || 0) + 1);
  }
  const rungGroups = [];
  for (let rung = 1; rung <= WIN_RUNG; rung++) {
    const level = difficultyFor(rung);
    const candidates = [...remaining.entries()]
      .map(([k, count]) => {
        const [lv, len] = k.split('|').map(Number);
        return { key: k, level: lv, length: len, count };
      })
      .filter((g) => g.level === level);
    const roomy = candidates.filter((g) => g.count >= teamCount + 2);
    const enough = candidates.filter((g) => g.count >= teamCount);
    const from = roomy.length ? roomy : enough.length ? enough : candidates;
    const pick = from[Math.floor(Math.random() * from.length)];
    remaining.set(pick.key, Math.max(0, pick.count - teamCount));
    rungGroups.push({ level: pick.level, length: pick.length });
  }
  return rungGroups;
}

// Deal a word to `team` for its next target rung. Same (level,length) group
// as every other team at that rung; graceful fallbacks if the group runs dry.
function dealWord(team) {
  const targetRung = team.rung + 1;
  const group = game.rungGroups[targetRung - 1];
  const unused = (w) => !game.usedWords.has(w.answer);
  const inGroup = (w) => w.level === group.level && w.length === group.length;
  const atLevel = (w) => w.level === group.level;
  const unseen = (w) => !team.seenAnswers.has(w.answer);

  let candidates =
    WORD_POOL.filter((w) => inGroup(w) && unused(w)) ||
    [];
  if (!candidates.length) candidates = WORD_POOL.filter((w) => atLevel(w) && unused(w));
  if (!candidates.length) candidates = WORD_POOL.filter((w) => atLevel(w) && unseen(w));
  if (!candidates.length) candidates = WORD_POOL.filter(atLevel);

  const word = candidates[Math.floor(Math.random() * candidates.length)];
  game.usedWords.add(word.answer);
  team.seenAnswers.add(word.answer);
  team.word = word;
  team.deadline = Date.now() + WORD_SECONDS * 1000;
}

function setEvent(team, type) {
  game.seq++;
  team.lastEvent = { type, seq: game.seq };
}

// ------------------------------------------------------------------ actions

function joinTeam(name, avatar) {
  name = String(name || '').trim().slice(0, 20);
  if (!name) return { error: 'Enter a team name.' };
  if (game.phase !== 'lobby') return { error: 'Game already in progress. Wait for a reset.' };
  if (game.teams.size >= MAX_TEAMS) return { error: 'Game is full (5 teams max).' };
  if (!AVATARS.includes(avatar)) return { error: 'Pick an avatar.' };
  for (const t of game.teams.values()) {
    if (t.name.toLowerCase() === name.toLowerCase()) return { error: 'That team name is taken.' };
    if (t.avatar === avatar) return { error: 'That avatar is taken.' };
  }
  const team = makeTeam(name, avatar);
  game.teams.set(team.id, team);
  game.seq++;
  broadcast();
  return { teamId: team.id };
}

function startGame() {
  if (game.phase !== 'lobby') return { error: 'Game already started.' };
  if (game.teams.size < 1) return { error: 'Need at least 1 team to start.' };
  game.phase = 'playing';
  game.rungGroups = pickRungGroups(game.teams.size);
  for (const team of game.teams.values()) dealWord(team);
  game.seq++;
  broadcast();
  return { ok: true };
}

function submitGuess(teamId, guess) {
  const team = game.teams.get(teamId);
  if (!team) return { error: 'Unknown team — rejoin the game.', rejoin: true };
  if (game.phase !== 'playing') return { error: 'Game is not running.' };
  if (!team.word) return { error: 'No word assigned.' };

  const cleaned = String(guess || '').toLowerCase().replace(/[^a-z]/g, '');
  if (cleaned !== team.word.answer) {
    return { correct: false };
  }

  team.rung++;
  if (team.rung >= WIN_RUNG) {
    team.word = null;
    team.deadline = null;
    game.phase = 'won';
    game.winnerId = team.id;
    for (const t of game.teams.values()) {
      t.deadline = null;
    }
    setEvent(team, 'win');
  } else {
    dealWord(team);
    setEvent(team, 'climb');
  }
  broadcast();
  return { correct: true, rung: team.rung };
}

function resetGame() {
  newGame();
  broadcast();
  return { ok: true };
}

// Timer sweep: drop teams whose word expired.
setInterval(() => {
  if (game.phase !== 'playing') return;
  const now = Date.now();
  let changed = false;
  for (const team of game.teams.values()) {
    if (team.deadline && now >= team.deadline) {
      team.rung = Math.max(0, team.rung - 1);
      dealWord(team);
      setEvent(team, 'drop');
      changed = true;
    }
  }
  if (changed) broadcast();
}, 300);

// ----------------------------------------------------------- state snapshot

function publicState() {
  const winner = game.winnerId ? game.teams.get(game.winnerId) : null;
  return {
    phase: game.phase,
    seq: game.seq,
    now: Date.now(),
    winRung: WIN_RUNG,
    joinUrl: joinUrl(),
    avatars: AVATARS,
    takenAvatars: [...game.teams.values()].map((t) => t.avatar),
    winner: winner ? { id: winner.id, name: winner.name, avatar: winner.avatar } : null,
    teams: [...game.teams.values()].map((t) => ({
      id: t.id,
      name: t.name,
      avatar: t.avatar,
      rung: t.rung,
      scrambled: t.word ? t.word.scrambled : null,
      category: t.word ? t.word.category : null,
      length: t.word ? t.word.length : null,
      level: t.word ? t.word.level : null,
      deadline: t.deadline,
      lastEvent: t.lastEvent,
    })),
  };
}

// --------------------------------------------------------------------- SSE

const sseClients = new Set();

function broadcast() {
  const payload = 'data: ' + JSON.stringify(publicState()) + '\n\n';
  for (const res of sseClients) res.write(payload);
}

// Heartbeat keeps timers in sync and connections alive.
setInterval(() => {
  if (sseClients.size) broadcast();
}, 1000);

// -------------------------------------------------------------- http server

function lanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

function joinUrl() {
  return 'http://' + lanIp() + ':' + PORT;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.ico': 'image/x-icon',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 10000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function json(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const STATIC = {
  '/': path.join(PUBLIC, 'team.html'),
  '/board': path.join(PUBLIC, 'board.html'),
  '/background.png': path.join(ROOT, 'background.png'),
  '/tower1.png': path.join(ROOT, 'tower1.png'),
  '/tower2.png': path.join(ROOT, 'tower2.png'),
  '/tower3.png': path.join(ROOT, 'tower3.png'),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    res.write('data: ' + JSON.stringify(publicState()) + '\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'POST' && p.startsWith('/api/')) {
    const body = await readBody(req);
    if (p === '/api/join') return json(res, joinTeam(body.name, body.avatar));
    if (p === '/api/guess') return json(res, submitGuess(body.teamId, body.guess));
    if (p === '/api/start') return json(res, startGame());
    if (p === '/api/reset') return json(res, resetGame());
    return json(res, { error: 'Unknown endpoint' }, 404);
  }

  if (STATIC[p]) return serveFile(res, STATIC[p]);
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ████ TOWER SCRAMBLE ████');
  console.log('');
  console.log('  Big screen (host):  ' + joinUrl() + '/board');
  console.log('  Teams join at:      ' + joinUrl());
  console.log('');
});
