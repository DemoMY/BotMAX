#!/usr/bin/env node
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const os = require('node:os');
const BRIDGE = path.join(__dirname, 'bridge.js');
const BRIDGE_HOST = 'http://127.0.0.1';
const TEST_ID = `${process.pid}`;
const TEST_STATE = path.join(os.tmpdir(), `maxbridge-menu-${TEST_ID}.json`);

let maxSrv, bridge;
let maxPort, bridgePort;
let commandsLog = [];
let messagesLog = [];
let putLog = [];
let delLog = [];
let answersLog = [];

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
  maxSrv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/me') {
      json(res, 200, { user_id: 433239668, name: 'Agent007', username: 'se13536161_1_bot', is_bot: true });
      return;
    }
    if (req.method === 'GET' && u.pathname === '/updates') {
      json(res, 200, {
        marker: 1,
        updates: [{
          update_type: 'message_callback',
          chat_id: 777,
          user: { user_id: 11, name: 'Ivan', is_bot: false },
          timestamp: 1700000000000,
          callback: { callback_id: 'cb_abc123', payload: 'commands_page_2' },
          message: {
            recipient: { chat_id: 777, chat_type: 'private', user_id: 11 },
            sender: { user_id: 42, name: 'MockBot', is_bot: true },
            timestamp: 1700000000000,
            body: {
              mid: 'mid.menu1',
              seq: 900,
              text: 'Commands (1/2)',
              attachments: [{
                type: 'inline_keyboard',
                payload: { buttons: [[{ type: 'callback', text: '<', payload: 'commands_page_1' }, { type: 'callback', text: '>', payload: 'commands_page_3' }]] },
              }],
            },
          },
        }],
      });
      return;
    }
    if (req.method === 'PATCH' && u.pathname === '/me/commands') {
      const raw = await collect(req);
      commandsLog.push(JSON.parse(raw.toString('utf8')));
      json(res, 200, { success: true });
      return;
    }
    if (req.method === 'POST' && u.pathname === '/messages') {
      const raw = await collect(req);
      const body = JSON.parse(raw.toString('utf8'));
      messagesLog.push({ query: [...u.searchParams.entries()], body });
      json(res, 200, {
        message: {
          recipient: { chat_id: Number(u.searchParams.get('chat_id')) },
          sender: { user_id: 42, is_bot: true, name: 'MockBot' },
          timestamp: 1700000000000,
          body: { mid: 'mid.sent1', seq: 999, text: body.text || '', attachments: body.attachments || [] },
        },
      });
      return;
    }
    if (req.method === 'PUT' && u.pathname === '/messages') {
      const raw = await collect(req);
      const body = JSON.parse(raw.toString('utf8'));
      putLog.push({ query: [...u.searchParams.entries()], body });
      json(res, 200, {
        message: {
          recipient: { chat_id: Number(u.searchParams.get('chat_id')) },
          sender: { user_id: 42, is_bot: true, name: 'MockBot' },
          timestamp: 1700000000000,
          body: { mid: u.searchParams.get('message_id'), seq: 951, text: body.text || '', attachments: body.attachments || [] },
        },
      });
      return;
    }
    if (req.method === 'DELETE' && u.pathname === '/messages') {
      delLog.push({ query: [...u.searchParams.entries()] });
      json(res, 200, { messages: { deleted: 1 } });
      return;
    }
    if (req.method === 'POST' && u.pathname === '/answers') {
      const raw = await collect(req);
      answersLog.push({ query: [...u.searchParams.entries()], body: raw.length ? JSON.parse(raw.toString('utf8')) : {} });
      json(res, 200, { success: true });
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
function waitReady() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return (async () => {
    for (let i = 0; i < 40; i += 1) {
      try { const r = await botApi('getMe'); if (r && r.ok) return; } catch (_) {}
      await sleep(150);
    }
    throw new Error('bridge not ready');
  })();
}
after(() => { bridge.kill('SIGKILL'); maxSrv.close(); try { fs.rmSync(TEST_STATE, { force: true }); } catch (_) {} });

test('setMyCommands prods MAX PATCH /me/commands (default scope)', async () => {
  commandsLog = [];
  const r = await botApi('setMyCommands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands: [{ command: 'new', description: 'Start new chat' }, { command: 'think', description: 'Use deep thinking' }] }),
  });
  assert.equal(r.ok, true);
  assert.equal(commandsLog.length, 1);
  assert.deepEqual(commandsLog[0].commands, [{ name: 'new', description: 'Start new chat' }, { name: 'think', description: 'Use deep thinking' }]);
});

test('setMyCommands strips slashes and caps at 32', async () => {
  commandsLog = [];
  const cmds = [];
  for (let i = 0; i < 40; i += 1) cmds.push({ command: `/cmd${i}`, description: `desc ${i}` });
  const r = await botApi('setMyCommands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands: cmds }),
  });
  assert.equal(r.ok, true);
  assert.equal(commandsLog[0].commands.length, 32);
  assert.equal(commandsLog[0].commands[0].name, 'cmd0');
  assert.equal(commandsLog[0].commands[0].description, 'desc 0');
});

