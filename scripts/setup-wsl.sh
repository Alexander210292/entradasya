#!/usr/bin/env bash
set -euo pipefail

# El arranque de la aplicación se mantiene en TypeScript. Este instalador prepara
# Node.js y las herramientas que requiere un Ubuntu recién instalado.
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
if [[ "$(uname -s)" != "Linux" ]] || ! command -v apt-get >/dev/null; then
  echo "Ejecuta este instalador dentro de Ubuntu en WSL2." >&2
  exit 1
fi
if [[ "$EUID" -eq 0 ]]; then
  echo "Ejecuta bash scripts/setup-wsl.sh como tu usuario de Ubuntu. El instalador pedirá sudo." >&2
  exit 1
fi
case "$project_dir" in
  /mnt/*) echo "Clona el proyecto dentro de tu carpeta personal de Ubuntu, por ejemplo ~/proyectos/entradas-ya." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64) archive_arch="x64"; mailpit_arch="amd64" ;;
  aarch64|arm64) archive_arch="arm64"; mailpit_arch="arm64" ;;
  *) echo "Arquitectura no soportada por este instalador." >&2; exit 1 ;;
esac

echo "Preparando PostgreSQL, Nginx y utilidades de Ubuntu…"
sudo apt-get update
sudo apt-get install -y ca-certificates curl git xz-utils util-linux postgresql postgresql-client libpq-dev nginx

node_version="$(tr -d '[:space:]' < .nvmrc)"
[[ "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo ".nvmrc inválido" >&2; exit 1; }
node_dir="$HOME/.local/share/entradasya/node-v$node_version"
download_dir="$(mktemp -d)"
trap 'rm -rf -- "$download_dir"' EXIT
node_archive="node-v$node_version-linux-$archive_arch.tar.xz"
if [[ ! -x "$node_dir/bin/node" ]]; then
  echo "Descargando Node.js $node_version desde nodejs.org…"
  node_url="https://nodejs.org/dist/v$node_version"
  curl --fail --location --retry 2 "$node_url/$node_archive" -o "$download_dir/$node_archive"
  curl --fail --location --retry 2 "$node_url/SHASUMS256.txt" -o "$download_dir/SHASUMS256.txt"
  (cd "$download_dir" && awk -v file="$node_archive" '$2 == file { print }' SHASUMS256.txt | sha256sum --check --strict -)
  mkdir -p "$HOME/.local/share/entradasya"
  tar -xJf "$download_dir/$node_archive" -C "$download_dir"
  mv "$download_dir/node-v$node_version-linux-$archive_arch" "$node_dir"
fi
export PATH="$node_dir/bin:$PATH"

path_line='export PATH="$HOME/.local/share/entradasya/node-v'"$node_version"'/bin:$PATH"'
for profile in "$HOME/.profile" "$HOME/.bashrc"; do
  touch "$profile"
  if ! grep -Fqx "$path_line" "$profile"; then
    printf '\n%s\n' "$path_line" >> "$profile"
  fi
done

mailpit_version="1.33.1"
mkdir -p .local/bin
if [[ ! -x .local/bin/mailpit ]]; then
  echo "Descargando Mailpit desde su repositorio oficial…"
  asset_name="mailpit-linux-$mailpit_arch.tar.gz"
  curl --fail --location --retry 2 "https://api.github.com/repos/axllent/mailpit/releases/tags/v$mailpit_version" -o "$download_dir/release.json"
  curl --fail --location --retry 2 "https://github.com/axllent/mailpit/releases/download/v$mailpit_version/$asset_name" -o "$download_dir/$asset_name"
  node --input-type=module - "$download_dir" "$asset_name" <<'JS'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const [directory, name] = process.argv.slice(2);
const release = JSON.parse(readFileSync(join(directory, 'release.json'), 'utf8'));
const asset = release.assets.find((entry) => entry.name === name);
assert(asset?.digest?.startsWith('sha256:'), 'La publicación de Mailpit debe incluir SHA-256.');
const digest = 'sha256:' + createHash('sha256').update(readFileSync(join(directory, name))).digest('hex');
assert.equal(digest, asset.digest, 'El archivo descargado de Mailpit no coincide con su SHA-256.');
JS
  tar -xzf "$download_dir/$asset_name" -C .local/bin mailpit
fi

echo "Instalando dependencias y arrancando EntradasYa…"
npm ci
npm run start:local
npm run seed:events
echo
echo "Preparación terminada. Abre la URL de EntradasYa mostrada arriba en tu navegador de Windows."
echo "Para trabajar otro día, abre Ubuntu en esta carpeta y usa npm run start:local."
echo "Para detenerlo usa npm run stop:local."
