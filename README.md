# dsh-copilot-bridge

Use your existing **VS Code Copilot agents and skills** directly in
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). No parallel
setup — the plugin reads the folders Copilot already uses and mirrors them into
the harness as first-class skills and agent presets.

- **Skills** become loadable through the normal `skill` tool.
- **Agents** become Agent Presets (own persona + own tool set) and delegation
  targets (`list_copilot_agents` / `call_agent`).
- The agent picker **follows the workspace you are in**, so you never see another
  project's agents.

## What it reads

| Scope | Agents | Skills |
|---|---|---|
| Global (every workspace) | `~/.copilot/agents/*.md` | `~/.copilot/skills/<name>/SKILL.md` |
| Local (this workspace only) | `<workspace>/.github/agents/*.md` | `<workspace>/.github/skills/<name>/SKILL.md` |

`<workspace>` is the nearest ancestor of the session directory containing
`.git`, `.github/agents`, or `.github/skills`. A **workspace skill/agent overrides
a global one with the same name**.

## What you get

1. **Skills** — published to the shared skill catalog. Local skills rank above
   global ones; bodies are re-read on every load, so edits apply immediately.
2. **Agent presets** — every `*.agent.md` becomes a preset. Its markdown body is
   the persona and its `tools:` frontmatter selects the harness tools:

   | Copilot tool | Harness tools |
   |---|---|
   | `read/*` | `read`, `read_image` |
   | `edit` | `write`, `edit` |
   | `execute` | `pwsh` (or `bash` off Windows) + `jobs` |
   | `search/*` | `glob`, `grep` |
   | `web/*` | `web_search`, `web_fetch` |
   | `todo` | `todo_write` |
   | `agent/runSubagent` | `call_agent`, `list_copilot_agents` |
   | `vscode`, `browser`, `context7/*` | none (no harness equivalent) |

   An agent with no `tools:` gets read/search/web/todo.
3. **`list_copilot_agents` / `call_agent`** — Host-level tools. Delegation is
   refused unless the caller's `tools:` grants `agent/runSubagent` and the target
   is in its `agents: [...]` list. Local agents win name clashes, so
   `call_agent('auditor')` resolves to the workspace's `auditor`.

### Workspace scoping

Global agents are always on the picker. A workspace's agents are added when you
enter it (open/create a session there, delegate from it, or list its agents) and
withdrawn when you move to another workspace. A workspace stays while a live
session still has one of its agents selected, because withdrawing it would break
that session.

## Configuration

Everything is optional; the defaults above are used when `config` is `{}`.
Edit `cordis.patch.yml` (or the row in the profile) to override:

| Field | Default | Meaning |
|---|---|---|
| `globalRoot` | `~/.copilot` | Root of the global Copilot folder |
| `globalAgentsDir` / `globalSkillsDir` | `<globalRoot>/agents`, `<globalRoot>/skills` | Absolute overrides |
| `localAgentsDir` / `localSkillsDir` | `.github/agents`, `.github/skills` | Project-relative paths |
| `providerName` | `copilot` | Skill provider name |
| `provider` | `spawn` | Subagent provider used by `call_agent` |
| `cacheMs` | `5000` | How long a workspace agent scan is reused |
| `presetScope` | `workspace` | `workspace` = current workspace only; `all` = keep everything |

## Installation

It is a DeepSeek Harness **bundle**: a `package.json` with a `dsh.bundle.patch`
declaration plus a Host plugin, a client plugin, and display metadata. Install it
with the standard procedure — `plugin_manager` → `install_bundle` — using one of:

**From a local checkout**

```text
plugin_manager  install_bundle  C:\path\to\dsh-copilot-bridge
```

**From GitHub (no publish needed)**

```text
plugin_manager  install_bundle  github:grovergol/dsh-copilot-bridge
```

or `https://github.com/grovergol/dsh-copilot-bridge.git`.

**From npm (after publishing)**

```text
plugin_manager  install_bundle  dsh-copilot-bridge@0.1.0
```

Replace `grovergol` and the version as appropriate. The Web UI's **Plugins →
Add plugin** flow accepts the same targets. The bundle has no npm dependencies and
no build step, so installation is a plain `pnpm add`.

## Version requirement

`package.json` pins `engines.dsh` to `>=0.2.1-rc.3 <0.3.0`. The plugin relies on
the `@deepseek-ai/dsh-*` packages that ship with the harness; installation is
blocked on a DSH release outside that range (adjust it if you target a newer
release).

## Notes and limits

- Frontmatter is parsed with a small YAML subset reader (scalars, quoted strings,
  flow lists, `|` / `>` blocks); exotic YAML is skipped rather than failing the
  file.
- A literal `{{` in an agent body is rendered as `{ {` (persona text is a prompt
  template).
- `.github/copilot-instructions.md` is not injected; agents reference it with the
  `read` tool.
- Editing an agent `.md` needs a restart to re-compose its preset (presets are
  immutable revisions); edited skill bodies are re-read on every load.
- The plugin writes a bounded diagnostic log `bridge.log` next to itself on the
  Host; it is capped at 512 KiB and safe to delete.

## License

MIT. See [LICENSE](LICENSE).
