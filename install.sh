#!/bin/bash
# RaSh installer for macOS
#
#   curl -fsSL https://raw.githubusercontent.com/SubhamMahmia/rash-app/main/install.sh | bash
#
# or, from inside a copy you already cloned:   bash install.sh
#
# What it does. Every step is skipped when it's already done, so running it again is safe:
#   1. Homebrew, then Git, Node.js (22 or newer) and Ollama through Homebrew
#   2. RaSh itself: cloned into ~/rash-app, unless this is run from inside a copy
#   3. RaSh's npm packages, and the English text-recognition data for reading text in pictures
#   4. The local AI models RaSh uses (the one big download)
#   5. Shows how to add the Chrome extension, then starts RaSh in this window
#
# Optional settings, put in front of the command (e.g. RASH_DIR=~/Apps/rash bash install.sh):
#   RASH_DIR       where to put RaSh (default ~/rash-app)
#   RASH_BRANCH    which branch to install (default main)
#   RASH_NO_START  set to 1 to set everything up without starting RaSh at the end
#
# The whole script is one function, called on the very last line: if the download is cut off halfway,
# nothing runs. Anything that needs your input (Homebrew asks for your Mac password) reads from the
# keyboard, never from the script being piped in.

set -uo pipefail

RASH_REPO_URL="${RASH_REPO_URL:-https://github.com/SubhamMahmia/rash-app.git}"
RASH_BRANCH="${RASH_BRANCH:-main}"
RASH_DIR="${RASH_DIR:-$HOME/rash-app}"
RASH_PORT=3000                       # the Chrome extension looks for RaSh on this port
OLLAMA_URL="http://127.0.0.1:11434"
NODE_MIN_MAJOR=22                    # better-sqlite3 13 needs Node.js 22 or newer
HOMEBREW_INSTALLER="https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"
# tesseract.js's English data (LSTM, "best_int"); the server reads it from ./tessdata and never downloads it
OCR_URL="https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz"
OCR_SHA256="5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747"

ARCH=""
APP_DIR=""
BREW=""
NOTES=""                             # things to mention again at the end

if [ -t 1 ]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
  BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi

step() { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$RESET"; }
ok()   { printf '%s  OK%s  %s\n' "$GREEN" "$RESET" "$1"; }
say()  { printf '      %s\n' "$1"; }
warn() {
  printf '%s  !!%s  %s\n' "$YELLOW" "$RESET" "$1"
  NOTES="${NOTES}  - $1"$'\n'
}
# stop <what went wrong> [next step]...   prints a clear message and what to do, then exits
stop() {
  printf '\n%sRaSh setup stopped: %s%s\n' "$RED" "$1" "$RESET"
  shift
  local line
  for line in "$@"; do printf '  %s\n' "$line"; done
  printf '\nWhen that is sorted, run the same install command again. It picks up where it left off.\n'
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }
# Can we ask the person at the keyboard something? (No when there is no terminal at all.)
can_prompt() { ( : </dev/tty ) 2>/dev/null; }
sha256_of() {
  if have shasum; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi
}

# ---------------------------------------------------------------------------------------------------
check_mac() {
  [ "$(uname -s)" = "Darwin" ] || stop "this installer is for macOS only."
  [ "$(id -u)" -ne 0 ] || stop "please don't run this with sudo." "Run the same command again without 'sudo'. Homebrew refuses to install as root."
  ARCH="$(uname -m)"
  local chip="Intel"
  [ "$ARCH" = "arm64" ] && chip="Apple Silicon"
  ok "macOS $(sw_vers -productVersion 2>/dev/null || echo '') on $chip"

  # The AI models take about 9 GB on Apple Silicon (4 GB on Intel), plus about 1 GB for everything else
  local need_gb=10
  [ "$ARCH" = "arm64" ] || need_gb=6
  local free_kb
  free_kb="$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')"
  case "$free_kb" in
    ''|*[!0-9]*) ;;
    *) if [ "$free_kb" -lt $((need_gb * 1024 * 1024)) ]; then
         warn "Only $((free_kb / 1024 / 1024)) GB of disk space is free; RaSh needs about $need_gb GB. Some downloads may fail."
       fi ;;
  esac
}

# Puts Homebrew on PATH for the rest of this script, wherever it is installed
load_brew() {
  local b
  for b in "$(command -v brew 2>/dev/null)" /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -n "$b" ] && [ -x "$b" ]; then
      eval "$("$b" shellenv)"
      BREW="$b"
      return 0
    fi
  done
  return 1
}

