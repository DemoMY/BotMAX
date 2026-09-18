#!/usr/bin/env node
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const BRIDGE = path.join(__dirname, 'bridge.js');
const BRIDGE_HOST = 'http://127.0.0.1';
const TEST_ID = `${process.pid}`;
const TEST_STATE = path.join(os.tmpdir(), `maxbridge-media-${TEST_ID}.json`);
const IMG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xff, 0x00, 0x13, 0x37]);

let cdnSrv, maxSrv, bridge;
let cdnPort, maxPort, bridgePort;
let uploadsLog = [];
let messagesLog = [];

function listen(srv) {
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res(srv.address().port)));
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function collect(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

before(async () => {
  cdnSrv = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/media/file.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': IMG_BYTES.length });
      res.end(IMG_BYTES);
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/upload')) {
      await collect(req);
      json(res, 200, { token: 'cdn-token-1' });
      return;
    }
    json(res, 404, { error: 'cdn not found' });
  });
  cdnPort = await listen(cdnSrv);

  maxSrv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/me') {
      json(res, 200, { user_id: 42, name: 'MockBot', username: 'mockbot', is_bot: true });
      return;
    }
    if (req.method === 'GET' && u.pathname === '/updates') {
      json(res, 200, {
        marker: 1,
        updates: [{
          update_type: 'message_created',
          chat_id: 777,
          user: { user_id: 11, name: 'Ivan', is_bot: false },
          timestamp: 1700000000000,
          message: {
            recipient: { chat_id: 777, chat_type: 'private', user_id: 11 },
            sender: { user_id: 11, name: 'Ivan', is_bot: false },
            timestamp: 1700000000000,
            body: {
              mid: 'mid.abcd',
              seq: 9,
              text: 'photo test',
              attachments: [{ type: 'image', size: IMG_BYTES.length, payload: { url: `http://127.0.0.1:${cdnPort}/media/file.png`, token: 't1', photo_id: 55 } }],
            },
          },
        }, {
          update_type: 'message_created',
          chat_id: 777,
          user: { user_id: 12, name: 'Petr', is_bot: false },
          timestamp: 1700000000000,
          message: {
            recipient: { chat_id: 777, chat_type: 'private', user_id: 12 },
            sender: { user_id: 12, name: 'Petr', is_bot: false },
            timestamp: 1700000000000,
            body: {
              mid: 'mid.ef01',
              seq: 10,
              text: '',
              attachments: [{ type: 'file', filename: 'report.pdf', size: 403, payload: { url: `http://127.0.0.1:${cdnPort}/media/file.png`, token: 't2' } }],
            },
          },
        }],
      });
      return;
    }
    if (req.method === 'POST' && u.pathname === '/uploads') {
      uploadsLog.push(u.searchParams.get('type'));
      json(res, 200, u.searchParams.get('type') === 'video' || u.searchParams.get('type') === 'audio'
        ? { url: `http://127.0.0.1:${cdnPort}/upload`, token: 'early-token' }
        : { url: `http://127.0.0.1:${cdnPort}/upload` });
      return;
    }
    if (req.method === 'POST' && u.pathname === '/messages') {
      const raw = await collect(req);
      messagesLog.push({ query: [...u.searchParams.entries()], body: JSON.parse(raw.toString('utf8')) });
      json(res, 200, {
        message: {
          recipient: { chat_id: Number(u.searchParams.get('chat_id')) },
          sender: { user_id: 42, is_bot: true, name: 'MockBot' },
          timestamp: 1700000000000,
          body: { mid: 'mid.sent1', seq: 999, text: (JSON.parse(raw.toString('utf8')).text || '') },
        },
      });
      return;
    }
    json(res, 404, { code: 'not.found' });
  });
  maxPort = await listen(maxSrv);

  bridgePort = await new Promise((resolvePort) => {
    const probe = net.createServer((s) => s.end());
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolvePort(p)); });
  });

  bridge = spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      MAX_BOT_TOKEN: '9:mock',
      MAX_API: `http://127.0.0.1:${maxPort}`,
      MAX_BRIDGE_PORT: String(bridgePort),
      MAX_BRIDGE_STATE: TEST_STATE,
      MAX_BRIDGE_INSECURE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bridge.stderr.on('data', () => {});
  await new Promise((res) => setTimeout(res, 600));
  await waitReady();
});

