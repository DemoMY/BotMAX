#!/usr/bin/env node
'use strict';
// BotMAX — Telegram Bot API compatibility layer over the MAX messenger API
//
// MAX API differs from Telegram Bot API:
//   - auth via `Authorization: <token>` header (no /bot<token>/ path)
//   - REST endpoints (GET /updates, POST /messages) instead of /getUpdates, /sendMessage
//   - different Update/Message JSON object shapes
//
// This daemon exposes a Telegram Bot API-shaped HTTP server (grammY-compatible)
// so OpenClaw's `channels.telegram` (and any other Bot API client) can talk to
// it via `apiRoot`. Inbound MAX long-polling is driven by client getUpdates.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const net = require('net');

const HOST = process.env.BOTMAX_HOST || process.env.MAX_BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.BOTMAX_PORT || process.env.MAX_BRIDGE_PORT || 18790);
const MAX_URL = process.env.BOTMAX_UPSTREAM || process.env.MAX_API || 'https://platform-api2.max.ru';
const TOKEN = process.env.BOTMAX_BOT_TOKEN || process.env.MAX_BOT_TOKEN;
const STATE_FILE = process.env.BOTMAX_STATE || process.env.MAX_BRIDGE_STATE || path.join(os.homedir(), '.config', 'botmax', 'state.json');
const LOG_PREFIX = '[botmax]';
const STARTED_AT = Date.now();
let lastUpstreamOk = null; // last successful MAX /updates poll (ms epoch)

if (!TOKEN && require.main === module) {
  console.error(`${LOG_PREFIX} BOTMAX_BOT_TOKEN is not set`);
  process.exit(2);
}

