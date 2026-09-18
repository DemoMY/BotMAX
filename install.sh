#!/usr/bin/env bash
#
# BotMAX — add your bot to MAX. One-command installer.
#
#   curl -fsSL https://raw.githubusercontent.com/DemoMY/BotMAX/main/install.sh | bash
#
# What it does:
#   1. downloads the latest BotMAX release into ~/.local/share/botmax
#   2. asks for your MAX bot token (or takes $BOTMAX_BOT_TOKEN)
#   3. installs a per-user systemd service (botmax.service, loopback 127.0.0.1:18790)
#   4. validates the token via the live bridge (real GET /me through MAX)
#   5. auto-configures OpenClaw if found (~/.openclaw/openclaw.json) and restarts the gateway
#   6. prints a verification checklist
#
# Requirements: Linux + bash + node >= 18. No other dependencies.
set -euo pipefail

REPO_OWNER="DemoMY"
REPO_NAME="BotMAX"
BRANCH="${BOTMAX_BRANCH:-main}"

INSTALL_DIR="${BOTMAX_INSTALL_DIR:-$HOME/.local/share/botmax}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/botmax"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/botmax"
BRIDGE_PORT="${BOTMAX_PORT:-18790}"
BOT_TOKEN_OVERRIDE="${BOTMAX_BOT_TOKEN:-}"
FORCE="${BOTMAX_FORCE:-0}"
PATCH_EC=1

info()  { printf '\033[1;36m[botmax]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[botmax]\033[0m %s\n' "$*"; }
err()   { printf '\033[1;31m[botmax]\033[0m %s\n' "$*" >&2; }
die()   { err "$*"; exit 1; }

# ---- preflight --------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "node is required (>= 18). Install it first: https://nodejs.org"
node -e 'process.exit(Number(process.version.startsWith("v18") || Number(process.versions.node.split(".")[0]) >= 18) ? 0 : 1)' \
  || die "node >= 18 is required, found: $(node -v)"
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user is-system-running >/dev/null 2>&1 || warn "systemd user bus not fully up; service will still be written"
fi
PORT_IN_USE=0
if command -v ss >/dev/null 2>&1 && ss -tlnp 2>/dev/null | grep -q ":${BRIDGE_PORT} "; then PORT_IN_USE=1; fi
if [ "$PORT_IN_USE" = "1" ]; then
  info "port ${BRIDGE_PORT} already in use — proceeding (your bridge may already run)"
fi

# ---- fetch ---------------------------------------------------------------
info "downloading BotMAX@${BRANCH} -> $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
if [ -f "$INSTALL_DIR/bridge.js" ]; then
  info "existing install found; keeping files (override with BOTMAX_FORCE=1)"
  if [ "$FORCE" = "1" ]; then
    warn "BOTMAX_FORCE=1 — re-downloading"
    rm -rf "$INSTALL_DIR"
    mkdir -p "$INSTALL_DIR"
  fi
fi
if [ ! -f "$INSTALL_DIR/bridge.js" ]; then
  TARBALL_URL="https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/tar.gz/${BRANCH}"
  TMP_TAR="$(mktemp -d)"
  curl -fsSL "$TARBALL_URL" -o "$TMP_TAR/repo.tgz" || die "failed to download ${TARBALL_URL}"
  tar -xzf "$TMP_TAR/repo.tgz" -C "$TMP_TAR"
  SRC_DIR="$(find "$TMP_TAR" -maxdepth 2 -name bridge.js -printf '%h\n' -quit)"
  [ -n "$SRC_DIR" ] || die "downloaded archive has an unexpected layout"
  cp -a "$SRC_DIR"/. "$INSTALL_DIR/"
  rm -rf "$TMP_TAR"
  chmod +x "$INSTALL_DIR/bridge.js"
fi

# ---- token --------------------------------------------------------------
if [ -n "$BOT_TOKEN_OVERRIDE" ]; then
  BOT_TOKEN="$BOT_TOKEN_OVERRIDE"
  info "using BOTMAX_BOT_TOKEN from environment"
elif [ -f "$CONFIG_DIR/env" ]; then
  # shellcheck disable=SC1090
  OLD_TOKEN=$(grep '^BOTMAX_BOT_TOKEN=' "$CONFIG_DIR/env" | head -1 | cut -d= -f2- | tr -d '"')
  info "reusing token from previous install ($CONFIG_DIR/env)"
  BOT_TOKEN="$OLD_TOKEN"
else
  BOT_TOKEN=""
  printf 'Paste your MAX bot token: ' >&2
  read -r -s BOT_TOKEN
  printf '\n' >&2
fi
[ -n "$BOT_TOKEN" ] || die "empty token. Get one: https://business.max.ru/self → Чат-боты → Настройки"

