'use strict';
// Run with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const srv = require('../server.js');

// ------------------------------------------------------------ pickLanIp

test('pickLanIp skips link-local and virtual adapters, prefers the real NIC', () => {
  const ifaces = {
    'vEthernet (WSL (Hyper-V firewall))': [{ family: 'IPv4', address: '172.26.176.1', internal: false }],
    'vEthernet (Default Switch)': [{ family: 'IPv4', address: '172.17.176.1', internal: false }],
    'Ethernet': [{ family: 'IPv4', address: '169.254.17.90', internal: false }],
    'bwanif': [{ family: 'IPv4', address: '10.137.168.227', internal: false }],
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    'Wi-Fi': [{ family: 'IPv4', address: '10.130.170.135', internal: false }],
  };
  assert.equal(srv.pickLanIp(ifaces), '10.130.170.135');
});

test('pickLanIp falls back to a virtual adapter rather than nothing', () => {
  const ifaces = {
    'vEthernet (Default Switch)': [{ family: 'IPv4', address: '172.17.176.1', internal: false }],
  };
  assert.equal(srv.pickLanIp(ifaces), '172.17.176.1');
});

test('pickLanIp returns localhost when only loopback exists', () => {
  const ifaces = { lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] };
  assert.equal(srv.pickLanIp(ifaces), 'localhost');
});

test('chooseLanIp trusts the default-route probe when it lands on a real NIC', () => {
  const ifaces = {
    'Wi-Fi': [{ family: 'IPv4', address: '10.130.170.135', internal: false }],
    'bwanif': [{ family: 'IPv4', address: '10.137.168.227', internal: false }],
  };
  assert.equal(srv.chooseLanIp('10.130.170.135', ifaces), '10.130.170.135');
});

test('chooseLanIp overrides the probe when it lands on a VPN tunnel adapter', () => {
  const ifaces = {
    'bwanif': [{ family: 'IPv4', address: '10.137.168.227', internal: false }],
    'Wi-Fi': [{ family: 'IPv4', address: '10.130.170.135', internal: false }],
  };
  assert.equal(srv.chooseLanIp('10.137.168.227', ifaces), '10.130.170.135');
});

test('chooseLanIp falls back to the heuristic when the probe failed', () => {
  const ifaces = { 'Wi-Fi': [{ family: 'IPv4', address: '10.130.170.135', internal: false }] };
  assert.equal(srv.chooseLanIp(null, ifaces), '10.130.170.135');
  assert.equal(srv.chooseLanIp('169.254.1.2', ifaces), '10.130.170.135');
});

// ------------------------------------------------------------ joinUrlFor

const fallback = { ip: '10.0.0.5', port: 3000 };

test('joinUrlFor uses the Host header the board was opened with', () => {
  const req = { headers: { host: '10.130.170.135:3000' } };
  assert.equal(srv.joinUrlFor(req, fallback, {}), 'http://10.130.170.135:3000');
});

test('joinUrlFor never advertises localhost; falls back to LAN ip', () => {
  for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000']) {
    const req = { headers: { host } };
    assert.equal(srv.joinUrlFor(req, fallback, {}), 'http://10.0.0.5:3000');
  }
});

test('joinUrlFor honours X-Forwarded-* when behind a reverse proxy', () => {
  const req = {
    headers: {
      host: '10.0.0.7:3000',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'tower.example.com',
    },
  };
  assert.equal(srv.joinUrlFor(req, fallback, {}), 'https://tower.example.com');
});

test('joinUrlFor: PUBLIC_URL env wins over everything, trailing slash stripped', () => {
  const req = { headers: { host: '10.0.0.7:3000' } };
  const env = { PUBLIC_URL: 'https://game.woodmenlife.example/' };
  assert.equal(srv.joinUrlFor(req, fallback, env), 'https://game.woodmenlife.example');
});