// ---- persistent state (MAX marker) --------------------------------------
let state = { marker: null, tgUpdateId: 0 };

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (typeof raw.marker === 'number') state.marker = raw.marker;
    if (typeof raw.tgUpdateId === 'number') state.tgUpdateId = raw.tgUpdateId;
  } catch (_) { /* first run */ }
}
function saveState() {
  try {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { console.error(`${LOG_PREFIX} state save failed: ${e.message}`); }
}

// ---- MAX client ----------------------------------------------------------
const INSECURE = process.env.BOTMAX_INSECURE === '1' || process.env.MAX_BRIDGE_INSECURE === '1'; // test-only: allow http upstream
function maxReq(method, pathname, { query = {}, body, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, MAX_URL);
    const base = new URL(MAX_URL);
    if (url.origin !== base.origin || (url.protocol !== 'https:' && !INSECURE) || url.username || url.password) {
      reject(new Error('Invalid API origin'));
      return;
    }
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method,
      headers: {
        Authorization: TOKEN,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      rejectUnauthorized: !INSECURE,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, json, raw: data });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout + 1000, () => req.destroy(new Error('max request timeout')));
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---- value helpers -------------------------------------------------------
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function str(v) { return v === undefined || v === null ? '' : String(v); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---- file registry (inbound media) ----------------------------------------
const fileStore = new Map();
const FILE_TTL_MS = 30 * 60 * 1000;
const MAX_STORE_ENTRIES = 5000;
function registerFile(url, opts = {}) {
  const id = crypto.randomBytes(8).toString('hex');
  fileStore.set(id, { url, filename: opts.filename || null, size: opts.size || 0, mime: opts.mime || null, created: Date.now() });
  return id;
}
function getFileEntry(id) { return fileStore.get(id) || null; }
function cleanupRegistry() {
  const now = Date.now();
  for (const [k, v] of fileStore) { if (now - v.created > FILE_TTL_MS) fileStore.delete(k); }
  if (fileStore.size > MAX_STORE_ENTRIES) {
    const excess = [...fileStore.keys()].slice(0, fileStore.size - MAX_STORE_ENTRIES);
    for (const k of excess) fileStore.delete(k);
  }
}
setInterval(cleanupRegistry, 60_000).unref();

// MAX message ids are opaque strings ("mid.00...") while Telegram requires an
// integer. Derive a stable positive int32-range id from the seq field when
// present, otherwise hash the mid string. MAX accepts the original mid back on
// edit/delete only when we keep a mapping, so remember the last one per chat.
const midByChat = new Map();

const midByTg = new Map();
function rememberMidByTg(chatId, tgId, mid) {
  if (!mid) return;
  const key = `${chatId}:${tgId}`;
  if (midByTg.get(key) !== mid) {
    midByTg.set(key, mid);
    if (midByTg.size > 20000) { const k = midByTg.keys().next().value; midByTg.delete(k); }
  }
}
function resolveMaxMessageId(chatId, tgId) {
  if (chatId !== undefined && tgId !== undefined) {
    const key = `${chatId}:${tgId}`;
    if (midByTg.has(key)) return midByTg.get(key);
  }
  return undefined;
}

function toTgMessageId(m, body) {
  const seq = num((body && body.seq) ?? (m && m.seq));
  const mid = str((body && body.mid) ?? (m && (m.mid ?? m.message_id)));
  if (seq > 0) return seq % 2147483647;
  if (/^\d+$/.test(mid)) return num(mid);
  let h = 0;
  for (let i = 0; i < mid.length; i += 1) h = (h * 31 + mid.charCodeAt(i)) % 2147483647;
  return h;
}

function maxMessageIdOf(m, body) {
  const mid = (body && (body.mid ?? body.message_id)) ?? (m && (m.mid ?? m.message_id));
  return mid === undefined || mid === null ? undefined : String(mid);
}

// ---- telegram object builders -------------------------------------------
function toTgUser(u) {
  if (!u || typeof u !== 'object') return undefined;
  return {
    id: num(u.user_id ?? u.id),
    is_bot: !!u.is_bot,
    first_name: str(u.name ?? u.first_name),
    last_name: u.last_name === undefined || u.last_name === null ? undefined : str(u.last_name),
    username: u.username === undefined || u.username === null ? undefined : str(u.username ?? u.nickname),
    language_code: u.language_code === undefined || u.language_code === null ? undefined : str(u.language_code),
  };
}

function toTgChat(id, opts = {}) {
  const chatId = num(id);
  const isChannel = !!(opts.isChannel || String(opts.type || '').toLowerCase().includes('channel'));
  const chat = {
    id: chatId,
    type: isChannel ? 'channel' : (chatId < 0 ? 'group' : 'private'),
  };
  if (opts.title !== undefined && opts.title !== null) chat.title = str(opts.title);
  return chat;
}

function toTgMessage(m, ctx = {}) {
  if (!m || typeof m !== 'object') return undefined;
  const recip = m.recipient && typeof m.recipient === 'object' ? m.recipient : {};
  const chatId = ctx.chat_id !== undefined ? ctx.chat_id : (recip.chat_id ?? recip.chatId);
  if (chatId === undefined || chatId === null) return undefined;
  const body = m.body && typeof m.body === 'object' ? m.body : {};
  const sender = toTgUser(m.sender ?? ctx.user);
  const isChannel = !!(ctx.is_channel ?? recip.is_channel ?? String(recip.type || '').toLowerCase().includes('channel'));
  const textRaw = body.text ?? m.text;
  const text = typeof textRaw === 'string'
    ? textRaw
    : (textRaw === undefined || textRaw === null ? '' : JSON.stringify(textRaw));
  const messageId = toTgMessageId(m, body);
  const date = Math.floor((num(m.timestamp ?? ctx.timestamp) || Date.now()) / 1000);
  const chat = toTgChat(chatId, { isChannel, type: recip.type, title: recip.title ?? recip.name });
  const out = { message_id: messageId, date, chat, text };
  rememberMidByTg(chatId, messageId, maxMessageIdOf(m, body));
  if (sender) out.from = sender;
  if (isChannel && !out.from) out.sender_chat = { id: chat.id, type: 'channel', title: chat.title };
  attachMediaToMessage(out, m);
  return out;
}

// ---- inbound media: parse MAX attachments → Telegram fields ----------------
function attachMediaToMessage(msg, m) {
  if (!msg) return;
  const body = m.body && typeof m.body === 'object' ? m.body : {};
  const atts = Array.isArray(body.attachments) ? body.attachments : [];
  const mediaAtts = atts.filter((a) => a && typeof a === 'object' && ['image','file','video','audio','sticker'].includes(a.type));
  if (mediaAtts.length === 0) return;
  const imageAtts = mediaAtts.filter((a) => a.type === 'image');
  if (imageAtts.length === 1) {
    const a = imageAtts[0]; const p = a.payload || {};
    const rid = registerFile(p.url, { mime: 'image/jpeg' });
    msg.photo = [{ file_id: `max:img:${rid}`, file_unique_id: rid, file_size: a.size || 0 }];
  } else if (imageAtts.length > 1) {
    msg.media_group_id = `mg_${msg.message_id}`;
    msg.photo = imageAtts.map((a) => { const p = a.payload || {}; const rid = registerFile(p.url, { mime: 'image/jpeg' }); return { file_id: `max:img:${rid}`, file_unique_id: rid, file_size: a.size || 0 }; });
  }
  const fileAtts = mediaAtts.filter((a) => a.type === 'file');
  if (fileAtts.length >= 1) {
    const a = fileAtts[0]; const p = a.payload || {};
    const rid = registerFile(p.url, { filename: p.filename || a.filename, size: a.size || p.size || 0 });
    msg.document = { file_id: `max:file:${rid}`, file_unique_id: rid, file_name: p.filename || a.filename || 'file', file_size: a.size || p.size || 0 };
  }
  const videoAtts = mediaAtts.filter((a) => a.type === 'video');
  if (videoAtts.length >= 1) {
    const a = videoAtts[0]; const p = a.payload || {};
    const rid = registerFile(p.url, { mime: 'video/mp4' });
    msg.video = { file_id: `max:video:${rid}`, file_unique_id: rid, file_size: a.size || 0, file_name: p.filename || a.filename || null, width: p.width || a.width || 0, height: p.height || a.height || 0, duration: p.duration || a.duration || null };
  }
  const audioAtts = mediaAtts.filter((a) => a.type === 'audio');
  if (audioAtts.length >= 1) {
    const a = audioAtts[0]; const p = a.payload || {};
    const rid = registerFile(p.url, { mime: 'audio/mpeg' });
    msg.audio = { file_id: `max:audio:${rid}`, file_unique_id: rid, file_size: a.size || 0, file_name: p.filename || a.filename || null };
  }
  const stickerAtts = mediaAtts.filter((a) => a.type === 'sticker');
  if (stickerAtts.length >= 1) {
    const a = stickerAtts[0]; const p = a.payload || {};
    const rid = registerFile(p.url, { mime: 'image/png' });
    msg.sticker = { file_id: `max:sticker:${rid}`, file_unique_id: rid, file_size: a.size || 0, width: a.width || 0, height: a.height || 0, is_animated: false, is_video: false };
  }
}

// ---- MAX Update -> Telegram Update -----------------------------------------
function maxUpdateToTg(u) {
  if (!u || typeof u !== 'object' || !u.update_type) return undefined;
  const t = u.update_type;
  const ctx = { chat_id: u.chat_id, is_channel: u.is_channel, user: u.user, timestamp: u.timestamp };
  const base = { update_id: ++state.tgUpdateId };

  if (t === 'message_created') {
    const m = toTgMessage(u.message, ctx);
    if (!m) return null;
    return { ...base, message: m };
  }
  if (t === 'message_edited') {
    const m = toTgMessage(u.message, ctx);
    if (!m) return null;
    return { ...base, edited_message: m };
  }
  if (t === 'message_callback') {
    const cb = u.callback && typeof u.callback === 'object' ? u.callback : {};
    const m = toTgMessage(cb.message ?? u.message, ctx);
    const from = toTgUser(u.user ?? cb.user);
    const cq = { id: str(cb.callback_id ?? cb.id ?? `${u.timestamp}-${m ? m.message_id : 0}`), chat_instance: str(u.chat_id ?? '') };
    if (from) cq.from = from;
    if (m) cq.message = m;
    cq.data = str(cb.payload ?? cb.data ?? '');
    return { ...base, callback_query: cq };
  }
  if (t === 'bot_started') {
    return {
      ...base,
      message: {
        message_id: num(u.chat_id ?? 0),
        from: toTgUser(u.user),
        chat: toTgChat(u.chat_id, { type: 'private' }),
        date: Math.floor((num(u.timestamp) || Date.now()) / 1000),
        text: '/start',
      },
    };
  }
  // bot_added/bot_removed/chat_title_changed/user_added/dialog_*/comment_* are not mapped
  return null;
}

// ---- long-polling driver (pull model, driven by grammY getUpdates) ---------
let pending = [];
let polling = false;
const PENDING_CAP = 200;

async function drainUpdates({ limit = 100, timeout = 0 }) {
  if (pending.length || polling) return;
  polling = true;
  try {
    const deadline = Date.now() + Math.max(timeout, 0) * 1000;
    let first = true;
    // Always poll MAX at least once per getUpdates call: grammY normally calls us
    // with a short/zero timeout, and the old deadline-guard made that a no-op.
    while (pending.length === 0) {
      if (!first && Date.now() >= deadline) break;
      first = false;
      const waitSec = Math.max(0, Math.min(Math.ceil((deadline - Date.now()) / 1000), 30));
      let r;
      try {
        r = await maxReq('GET', '/updates', {
          query: { limit: Math.min(limit || 100, 100), timeout: waitSec, marker: state.marker },
        });
      } catch (e) {
        console.error(`${LOG_PREFIX} updates poll failed: ${e.message}`);
        await sleep(2000);
        break;
      }
      const nextMarker = r && r.json && (r.json.marker ?? state.marker);
      if (r && r.json && Array.isArray(r.json.updates)) {
        lastUpstreamOk = Date.now();
        if (r.json.updates.length) {
          console.log(`${LOG_PREFIX} MAX delivered ${r.json.updates.length} update(s): ${r.json.updates.map((u) => u.update_type).join(',')}`);
        }
        for (const u of r.json.updates) {
          try {
            const tg = maxUpdateToTg(u);
            if (tg) pending.push(tg);
          } catch (e) {
            console.error(`${LOG_PREFIX} update transform failed: ${e.message}`);
          }
        }
      } else {
        console.warn(`${LOG_PREFIX} unexpected /updates response: ${r && r.status} ${(r && r.raw || '').slice(0, 300)}`);
      }
      if (state.marker !== nextMarker && nextMarker !== null) {
        state.marker = nextMarker;
        saveState();
      }
      if (pending.length) break;
      if (waitSec <= 0) break; // no long-poll budget left; grammY will call again
    }
  } finally {
    polling = false;
  }
}

// ---- telegram method handlers ----------------------------------------------
async function handleGetMe() {
  const r = await maxReq('GET', '/me');
  if (!r.json || r.status !== 200) {
    return { ok: false, error_code: r.status || 500, description: errText(r) };
  }
  const u = r.json;
  return {
    ok: true,
    result: {
      id: num(u.user_id),
      is_bot: true,
      first_name: str(u.first_name ?? u.name) || u.username || 'MAX bot',
      username: str(u.username),
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: false,
    },
  };
}

async function handleGetUpdates(params) {
  const offset = num(params.offset || 0);
  if (offset) pending = pending.filter((u) => u.update_id >= offset);
  if (pending.length > PENDING_CAP) pending = pending.slice(-PENDING_CAP);
  const timeout = Math.min(Math.max(num(params.timeout || 0), 0), 50);
  const limit = Math.min(Math.max(num(params.limit || 100), 1), 100);
  if (pending.length === 0) {
    await drainUpdates({ limit, timeout });
  }
  const batch = pending.slice(0, limit);
  pending = pending.slice(batch.length);
  return { ok: true, result: batch };
}

function formatFromParseMode(parseMode) {
  if (!parseMode) return undefined;
  return String(parseMode).toLowerCase().startsWith('markdown') ? 'markdown' : 'html';
}

// Translate a Telegram reply_markup.inline_keyboard into MAX inline_keyboard
// attachments. MAX limits: 210 buttons / 30 rows, <=7 per row for callback,
// <=3 per row when a row contains link/open_app/request_* buttons.
function botReplyMarkupToMaxAttachments(replyMarkup) {
  const kb = replyMarkup && Array.isArray(replyMarkup.inline_keyboard) ? replyMarkup.inline_keyboard : [];
  if (kb.length === 0) return undefined;
  const rows = [];
  let overflow = false;
  for (const row of kb) {
    if (!Array.isArray(row) || row.length === 0 || rows.length >= 30) continue;
    const maxRow = [];
    for (const b of row) {
      if (rows.length >= 30 || maxRow.length >= 7) { overflow = true; break; }
      let btn = null;
      if (b && typeof b.text === 'string' && b.url) {
        btn = { type: 'link', text: b.text, url: String(b.url) };
      } else if (b && typeof b.text === 'string' && b.web_app && b.web_app.url) {
        btn = { type: 'link', text: b.text, url: String(b.web_app.url) };
      } else if (b && typeof b.text === 'string' && b.callback_data !== undefined && b.callback_data !== null) {
        btn = { type: 'callback', text: b.text, payload: String(b.callback_data) };
      }
      if (!btn) continue;
      if (btn.type === 'link' && maxRow.length >= 3) { overflow = true; break; }
      maxRow.push(btn);
    }
    if (maxRow.length) rows.push(maxRow);
    if (overflow) break;
  }
  if (rows.length === 0) return undefined;
  return [{ type: 'inline_keyboard', payload: { buttons: rows } }];
}

function buildMaxMessagePayload({ text, format, disableLinkPreview, replyMarkup, mediaAttachments }) {
  const payload = { text, notify: true };
  if (format) payload.format = format;
  if (disableLinkPreview !== undefined) payload.disable_link_preview = !!disableLinkPreview;
  const kb = botReplyMarkupToMaxAttachments(replyMarkup);
  if (kb) payload.attachments = [...(mediaAttachments || []), ...kb];
  else if (mediaAttachments && mediaAttachments.length) payload.attachments = mediaAttachments;
  return payload;
}

async function handleSetMyCommands(params, body) {
  // Only the default scope maps to MAX's single command list; group/language
  // scopes are not representable and are acked to keep OpenClaw's sync simple.
  const scope = params.scope ? JSON.parse(params.scope) : (params.scope_type ? { type: params.scope_type } : body.scope || null);
  const scopeType = (scope && scope.type) || 'default';
  if (scopeType !== 'default') return { ok: true, result: true };
  let commands = Array.isArray(body.commands) ? body.commands : [];
  commands = commands
    .map((c) => ({ name: String(c.command || c.name || '').replace(/^\/+/, ''), description: String(c.description || '').slice(0, 256) }))
    .filter((c) => c.name);
  commands = commands.slice(0, 32);
  try {
    const r = await maxReq('PATCH', '/me/commands', { body: { commands } });
    if (r.status !== 200) console.warn(`${LOG_PREFIX} PATCH /me/commands -> ${r.status} ${errText(r)}`);
  } catch (e) {
    console.warn(`${LOG_PREFIX} PATCH /me/commands failed: ${e.message}`);
  }
  return { ok: true, result: true };
}

async function handleDeleteMyCommands(params, body) {
  const scope = params.scope ? JSON.parse(params.scope) : (params.scope_type ? { type: params.scope_type } : body.scope || null);
  const scopeType = (scope && scope.type) || 'default';
  if (scopeType !== 'default') return { ok: true, result: true };
  try {
    const r = await maxReq('PATCH', '/me/commands', { body: { commands: [] } });
    if (r.status !== 200) console.warn(`${LOG_PREFIX} PATCH /me/commands (clear) -> ${r.status} ${errText(r)}`);
  } catch (e) {
    console.warn(`${LOG_PREFIX} PATCH /me/commands (clear) failed: ${e.message}`);
  }
  return { ok: true, result: true };
}

function handleGetMyCommands() {
  return { ok: true, result: [] };
}

async function handleSendMessage(params, body) {
  const chatId = params.chat_id ?? body.chat_id;
  const text = typeof body.text === 'string' ? body.text : '';
  if (chatId === undefined || chatId === null || text === '') {
    return tgErr(400, 'chat_id and text string are required');
  }
  const payload = buildMaxMessagePayload({
    text,
    format: formatFromParseMode(body.parse_mode),
    disableLinkPreview: body.disable_web_page_preview,
    replyMarkup: body.reply_markup,
  });
  const r = await maxReq('POST', '/messages', { query: { chat_id: chatId }, body: payload });
  if (!r.json || r.status !== 200) return tgErr(r.status || 500, errText(r));
  const result = toTgMessage(r.json.message, { chat_id: chatId });
  if (result) return { ok: true, result };
  return { ok: true, result: { message_id: 0, date: Math.floor(Date.now() / 1000), chat: toTgChat(chatId, {}), text } };
}

async function handleEditMessageText(params, body) {
  const chatId = params.chat_id ?? body.chat_id;
  const messageId = params.message_id ?? body.message_id;
  const text = typeof body.text === 'string' ? body.text : '';
  if (chatId === undefined || messageId === undefined || text === '') {
    return tgErr(400, 'chat_id, message_id and text are required');
  }
  const maxId = resolveMaxMessageId(chatId, messageId) ?? messageId;
  const payload = { text };
  const format = formatFromParseMode(body.parse_mode);
  if (format) payload.format = format;
  if (body.disable_web_page_preview !== undefined) payload.disable_link_preview = !!body.disable_web_page_preview;
  // Telegram: editMessageText without reply_markup removes the keyboard.
  payload.attachments = botReplyMarkupToMaxAttachments(body.reply_markup) || [];
  const r = await maxReq('PUT', '/messages', { query: { chat_id: chatId, message_id: maxId }, body: payload });
  if (!r.json || r.status !== 200) return tgErr(r.status || 500, errText(r));
  const result = toTgMessage(r.json.message, { chat_id: chatId });
  if (result) return { ok: true, result };
  return { ok: true, result: { message_id: num(messageId), date: Math.floor(Date.now() / 1000), chat: toTgChat(chatId, {}), text } };
}

async function handleEditMessageCaption(params, body) {
  const chatId = params.chat_id ?? body.chat_id;
  const messageId = params.message_id ?? body.message_id;
  const caption = typeof body.caption === 'string' ? body.caption : '';
  if (chatId === undefined || messageId === undefined) return tgErr(400, 'chat_id and message_id are required');
  const maxId = resolveMaxMessageId(chatId, messageId) ?? messageId;
  const payload = {};
  if (body.caption !== undefined) payload.text = str(body.caption);
  const format = formatFromParseMode(body.parse_mode);
  if (format) payload.format = format;
  if (body.reply_markup !== undefined) payload.attachments = botReplyMarkupToMaxAttachments(body.reply_markup) || [];
  const r = await maxReq('PUT', '/messages', { query: { chat_id: chatId, message_id: maxId }, body: payload });
  if (!r.json || r.status !== 200) return tgErr(r.status || 500, errText(r));
  return { ok: true, result: true };
}

async function handleEditMessageReplyMarkup(params, body) {
  const chatId = params.chat_id ?? body.chat_id;
  const messageId = params.message_id ?? body.message_id;
  if (chatId === undefined || messageId === undefined) return tgErr(400, 'chat_id and message_id are required');
  const maxId = resolveMaxMessageId(chatId, messageId) ?? messageId;
  const payload = { attachments: botReplyMarkupToMaxAttachments(body.reply_markup) || [] };
  const r = await maxReq('PUT', '/messages', { query: { chat_id: chatId, message_id: maxId }, body: payload });
  if (!r.json || r.status !== 200) return tgErr(r.status || 500, errText(r));
  return { ok: true, result: true };
}

async function handleDeleteMessage(params, body) {
  const chatId = params.chat_id ?? body.chat_id;
  const messageId = params.message_id ?? body.message_id;
  if (chatId === undefined || messageId === undefined) return tgErr(400, 'chat_id and message_id are required');
  const maxId = resolveMaxMessageId(chatId, messageId) ?? messageId;
  const r = await maxReq('DELETE', '/messages', { query: { chat_id: chatId, message_id: maxId } });
  return { ok: r.status >= 200 && r.status < 300, result: true, ...(r.status < 200 || r.status >= 300 ? { error_code: r.status, description: errText(r) } : {}) };
}

async function handleAnswerCallbackQuery(params, body) {
  const cid = params.callback_query_id ?? body.callback_query_id;
  if (!cid) return tgErr(400, 'callback_query_id is required');
  // MAX: answers body.message REPLACES the message — never touch it on a plain
  // acknowledgment, so just mark the callback as handled.
  const r = await maxReq('POST', '/answers', { query: { callback_id: cid }, body: {} });
  return { ok: true, result: true };
}

const ACTION_MAP = {
  typing: 'typing_on',
  upload_photo: 'sending_photo',
  upload_video: 'sending_video',
  record_video: 'sending_video',
  upload_audio: 'sending_audio',
  record_audio: 'sending_audio',
  upload_document: 'sending_file',
  find_location: 'typing_on',
};

async function handleSendChatAction(params, body) {
  const chatId = params.chat_id ?? body.chat_id;
  const action = ACTION_MAP[body.action] || ACTION_MAP[params.action];
  if (chatId === undefined || !action) return { ok: true, result: true }; // no-op for unknown actions
  try {
    const r = await maxReq('POST', `/chats/${num(chatId)}/actions`, { body: { action } });
    return { ok: true, result: true };
  } catch (e) {
    return { ok: true, result: true }; // best effort
  }
}

async function handleGetChat(params, body) {
  const chatId = params.chat_id ?? body.chat_id;
  if (chatId === undefined) return tgErr(400, 'chat_id is required');
  const r = await maxReq('GET', `/chats/${num(chatId)}`);
  if (!r.json || r.status !== 200) return tgErr(r.status || 500, errText(r));
  const c = r.json;
  const isChannel = String(c.type || '').toLowerCase().includes('channel');
  const chat = toTgChat(c.chat_id ?? chatId, { isChannel: isChannel || c.is_channel, type: c.type, title: c.title ?? c.name });
  if (c.username != null) chat.username = str(c.username);
  return { ok: true, result: chat };
}

// ---- utilities -------------------------------------------------------------
function tgErr(code, desc) {
  return { ok: false, error_code: code || 400, description: desc || 'error' };
}
function errText(r) {
  if (!r) return 'no response';
  if (r.json) return str(r.json.message ?? r.json.code ?? r.json.error ?? JSON.stringify(r.json).slice(0, 300));
  return (r.raw || 'empty').slice(0, 300);
}

// ---- inbound file serving (getFile + /file route) --------------------------
function entryForFileId(fileId) {
  const parts = String(fileId || '').split(':');
  if (parts.length < 3 || parts[0] !== 'max') return null;
  const entry = getFileEntry(parts[2]);
  return entry ? { rid: parts[2], entry } : null;
}

async function handleGetFile(params, body) {
  const fileId = params.file_id || (body && body.file_id);
  if (!fileId) return tgErr(400, 'file_id is required');
  const hit = entryForFileId(fileId);
  if (!hit) return tgErr(400, 'unknown file_id');
  return { ok: true, result: { file_id: fileId, file_unique_id: hit.rid, file_size: hit.entry.size || 0, file_path: `media/${hit.rid}` } };
}

// Block SSRF/internal targets. Media URLs come from MAX CDN or the upload host;
// allow only https (unless INSECURE test flag) and public DNS names.
function assertSafeMediaUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch (_) { throw new Error('invalid URL'); }
  if (u.username || u.password) throw new Error('URL must not contain credentials');
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('unsupported URL protocol');
  if (u.protocol !== 'https:' && !INSECURE) throw new Error('non-https media URL blocked');
  if (!INSECURE) {
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost')) throw new Error('local host blocked');
    if (net.isIP(h)) throw new Error('IP-literal media URL blocked');
    if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) throw new Error('private range blocked');
    if (h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home')) throw new Error('reserved domain blocked');
  }
  return u;
}