# ---- write config + systemd --------------------------------------------
mkdir -p "$CONFIG_DIR" "$STATE_DIR"
umask 077
printf 'BOTMAX_BOT_TOKEN=%s\n' "$BOT_TOKEN" > "$CONFIG_DIR/env"
BOTMAX_STATE="$STATE_DIR/state.json"
grep -q '^BOTMAX_STATE=' "$CONFIG_DIR/env" || printf 'BOTMAX_STATE=%s\n' "$BOTMAX_STATE" >> "$CONFIG_DIR/env"
grep -q '^BOTMAX_PORT=' "$CONFIG_DIR/env" || printf 'BOTMAX_PORT=%s\n' "$BRIDGE_PORT" >> "$CONFIG_DIR/env"

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/botmax.service" <<EOF
[Unit]
Description=BotMAX — Telegram Bot API over MAX messenger (add your bot to MAX)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/env node "$INSTALL_DIR/bridge.js"
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$CONFIG_DIR/env
Environment=NODE_EXTRA_CA_CERTS=$INSTALL_DIR/certs/russian-trusted-root-ca.pem
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now botmax.service >/dev/null 2>&1 || warn "could not enable botmax.service — check: systemctl --user status botmax"

# ---- wait for readiness + validate token via the bridge ------------------
info "waiting for bridge to start (${BRIDGE_PORT})..."
READY=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${BRIDGE_PORT}/healthz" >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
[ "$READY" = "1" ] || die "bridge did not become ready. Check: journalctl --user -u botmax -n 50"
INFO=$(curl -fsS --max-time 5 -X POST "http://127.0.0.1:${BRIDGE_PORT}/botbotmax/getMe")
if printf '%s' "$INFO" | grep -q '"ok":[[:space:]]*true'; then
  USERNAME=$(printf '%s' "$INFO" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
  NAME=$(printf '%s' "$INFO" | sed -n 's/.*"first_name":"\([^"]*\)".*/\1/p')
  info "token valid — bot${USERNAME:+ @}${USERNAME:- unknown} (${NAME:-}) is online in MAX"
else
  systemctl --user stop botmax.service
  err "token rejected by MAX. Error: $(printf '%s' "$INFO" | head -c 300)"
  die "fix the token, then run the installer again"
fi

# ---- OpenClaw auto-config ----------------------------------------------
OPENCLAW_JSON="${OPENCLAW_JSON:-$HOME/.openclaw/openclaw.json}"
HAS_OPENCLAW=0
if [ -f "$OPENCLAW_JSON" ]; then HAS_OPENCLAW=1; fi
if [ "$HAS_OPENCLAW" = "1" ]; then
  info "OpenClaw config found at $OPENCLAW_JSON"
  PATCH_OUT=$(node "$INSTALL_DIR/scripts/openclaw-patch.js" "$OPENCLAW_JSON" \
    --apiRoot "http://127.0.0.1:${BRIDGE_PORT}" --botToken "9:botmax" $([ "$FORCE" = "1" ] && echo --force)) || true
  PATCH_EC=$?
  if [ "$PATCH_EC" = "0" ]; then
    printf '%s\n' "$PATCH_OUT"
    if systemctl --user list-unit-files | grep -q '^openclaw-gateway.service '; then
      info "restarting openclaw-gateway.service..."
      systemctl --user restart openclaw-gateway.service
    else
      info "no openclaw-gateway.service found — restart OpenClaw yourself to apply the config"
    fi
  elif [ "$PATCH_EC" = "2" ]; then
    warn "OpenClaw telegram channel already uses a different apiRoot."
    warn "Re-run with BOTMAX_FORCE=1 to point it at BotMAX."
  fi
else
  info "no ~/.openclaw/openclaw.json — skipping OpenClaw auto-config"
fi

# ---- summary ------------------------------------------------------------
info "──────────────────────────────────────────────"
info "BotMAX is running:  http://127.0.0.1:${BRIDGE_PORT}"
info "Health check:       curl -s http://127.0.0.1:${BRIDGE_PORT}/healthz"
info "Config:             $CONFIG_DIR/env (token), state: $BOTMAX_STATE"
info "Logs:               journalctl --user -u botmax -f"
if [ "$HAS_OPENCLAW" = "1" ] && [ "$PATCH_EC" = "0" ]; then
  info "OpenClaw:           configured + gateway restarted"
fi
info "──────────────────────────────────────────────"
info "Verify in the MAX app:"
info "  1. open your bot chat, send any message — the agent should answer"
info "  2. type /commands — expect a command list with inline buttons"
info "  3. tap a button — the message should get edited in place"
info "Need Hermes or manual setup? See README → 'Manual / Hermes'."