# So brew, node and ollama also work in new Terminal windows
remember_brew() {
  local profile="$HOME/.zprofile"
  case "${SHELL:-}" in */bash) profile="$HOME/.bash_profile" ;; esac
  if ! grep -qsF "$BREW shellenv" "$profile"; then
    printf '\n# Homebrew (added by the RaSh installer)\neval "$(%s shellenv)"\n' "$BREW" >> "$profile"
    ok "Added Homebrew to $profile, so new Terminal windows can find it"
  fi
}

brew_install() { # brew_install <formula> <friendly name>
  say "Installing $2..."
  brew install "$1" || stop "$2 didn't install." "Try running:  brew install $1" "If that shows an error, run 'brew doctor' and follow what it says."
  ok "$2 installed"
}

setup_homebrew() {
  step "Homebrew (installs the other tools)"
  if load_brew; then
    ok "Homebrew is installed"
  else
    say "Homebrew isn't installed yet, so I'm installing it now."
    say "It will ask for your Mac password (nothing shows while you type, that's normal)"
    say "and ask you to press RETURN. It can take a few minutes."
    can_prompt || stop "Homebrew needs to ask for your password, but this window can't take input." \
      "Open the Terminal app and paste the install command there."
    local installer
    installer="$(curl -fsSL "$HOMEBREW_INSTALLER")" || stop "couldn't download Homebrew's installer." "Check your internet connection."
    if ! /bin/bash -c "$installer" </dev/tty; then
      stop "Homebrew didn't finish installing." \
        "- Check your internet connection." \
        "- Homebrew needs an administrator account on this Mac." \
        "- If a window asked to install the Command Line Tools, let that finish first." \
        "- Or install Homebrew yourself from https://brew.sh"
    fi
    load_brew || stop "Homebrew installed, but I can't find it." "Close this window, open a new Terminal window, and run the install command again."
    ok "Homebrew installed"
  fi
  remember_brew
}

setup_git() {
  step "Git (downloads RaSh)"
  # Without Apple's Command Line Tools, /usr/bin/git is only a stub that opens an install dialog
  if [ -x "$(brew --prefix)/bin/git" ] || xcode-select -p >/dev/null 2>&1; then
    ok "Git is available"
  else
    brew_install git "Git"
  fi
}

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

setup_node() {
  step "Node.js (runs RaSh)"
  local major
  major="$(node_major)"
  if [ "$major" -ge "$NODE_MIN_MAJOR" ]; then
    ok "Node.js $(node -v)"
    return
  fi
  [ "$major" -gt 0 ] && say "Node.js $(node -v) is too old for RaSh (it needs $NODE_MIN_MAJOR or newer)."
  if brew list --formula node >/dev/null 2>&1; then
    say "Updating Homebrew's Node.js..."
    brew upgrade node || true
  else
    brew_install node "Node.js"
  fi
  export PATH="$(brew --prefix)/bin:$PATH"   # Homebrew's Node.js first, for the rest of this script
  hash -r
  major="$(node_major)"
  [ "$major" -ge "$NODE_MIN_MAJOR" ] || stop "Node.js is still older than $NODE_MIN_MAJOR ($(node -v 2>/dev/null))." \
    "Another Node.js (from nvm or a download) is probably in the way." \
    "Run:  brew install node   then open a new Terminal window and run the install command again."
  ok "Node.js $(node -v)"
}

ollama_up() { curl -fsS -m 2 "$OLLAMA_URL/api/version" >/dev/null 2>&1; }
wait_for_ollama() {
  local i
  for i in $(seq 1 "$1"); do
    ollama_up && return 0
    sleep 1
  done
  return 1
}

setup_ollama() {
  step "Ollama (runs the AI models on this Mac)"
  if ! have ollama; then
    if [ -x /Applications/Ollama.app/Contents/Resources/ollama ]; then
      export PATH="/Applications/Ollama.app/Contents/Resources:$PATH"
      ok "Found the Ollama app"
    else
      brew_install ollama "Ollama"
    fi
  fi
  if ! ollama_up; then
    say "Starting Ollama..."
    if brew list --formula ollama >/dev/null 2>&1; then
      brew services start ollama >/dev/null 2>&1   # also starts it by itself when you log in
    elif [ -d /Applications/Ollama.app ]; then
      open -a Ollama
    fi
    if ! wait_for_ollama 30; then
      nohup ollama serve >"${TMPDIR:-/tmp}/ollama-rash.log" 2>&1 &
      wait_for_ollama 20
    fi
  fi
  ollama_up || stop "Ollama is installed but isn't answering." \
    "Try:  brew services restart ollama   (or open the Ollama app), then run the install command again."
  ok "Ollama is running"
}

