# Evidence: Isolate Claude plugin MCP config

All commands ran against a throwaway Claude Code config dir (`CLAUDE_CONFIG_DIR=/tmp/nm-claude-cfg`),
so nothing in the user's real Claude Code configuration was touched.

## Files

- `claude-code-mcp-scoping.txt` - real `claude mcp list` / `claude mcp get` transcript for three states:
  the pre-fix checkout (broken project-scoped server + `Missing environment variables:
  CLAUDE_PLUGIN_ROOT, CLAUDE_PROJECT_DIR`), the fixed checkout (no project-scoped server, no
  diagnostics), and a real plugin install (`plugin:stepstone:stepstone ... Connected`).
- `plugin-mcp-launch-env.json` - the command line and environment Claude Code actually handed the
  plugin MCP process when it started the inline `mcpServers` declaration from
  `.claude-plugin/plugin.json`. Captured by temporarily wrapping `dist/mcp.js` in the throwaway
  plugin copy; the manifest under test was left exactly as generated. Both placeholders are expanded
  by Claude Code: `${CLAUDE_PLUGIN_ROOT}` -> the installed plugin root, and `${CLAUDE_PROJECT_DIR}`
  -> the project directory, delivered as `STEPSTONE_PLUGIN_PROJECT_ROOT`.
- `no-pi-install-check.log` - `npm run no-pi-install:check`: packs the publishable tarball, installs
  it with no dev dependencies and no Pi packages, drives both published bins, and starts the MCP
  server from the installed manifest's inline declaration.

## Real plugin install steps reproduced here

```
npm pack --pack-destination /tmp/nm-plugin-e2e/pack
npm install --omit=dev /tmp/nm-plugin-e2e/pack/stepstone-0.9.2.tgz   # scratch install dir
# installed package copied to a local marketplace, then:
claude plugin marketplace add /tmp/nm-plugin-e2e/marketplace
claude plugin install stepstone@stepstone-local -y
claude mcp list        # in a fresh git project and in this repo checkout
```