test('joinUrlFor rejects a garbage Host header and falls back', () => {
  const req = { headers: { host: 'not a host <script>' } };
  assert.equal(srv.joinUrlFor(req, fallback, {}), 'http://10.0.0.5:3000');
});

// ------------------------------------------------------------ integration

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body, res }));
    }).on('error', reject);
  });
}

// Read the first SSE "data:" frame then close.
function firstEvent(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        const m = buf.match(/^data: (.*)$/m);
        if (m) {
          req.destroy();
          resolve(JSON.parse(m[1]));
        }
      });
    });
    req.on('error', (e) => e.code === 'ECONNRESET' ? null : reject(e));
  });
}

test('server listens on all interfaces, not just loopback', async () => {
  const server = srv.createServer();
  await new Promise((r) => server.listen(0, r));
  try {
    const addr = server.address();
    assert.ok(['::', '0.0.0.0'].includes(addr.address), 'bound to ' + addr.address);
  } finally {
    server.close();
  }
});

test('join page and board are served; SSE advertises the requesting Host', async () => {
  const server = srv.createServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    const home = await get(`http://127.0.0.1:${port}/`);
    assert.equal(home.status, 200);
    assert.match(home.body, /<html/i);

    const board = await get(`http://127.0.0.1:${port}/board`);
    assert.equal(board.status, 200);

    // Opened via a LAN-style host header: advertise exactly that.
    const state = await new Promise((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/events', headers: { Host: `10.9.8.7:${port}` } },
        (res) => {
          let buf = '';
          res.on('data', (c) => {
            buf += c;
            const m = buf.match(/^data: (.*)$/m);
            if (m) { req.destroy(); resolve(JSON.parse(m[1])); }
          });
        }
      );
      req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
    });
    assert.equal(state.joinUrl, `http://10.9.8.7:${port}`);

    // Opened via localhost: must NOT advertise localhost.
    const local = await firstEvent(`http://127.0.0.1:${port}/events`);
    assert.doesNotMatch(local.joinUrl, /localhost|127\.0\.0\.1/);
    assert.match(local.joinUrl, /^http:\/\/[^/]+:\d+$/);
  } finally {
    server.close();
  }
});

test('GET /state returns one complete JSON snapshot with the requesting Host as joinUrl', async () => {
  const server = srv.createServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    const r = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/state', headers: { Host: `10.9.8.7:${port}` } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }).on('error', reject);
    });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /application\/json/);
    assert.ok(r.headers['content-length'], 'complete response must carry Content-Length');
    const state = JSON.parse(r.body);
    assert.equal(state.joinUrl, `http://10.9.8.7:${port}`);
    assert.equal(state.phase, 'lobby');
    assert.ok(Array.isArray(state.avatars) && state.avatars.length > 0);
  } finally {
    server.close();
  }
});