is_rash_dir() { [ -f "$1/server.js" ] && [ -f "$1/package.json" ] && [ -f "$1/extension/manifest.json" ]; }

get_app() {
  step "RaSh"
  # Run from inside a copy (bash install.sh)? Then use that copy as it is.
  local here=""
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  fi
  if [ -n "$here" ] && is_rash_dir "$here"; then APP_DIR="$here"; ok "Using the copy in $APP_DIR"; return; fi
  if is_rash_dir "$PWD"; then APP_DIR="$PWD"; ok "Using the copy in $APP_DIR"; return; fi

  APP_DIR="$RASH_DIR"
  if [ -d "$APP_DIR/.git" ] && is_rash_dir "$APP_DIR"; then
    say "RaSh is already in $APP_DIR. Getting the latest version..."
    # node_modules is committed in the repo, but npm ci (below) rebuilds it for this Mac, which git sees as
    # local changes that would block the update. Put the committed copy back first; npm ci rebuilds it again.
    if [ -n "$(git -C "$APP_DIR" ls-files node_modules 2>/dev/null | head -n 1)" ]; then
      rm -rf "$APP_DIR/node_modules"
      git -C "$APP_DIR" checkout -- node_modules >/dev/null 2>&1
    fi
    if git -C "$APP_DIR" pull --ff-only; then
      ok "Up to date"
    else
      warn "Couldn't update $APP_DIR (it may have local changes), so the version that's there is used."
    fi
  elif [ -e "$APP_DIR" ]; then
    stop "$APP_DIR already exists, and it isn't a RaSh folder." \
      "Move or rename it, or pick another folder by running:  RASH_DIR=~/some-other-folder bash install.sh"
  else
    say "Downloading RaSh into $APP_DIR..."
    git clone --branch "$RASH_BRANCH" "$RASH_REPO_URL" "$APP_DIR" || stop "RaSh didn't download from GitHub." "Check your internet connection."
    ok "Downloaded"
  fi
}

install_packages() {
  step "RaSh's packages"
  if [ -f "$APP_DIR/package-lock.json" ]; then
    (cd "$APP_DIR" && npm ci --no-audit --no-fund)
  else
    (cd "$APP_DIR" && npm install --no-audit --no-fund)
  fi || stop "npm couldn't install RaSh's packages." "Check your internet connection." \
    "If it fails the same way again, send the error above to whoever shared RaSh with you."
  (cd "$APP_DIR" && node -e "require('better-sqlite3'); require('sqlite-vec')") >/dev/null 2>&1 || stop "RaSh's database module doesn't load on this Mac." \
    "Run:  xcode-select --install   wait for it to finish, then:  cd \"$APP_DIR\" && npm rebuild"
  ok "Packages installed"
}

get_ocr_data() {
  step "Text recognition (reads text in pictures you attach)"
  local file="$APP_DIR/tessdata/eng.traineddata"
  if [ -f "$file" ] && [ "$(sha256_of "$file")" = "$OCR_SHA256" ]; then
    ok "Already in place"
    return
  fi
  mkdir -p "$APP_DIR/tessdata"
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/rash-ocr.XXXXXX")"
  if curl -fsSL --retry 2 "$OCR_URL" -o "$tmp.gz" && gunzip -c "$tmp.gz" > "$tmp" && [ "$(sha256_of "$tmp")" = "$OCR_SHA256" ]; then
    mv "$tmp" "$file"
    ok "Downloaded and checked"
  else
    warn "Couldn't download the text recognition data. RaSh works without it, but can't read text in pictures until you run the installer again."
  fi
  rm -f "$tmp" "$tmp.gz"
}

has_model() {
  ollama list 2>/dev/null | awk 'NR > 1 {print $1}' | grep -qx -e "$1" -e "$1:latest"
}