test('setMyCommands with non-default scope is acked without PATCH', async () => {
  commandsLog = [];
  const r = await botApi('setMyCommands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands: [{ command: 'x', description: 'y' }], scope: { type: 'all_private_chats' } }),
  });
  assert.equal(r.ok, true);
  assert.equal(commandsLog.length, 0);
});

test('deleteMyCommands clears commands and getMyCommands returns []', async () => {
  commandsLog = [];
  const d = await botApi('deleteMyCommands', { method: 'POST', body: '{}' });
  assert.equal(d.ok, true);
  assert.deepEqual(commandsLog[0].commands, []);
  const g = await botApi('getMyCommands', { method: 'POST', body: '{}' });
  assert.equal(g.ok, true);
  assert.deepEqual(g.result, []);
});

test('sendMessage with inline_keyboard maps to MAX inline_keyboard attachment', async () => {
  messagesLog = [];
  const r = await botApi('sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: 777,
      text: 'Commands (1/2)',
      reply_markup: {
        inline_keyboard: [
          [{ text: '<', callback_data: 'cmd_prev' }, { text: '>', callback_data: 'cmd_next' }],
          [{ text: 'Open site', url: 'https://example.com' }],
          [{ text: 'unknown', switch_inline_query: 'x' }],
        ],
      },
    }),
  });
  assert.equal(r.ok, true);
  const req = messagesLog[0];
  assert.ok(req, 'no POST /messages recorded');
  const kb = req.body.attachments.find((a) => a.type === 'inline_keyboard');
  assert.ok(kb, 'no inline_keyboard attachment');
  assert.equal(kb.payload.buttons.length, 2);
  assert.deepEqual(kb.payload.buttons[0], [{ type: 'callback', text: '<', payload: 'cmd_prev' }, { type: 'callback', text: '>', payload: 'cmd_next' }]);
  assert.deepEqual(kb.payload.buttons[1], [{ type: 'link', text: 'Open site', url: 'https://example.com' }]);
});

test('sendMessage without reply_markup sends no attachments', async () => {
  messagesLog = [];
  const r = await botApi('sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: 777, text: 'plain text' }),
  });
  assert.equal(r.ok, true);
  assert.equal(messagesLog[0].body.attachments, undefined);
});

test('message_callback arrives as Telegram callback_query', async () => {
  const r = await botApi('getUpdates', { method: 'POST', body: '{}' });
  assert.equal(r.ok, true);
  const cq = r.result.find((u) => u.callback_query);
  assert.ok(cq, 'no callback_query update');
  assert.equal(cq.callback_query.id, 'cb_abc123');
  assert.equal(cq.callback_query.data, 'commands_page_2');
  assert.equal(cq.callback_query.from.id, 11);
  assert.equal(cq.callback_query.from.first_name, 'Ivan');
  assert.equal(cq.callback_query.message.message_id, 900);
  assert.equal(cq.callback_query.message.text, 'Commands (1/2)');
});

test('answerCallbackQuery posts empty body to MAX /answers', async () => {
  answersLog = [];
  const r = await botApi('answerCallbackQuery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: 'cb_abc123', text: '✓' }),
  });
  assert.equal(r.ok, true);
  assert.equal(answersLog.length, 1);
  assert.deepEqual([...answersLog[0].query].find(([k]) => k === 'callback_id')[1], 'cb_abc123');
  assert.deepEqual(answersLog[0].body, {});
});

test('editMessageText resolves the MAX mid and updates text + keyboard', async () => {
  putLog = [];
  const cq = (await botApi('getUpdates', { method: 'POST', body: '{}' })).result.find((u) => u.callback_query);
  const r = await botApi('editMessageText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: 777,
      message_id: cq.callback_query.message.message_id,
      text: 'Commands (2/2)',
      reply_markup: { inline_keyboard: [[{ text: '<', callback_data: 'cmd_first' }]] },
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(putLog.length, 1);
  const q = Object.fromEntries(putLog[0].query);
  assert.equal(q.message_id, 'mid.menu1');
  assert.equal(q.chat_id, '777');
  assert.equal(putLog[0].body.text, 'Commands (2/2)');
  assert.deepEqual(putLog[0].body.attachments[0], { type: 'inline_keyboard', payload: { buttons: [[{ type: 'callback', text: '<', payload: 'cmd_first' }]] } });
});

test('editMessageReplyMarkup without keyboard clears attachments', async () => {
  putLog = [];
  const cq = (await botApi('getUpdates', { method: 'POST', body: '{}' })).result.find((u) => u.callback_query);
  const r = await botApi('editMessageReplyMarkup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: 777, message_id: cq.callback_query.message.message_id }),
  });
  assert.equal(r.ok, true);
  assert.equal(putLog.length, 1);
  const q = Object.fromEntries(putLog[0].query);
  assert.equal(q.message_id, 'mid.menu1');
  assert.deepEqual(putLog[0].body.attachments, []);
});

test('deleteMessage resolves the MAX mid', async () => {
  delLog = [];
  const cq = (await botApi('getUpdates', { method: 'POST', body: '{}' })).result.find((u) => u.callback_query);
  const r = await botApi('deleteMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: 777, message_id: cq.callback_query.message.message_id }),
  });
  assert.equal(r.ok, true);
  assert.equal(delLog.length, 1);
  const q = Object.fromEntries(delLog[0].query);
  assert.equal(q.message_id, 'mid.menu1');
});