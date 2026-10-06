# opencode-handoff-on-context

> **Archived — no longer maintained.** This plugin targets **OpenCode v1**.
> OpenCode **v2** reworked the plugin/agent APIs it depends on, so it does not
> work against v2 and is kept here for reference only.

An [OpenCode](https://opencode.ai) plugin that automatically **hands off a session to a fresh one before the context window fills up** — while running inside [Herdr](https://github.com/anomalyco/opencode).

When the active (root) session crosses a token threshold, the plugin:

1. Summarizes the current session.
2. Writes an authoritative handoff file into the working directory (`.opencode-handoff/`).
3. Splits the current Herdr pane and launches a fresh `opencode` process pointed at that file.
4. Waits until the new pane confirms it is `working`, then closes the old pane.

The new session continues the task from the next concrete step — no manual copy/paste.

## Requirements

This plugin is **not generic**. It only does anything inside Herdr and needs its CLI:

- Runs **only** when `HERDR_ENV=1` (no-ops otherwise).
- `herdr` CLI on `PATH` — uses `pane split`, `pane run`, `pane close`, and `agent wait`.
- Relies on a companion `herdr-agent-state` plugin that reports OpenCode agent status (`working`) so the handoff can be confirmed before the old pane is torn down.
- `opencode` CLI on `PATH` (or set `OPENCODE_HANDOFF_COMMAND`).

Without these, it either no-ops or fails to complete the handoff.

## Install

### From npm

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-handoff-on-context@latest"]
}
```

### From GitHub

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["github:simranjeetc/opencode-handoff-on-context"]
}
```

### Local file

Symlink (or copy) `index.js` into `~/.config/opencode/plugins/` (global) or
`.opencode/plugins/` (project). `index.js` re-exports the plugin from `lib.js`,
so keep both files together — do not copy `index.js` alone.

**Module layout:** `index.js` is the entry point and exports ONLY the plugin as
its default export. This is deliberate: OpenCode's plugin loader invokes every
function export as a plugin factory, so any helper exported from the entry
point gets called with `PluginInput` and throws on boot. All helpers
(`startHandoff`, `resolveAuto`, …) live in `lib.js`, which tests import.

### Orchestrator agent (recommended)

By default each handoff session is launched with `--agent orchestrator`. This agent
enforces orchestrator-first behavior structurally — its `edit`/`write` tools are
denied, so the model **cannot** implement work itself and must delegate to
sub-agents via the `task` tool. This is far more robust than prompt instructions,
which the model can skim past; the constraint is re-asserted every turn and carried
across every handoff hop.

Install the agent by copying it into your OpenCode agent directory:

```
cp agent/orchestrator.md ~/.config/opencode/agent/
```

Set `OPENCODE_HANDOFF_AGENT` to launch a different agent, or `OPENCODE_HANDOFF_AGENT=""`
to disable and fall back to the default agent.


## Configuration

All configuration is via environment variables.

| Env var | Default | Description |
| --- | --- | --- |
| `OPENCODE_HANDOFF_THRESHOLD` | `100000` | Total context tokens that trigger a handoff. |
| `OPENCODE_HANDOFF_PROMPT_LIMIT` | `200000` | Max chars of session text kept in the handoff file (middle-truncated). |
| `OPENCODE_HANDOFF_AUTO` | _(unset)_ | Force the next session's `--auto` state. `1`/`true`/`yes`/`on` => always launch with `--auto`; `0`/`false`/`no`/`off` => never. Beats all heuristics. Leave unset to use sticky/inferred auto. |
| `OPENCODE_HANDOFF_AUTO_REPLY_MS` | `1500` | Permission replies faster than this infer the old session ran with `--auto` (last-resort fallback only). |
| `OPENCODE_HANDOFF_SPLIT_DIRECTION` | `down` | Herdr pane split direction. |
| `OPENCODE_HANDOFF_SPLIT_RATIO` | `0.5` | Herdr pane split ratio. |
| `OPENCODE_HANDOFF_COMMAND` | `opencode` | Command used to launch the new session. |
| `OPENCODE_HANDOFF_AGENT` | `orchestrator` | Agent to launch the handoff session as (`--agent`). Empty string disables the flag. |
| `OPENCODE_HANDOFF_CONFIRM_TIMEOUT_MS` | `30000` | How long to wait for the new pane to report `working`. |
| `OPENCODE_HANDOFF_FILE_TTL_MS` | `3600000` | TTL for sweeping stale handoff files. |
| `OPENCODE_HANDOFF_LOG` | `~/.config/opencode/logs/handoff-on-context.log` | Log file path. |
| `OPENCODE_HANDOFF_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |

## How it works

The plugin also enables OpenCode auto-compaction with a 10k-token reserve via the `config` hook, and captures the current model + reasoning variant so the new session is launched with the same `--model` (and `--auto` when inferred).

The handoff body is written **in-tree** (under the working directory) so the new session can read it without an out-of-tree read permission prompt. The new session is asked to delete the file once read; stale files are swept on each handoff.

### Unattended / chained runs

For overnight or looped runs the plugin guarantees the handoff never stalls on a human:

- A `permission.ask` hook **auto-approves any permission that touches `.opencode-handoff/`** (the handoff file read and its follow-up delete). This is scoped strictly to handoff paths and never broadens approval for ordinary task commands. It fixes the failure where a session launched without `--auto` blocks forever on deleting the handoff file.
- `--auto` propagation is **deterministic and sticky**, resolved in priority order: `OPENCODE_HANDOFF_AUTO` env override → this process was itself launched with `--auto` (a marker env `OPENCODE_HANDOFF_IS_AUTO=1` is stamped into each auto child, so auto-ness survives every hop) → legacy permission-timing inference. This avoids the old bug where a session that never hit a permission prompt was misdetected as non-auto, dropping `--auto` for the rest of the chain.

## Development

Tests use Node's built-in runner (`node --test`) — zero dependencies. They import the shipped `lib.js` directly (plus an export-surface guard on `index.js`), so a behavior drift fails a test.

```sh
npm test
```

Coverage is risk-based: the unattended-safety decision logic (`resolveAuto`, `permissionTouchesHandoff`), the pure prompt/quoting/token helpers, and the `startHandoff` orchestration seam (exercised with an injected fake shell `$` and fake `fs`, so no real Herdr or disk is needed). CI runs the suite on Node 20 and 22 for every push and PR.

## License

MIT
