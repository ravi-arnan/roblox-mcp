#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEV_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"

prepend_path_if_exists() {
	local dir="$1"
	if [[ -d "${dir}" ]]; then
		PATH="${dir}:${PATH}"
	fi
}

# Codex App, VS Code, CLI, and phone-controlled sessions can launch this
# wrapper with different startup environments. Bootstrap the WSL user
# toolchain here so the MCP does not depend on the host process PATH.
prepend_path_if_exists "${HOME}/.local/bin"
prepend_path_if_exists "${HOME}/.cargo/bin"
prepend_path_if_exists "${HOME}/.bun/bin"
prepend_path_if_exists "${HOME}/.rokit/bin"

# Some Codex App launches inherit Windows temp paths mounted under /mnt/c.
# tsx creates a Unix socket in the temp dir, which requires a native WSL path.
export TMPDIR="${ROBLOXSTUDIO_MCP_TMPDIR:-/tmp}"
export TMP="${TMPDIR}"
export TEMP="${TMPDIR}"
mkdir -p "${TMPDIR}"

export NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"
if [[ -s "${NVM_DIR}/nvm.sh" ]]; then
	# shellcheck source=/dev/null
	. "${NVM_DIR}/nvm.sh"
	nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || true
fi

export PATH

if [[ "${ROBLOXSTUDIO_MCP_USE_PUBLISHED:-}" == "1" ]]; then
	exec npx -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin
fi

cd "${DEV_ROOT}"
npm run build -w packages/core >&2
npm run build:plugin >&2
exec ./node_modules/.bin/tsx packages/robloxstudio-mcp/src/index.ts --auto-install-plugin
