// Auto-handoff OpenCode sessions in Herdr before the context window gets too large.
// Custom plugin; keep beside Herdr's managed plugin, not inside it.

import { appendFileSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Filesystem operations bundled so I/O-heavy functions can be exercised with a
// fake in tests (seam testing) without touching the real disk.
const defaultFs = { mkdirSync, writeFileSync, rmSync, readdirSync, statSync };

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
// Structured, leveled logger that writes to both a rotating-ish log file and
// stderr. The log file is the primary diagnostic surface: when a handoff
// misbehaves, tail this file to see the full sequence of herdr commands and
// their outcomes.
//
//   Log file: $OPENCODE_HANDOFF_LOG or ~/.config/opencode/logs/handoff-on-context.log
//   Level:    $OPENCODE_HANDOFF_LOG_LEVEL (debug|info|warn|error, default info)
//
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveLogFile() {
  if (process.env.OPENCODE_HANDOFF_LOG) {
    return process.env.OPENCODE_HANDOFF_LOG;
  }
  try {
    const dir = join(homedir(), ".config", "opencode", "logs");
    mkdirSync(dir, { recursive: true });
    return join(dir, "handoff-on-context.log");
  } catch {
    return join(tmpdir(), "handoff-on-context.log");
  }
}

const LOG_FILE = resolveLogFile();
const LOG_THRESHOLD =
  LOG_LEVELS[(process.env.OPENCODE_HANDOFF_LOG_LEVEL || "info").toLowerCase()] ??
  LOG_LEVELS.info;

function serializeError(error) {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return error;
}

function writeLog(level, message, fields) {
  if ((LOG_LEVELS[level] ?? LOG_LEVELS.info) < LOG_THRESHOLD) {
    return;
  }
  const entry = {
    ts: new Date().toISOString(),
    level,
    plugin: "handoff-on-context",
    pane: process.env.HERDR_PANE_ID,
    msg: message,
    ...(fields && typeof fields === "object" ? fields : {}),
  };
  let line;
  try {
    line = JSON.stringify(entry);
  } catch {
    line = JSON.stringify({ ...entry, fields: String(fields) });
  }
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // File logging is best-effort; never let logging break the handoff.
  }
  // Mirror to stderr so it also shows up in OpenCode's own logs.
  const sink = level === "error" || level === "warn" ? console.error : console.log;
  sink(`handoff-on-context [${level}] ${message}`, fields ? entry : "");
}

const log = {
  debug: (msg, fields) => writeLog("debug", msg, fields),
  info: (msg, fields) => writeLog("info", msg, fields),
  warn: (msg, fields) => writeLog("warn", msg, fields),
  error: (msg, fields) => writeLog("error", msg, fields),
};

// 110k context limit − 10k reserved = 100k effective handoff trigger.
const DEFAULT_THRESHOLD = 100_000;
// The handoff body now goes to a temp file (read by the new session), not
// typed into the TUI, so the old ~28k paste budget no longer applies. Keep a
// generous safety cap to avoid pathological file sizes.
const DEFAULT_PROMPT_LIMIT = 200_000;
// A permission reply arriving faster than this after the ask is treated as
// auto-approved (i.e. the old session ran with `--auto`). Manual approvals
// take a human's reaction time, which is far longer than this.
const DEFAULT_AUTO_REPLY_MS = 1_500;
const triggeredSessions = new Set();
const childSessions = new Set();
const latestModelBySession = new Map();
// Latest model variant (reasoning effort, e.g. "high"/"max") per root session.
const variantBySession = new Map();
// permissionID -> ask timestamp (ms), used to measure reply latency.
const permAskTimes = new Map();
// Sessions inferred to be running with `--auto` (instant permission replies).
const autoSessions = new Set();

// Marker directory segment for handoff files. Any permission whose payload
// references this path is part of the handoff machinery (reading the handoff
// file, or the follow-up delete of it) and must never block on a human — that
// is exactly what stalls unattended, chained overnight runs.
const HANDOFF_DIR_SEGMENT = ".opencode-handoff";

// Did THIS OpenCode process launch with `--auto`? Two signals:
//  1. Our own launcher stamps OPENCODE_HANDOFF_IS_AUTO=1 into the child env, so
//     auto-ness propagates deterministically across the handoff chain without
//     re-inferring at every hop.
//  2. Fallback: inspect our own argv for a literal --auto flag.
export function selfLaunchedWithAuto(env = process.env, argv = process.argv) {
  if (env?.OPENCODE_HANDOFF_IS_AUTO === "1") {
    return true;
  }
  const args = Array.isArray(argv) ? argv : [];
  return args.includes("--auto");
}

