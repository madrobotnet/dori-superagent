#!/usr/bin/env bash
# Installs the dori-mode skill and the `dori` CLI.
# Usage: curl -fsSL https://raw.githubusercontent.com/sisyphuslabs/dori-superagent/main/install.sh | bash
# Needs: git, bun 1.3+. Optional env: DORI_SRC (clone dir), SKILLS_DIR (where your agent loads skills),
# DORI_NO_PULL=1 (or true, yes: install an existing checkout as it is, without pulling).
set -euo pipefail

repo="https://github.com/sisyphuslabs/dori-superagent.git"
src="${DORI_SRC:-$HOME/.dori/src}"
skills="${SKILLS_DIR:-$HOME/.agents/skills}"

command -v bun >/dev/null || { echo "bun is required: https://bun.sh" >&2; exit 1; }
command -v git >/dev/null || { echo "git is required" >&2; exit 1; }

if [ ! -d "$src/.git" ]; then
  git clone --quiet --depth 1 "$repo" "$src"
elif [[ "${DORI_NO_PULL:-}" =~ ^(1|true|yes)$ ]]; then
  echo "DORI_NO_PULL=$DORI_NO_PULL: installing $src as it is, without pulling" >&2
elif ! git -C "$src" fetch --quiet; then
  echo "Could not fetch updates for $src; git's message above says why." >&2
  exit 1
elif ! git -C "$src" merge --ff-only --quiet '@{u}'; then
  # Only local work (edits, or commits upstream lacks) is ours to explain; anything else is git's message above.
  if git -C "$src" rev-parse --verify --quiet '@{u}' >/dev/null &&
    [ -n "$(git -C "$src" status --porcelain)$(git -C "$src" rev-list '@{u}..HEAD')" ]; then
    echo "Could not update $src. Local work in that checkout:" >&2
    git -C "$src" status --short --branch >&2
    git -C "$src" log --oneline '@{u}..HEAD' >&2
    echo "To keep it and install the checkout as it is, run install.sh again with DORI_NO_PULL=1." >&2
    echo "To drop it and update: git -C \"$src\" reset --hard '@{u}', then run install.sh again." >&2
  else
    echo "Could not update $src; git's message above says why." >&2
  fi
  exit 1
fi

mkdir -p "$skills"
if [ -e "$skills/dori-mode" ] && [ ! -L "$skills/dori-mode" ]; then
  echo "$skills/dori-mode exists and is not a link; leaving it alone" >&2
else
  ln -sfn "$src/skills/dori-mode" "$skills/dori-mode"
fi

(cd "$src/skills/dori-mode/scripts" && bun install --silent && bun link --silent)

mkdir -p "$HOME/.dori"
[ -f "$HOME/.dori/config.json" ] || cp "$src/skills/dori-mode/references/config.example.json" "$HOME/.dori/config.json"

echo "Installed. Skill: $skills/dori-mode  CLI: dori  Config: ~/.dori/config.json"
echo "Next: edit ~/.dori/config.json, then tell your agent: Dori mode"