function streamRemoteFile(remoteUrl, res) {
  return new Promise((resolve) => {
    let parsedUrl;
    try { parsedUrl = assertSafeMediaUrl(remoteUrl); } catch (e) { res.writeHead(400); res.end(`blocked: ${e.message}`); return resolve(); }
    const mod = parsedUrl.protocol === 'https:' ? https : http;
    const doFetch = (urlStr, attempt) => {
      let u;
      try { u = assertSafeMediaUrl(urlStr); } catch (e) { res.writeHead(400); res.end(`blocked: ${e.message}`); return resolve(); }
      const req = mod.get(u, { timeout: 60_000, rejectUnauthorized: !INSECURE }, (upRes) => {
        if (upRes.statusCode >= 300 && upRes.statusCode < 400 && upRes.headers.location && attempt < 5) {
          upRes.resume(); doFetch(upRes.headers.location, attempt + 1); return;
        }
        if (upRes.statusCode < 200 || upRes.statusCode >= 300) { upRes.resume(); res.writeHead(upRes.statusCode || 502); res.end('upstream error'); return resolve(); }
        const headers = {};
        if (upRes.headers['content-type']) headers['Content-Type'] = upRes.headers['content-type'];
        if (upRes.headers['content-length']) headers['Content-Length'] = upRes.headers['content-length'];
        if (upRes.headers['content-disposition']) headers['Content-Disposition'] = upRes.headers['content-disposition'];
        res.writeHead(200, headers);
        upRes.pipe(res);
        upRes.on('end', () => resolve());
        upRes.on('error', () => { res.end(); resolve(); });
      });
      req.on('error', () => { res.writeHead(502); res.end('fetch failed'); resolve(); });
    };
    doFetch(remoteUrl, 0);
  });
}

