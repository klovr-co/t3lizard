#!/usr/bin/env bash
# t3lizard machine setup for github.com/klovr-co/aldrent.
# Runs on every new machine for this repo: as the sandbox user, in the checkout, after the clone
# and before the machine is handed out. Every step must be safe to run twice.
# Add a step:    t3lizard setup add github.com/klovr-co/aldrent -- <shell line>    (agents: pool_setup_add)
# Remove a step: t3lizard setup remove github.com/klovr-co/aldrent <step number>   (numbers: t3lizard setup show)
set -euo pipefail

# 2026-11-20: the bun install script needs unzip, which the claude image may lack (t3lizard seed)
command -v unzip >/dev/null || { sudo -n apt-get update -qq && sudo -n apt-get install -y -qq unzip; }

# 2026-11-20: aldrent needs bun; the claude image has none (official script, installs into ~/.bun) (t3lizard seed)
[ -x "$HOME/.bun/bin/bun" ] || curl -fsSL https://bun.sh/install | bash

# 2026-11-20: bun on PATH for T3 threads and later shells: ~/.local/bin is on t3 serve's PATH; the installer adds ~/.bun/bin to ~/.bashrc (t3lizard seed)
mkdir -p "$HOME/.local/bin" && ln -sf "$HOME/.bun/bin/bun" "$HOME/.local/bin/bun" && ln -sf "$HOME/.bun/bin/bun" "$HOME/.local/bin/bunx"