// Resolve whether the NEXT session should launch with `--auto`, in priority
// order (first decisive signal wins):
//   1. OPENCODE_HANDOFF_AUTO env: explicit human override ("1"/"true" => on,
//      "0"/"false" => off). Deterministic, beats all heuristics.
//   2. This process was itself launched with --auto => stay auto (sticky chain).
//   3. Timing inference from observed permission replies (legacy best-effort).
export function resolveAuto(sessionID, deps = {}) {
  const env = deps.env ?? process.env;
  const argv = deps.argv ?? process.argv;
  const autoSet = deps.autoSessions ?? autoSessions;
  const override = (env?.OPENCODE_HANDOFF_AUTO || "").trim().toLowerCase();
  if (override === "1" || override === "true" || override === "yes" || override === "on") {
    return { auto: true, source: "env-override" };
  }
  if (override === "0" || override === "false" || override === "no" || override === "off") {
    return { auto: false, source: "env-override" };
  }
  if (selfLaunchedWithAuto(env, argv)) {
    return { auto: true, source: "sticky-self" };
  }
  return { auto: autoSet.has(sessionID), source: "inference" };
}

// True if a permission's payload references a handoff file/dir. Serializing the
// whole object is deliberately version-agnostic: OpenCode's Permission shape
// puts the concrete path/command in tool-specific metadata whose exact keys
// vary across versions. The .opencode-handoff/ segment appears both in the read
// target and in the `rm` command string, so a substring test is robust.
export function permissionTouchesHandoff(permission) {
  try {
    return JSON.stringify(permission ?? {}).includes(HANDOFF_DIR_SEGMENT);
  } catch {
    return false;
  }
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getSessionID(properties) {
  if (typeof properties?.sessionID === "string" && properties.sessionID) {
    return properties.sessionID;
  }
  if (typeof properties?.info?.sessionID === "string" && properties.info.sessionID) {
    return properties.info.sessionID;
  }
  return undefined;
}

function getMessageInfo(properties) {
  const info = properties?.info;
  return info && typeof info === "object" ? info : undefined;
}

export function getTokenCount(info) {
  const t = info?.tokens;
  if (!t || typeof t !== "object") {
    return 0;
  }
  return (Number(t.input) || 0)
       + (Number(t.output) || 0)
       + (Number(t.reasoning) || 0)
       + (Number(t.cache?.read) || 0)
       + (Number(t.cache?.write) || 0);
}

function rememberModel(sessionID, info) {
  if (!sessionID || !info?.providerID || !info?.modelID) {
    return;
  }
  latestModelBySession.set(sessionID, {
    providerID: info.providerID,
    modelID: info.modelID,
  });
}

// Capture model + variant from the `chat.message` hook, which is the only
// runtime surface that carries the current variant (v1 message/session info
// does not include it).
function rememberFromChat(sessionID, model, variant) {
  if (!sessionID) {
    return;
  }
  if (model?.providerID && model?.modelID) {
    latestModelBySession.set(sessionID, {
      providerID: model.providerID,
      modelID: model.modelID,
    });
  }
  if (typeof variant === "string" && variant) {
    variantBySession.set(sessionID, variant);
  } else {
    // No variant on this send means provider/model default — clear any stale one.
    variantBySession.delete(sessionID);
  }
}

// Best-effort detection of `--auto`: OpenCode's auto mode replies to permission
// prompts effectively instantly, whereas a human takes seconds. If a reply for a
// non-rejected permission lands within DEFAULT_AUTO_REPLY_MS of the ask, treat
// the session as auto-approving.
function recordPermissionAsk(permission) {
  if (permission?.id) {
    permAskTimes.set(permission.id, Date.now());
  }
}

function recordPermissionReply(properties, autoReplyMs) {
  const sessionID = properties?.sessionID;
  const permissionID = properties?.permissionID;
  const response = properties?.response;
  if (!sessionID || !permissionID) {
    return;
  }
  const askTime = permAskTimes.get(permissionID);
  permAskTimes.delete(permissionID);
  if (response === "reject" || askTime === undefined) {
    return;
  }
  if (Date.now() - askTime <= autoReplyMs) {
    autoSessions.add(sessionID);
  }
}

function isRootSessionEvent(event) {
  const properties = event?.properties ?? {};
  const info = properties?.info;

  switch (event?.type) {
    case "session.created":
    case "session.updated": {
      // Here `info` is a Session; parentID (optional) marks a subagent/child session.
      if (info?.parentID) {
        if (info.id) {
          childSessions.add(info.id);
        }
        return false;
      }
      const sessionID = getSessionID(properties);
      return Boolean(sessionID) && !childSessions.has(sessionID);
    }
    case "message.updated":
    default: {
      // Here `info` is an AssistantMessage whose parentID is the parent MESSAGE id
      // (always present) — NOT a session parent. Determine root-ness via sessionID.
      const sessionID = getSessionID(properties);
      if (!sessionID) {
        return false;
      }
      return !childSessions.has(sessionID);
    }
  }
}

export function textFromMessages(messages) {
  const chunks = [];
  for (const message of messages ?? []) {
    const role = message?.info?.role ?? "unknown";
    const isSummary = message?.info?.summary ? " summary" : "";
    const text = (message?.parts ?? [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n");
    if (text) {
      chunks.push(`## ${role}${isSummary}\n${text}`);
    }
  }
  return chunks.join("\n\n");
}

function unwrapData(result) {
  return result?.data ?? result?.response?.data ?? result;
}

export function truncateMiddle(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  const half = Math.floor((maxLength - 120) / 2);
  return `${text.slice(0, half)}\n\n[...handoff truncated to fit prompt budget...]\n\n${text.slice(-half)}`;
}

async function summarizeSession(client, sessionID, directory, model) {
  if (!model?.providerID || !model?.modelID) {
    return;
  }
  await client.session.summarize({
    path: { id: sessionID },
    query: { directory },
    body: model,
  });
}

async function getSessionText(client, sessionID, directory) {
  const result = await client.session.messages({
    path: { id: sessionID },
    query: { directory, limit: 30 },
  });
  return textFromMessages(unwrapData(result));
}

export function buildHandoffPrompt({ sessionID, directory, tokenCount, sessionText }) {
  const body = truncateMiddle(
    sessionText || "No readable session text was returned by OpenCode.",
    numberFromEnv("OPENCODE_HANDOFF_PROMPT_LIMIT", DEFAULT_PROMPT_LIMIT),
  );

  return `Automatic OpenCode handoff from previous Herdr session.

Reason: previous session reached ${tokenCount} context tokens. Keep this new session as the main session. Do not ask the user to copy anything from the old session.

Working directory:
${directory}

Previous OpenCode session ID:
${sessionID}

Instructions for this new session:
1. Treat the handoff below as authoritative context.
2. Continue the user's active task from the next concrete step.
3. Preserve constraints, pending todos, files touched, blockers, and verification state.
4. If evidence is missing, inspect files/tools instead of guessing.

Handoff context:

${body}`;
}

// POSIX-safe single-quote shell quoting: wrap in single quotes and escape any
// embedded single quote as '\''. Used to build the opencode command line that
// `herdr pane run` executes via the shell.
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Write the handoff body to a file and return its path. The new session reads
// this file instead of having the full text typed into its TUI — this
// eliminates the slow, chunked `send-text` paste that scaled with prompt size.
//
// The file is written INSIDE the working directory (under .opencode-handoff/)
// rather than the OS temp dir: OpenCode gates reads of files outside the
// working directory behind a permission prompt, which would stall a non-auto
// handoff. Keeping it in-tree means the new session can read it with no prompt.
function writeHandoffFile(directory, sessionID, body, fs = defaultFs) {
  const dir = join(directory, ".opencode-handoff");
  fs.mkdirSync(dir, { recursive: true });
  sweepStaleHandoffFiles(dir, fs);
  const safeID = String(sessionID || "session").replace(/[^A-Za-z0-9_-]/g, "_");
  const path = join(dir, `handoff-${safeID}-${Date.now()}.md`);
  fs.writeFileSync(path, body, { mode: 0o600 });
  log.info("wrote handoff file", { path, bytes: Buffer.byteLength(body) });
  return path;
}

// Best-effort cleanup of old handoff files. The new session is asked to delete
// its own file, but that is not guaranteed, and the process that created the
// file is torn down right after handoff (so an in-process timer is unreliable).
// Instead we sweep leftovers older than a TTL on each new handoff. Never throws.
function sweepStaleHandoffFiles(dir, fs = defaultFs) {
  const ttlMs = numberFromEnv("OPENCODE_HANDOFF_FILE_TTL_MS", 60 * 60 * 1000);
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith("handoff-")) continue;
      const full = join(dir, name);
      try {
        if (now - fs.statSync(full).mtimeMs > ttlMs) {
          fs.rmSync(full, { force: true });
          log.debug("swept stale handoff file", { path: full });
        }
      } catch {
        // ignore individual file errors
      }
    }
  } catch {
    // ignore directory read errors
  }
}

