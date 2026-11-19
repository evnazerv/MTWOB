#!/bin/bash
# NodeTelehealth Marketing — one-step Mac installer.
# Builds the app for this Mac (Apple Silicon or Intel), installs it in Applications,
# adds a Desktop icon (and optionally a Dock icon), then opens it.
# Run it again any time to install an updated version; your settings are kept.
set -euo pipefail

APP_NAME="NodeTelehealth Marketing"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() {
  printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2
  read -r -p "Press Enter to close this window…" _ || true
  exit 1
}
trap 'fail "The installer stopped at line $LINENO. Scroll up for the reason."' ERR

[ "$(uname)" = "Darwin" ] || fail "This installer runs on macOS only."

# A Terminal window opened by double-clicking may not have Node's folders on its PATH yet.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
command -v npm >/dev/null 2>&1 || fail "Node.js is not installed. Install it from https://nodejs.org, then run this installer again."

cd "$APP_DIR"
echo "Installing $APP_NAME from: $APP_DIR"

step "1/5  Installing dependencies (the first run takes a few minutes)…"
npm install --no-audit --no-fund

if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then ARCH=arm64; else ARCH=x64; fi
step "2/5  Building the app for this Mac ($ARCH)…"
rm -rf ./dist
CSC_IDENTITY_AUTO_DISCOVERY=false npx --no-install electron-builder --mac dir "--$ARCH"
BUILT="$(find ./dist -maxdepth 2 -type d -name "$APP_NAME.app" | head -n 1)"
[ -n "$BUILT" ] || fail "The build finished but the app was not found in dist/."

step "3/5  Installing into Applications…"
# Close running copies (the installed app, or a development copy started with "npm start").
if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
  osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
  sleep 2
fi
pkill -f "mac-desktop-app/node_modules/electron/dist" >/dev/null 2>&1 || true

DEST_DIR="/Applications"
if [ ! -w "$DEST_DIR" ]; then DEST_DIR="$HOME/Applications"; mkdir -p "$DEST_DIR"; fi
DEST="$DEST_DIR/$APP_NAME.app"
rm -rf "$DEST"
ditto "$BUILT" "$DEST"
xattr -cr "$DEST"
# Ad-hoc signature so macOS lets a locally built (unsigned) app run, including on Apple Silicon.
codesign --force --deep --sign - "$DEST" >/dev/null 2>&1 || echo "  (could not ad-hoc sign; the app may need right-click → Open the first time)"
echo "  Installed: $DEST"

step "4/5  Adding the Desktop icon…"
LINK="$HOME/Desktop/$APP_NAME.app"
if [ -L "$LINK" ] || [ ! -e "$LINK" ]; then
  ln -sfn "$DEST" "$LINK"
  mkdir -p "$HOME/Library/Application Support/$APP_NAME"
  date > "$HOME/Library/Application Support/$APP_NAME/desktop-shortcut.done"
  echo "  Desktop icon: $APP_NAME"
else
  echo "  Skipped: something named \"$APP_NAME\" is already on your Desktop."
fi

ADD_DOCK="n"
read -r -p "Also add it to the Dock? [y/N] " ADD_DOCK || ADD_DOCK="n"
if [[ "$ADD_DOCK" =~ ^[Yy] ]]; then
  if defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "NodeTelehealth"; then
    echo "  Already in the Dock."
  else
    defaults write com.apple.dock persistent-apps -array-add \
      "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>$DEST</string><key>_CFURLStringType</key><integer>0</integer></dict></dict></dict>"
    killall Dock
    echo "  Added to the Dock."
  fi
fi

step "5/5  Opening $APP_NAME…"
open "$DEST"

printf '\n\033[32mDone.\033[0m Open the app any time from the Desktop icon, Launchpad, or Spotlight (⌘Space, type "NodeTelehealth").\n'
printf 'If macOS asks to allow access to "Safe Storage" in your keychain, choose Always Allow — that is where the handshake token is kept.\n\n'
read -r -p "Press Enter to close this window…" _ || true
