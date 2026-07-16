#!/bin/sh
set -eu

repo_root="$(git rev-parse --show-toplevel)"
hook_dir="$repo_root/.git/hooks"
hook_source="$repo_root/cartorio/scripts/missao-pre-commit.sh"
if [ ! -f "$hook_source" ]; then
  hook_source="$repo_root/scripts/missao-pre-commit.sh"
fi
mkdir -p "$hook_dir"
cp "$hook_source" "$hook_dir/pre-commit"
chmod 0755 "$hook_dir/pre-commit"
printf '%s\n' "installed: $hook_dir/pre-commit"