function downloadRemoteBytes(remoteUrl, maxBytes = 100 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = assertSafeMediaUrl(remoteUrl); } catch (e) { return reject(e); }
    const mod = u.protocol === 'https:' ? https : http;
    const doFetch = (urlStr, attempt) => {
      let cu;
      try { cu = assertSafeMediaUrl(urlStr); } catch (e) { return reject(e); }
      mod.get(cu, { timeout: 60_000, rejectUnauthorized: !INSECURE }, (upRes) => {
        if (upRes.statusCode >= 300 && upRes.statusCode < 400 && upRes.headers.location && attempt < 5) {
          upRes.resume(); doFetch(upRes.headers.location, attempt + 1); return;
        }
        if (upRes.statusCode < 200 || upRes.statusCode >= 300) { upRes.resume(); return reject(new Error(`download failed: ${upRes.statusCode}`)); }
        const chunks = [];
        let total = 0;
        upRes.on('data', (c) => { total += c.length; if (total > maxBytes) { reject(new Error('download exceeds size limit')); upRes.destroy(); } else { chunks.push(c); } });
        upRes.on('end', () => resolve({ data: Buffer.concat(chunks), mime: upRes.headers['content-type'] || null }));
        upRes.on('error', reject);
      }).on('error', reject);
    };
    doFetch(remoteUrl, 0);
  });
}