// Open the new session in a NEW PANE within the SAME tab (via `herdr pane
// split`) instead of a brand new workspace. This keeps the original tab — and
// its human-recognizable label — intact, so the work is not scattered across
// freshly-created tabs. Once the new pane is up and processing the handoff,
// the old pane (this process) is closed.
//
// The handoff body is written to an in-tree file and the new OpenCode is
// launched with a tiny `opencode --prompt "<pointer>"` that instructs it to
// read that file. No TUI typing, no send-text chunking, no readiness-then-type.
export async function startHandoff({ $, directory, sessionID, prompt, model, auto, env = process.env, fs = defaultFs }) {
  const oldPaneID = env.HERDR_PANE_ID;
  if (!oldPaneID) {
    throw new Error("HERDR_PANE_ID is not set; cannot split the current pane for handoff");
  }

  const handoffFile = writeHandoffFile(directory, sessionID, prompt, fs);

  const direction = env.OPENCODE_HANDOFF_SPLIT_DIRECTION || "down";
  const ratio = env.OPENCODE_HANDOFF_SPLIT_RATIO || "0.5";
  log.info("splitting current pane for handoff", { oldPaneID, direction, ratio, directory });

  const split = await $`herdr pane split ${oldPaneID} --direction ${direction} --ratio ${ratio} --cwd ${directory} --focus`.json();
  const newPaneID = split?.result?.pane?.pane_id;
  if (!newPaneID) {
    throw new Error(`Could not parse Herdr pane split response: ${JSON.stringify(split)}`);
  }
  log.info("new pane created", { oldPaneID, newPaneID });

  const command = env.OPENCODE_HANDOFF_COMMAND || "opencode";
  // Tiny pointer prompt: the new session reads the temp file for full context.
  const pointer =
    `Automatic context handoff. Read the file ${handoffFile} — it is your`
    + ` authoritative context for this task. Continue the work from the next`
    + ` concrete step. Once you have read and internalized it, delete that file.`;

  // Reuse the previous session's model and auto-approve permission state.
  // Unknown values are omitted so OpenCode falls back to its own defaults.
  //
  // IMPORTANT: `herdr pane run` must receive the whole invocation as a SINGLE
  // shell string. If flags like --prompt/--auto are passed as separate herdr
  // arguments, herdr consumes them itself and opencode just prints its help.
  // So we assemble a shell-quoted command line and hand it to herdr as one arg.
  const parts = [command];
  if (model?.providerID && model?.modelID) {
    parts.push("--model", `${model.providerID}/${model.modelID}`);
  }
  if (auto) {
    parts.push("--auto");
  }
  parts.push("--prompt", pointer);
  // Stamp a marker env into the child so the NEXT hop in the handoff chain
  // knows it is auto deterministically (see selfLaunchedWithAuto), instead of
  // re-inferring from permission timing — which fails whenever a session never
  // hits a permission prompt (common in long unattended runs).
  const envPrefix = auto ? "OPENCODE_HANDOFF_IS_AUTO=1 " : "";
  const commandLine = envPrefix + parts.map(shellQuote).join(" ");
  log.info("launching opencode in new pane", {
    newPaneID,
    handoffFile,
    model: model ? `${model.providerID}/${model.modelID}` : undefined,
    auto,
    commandLine,
  });
  await $`herdr pane run ${newPaneID} ${commandLine}`.quiet();

  // Confirm the new pane actually started processing the handoff before we
  // tear down the old pane. The companion herdr-agent-state plugin reports the
  // new OpenCode's agent status; "working" means it accepted the prompt and is
  // running. If it never flips to working we keep the old pane alive so nothing
  // is lost.
  const confirmTimeout = numberFromEnv("OPENCODE_HANDOFF_CONFIRM_TIMEOUT_MS", 30_000);
  const started = await $`herdr wait agent-status ${newPaneID} --status ${"working"} --timeout ${String(confirmTimeout)}`.nothrow();
  const confirmed = started?.exitCode === 0;
  if (confirmed) {
    log.info("new pane confirmed processing handoff", { newPaneID });
  } else {
    log.warn("could not confirm new pane processing; keeping old pane open", {
      newPaneID,
      oldPaneID,
      exitCode: started?.exitCode,
    });
  }

  if (confirmed) {
    log.info("closing old pane", { oldPaneID, newPaneID });
    // This kills the current OpenCode process — it is the last thing we do.
    await $`herdr pane close ${oldPaneID}`.nothrow().quiet();
  }

  return { oldPaneID, newPaneID, handoffFile, oldPaneClosed: confirmed };
}