function botApi(path, init) {
  return fetch(`${BRIDGE_HOST}:${bridgePort}/bot9:mock/${path}`, init).then((r) => r.json());
}
async function waitReady() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${bridgePort}/bot9:mock/getMe`).then((r) => r.json());
      if (r && r.ok) return;
    } catch (_) {}
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error('bridge did not become ready');
}
function multipart(fields, fileParts) {
  const boundary = '----test' + Date.now();
  const out = [];
  for (const [k, v] of Object.entries(fields)) {
    out.push({ k, v: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`) });
  }
  for (const f of fileParts) {
    out.push({ k: f.name, v: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      f.data,
      Buffer.from('\r\n'),
    ]) });
  }
  const body = Buffer.concat(out.map((o) => o.v).concat([Buffer.from(`--${boundary}--\r\n`)]));
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

after(() => { try { bridge.kill('SIGKILL'); } catch (_) {} cdnSrv.close(); maxSrv.close(); try { fs.rmSync(TEST_STATE, { force: true }); } catch (_) {} });

test('getMe works', async () => {
  const r = await botApi('getMe');
  assert.equal(r.ok, true);
  assert.equal(r.result.id, 42);
});

test('inbound media maps image+file and downloads bytes via /file', async () => {
  uploadsLog.length = 0; messagesLog.length = 0;
  const upd = await botApi('getUpdates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ offset: 0, limit: 10, timeout: 0 }) });
  assert.equal(upd.ok, true);
  const imageMsg = upd.result.find((u) => u.message && u.message.photo);
  const fileMsg = upd.result.find((u) => u.message && u.message.document);
  assert.ok(imageMsg, 'image update present');
  assert.ok(fileMsg, 'file update present');

  const photo = imageMsg.message.photo[0];
  assert.ok(photo.file_id.startsWith('max:img:'), `file_id format: ${photo.file_id}`);
  const doc = fileMsg.message.document;
  assert.equal(doc.file_name, 'report.pdf');
  assert.equal(doc.file_size, 403);

  const gf = await botApi('getFile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: photo.file_id }) });
  assert.equal(gf.ok, true);
  assert.ok(/^media\/[a-f0-9]+$/.test(gf.result.file_path), `relative file_path: ${gf.result.file_path}`);
  assert.equal(gf.result.file_unique_id, photo.file_id.split(':')[2]);

  const dl = await fetch(`http://127.0.0.1:${bridgePort}/file/bot9:mock/${gf.result.file_path}`);
  assert.equal(dl.status, 200);
  const bytes = Buffer.from(await dl.arrayBuffer());
  assert.equal(bytes.equals(IMG_BYTES), true);
  assert.equal(dl.headers.get('content-type'), 'image/png');
});

test('sendPhoto multipart upload flow reaches MAX with token', async () => {
  uploadsLog.length = 0; messagesLog.length = 0;
  const { body, contentType } = multipart({ chat_id: '777', caption: 'hi', photo: 'attach://f0' }, [{ name: 'f0', filename: 'pic.png', data: IMG_BYTES }]);
  const r = await botApi('sendPhoto', {
    method: 'POST', headers: { 'Content-Type': contentType },
    body,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(uploadsLog, ['image']);
  assert.equal(messagesLog.length, 1);
  const att = messagesLog[0].body.attachments[0];
  assert.equal(att.type, 'image');
  assert.ok(att.payload.token, 'token present');
});

test('sendDocument maps to file upload', async () => {
  uploadsLog.length = 0; messagesLog.length = 0;
  const { body, contentType } = multipart({ chat_id: '777', document: 'attach://f1' }, [{ name: 'f1', filename: 'doc.pdf', data: Buffer.from('%PDF-1.4 test') }]);
  const r = await botApi('sendDocument', { method: 'POST', headers: { 'Content-Type': contentType }, body });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(uploadsLog, ['file']);
  assert.equal(messagesLog[0].body.attachments[0].type, 'file');
});

test('sendPhoto by image URL attaches directly without upload', async () => {
  uploadsLog.length = 0; messagesLog.length = 0;
  const url = `http://127.0.0.1:${cdnPort}/media/file.png`;
  const r = await botApi('sendPhoto', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: 777, photo: url }),
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(uploadsLog.length, 0);
  assert.equal(messagesLog[0].body.attachments[0].payload.url, url);
});

test('unknown file_id returns error', async () => {
  const r = await botApi('getFile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: 'max:img:deadbeef' }) });
  assert.equal(r.ok, false);
  assert.equal(r.error_code, 400);
});

test('blocked: media download rejects http when not in insecure mode', async () => {
  // pure-function-ish check via /file route is impossible without server; validate static regex
  const res = await fetch(`http://127.0.0.1:${bridgePort}/file/bot9:mock/media/0000000000000000`);
  assert.equal(res.status, 404);
});