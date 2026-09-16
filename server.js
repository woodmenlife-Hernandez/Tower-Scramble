// Tower Scramble — retro arcade multiplayer word game server.
// Zero dependencies: static files + Server-Sent Events + JSON POST API.
// Run:  node server.js   then open the printed URLs.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dgram = require('dgram');
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
      category: w.category,
      length: w.unscrambled.length,
    });
  }
  return pool;
}

const WORD_POOL = loadWords();

// Fisher-Yates shuffle of the letters. The pre-baked `scrambled` field in
// words.json is just the word reversed, so we ignore it and shuffle here.
// Rejects results equal to the word or its mirror image whenever a genuinely
// different arrangement exists (e.g. "aa" or "ab" have no such arrangement).
function scrambleWord(word, rng = Math.random) {
  const letters = word.split('');
  const reversed = letters.slice().reverse().join('');
  const distinct = new Set(letters).size;
  // Any word of 3+ letters with at least two distinct letters has an
  // arrangement that is neither the word nor its reverse.
  const canDiffer = distinct >= 2 && word.length >= 3;
  for (let attempt = 0; attempt < 50; attempt++) {
    const a = letters.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    const out = a.join('');
    if (!canDiffer || (out !== word && out !== reversed)) return out;
  }
  // Astronomically unlikely fallback: rotate by one so it at least differs.
  return word.slice(1) + word[0];
}

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
    lastEvent: null, // {type: climb|drop|win, reason?: timeout|wrong, seq}
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
  team.word = { ...word, scrambled: scrambleWord(word.answer) };
  team.deadline = Date.now() + WORD_SECONDS * 1000;
}

function setEvent(team, type, extra) {
  game.seq++;
  team.lastEvent = { type, seq: game.seq, ...extra };
}

// Knock a team down one floor (never below the ground) and hand it a fresh
// word for its new target rung. `reason` is 'timeout' or 'wrong'.
function knockDown(team, reason) {
  team.rung = Math.max(0, team.rung - 1);
  dealWord(team);
  setEvent(team, 'drop', { reason });
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
    // A wrong guess costs a floor, same as running out of time.
    knockDown(team, 'wrong');
    broadcast();
    return { correct: false, rung: team.rung };
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
const sweepTimer = setInterval(() => {
  if (game.phase !== 'playing') return;
  const now = Date.now();
  let changed = false;
  for (const team of game.teams.values()) {
    if (team.deadline && now >= team.deadline) {
      knockDown(team, 'timeout');
      changed = true;
    }
  }
  if (changed) broadcast();
}, 300);
sweepTimer.unref(); // never keep the process alive on its own (tests)

// ----------------------------------------------------------- state snapshot

function publicState() {
  const winner = game.winnerId ? game.teams.get(game.winnerId) : null;
  return {
    phase: game.phase,
    seq: game.seq,
    now: Date.now(),
    winRung: WIN_RUNG,
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

// Every client gets the same game state but its *own* join URL: the address
// the board was opened with is the one teammates can actually reach.
function broadcast() {
  const state = publicState();
  for (const res of sseClients) {
    state.joinUrl = res.joinUrl;
    res.write('data: ' + JSON.stringify(state) + '\n\n');
  }
}

// Heartbeat keeps timers in sync and connections alive.
const heartbeat = setInterval(() => {
  if (sseClients.size) broadcast();
}, 1000);
heartbeat.unref();

// -------------------------------------------------------------- http server

// ------------------------------------------------------------- addressing
//
// Which URL do teammates type? In order of trust:
//   1. PUBLIC_URL env  — set this when the server runs behind a proxy or on a
//      hosted box (e.g. PUBLIC_URL=https://tower.example.com).
//   2. The Host header of the browser that opened the board — if the host
//      could reach us at that address, so can the room (unless it was
//      localhost, which only works on the host's own machine).
//   3. A best-guess LAN IP: the interface that owns the default route, else
//      the first real-looking adapter (skipping link-local, Hyper-V, WSL,
//      VPN tunnels...).

const VIRTUAL_ADAPTER = /vethernet|wsl|hyper-v|virtualbox|vmware|vmnet|docker|loopback|bwan|tun|tap|tailscale|zerotier|wintun|npcap/i;

function pickLanIp(interfaces = os.networkInterfaces()) {
  const candidates = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' && i.family !== 4) continue;
      if (i.internal) continue;
      if (i.address.startsWith('169.254.')) continue; // APIPA: unplugged NIC
      candidates.push({ name, address: i.address, virtual: VIRTUAL_ADAPTER.test(name) });
    }
  }
  const real = candidates.find((c) => !c.virtual);
  if (real) return real.address;
  if (candidates.length) return candidates[0].address;
  return 'localhost';
}

let cachedLanIp = pickLanIp();

// The default-route probe can land on a VPN/SASE tunnel adapter when a
// full-tunnel client owns the default route. Teammates on the office LAN
// can't reach that address, so prefer the heuristic pick in that case.
function chooseLanIp(detected, interfaces = os.networkInterfaces()) {
  const heuristic = pickLanIp(interfaces);
  if (!detected || detected.startsWith('169.254.') || detected === '0.0.0.0') return heuristic;
  for (const [name, list] of Object.entries(interfaces)) {
    for (const i of list || []) {
      if (i.address === detected) return VIRTUAL_ADAPTER.test(name) ? heuristic : detected;
    }
  }
  return detected;
}

// Ask the OS which source address it would use to reach the internet. UDP
// connect() sends nothing on the wire; it only resolves the route. This is
// the most reliable "my LAN IP" on machines with many virtual adapters.
function detectLanIp() {
  return new Promise((resolve) => {
    let sock;
    try {
      sock = dgram.createSocket('udp4');
    } catch {
      return resolve(cachedLanIp);
    }
    const done = (ip) => {
      try { sock.close(); } catch {}
      cachedLanIp = chooseLanIp(ip);
      resolve(cachedLanIp);
    };
    sock.once('error', () => done(null));
    try {
      sock.connect(53, '1.1.1.1', () => {
        try { done(sock.address().address); } catch { done(null); }
      });
    } catch {
      done(null);
    }
  });
}

function lanIp() {
  return cachedLanIp;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', '[::]']);
const HOST_RE = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(:\d{1,5})?$/;

function joinUrlFor(req, fallback, env = process.env) {
  if (env.PUBLIC_URL) return String(env.PUBLIC_URL).trim().replace(/\/+$/, '');

  const h = (req && req.headers) || {};
  const rawHost = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim();
  const proto = String(h['x-forwarded-proto'] || 'http').split(',')[0].trim() === 'https' ? 'https' : 'http';

  const m = HOST_RE.exec(rawHost);
  if (m) {
    const hostname = m[1].toLowerCase();
    const isLocal = LOCAL_HOSTS.has(hostname) || hostname.startsWith('127.');
    if (!isLocal) return proto + '://' + rawHost;
  }
  return 'http://' + fallback.ip + ':' + fallback.port;
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

// Complete responses with an explicit length: proxies that buffer chunked
// bodies (corporate TLS inspection) release these immediately.
function json(res, obj, status = 200) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length });
  res.end(body);
}