async function triggerHandoff({ client, $, directory, sessionID, tokenCount }) {
  if (triggeredSessions.has(sessionID)) {
    return;
  }
  triggeredSessions.add(sessionID);
  log.info("handoff triggered", { sessionID, tokenCount, directory });

  const model = latestModelBySession.get(sessionID);
  try {
    await summarizeSession(client, sessionID, directory, model);
    log.debug("session summarize requested", { sessionID });
  } catch (error) {
    log.error("session summarize failed", { sessionID, error: serializeError(error) });
  }

  let sessionText = "";
  try {
    sessionText = await getSessionText(client, sessionID, directory);
    log.debug("session text fetched", { sessionID, textChars: sessionText.length });
  } catch (error) {
    log.error("session message fetch failed", { sessionID, error: serializeError(error) });
  }

  const prompt = buildHandoffPrompt({ sessionID, directory, tokenCount, sessionText });
  const variant = variantBySession.get(sessionID);
  const { auto, source: autoSource } = resolveAuto(sessionID);
  try {
    const result = await startHandoff({ $, directory, sessionID, prompt, model, auto });
    log.info("handoff completed", {
      sessionID,
      tokenCount,
      model: model ? `${model.providerID}/${model.modelID}` : undefined,
      variant: variant ?? "default",
      auto,
      autoSource,
      ...result,
    });
  } catch (error) {
    log.error("handoff failed", { sessionID, error: serializeError(error) });
    throw error;
  }
}