// ---- outbound media helpers ------------------------------------------------
function parseMultipart(rawBody, contentType) {
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) return { fields: {}, files: {} };
  const boundary = '--' + boundaryMatch[1];
  const parts = rawBody.split(boundary);
  const fields = {}; const files = {};
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === '' || trimmed === '--') continue;
    const headerEnd = trimmed.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = trimmed.substring(0, headerEnd);
    let value = trimmed.substring(headerEnd + 4);
    if (value.endsWith('\r\n')) value = value.slice(0, -2);
    const nameMatch = headers.match(/name="([^"]+)"/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    if (filenameMatch) {
      const ctMatch = headers.match(/Content-Type:\s*(.+)/i);
      files[name] = { filename: filenameMatch[1], mime: ctMatch ? ctMatch[1].trim() : 'application/octet-stream', data: Buffer.from(value, 'binary') };
    } else {
      fields[name] = value;
    }
  }
  return { fields, files };
}

function maxUpload(uploadType, fileData, filename) {
  return new Promise(async (resolve, reject) => {
    try {
      const r1 = await maxReq('POST', '/uploads', { query: { type: uploadType } });
      if (!r1.json || r1.status !== 200) return reject(new Error(`uploads step1 failed: ${r1.status} ${(r1.raw || '').slice(0, 200)}`));
      const { url, token: earlyToken } = r1.json;
      let u;
      try { u = assertSafeMediaUrl(url); } catch (e) { return reject(new Error(`blocked upload url: ${e.message}`)); }
      const boundary = '----mb-' + crypto.randomBytes(8).toString('hex');
      const hdr = `--${boundary}\r\nContent-Disposition: form-data; name="data"; filename="${filename || 'file'}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
      const ftr = `\r\n--${boundary}--`;
      const uploadBody = Buffer.concat([Buffer.from(hdr), fileData, Buffer.from(ftr)]);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(u, { method: 'POST', rejectUnauthorized: !INSECURE, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': uploadBody.length } }, (res2) => {
        let d = ''; res2.on('data', (c) => d += c); res2.on('end', () => {
          let j = null; try { j = JSON.parse(d); } catch (_) {}
          if (res2.statusCode < 200 || res2.statusCode >= 300) return reject(new Error(`upload step2 failed: ${res2.statusCode}`));
          let finalToken = earlyToken;
          if (j && j.token) finalToken = j.token;
          if (j && j.photos) { const k = Object.keys(j.photos)[0]; if (k && j.photos[k].token) finalToken = j.photos[k].token; }
          resolve({ token: finalToken, response: j });
        });
      });
      req.on('error', reject);
      req.setTimeout(300_000, () => req.destroy(new Error('upload timeout')));
      req.write(uploadBody);
      req.end();
    } catch (e) { reject(e); }
  });
}

// Upload bytes sourced from our own previously-received file (file_id reuse).
async function uploadFromMaxFileId(fileId, maxType, fallbackName) {
  const hit = entryForFileId(fileId);
  if (!hit || !hit.entry.url) return null;
  const dl = await downloadRemoteBytes(hit.entry.url);
  return maxUpload(maxType, dl.data, hit.entry.filename || fallbackName || 'file');
}

function resolveMediaField(fieldValue, files) {
  if (!fieldValue || typeof fieldValue !== 'string') return null;
  if (fieldValue.startsWith('attach://')) { const id = fieldValue.slice(9); const f = files[id]; return f ? { type: 'file', data: f.data, filename: f.filename, mime: f.mime } : null; }
  if (fieldValue.startsWith('http://') || fieldValue.startsWith('https://')) return { type: 'url', url: fieldValue };
  return { type: 'file_id', id: fieldValue };
}

function isAttachmentNotReady(r) {
  const code = str((r && r.json && (r.json.code ?? r.json.error)) || '');
  return /not\s*[._ ]?ready/i.test(code);
}

async function handleSendMedia(params, body, files, mediaType, maxType) {
  const chatId = params.chat_id ?? body.chat_id;
  if (chatId === undefined || chatId === null) return tgErr(400, 'chat_id is required');
  const caption = typeof body.caption === 'string' ? body.caption : (typeof body.text === 'string' ? body.text : '');
  const format = formatFromParseMode(body.parse_mode);
  const field = body[mediaType];
  const resolved = resolveMediaField(field, files);
  if (!resolved) return tgErr(400, `${mediaType} is required (attach://, URL, or file_id)`);
  let uploadResult;
  try {
    if (resolved.type === 'file') {
      uploadResult = await maxUpload(maxType, resolved.data, resolved.filename);
    } else if (resolved.type === 'url') {
      if (maxType === 'image') { uploadResult = { token: null, urlPayload: { url: resolved.url } }; }
      else { return tgErr(400, `URL attachment not supported for type ${mediaType}`); }
    } else {
      uploadResult = await uploadFromMaxFileId(resolved.id, maxType, caption ? undefined : `file.${maxType === 'image' ? 'img' : maxType}`);
      if (!uploadResult) return tgErr(400, 'file_id not reusable via MAX bridge');
    }
  } catch (e) {
    return tgErr(500, `upload failed: ${e.message}`);
  }
  const att = { type: maxType, payload: uploadResult.urlPayload || { token: uploadResult.token } };
  const payload = buildMaxMessagePayload({
    text: caption,
    format,
    disableLinkPreview: body.disable_web_page_preview,
    replyMarkup: body.reply_markup,
    mediaAttachments: [att],
  });
  let r;
  for (let attempt = 0; attempt < 4; attempt++) {
    r = await maxReq('POST', '/messages', { query: { chat_id: chatId }, body: payload });
    if (r.json && r.json.message) break;
    if (isAttachmentNotReady(r)) { await sleep(1500 * (attempt + 1)); continue; }
    break;
  }
  if (!r.json || r.status !== 200) return tgErr(r.status || 500, errText(r));
  const result = toTgMessage(r.json.message, { chat_id: chatId });
  if (result) return { ok: true, result };
  return { ok: true, result: { message_id: 0, date: Math.floor(Date.now() / 1000), chat: toTgChat(chatId, {}), text: caption } };
}

async function handleSendMediaGroup(params, body, files) {
  const chatId = params.chat_id ?? body.chat_id;
  if (chatId === undefined || chatId === null) return tgErr(400, 'chat_id is required');
  let media; try { media = JSON.parse(body.media || '[]'); } catch (_) { media = []; }
  if (!Array.isArray(media) || media.length === 0) return tgErr(400, 'media array is required');
  const attachments = [];
  for (const item of media) {
    const resolved = resolveMediaField(item.media || item.photo, files);
    if (!resolved) continue;
    try {
      let u;
      if (resolved.type === 'file') u = await maxUpload('image', resolved.data, resolved.filename);
      else if (resolved.type === 'url') { u = { token: null, urlPayload: { url: resolved.url } }; }
      else u = await uploadFromMaxFileId(resolved.id, 'image');
      if (u) attachments.push({ type: 'image', payload: u.urlPayload || { token: u.token } });
    } catch (_) {}
  }
  if (attachments.length === 0) return tgErr(400, 'no valid media items');
  const caption = typeof body.caption === 'string' ? body.caption : '';
  const format = formatFromParseMode(body.parse_mode);
  const payload = buildMaxMessagePayload({
    text: caption,
    format,
    replyMarkup: body.reply_markup,
    mediaAttachments: attachments,
  });
  const r = await maxReq('POST', '/messages', { query: { chat_id: chatId }, body: payload });
  if (!r.json || r.status !== 200) return tgErr(r.status || 500, errText(r));
  const result = toTgMessage(r.json.message, { chat_id: chatId });
  if (result) return { ok: true, result };
  return { ok: true, result: { message_id: 0, date: Math.floor(Date.now() / 1000), chat: toTgChat(chatId, {}), text: caption } };
}

// ---- HTTP server ------------------------------------------------------------
const NOOP_METHODS = {
  deleteWebhook: true,
  logOut: true,
  close: true,
  setChatMenuButton: true,
  getChatMenuButton: true,
  setMyDescription: true,
  getMyDescription: true,
  setMyShortDescription: true,
  getMyShortDescription: true,
  setMyName: true,
  getMyName: true,
  setMyDefaultAdministratorRights: true,
  getMyDefaultAdministratorRights: true,
  setWebhook: true,
  getWebhookInfo: true,
  getChatMember: true,
  getChatMemberCount: true,
  getChatAdministrators: true,
  pinChatMessage: true,
  unpinChatMessage: true,
  setMessageReaction: true,
  banChatMember: true,
  unbanChatMember: true,
  restrictChatMember: true,
  leaveChat: true,
};

const NOOP_ARRAY_METHODS = {
  getChatAdministrators: true,
};

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${HOST}`);

  // ---- /file/bot<token>/media/<id> — raw byte streaming for OpenClaw --------
  const fileRoute = parsed.pathname.match(/^\/file\/bot[^/]+\/media\/([a-f0-9]+)$/);
  if (fileRoute && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/octet-stream');
    const entry = getFileEntry(fileRoute[1]);
    if (!entry || !entry.url) { res.writeHead(404); res.end('not found'); return; }
    streamRemoteFile(entry.url, res);
    return;
  }

  // ---- GET /healthz — lightweight liveness probe (no auth) ------------------
  if (parsed.pathname === '/healthz' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true,
      service: 'botmax',
      uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
      marker: state.marker,
      tgUpdateId: state.tgUpdateId,
      lastUpstreamOk: lastUpstreamOk,
      upstreamAgeMs: lastUpstreamOk ? Date.now() - lastUpstreamOk : null,
      upstream: MAX_URL,
      pending: pending.length,
    }));
    return;
  }

  const m = parsed.pathname.match(/^\/bot[^/]+\/([A-Za-z0-9_]+)$/);
  res.setHeader('Content-Type', 'application/json');

  const isMultipart = (req.headers['content-type'] || '').includes('multipart/form-data');
  const MAX_BODY = isMultipart ? 300 * 1024 * 1024 : 1 * 1024 * 1024;
  let rawBody = Buffer.alloc(0);
  req.on('data', (c) => { rawBody = Buffer.concat([rawBody, c]); if (rawBody.length > MAX_BODY) { rawBody = rawBody.slice(0, MAX_BODY); req.destroy(); } });
  req.on('end', async () => {
    let body = {};
    let files = {};
    if (isMultipart && rawBody.length) {
      const parsed2 = parseMultipart(rawBody.toString('binary'), req.headers['content-type']);
      body = parsed2.fields; files = parsed2.files;
    } else if (rawBody.length) {
      try { body = JSON.parse(rawBody.toString('utf8')); } catch (_) {}
    }
    const params = {};
    for (const [k, v] of parsed.searchParams) params[k] = v;
    parsed._files = files;

    let reply;
    if (!m) {
      reply = tgErr(404, 'not a telegram bot api path: ' + parsed.pathname.slice(0, 100));
    } else {
      const method = m[1];
      try {
        switch (method) {
          case 'getMe': reply = await handleGetMe(); break;
          case 'getUpdates': reply = await handleGetUpdates(params); break;
          case 'sendMessage': reply = await handleSendMessage(params, body); break;
          case 'editMessageText': reply = await handleEditMessageText(params, body); break;
          case 'editMessageCaption': reply = await handleEditMessageCaption(params, body); break;
          case 'editMessageReplyMarkup': reply = await handleEditMessageReplyMarkup(params, body); break;
          case 'setMyCommands': reply = await handleSetMyCommands(params, body); break;
          case 'deleteMyCommands': reply = await handleDeleteMyCommands(params, body); break;
          case 'getMyCommands': reply = await handleGetMyCommands(params, body); break;
          case 'deleteMessage': reply = await handleDeleteMessage(params, body); break;
          case 'answerCallbackQuery': reply = await handleAnswerCallbackQuery(params, body); break;
          case 'sendChatAction': reply = await handleSendChatAction(params, body); break;
          case 'getChat': reply = await handleGetChat(params, body); break;
          case 'getFile': reply = await handleGetFile(params, body); break;
          case 'sendPhoto': reply = await handleSendMedia(params, body, files, 'photo', 'image'); break;
          case 'sendDocument': reply = await handleSendMedia(params, body, files, 'document', 'file'); break;
          case 'sendVideo': reply = await handleSendMedia(params, body, files, 'video', 'video'); break;
          case 'sendAudio': reply = await handleSendMedia(params, body, files, 'audio', 'audio'); break;
          case 'sendVoice': reply = await handleSendMedia(params, body, files, 'voice', 'audio'); break;
          case 'sendAnimation': reply = await handleSendMedia(params, body, files, 'animation', 'image'); break;
          case 'sendVideoNote': reply = await handleSendMedia(params, body, files, 'video_note', 'video'); break;
          case 'sendSticker': reply = await handleSendMedia(params, body, files, 'sticker', 'image'); break;
          case 'sendMediaGroup': reply = await handleSendMediaGroup(params, body, files); break;
          default:
            if (NOOP_METHODS[method]) {
              reply = { ok: true, result: NOOP_ARRAY_METHODS[method] ? [] : true };
            } else {
              reply = tgErr(404, `botmax: unsupported method ${method}`);
            }
        }
      } catch (e) {
        console.error(`${LOG_PREFIX} handler ${method} failed: ${e.message}`);
        reply = tgErr(500, `botmax internal error: ${e.message}`);
      }
    }
    res.statusCode = reply.ok ? 200 : (reply.error_code && reply.error_code >= 100 ? reply.error_code : 400);
    res.end(JSON.stringify(reply));
    if (reply.ok && m && ['getMe', 'sendMessage', 'sendChatAction'].includes(m[1])) {
      console.log(`${LOG_PREFIX} ${req.method} ${m[1]} -> ok`);
    } else if (reply.ok && m && m[1] === 'getUpdates' && reply.result.length > 0) {
      console.log(`${LOG_PREFIX} ${req.method} getUpdates -> ok (${reply.result.length} updates)`);
    } else if (!reply.ok) {
      console.warn(`${LOG_PREFIX} ${req.method} ${m ? m[1] : parsed.pathname} -> ${reply.error_code} ${reply.description}`);
    }
  });
});

loadState();
server.listen(PORT, HOST, () => {
  console.log(`${LOG_PREFIX} listening on http://${HOST}:${PORT}`);
  console.log(`${LOG_PREFIX} upstream=${MAX_URL} state=${STATE_FILE}`);
  if (process.send) process.send('ready');
});

// Persist the MAX marker on graceful shutdown so a restart does not re-deliver
// (state is also saved after every marker advance during polling).
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${LOG_PREFIX} ${sig} received, saving state and closing`);
  try { saveState(); } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));