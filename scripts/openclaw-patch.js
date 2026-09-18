#!/usr/bin/env node
'use strict';
// openclaw-patch.js — inject BotMAX into ~/.openclaw/openclaw.json safely.
// Usage: node openclaw-patch.js <config.json> --apiRoot <url> --botToken <tok> [--force]
// Exit codes: 0 = patched/unchanged, 2 = needs --force (existing non-BotMAX telegram), 1 = error.
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const file = argv[0];
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const apiRoot = arg('--apiRoot');
const botToken = arg('--botToken');
const force = argv.includes('--force');

if (!file || !apiRoot || !botToken) {
  console.error('usage: openclaw-patch.js <config.json> --apiRoot <url> --botToken <tok> [--force]');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`openclaw.json not found: ${file}`);
  process.exit(1);
}

let cfg;
try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
  console.error(`cannot parse ${file}: ${e.message}`);
  process.exit(1);
}

if (!cfg.channels) cfg.channels = {};
const tg = cfg.channels.telegram;

// already pointing at BotMAX? idempotent.
if (tg && tg.apiRoot && /botmax|127\.0\.0\.1:18790|:18790/.test(String(tg.apiRoot))) {
  console.log('telegram channel already points at BotMAX, nothing to change');
  process.exit(0);
}
if (tg && tg.apiRoot && !force) {
  console.error(
    `channels.telegram already has apiRoot=${tg.apiRoot} ` +
    '(likely a real Telegram bot). Refusing to overwrite. Re-run with --force to replace it.'
  );
  process.exit(2);
}
const prevApiRoot = tg && tg.apiRoot;
cfg.channels.telegram = Object.assign({}, tg, {
  enabled: true,
  apiRoot,
  botToken,
});
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(`${file}.bak-botmax-${stamp}`, JSON.stringify(cfg, null, 2));
const tmp = `${file}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
fs.renameSync(tmp, file);
console.log(`patched channels.telegram -> apiRoot=${apiRoot}${prevApiRoot ? ` (was ${prevApiRoot})` : ''}`);
process.exit(0);