export const HandoffOnContextPlugin = async ({ client, directory, $ }) => {
  const threshold = numberFromEnv("OPENCODE_HANDOFF_THRESHOLD", DEFAULT_THRESHOLD);
  const autoReplyMs = numberFromEnv("OPENCODE_HANDOFF_AUTO_REPLY_MS", DEFAULT_AUTO_REPLY_MS);

  return {
    config: async (config) => {
      config.compaction = {
        ...(config.compaction ?? {}),
        auto: true,
        reserved: Math.max(Number(config.compaction?.reserved ?? 0), 10_000),
      };
    },
    // Unconditionally auto-approve permissions that belong to the handoff
    // machinery itself (reading the handoff file, and the follow-up `rm` that
    // deletes it). Without this, a session launched WITHOUT `--auto` — which
    // happens whenever the previous session never triggered a permission prompt
    // and so was not detected as auto — stalls forever on the delete step,
    // freezing the whole chained/overnight run until a human clicks approve.
    // This is scoped strictly to .opencode-handoff/ paths, so it never
    // broadens approval for ordinary task commands.
    "permission.ask": async (input, output) => {
      if (process.env.HERDR_ENV !== "1") {
        return;
      }
      if (permissionTouchesHandoff(input)) {
        output.status = "allow";
        log.info("auto-allowed handoff permission", {
          permissionID: input?.id,
          type: input?.type,
          title: input?.title,
        });
      }
    },
    // Authoritative capture point for model + variant (reasoning level): the
    // variant is not present on v1 message/session info, only here.
    "chat.message": async (input) => {
      if (process.env.HERDR_ENV !== "1") {
        return;
      }
      const sessionID = input?.sessionID;
      if (!sessionID || childSessions.has(sessionID)) {
        return;
      }
      rememberFromChat(sessionID, input?.model, input?.variant);
    },
    event: async ({ event }) => {
      if (process.env.HERDR_ENV !== "1") {
        return;
      }

      // Permission events feed --auto inference. They are not session/message
      // events, so handle them before the root-session gate below.
      if (event?.type === "permission.updated") {
        recordPermissionAsk(event?.properties);
        return;
      }
      if (event?.type === "permission.replied") {
        recordPermissionReply(event?.properties, autoReplyMs);
        return;
      }

      const properties = event?.properties ?? {};
      if (!isRootSessionEvent(event)) {
        return;
      }

      const sessionID = getSessionID(properties);
      const info = getMessageInfo(properties);
      rememberModel(sessionID, info);

      if (event?.type !== "message.updated" || info?.role !== "assistant") {
        return;
      }

      const tokenCount = getTokenCount(info);
      if (sessionID && tokenCount >= threshold) {
        await triggerHandoff({ client, $, directory, sessionID, tokenCount });
      }
    },
  };
};
