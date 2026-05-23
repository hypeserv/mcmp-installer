#!/bin/bash
# CF Modpack Installation Script (hypeServ panel)
#
# Server Files: /mnt/server
# Required env vars:
#   DL_PATH         direct download URL to the modpack serverpack zip
#   HS_MOD_API_KEY  hypeServ manifest mod API key (optional, only for Curse manifest packs)

set -e

echo "    __  __                _____                ";
echo "   / / / /_  ______  ___ / ___/___  ______   __";
echo "  / /_/ / / / / __ \\/ _ \\\\__ \\/ _ \\/ ___/ | / /";
echo " / __  / /_/ / /_/ /  __/__/ /  __/ /   | |/ / ";
echo "/_/ /_/\\__, / .___/\\___/____/\\___/_/    |___/  ";
echo "      /____/_/                                 ";
echo "Modpack Installer v0.9.0 (Node/TypeScript)";

# --- System deps ----------------------------------------------------------
apt update
apt install -y curl jq unzip wget rsync ca-certificates gnupg

# Install Node.js 20 LTS if not already present (or if too old)
NEEDS_NODE=1
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
  if [ "${NODE_MAJOR:-0}" -ge 18 ]; then
    NEEDS_NODE=0
  fi
fi

if [ "$NEEDS_NODE" -eq 1 ]; then
  echo -e "Installing Node.js LTS..."
#  mkdir -p /etc/apt/keyrings
#  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
#    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
#  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
#    > /etc/apt/sources.list.d/nodesource.list
  apt update
  apt install -y nodejs npm
fi

node --version
npm --version

# Java is needed for Forge/NeoForge/Fabric server installers
if ! command -v java >/dev/null 2>&1; then
  echo -e "Installing default JRE (needed by Forge/NeoForge/Fabric installers)..."
  apt install -y default-jre-headless || apt install -y openjdk-21-jre-headless || true
fi

# --- Working dir ----------------------------------------------------------
if [[ ! -d /mnt/server ]]; then
  mkdir -p /mnt/server
fi
cd /mnt/server

echo -e "Checking Modpack with URL $DL_PATH"

if [[ -z "${DL_PATH}" ]]; then
  echo -e "no download link provided. Exiting now"
  exit 3
fi

if curl --output /dev/null --globoff --silent --head --fail "$DL_PATH"; then
  echo -e "Modpack download link is valid."
else
  echo -e "link is invalid. Exiting now"
  exit 2
fi

# --- Wipe existing server files (preserve world + player data) -----------
echo -e "Cleaning server files. Worlds and player data are preserved."

shopt -s dotglob nullglob
for entry in *; do
  case "$entry" in
    # vanilla + common world dirs
    world|world_nether|world_the_end)
      echo "  preserving $entry"
      ;;
    # multiworld plugins, modded dimensions, custom world names
    world_*|*_world|DIM*|dim_*|dimensions)
      echo "  preserving $entry"
      ;;
    # player + server state we don't want to lose
    playerdata|stats|advancements|logs|crash-reports|backups)
      echo "  preserving $entry"
      ;;
    whitelist.json|ops.json|banned-players.json|banned-ips.json|usercache.json)
      echo "  preserving $entry"
      ;;
    server.properties|server-icon.png|eula.txt)
      echo "  preserving $entry"
      ;;
    *)
      rm -rf -- "$entry"
      ;;
  esac
done
shopt -u dotglob nullglob

echo -e "Server files cleaned."

# --- Fetch + build installer ---------------------------------------------
echo -e "Downloading & Installing Modpack"

INSTALLER_DIR="/tmp/mcmp-installer-master"
rm -rf "$INSTALLER_DIR"

wget -q https://github.com/hypeserv/mcmp-installer/archive/refs/heads/master.zip -O /tmp/installer.zip
unzip -q /tmp/installer.zip -d /tmp
rm -f /tmp/installer.zip
cd "$INSTALLER_DIR"

echo -e "Installing npm dependencies..."
npm ci --omit=dev --no-audit --no-fund --silent || npm install --omit=dev --no-audit --no-fund --silent

echo -e "Building TypeScript sources..."
# build needs devDependencies (typescript); install them temporarily then build
npm install --no-audit --no-fund --silent
npm run build --silent

# --- Run installer --------------------------------------------------------
node dist/cli.js \
  --wget-mode \
  --modpack-id "${DL_PATH}" \
  --wings \
  --clean-scripts \
  --working-path /mnt/server \
  --manifest-api-key "${HS_MOD_API_KEY}"

echo -e "Modpack installed successfully, cleaning up installer files..."

cd /mnt/server
rm -rf "$INSTALLER_DIR"

echo -e "Cleanup complete"

# --- Defaults: server.properties + icon ----------------------------------
if [ ! -f server.properties ]; then
    echo -e "Downloading MC server.properties"
    curl -fsSL -o server.properties https://raw.githubusercontent.com/onesrvnet/pterodactyl-optimized-purpur-egg/main/server.properties
fi

if [ ! -f server-icon.png ]; then
    echo -e "Downloading server icon"
    curl -fsSL -o server-icon.png https://raw.githubusercontent.com/onesrvnet/pterodactyl-optimized-purpur-egg/main/server-icon.png
fi

echo -e "--- Modpack installation process completed ---"

echo "    __  __                _____                ";
echo "   / / / /_  ______  ___ / ___/___  ______   __";
echo "  / /_/ / / / / __ \\/ _ \\\\__ \\/ _ \\/ ___/ | / /";
echo " / __  / /_/ / /_/ /  __/__/ /  __/ /   | |/ / ";
echo "/_/ /_/\\__, / .___/\\___/____/\\___/_/    |___/  ";
echo "      /____/_/                                 ";
