# 🤖 BotMAX — add your bot to **MAX**

Run your **OpenClaw** / **Hermes** / any **Telegram bot** in the MAX messenger
(ex-VK Messenger) with **one command**:

```bash
curl -fsSL https://raw.githubusercontent.com/DemoMY/BotMAX/main/install.sh | bash
```

BotMAX is a tiny, **zero-dependency** daemon that implements the **Telegram Bot
API** on top of the official **MAX Bot API**. Your agent keeps talking normal
Telegram — BotMAX translates everything (text, media, inline keyboards,
callbacks, commands menu) to MAX under the hood.

```
┌──────────────────┐   Telegram Bot API   ┌─────────────────────┐   MAX Bot API    ┌──────────────────┐
│  OpenClaw /  │◄──────────────────►│  BotMAX daemon   │◄──────────────────►│  MAX messenger  │
│  Hermes / grammY│   http://127.0.0.1:18790   │  (this repo)  │   platform-api2   │  (your phone) │
└──────────────────┘                    └─────────────────────┘          └──────────────────┘
```

---

## ✨ Features

- **One-line install** — downloads, asks for your MAX token, validates it live,
  sets up a per-user `systemd` service, and auto-configures **OpenClaw** if found.
- **Zero npm dependencies** — only Node.js ≥ 18 built-ins. No lockfiles, no audit.
- **Real MAX Bot API** (official, documented at dev.max.ru) — text, media
  (photos / video / audio / files), **inline keyboards**, **callback buttons**,
  **command menu** (`setMyCommands`), message editing & deletion.
- **Loopback-only by default** (`127.0.0.1`) — your token never hits the network.
- **No system-wide TLS trust needed** — the bundled Mintsifry root CA is used by
  the daemon alone via `NODE_EXTRA_CA_CERTS`.
- **Production-grade basics**: `/healthz` liveness, graceful shutdown, atomic
  state persistence, 18 integration tests.

---

## 🚀 Quick start (OpenClaw)

```bash
curl -fsSL https://raw.githubusercontent.com/DemoMY/BotMAX/main/install.sh | bash
```

The installer will:

1. download BotMAX into `~/.local/share/botmax/`,
2. ask for your **MAX bot token** (get it from
   [business.max.ru/self](https://business.max.ru/self) → Чат-боты → Настройки,
   or from the **«MAX для бизнеса»** bot via the command **Получить токен**),
3. start `botmax.service` on `127.0.0.1:18790` and **validate the token** via a
   real `GET /me`,
4. if it finds `~/.openclaw/openclaw.json`: **backs it up**, injects
   `channels.telegram` (`apiRoot=http://127.0.0.1:18790`, `botToken=9:botmax`)
   and restarts `openclaw-gateway.service`,
5. prints a verification checklist.

> Already have a real Telegram bot configured in OpenClaw? The installer refuses
> to overwrite it. Re-run with `BOTMAX_FORCE=1` to point OpenClaw at BotMAX
> instead.

**Verification in the MAX app:**
1. open your bot, send any message — the agent answers;
2. type `/commands` — command list with inline buttons arrives;
3. tap a button — the message edits in place.

---

## 🧩 Manual / Hermes / any Bot API client

Hermes and other agents have their own messenger stack — BotMAX is *just a
Telegram Bot API server*, so plug it in wherever you can override the Bot API
endpoint:

```bash
# 1) install without auto-OpenClaw (skip the agent step):
#    just run the installer; it skips ~/.openclaw if absent.

# 2) start standalone (no systemd — Docker, containers, macOS, Windows):
npm i -g .  # or: node bridge.js
BOTMAX_BOT_TOKEN=your_token node bridge.js

# 3) point your agent at it:
#    apiRoot  = http://127.0.0.1:18790
#    botToken = 9:botmax   (any non-empty string the bot accepts)
```

For agents that use `grammY`, this is a drop-in `apiRoot`. For OpenClaw the
equivalent manual change is `channels.telegram` in `~/.openclaw/openclaw.json`:

```jsonc
{
  "channels": {
    "telegram": {
      "enabled": true,
      "apiRoot": "http://127.0.0.1:18790",
      "botToken": "9:botmax",
      "dmPolicy": "allowlist"
    }
  }
}
```

---

## 🔧 Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `BOTMAX_BOT_TOKEN` | — | MAX bot token (required) |
| `BOTMAX_HOST` | `127.0.0.1` | bind address (loopback only — change carefully) |
| `BOTMAX_PORT` | `18790` | Telegram-Bot-API port |
| `BOTMAX_UPSTREAM` | `https://platform-api2.max.ru` | MAX API base URL |
| `BOTMAX_STATE` | `~/.config/botmax/state.json` | long-poll marker persistence |
| `BOTMAX_INSECURE` | off | allow http upstream (tests only — do not use in production) |
| `NODE_EXTRA_CA_CERTS` | set by installer | path to `certs/russian-trusted-root-ca.pem` |

`install.sh` flags / env: `BOTMAX_BOT_TOKEN` (non-interactive), `BOTMAX_PORT`,
`BOTMAX_FORCE=1`, `BOTMAX_INSTALL_DIR`.

---

## 🛠 Development

```bash
npm test          # 18 integration tests (self-contained, run against a fake MAX)
node bridge.js    # start standalone (needs BOTMAX_BOT_TOKEN)
```

---

## 🔒 Security model

- binds to `127.0.0.1`; the bridge is a **local** service for your agent.
- the MAX token is stored in `~/.config/botmax/env` (`chmod 600`).
- TLS to MAX uses the bundled **Russian Trusted Root CA**
  (SHA-256 `D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31`,
  fetched from gu-st.ru). No system-wide certificate installation is required.
- media downloads refuse non-HTTPS URLs by default.

*MAX is a trademark of its owner. This project is unofficial and not affiliated.*

---

## 📄 License

MIT — see [LICENSE](LICENSE).

EN version follows; RU version is the primary one.