pull_models() {
  step "AI models (a one-time download)"
  # RaSh's server picks llama3.1:8b on Apple Silicon and llama3.2:3b elsewhere (server.js); llama3.2:3b also
  # writes the answers, nomic-embed-text powers search, and moondream describes pictures you attach.
  local models="nomic-embed-text llama3.2:3b"
  [ "$ARCH" = "arm64" ] && models="$models llama3.1:8b"
  models="$models moondream"
  local m size
  for m in $models; do
    case "$m" in
      nomic-embed-text) size="0.3 GB" ;; llama3.2:3b) size="2 GB" ;; llama3.1:8b) size="4.9 GB" ;; moondream) size="1.7 GB" ;; *) size="" ;;
    esac
    if has_model "$m"; then ok "$m (already downloaded)"; continue; fi
    say "Downloading $m ($size)..."
    if ollama pull "$m" || ollama pull "$m"; then
      ok "$m"
    else
      warn "$m didn't download. RaSh needs it; when your connection is back, run:  ollama pull $m"
    fi
  done
  if [ "$ARCH" = "arm64" ]; then
    local mem_gb
    mem_gb=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1024 / 1024 / 1024 ))
    if [ "$mem_gb" -gt 0 ] && [ "$mem_gb" -lt 16 ]; then
      say "This Mac has $mem_gb GB of memory. If RaSh feels slow, start it with the smaller model:"
      say "  RASH_MODEL=llama3.2:3b node server.js"
    fi
  fi
}

rash_running() { curl -fsS -m 2 "http://127.0.0.1:$RASH_PORT/api/index/status" 2>/dev/null | grep -q '"backend"'; }

finish() {
  local ext="$APP_DIR/extension"
  if [ -n "$NOTES" ]; then
    step "Finished, with a few things to know"
    printf '%s' "$NOTES"
  fi

  step "Last step: add RaSh to Chrome"
  local copied=""
  if printf '%s' "$ext" | pbcopy 2>/dev/null; then copied=" (it's already copied, just paste)"; fi
  say "1. Open Google Chrome and go to:  chrome://extensions"
  say "2. Turn on \"Developer mode\" (the switch in the top-right corner)."
  say "3. Click \"Load unpacked\"."
  say "4. Choose this folder:  $ext"
  say "   Tip: in the folder window press Cmd+Shift+G and paste the path$copied."
  say "5. Click the puzzle-piece icon in Chrome's toolbar and pin \"RaSh Ambient Capture\"."
  say "6. Open any web page: RaSh's tab sits on the right edge. RaSh starts OFF;"
  say "   switch it ON in its panel when you want pages to be saved."
  say ""
  say "Your RaSh dashboard:  http://localhost:$RASH_PORT  (while RaSh is running)"
  say "If RaSh's panel ever says \"Blocked\", copy the extension's ID from chrome://extensions"
  say "and start RaSh with:  RASH_EXTENSION_IDS=<that id> node server.js"

  local start_cmd="cd \"$APP_DIR\" && node server.js"
  if [ "${RASH_NO_START:-}" = "1" ]; then
    step "All set"
    say "Start RaSh with:  $start_cmd"
    return 0
  fi

  if rash_running; then
    step "RaSh is already running"
    say "It's running in another window. To restart it, press Ctrl+C there, then run:  $start_cmd"
    return 0
  fi
  local pid name
  pid="$(lsof -nP -iTCP:"$RASH_PORT" -sTCP:LISTEN -t 2>/dev/null | head -n 1)"
  if [ -n "$pid" ]; then
    name="$(ps -p "$pid" -o comm= 2>/dev/null)"
    printf '\n%sRaSh is installed, but port %s is busy.%s\n' "$YELLOW" "$RASH_PORT" "$RESET"
    say "Another program (${name:-unknown}, process $pid) is using port $RASH_PORT, and the Chrome extension"
    say "only looks for RaSh there. Quit that program (or run:  kill $pid), then start RaSh with:"
    say "  $start_cmd"
    exit 1
  fi

  step "Starting RaSh"
  say "Keep this window open while you use RaSh. To stop it, press Ctrl+C."
  say "To start it again later, open Terminal and run:  $start_cmd"
  say "macOS may ask whether Terminal can open your Documents, Desktop and Downloads folders."
  say "Allow it so RaSh can find your files by name (it reads file names, not their contents)."
  say ""
  cd "$APP_DIR" && exec node server.js
}

main() {
  printf '%sRaSh installer for macOS%s\n' "$BOLD" "$RESET"
  say "Sets up RaSh, your private memory assistant. Everything runs on this Mac."
  check_mac
  setup_homebrew
  setup_git
  setup_node
  setup_ollama
  get_app
  install_packages
  get_ocr_data
  pull_models
  finish
}

main "$@"