const STATIC = {
  '/': path.join(PUBLIC, 'team.html'),
  '/board': path.join(PUBLIC, 'board.html'),
  '/live.js': path.join(PUBLIC, 'live.js'),
  '/background.png': path.join(ROOT, 'background.png'),
  '/tower1.png': path.join(ROOT, 'tower1.png'),
  '/tower2.png': path.join(ROOT, 'tower2.png'),
  '/tower3.png': path.join(ROOT, 'tower3.png'),
};

function createServer() {
  const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/events') {
    const addr = server.address();
    res.joinUrl = joinUrlFor(req, { ip: lanIp(), port: (addr && addr.port) || PORT });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    res.write('data: ' + JSON.stringify({ ...publicState(), joinUrl: res.joinUrl }) + '\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (p === '/state') {
    const addr = server.address();
    const joinUrl = joinUrlFor(req, { ip: lanIp(), port: (addr && addr.port) || PORT });
    return json(res, { ...publicState(), joinUrl });
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
  return server;
}

async function start() {
  await detectLanIp();
  const server = createServer();
  server.listen(PORT, () => {
    const base = process.env.PUBLIC_URL
      ? String(process.env.PUBLIC_URL).replace(/\/+$/, '')
      : 'http://' + lanIp() + ':' + PORT;
    console.log('');
    console.log('  ████ TOWER SCRAMBLE ████');
    console.log('');
    console.log('  Big screen (host):  ' + base + '/board');
    console.log('  Teams join at:      ' + base);
    console.log('');
    console.log('  Listening on all interfaces, port ' + PORT + '.');
    console.log("  Teammates can't connect? See README → Troubleshooting.");
    console.log('');
  });
  return server;
}

if (require.main === module) start();

// Test-only peek at server-side team state (answers are never sent to clients).
const _test = { team: (id) => game.teams.get(id) };

module.exports = { scrambleWord, _test, createServer, start, pickLanIp, chooseLanIp, detectLanIp, lanIp, joinUrlFor };