test('live.js helper is served and both pages load it before their inline script', async () => {
  const server = srv.createServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    const js = await get(`http://127.0.0.1:${port}/live.js`);
    assert.equal(js.status, 200);
    assert.match(js.body, /connectLive/);
    for (const p of ['/', '/board']) {
      const page = await get(`http://127.0.0.1:${port}${p}`);
      const helperAt = page.body.indexOf('<script src="/live.js">');
      const inlineAt = page.body.lastIndexOf('<script>');
      assert.ok(helperAt > -1, p + ' loads live.js');
      assert.ok(helperAt < inlineAt, p + ' loads live.js before its inline script');
      assert.match(page.body, /connectLive\(/);
      assert.doesNotMatch(page.body, /new EventSource\(/, p + ' no longer opens EventSource directly');
    }
  } finally {
    server.close();
  }
});

test('requiring server.js does not start listening on its own', async () => {
  // If the module auto-listened on PORT, this listen would collide (EADDRINUSE).
  const probe = http.createServer();
  const port = Number(process.env.PORT || 3000);
  const result = await new Promise((resolve) => {
    probe.once('error', (e) => resolve(e.code));
    probe.listen(port, () => resolve('free'));
  });
  probe.close();
  // Either the port is free, or something *else* owns it; the module itself
  // must not be the owner. We can only assert the module exposes createServer
  // and did not export a started server.
  assert.equal(typeof srv.createServer, 'function');
  assert.ok(result === 'free' || result === 'EADDRINUSE');
  assert.equal(srv.server, undefined);
});

// ------------------------------------------------------------ scrambleWord

test('scrambleWord keeps the same letters', () => {
  for (const w of ['data', 'model', 'algorithm', 'neural network']) {
    const out = srv.scrambleWord(w);
    assert.equal(out.length, w.length);
    assert.equal(out.split('').sort().join(''), w.split('').sort().join(''));
  }
});

test('scrambleWord never returns the word or its reverse', () => {
  const words = ['bot', 'data', 'model', 'tensor', 'gradient', 'aab', 'aba'];
  for (const w of words) {
    const rev = w.split('').reverse().join('');
    for (let i = 0; i < 300; i++) {
      const out = srv.scrambleWord(w);
      assert.notEqual(out, w, `returned the word itself: ${w}`);
      assert.notEqual(out, rev, `returned the reversed word: ${w}`);
    }
  }
});

test('scrambleWord produces varied arrangements, not mostly reversals', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(srv.scrambleWord('gradient'));
  assert.ok(seen.size > 20, `only ${seen.size} distinct scrambles`);
});

test('scrambleWord handles words with no alternative arrangement', () => {
  assert.equal(srv.scrambleWord('aa'), 'aa');
  assert.equal(srv.scrambleWord('a'), 'a');
  assert.ok(['ab', 'ba'].includes(srv.scrambleWord('ab')));
});

// ------------------------------------------------------------ wrong guesses

function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve(JSON.parse(buf)));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve(JSON.parse(buf)));
    }).on('error', reject);
  });
}

test('a wrong guess knocks the team down a floor and deals a new word', async () => {
  const server = srv.createServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    await postJson(port, '/api/reset', {});
    const avatar = (await getJson(port, '/state')).avatars[0];
    const { teamId } = await postJson(port, '/api/join', { name: 'Falcons', avatar });
    assert.ok(teamId);
    assert.deepEqual(await postJson(port, '/api/start', {}), { ok: true });

    const before = (await getJson(port, '/state')).teams[0];
    assert.equal(before.rung, 0);

    // Wrong from the ground floor: stays at 0 but still gets a fresh word.
    let r = await postJson(port, '/api/guess', { teamId, guess: 'zzzzzzzzzzzz' });
    assert.deepEqual(r, { correct: false, rung: 0 });
    let t = (await getJson(port, '/state')).teams[0];
    assert.equal(t.rung, 0);
    assert.equal(t.lastEvent.type, 'drop');
    assert.equal(t.lastEvent.reason, 'wrong');
    assert.ok(t.scrambled && t.scrambled !== before.scrambled, 'a new word should be dealt');

    // Climb to floor 1 with the real answer, then a wrong guess drops back to 0.
    const answer = srv._test.team(teamId).word.answer;
    r = await postJson(port, '/api/guess', { teamId, guess: answer.toUpperCase() });
    assert.equal(r.correct, true);
    assert.equal(r.rung, 1);
    const atOne = (await getJson(port, '/state')).teams[0];
    assert.equal(atOne.rung, 1);

    r = await postJson(port, '/api/guess', { teamId, guess: 'definitely-not-it' });
    assert.deepEqual(r, { correct: false, rung: 0 });
    t = (await getJson(port, '/state')).teams[0];
    assert.equal(t.rung, 0);
    assert.equal(t.lastEvent.reason, 'wrong');
    assert.ok(t.deadline > Date.now(), 'timer restarts with the new word');
  } finally {
    await postJson(port, '/api/reset', {});
    server.close();
  }
});
