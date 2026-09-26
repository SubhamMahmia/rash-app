#!/bin/bash
# RaSh installer for Mac - gets Homebrew, Node, Git, Ollama, the models, and the app itself
# all set up so you can just run start-rash.sh and go.

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

say_ok()   { echo -e "${GREEN}✅ $1${NC}"; }
say_wait() { echo -e "${YELLOW}⏳ $1${NC}"; }
say_err()  { echo -e "${RED}❌ $1${NC}"; }

echo ""
echo -e "${BOLD}🤖  Hey! I'm the RaSh installer.${NC}"
echo "    I'm going to set up your local, private memory assistant"
echo "    step by step. Nothing leaves your machine. Let's go! 🚀"
echo ""

# ---------- Homebrew ----------
if command -v brew >/dev/null 2>&1; then
  say_ok "Homebrew is already installed. Nice, one less thing to do."
else
  say_wait "Homebrew isn't installed yet — installing it now (this is the biggest one, hang tight)..."
  if /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; then
    if [[ -d "/opt/homebrew/bin" ]]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [[ -d "/usr/local/bin" ]]; then
      eval "$(/usr/local/bin/brew shellenv)"
    fi
    say_ok "Homebrew installed! You're a package manager now. 🍺"
  else
    say_err "Homebrew install failed. Fix that and re-run this script."
    exit 1
  fi
fi

# ---------- Node ----------
if command -v node >/dev/null 2>&1; then
  say_ok "Node.js is already here ($(node -v)). Moving on."
else
  say_wait "Installing Node.js via Homebrew..."
  brew install node
  say_ok "Node.js installed!"
fi

# ---------- Git ----------
if command -v git >/dev/null 2>&1; then
  say_ok "Git is already installed. Great."
else
  say_wait "Installing Git via Homebrew..."
  brew install git
  say_ok "Git installed!"
fi

# ---------- Ollama ----------
if command -v ollama >/dev/null 2>&1; then
  say_ok "Ollama is already installed."
else
  say_wait "Installing Ollama via Homebrew (this is what runs the local AI models)..."
  brew install ollama
  say_ok "Ollama installed!"
fi

say_wait "Starting the Ollama service in the background..."
(ollama serve >/dev/null 2>&1 &) || true
sleep 3
say_ok "Ollama service is up."

say_wait "Pulling llama3.1:8b — grab a chai, this takes a minute... ☕"
ollama pull llama3.1:8b
say_ok "llama3.1:8b is ready."

say_wait "Pulling llama3.2:3b too — almost there, one more chai sip... 🍵"
ollama pull llama3.2:3b
say_ok "llama3.2:3b is ready."

# ---------- Clone / update the app ----------
INSTALL_DIR="$HOME/rash-app"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  say_wait "RaSh is already cloned at $INSTALL_DIR — pulling the latest changes..."
  git -C "$INSTALL_DIR" pull
  say_ok "RaSh is up to date."
else
  say_wait "Cloning RaSh into $INSTALL_DIR..."
  git clone https://github.com/SubhamMahmia/rash-app.git "$INSTALL_DIR"
  say_ok "RaSh cloned!"
fi

# ---------- npm install ----------
say_wait "Installing RaSh's dependencies with npm (last big step, promise)..."
(cd "$INSTALL_DIR" && npm install)
say_ok "Dependencies installed."

# ---------- start-rash.sh ----------
say_wait "Writing start-rash.sh so you can boot RaSh with one command from now on..."
cat > "$INSTALL_DIR/start-rash.sh" << 'EOF'
#!/bin/bash
# Keeps Ollama models warm for 30 minutes between requests, then starts the RaSh server.
export OLLAMA_KEEP_ALIVE=30m
node server.js
EOF
chmod +x "$INSTALL_DIR/start-rash.sh"
say_ok "start-rash.sh is ready."

# ---------- Done! ----------
echo ""
echo -e "${GREEN}${BOLD}🎉  You're all set — RaSh is installed and ready to roll!${NC}"
echo ""
echo -e "${BOLD}Here's how to fire it up:${NC}"
echo -e "  ${YELLOW}1.${NC} Run:  cd ~/rash-app && ./start-rash.sh"
echo -e "  ${YELLOW}2.${NC} In Chrome, go to chrome://extensions, enable Developer Mode,"
echo "     and click 'Load unpacked' → select the ~/rash-app/extension folder"
echo -e "  ${YELLOW}3.${NC} Open ${BOLD}http://localhost:3000${NC} in your browser to see the RaSh dashboard"
echo ""
echo -e "${GREEN}Welcome to your own private, local memory assistant. Have fun! 🧠✨${NC}"
echo ""
