# opencode-handoff-on-context

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
- `herdr` CLI on `PATH` — uses `pane split`, `pane run`, `pane close`, and `wait agent-status`.
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

Copy `index.js` into `~/.config/opencode/plugins/` (global) or `.opencode/plugins/` (project).

## Configuration

All configuration is via environment variables.

| Env var | Default | Description |
| --- | --- | --- |
| `OPENCODE_HANDOFF_THRESHOLD` | `100000` | Total context tokens that trigger a handoff. |
| `OPENCODE_HANDOFF_PROMPT_LIMIT` | `200000` | Max chars of session text kept in the handoff file (middle-truncated). |
| `OPENCODE_HANDOFF_AUTO_REPLY_MS` | `1500` | Permission replies faster than this infer the old session ran with `--auto`. |
| `OPENCODE_HANDOFF_SPLIT_DIRECTION` | `down` | Herdr pane split direction. |
| `OPENCODE_HANDOFF_SPLIT_RATIO` | `0.5` | Herdr pane split ratio. |
| `OPENCODE_HANDOFF_COMMAND` | `opencode` | Command used to launch the new session. |
| `OPENCODE_HANDOFF_CONFIRM_TIMEOUT_MS` | `30000` | How long to wait for the new pane to report `working`. |
| `OPENCODE_HANDOFF_FILE_TTL_MS` | `3600000` | TTL for sweeping stale handoff files. |
| `OPENCODE_HANDOFF_LOG` | `~/.config/opencode/logs/handoff-on-context.log` | Log file path. |
| `OPENCODE_HANDOFF_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |

## How it works

The plugin also enables OpenCode auto-compaction with a 10k-token reserve via the `config` hook, and captures the current model + reasoning variant so the new session is launched with the same `--model` (and `--auto` when inferred).

The handoff body is written **in-tree** (under the working directory) so the new session can read it without an out-of-tree read permission prompt. The new session is asked to delete the file once read; stale files are swept on each handoff.

## License

MIT
