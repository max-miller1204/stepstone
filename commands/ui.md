---
description: "Open the interactive goal board for a human at the keyboard"
disable-model-invocation: true
---

<!-- Generated from src/cli-contract.ts by scripts/generate-docs.ts. Do not edit manually. -->
This command is only for a human at the keyboard.
Return the following command verbatim so the user can paste it into the current repository's interactive terminal:
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" project ui
Do not run it inside Claude Code's Bash tool because that process does not own the user's TTY.
The board may mutate Project Goals only through its existing explicit keyboard interactions.
Do not translate this request into a non-interactive mutation or invoke any mutation slash command.
