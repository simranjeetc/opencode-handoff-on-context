// Regression tests for the handoff plugin. These import the REAL module
// (../index.js) — not a copy — so a behavior drift in the shipped code fails a
// test. Uses Node's built-in test runner (node --test), zero dependencies.
//
// Coverage is risk-based (TEA):
//   P0 — unattended-safety decision logic: resolveAuto, permissionTouchesHandoff
//   P1 — pure helpers: shellQuote, truncateMiddle, getTokenCount, buildHandoffPrompt
//   P2 — orchestration seam: startHandoff with an injected fake $ and fake fs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveAuto,
  selfLaunchedWithAuto,
  permissionTouchesHandoff,
  shellQuote,
  truncateMiddle,
  getTokenCount,
  buildHandoffPrompt,
  textFromMessages,
  startHandoff,
} from "../index.js";

// ---------------------------------------------------------------------------
// P0: resolveAuto precedence  (env override > sticky-self > inference)
// ---------------------------------------------------------------------------

test("resolveAuto: env override ON beats everything", () => {
  for (const v of ["1", "true", "yes", "on", "TRUE", " On "]) {
    const r = resolveAuto("s", {
      env: { OPENCODE_HANDOFF_AUTO: v },
      argv: [],
      autoSessions: new Set(),
    });
    assert.deepEqual(r, { auto: true, source: "env-override" }, `value=${JSON.stringify(v)}`);
  }
});

test("resolveAuto: env override OFF beats sticky + inference", () => {
  for (const v of ["0", "false", "no", "off", "FALSE"]) {
    const r = resolveAuto("s", {
      // sticky marker AND inferred-auto both present; override must still win
      env: { OPENCODE_HANDOFF_AUTO: v, OPENCODE_HANDOFF_IS_AUTO: "1" },
      argv: ["--auto"],
      autoSessions: new Set(["s"]),
    });
    assert.deepEqual(r, { auto: false, source: "env-override" }, `value=${JSON.stringify(v)}`);
  }
});

test("resolveAuto: blank/garbage override is ignored, falls through", () => {
  for (const v of ["", "   ", "maybe", "2", "enabled"]) {
    const r = resolveAuto("s", {
      env: { OPENCODE_HANDOFF_AUTO: v },
      argv: [],
      autoSessions: new Set(),
    });
    assert.deepEqual(r, { auto: false, source: "inference" }, `value=${JSON.stringify(v)}`);
  }
});

test("resolveAuto: sticky marker env => sticky-self", () => {
  const r = resolveAuto("s", {
    env: { OPENCODE_HANDOFF_IS_AUTO: "1" },
    argv: [],
    autoSessions: new Set(),
  });
  assert.deepEqual(r, { auto: true, source: "sticky-self" });
});

test("resolveAuto: sticky via --auto argv => sticky-self", () => {
  const r = resolveAuto("s", {
    env: {},
    argv: ["node", "opencode", "--auto"],
    autoSessions: new Set(),
  });
  assert.deepEqual(r, { auto: true, source: "sticky-self" });
});

test("resolveAuto: no signal => inference from autoSessions set", () => {
  assert.deepEqual(
    resolveAuto("s", { env: {}, argv: [], autoSessions: new Set(["s"]) }),
    { auto: true, source: "inference" },
  );
  assert.deepEqual(
    resolveAuto("s", { env: {}, argv: [], autoSessions: new Set(["other"]) }),
    { auto: false, source: "inference" },
  );
});

test("selfLaunchedWithAuto: injected env + argv signals", () => {
  assert.equal(selfLaunchedWithAuto({ OPENCODE_HANDOFF_IS_AUTO: "1" }, []), true);
  assert.equal(selfLaunchedWithAuto({}, ["--auto"]), true);
  assert.equal(selfLaunchedWithAuto({}, ["--model", "x"]), false);
  assert.equal(selfLaunchedWithAuto({ OPENCODE_HANDOFF_IS_AUTO: "0" }, []), false);
});

// ---------------------------------------------------------------------------
// P0: permissionTouchesHandoff  (scopes the auto-allow to handoff files only)
// ---------------------------------------------------------------------------

test("permissionTouchesHandoff: matches handoff read + rm payloads", () => {
  assert.equal(
    permissionTouchesHandoff({ type: "read", metadata: { path: "/proj/.opencode-handoff/handoff-x.md" } }),
    true,
  );
  assert.equal(
    permissionTouchesHandoff({ type: "bash", metadata: { command: "rm /proj/.opencode-handoff/handoff-x.md" } }),
    true,
  );
  // nested arrays (pattern can be string[])
  assert.equal(
    permissionTouchesHandoff({ pattern: ["safe", "/a/.opencode-handoff/b.md"] }),
    true,
  );
});

test("permissionTouchesHandoff: does NOT match unrelated ops", () => {
  assert.equal(permissionTouchesHandoff({ type: "read", metadata: { path: "/proj/src/index.js" } }), false);
  assert.equal(permissionTouchesHandoff({ type: "bash", metadata: { command: "rm -rf build" } }), false);
});

test("permissionTouchesHandoff: safe on null/empty/circular", () => {
  assert.equal(permissionTouchesHandoff(null), false);
  assert.equal(permissionTouchesHandoff(undefined), false);
  assert.equal(permissionTouchesHandoff({}), false);
  const circular = {};
  circular.self = circular; // JSON.stringify throws -> caught -> false
  assert.equal(permissionTouchesHandoff(circular), false);
});

// ---------------------------------------------------------------------------
// P1: pure helpers
// ---------------------------------------------------------------------------

test("shellQuote: wraps and escapes single quotes (POSIX)", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.equal(shellQuote(123), "'123'");
});

test("truncateMiddle: passthrough under limit, middle-cut over limit", () => {
  assert.equal(truncateMiddle("short", 100), "short");
  const big = "x".repeat(1000);
  const out = truncateMiddle(big, 400);
  assert.ok(out.includes("[...handoff truncated to fit prompt budget...]"));
  assert.ok(out.length < big.length);
  assert.ok(out.startsWith("x"));
  assert.ok(out.endsWith("x"));
});

test("getTokenCount: sums input/output/reasoning/cache; tolerant of gaps", () => {
  assert.equal(
    getTokenCount({ tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 3 } } }),
    21,
  );
  assert.equal(getTokenCount({ tokens: { input: 10 } }), 10);
  assert.equal(getTokenCount({}), 0);
  assert.equal(getTokenCount(null), 0);
});

test("textFromMessages: renders role headings and text parts", () => {
  const out = textFromMessages([
    { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
    { info: { role: "assistant", summary: true }, parts: [{ type: "text", text: "hi" }] },
    { info: { role: "user" }, parts: [{ type: "image" }] }, // no text -> skipped
  ]);
  assert.ok(out.includes("## user\nhello"));
  assert.ok(out.includes("## assistant summary\nhi"));
});

test("buildHandoffPrompt: embeds directory, session id, token count, body", () => {
  const p = buildHandoffPrompt({
    sessionID: "sess-123",
    directory: "/work/dir",
    tokenCount: 100000,
    sessionText: "PRIOR CONTEXT",
  });
  assert.ok(p.includes("/work/dir"));
  assert.ok(p.includes("sess-123"));
  assert.ok(p.includes("100000"));
  assert.ok(p.includes("PRIOR CONTEXT"));
  assert.ok(p.includes("orchestrator"));
  assert.ok(p.includes("todos"));
  assert.ok(p.includes("sub-agents"));
  assert.ok(p.includes("GNHF"));
});

test("buildHandoffPrompt: falls back when session text empty", () => {
  const p = buildHandoffPrompt({ sessionID: "s", directory: "/d", tokenCount: 1, sessionText: "" });
  assert.ok(p.includes("No readable session text"));
});

// ---------------------------------------------------------------------------
// P2: startHandoff orchestration seam (fake $ + fake fs, no real herdr/disk)
// ---------------------------------------------------------------------------

// Build a fake tagged-template `$` that records the composed command string and
// returns canned results per herdr subcommand. Mirrors the .json()/.quiet()/
// .nothrow() surface the real code calls.
function makeFake$({ splitPaneID = "pane-new", waitExit = 0 } = {}) {
  const calls = [];
  function compose(strings, values) {
    let s = "";
    strings.forEach((part, i) => {
      s += part;
      if (i < values.length) s += String(values[i]);
    });
    return s;
  }
  const $ = (strings, ...values) => {
    const cmd = compose(strings, values);
    calls.push(cmd);
    const chain = {
      json: async () => {
        if (cmd.includes("herdr pane split")) {
          return { result: { pane: { pane_id: splitPaneID } } };
        }
        return {};
      },
      quiet: () => chain,
      nothrow: () => chain,
      then: (resolve) => resolve({ exitCode: cmd.includes("wait agent-status") ? waitExit : 0 }),
    };
    return chain;
  };
  return { $, calls };
}

function makeFakeFs() {
  const writes = [];
  return {
    fs: {
      mkdirSync: () => {},
      writeFileSync: (path, body) => writes.push({ path, body }),
      rmSync: () => {},
      readdirSync: () => [],
      statSync: () => ({ mtimeMs: Date.now() }),
    },
    writes,
  };
}

test("startHandoff: happy path splits, runs opencode, confirms, closes old pane", async () => {
  const { $, calls } = makeFake$({ waitExit: 0 });
  const { fs, writes } = makeFakeFs();

  const result = await startHandoff({
    $,
    directory: "/work/dir",
    sessionID: "sess-1",
    prompt: "HANDOFF BODY",
    model: { providerID: "github-copilot", modelID: "claude" },
    auto: true,
    env: { HERDR_PANE_ID: "pane-old" },
    fs,
  });

  // handoff file written with body
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body, "HANDOFF BODY");

  const joined = calls.join("\n");
  assert.ok(joined.includes("herdr pane split pane-old"), "splits the old pane");
  assert.ok(joined.includes("herdr pane run pane-new"), "runs in the new pane");
  // auto => --auto flag AND sticky env stamp propagated to the child
  assert.ok(joined.includes("--auto"), "passes --auto when auto");
  assert.ok(joined.includes("OPENCODE_HANDOFF_IS_AUTO=1"), "stamps sticky marker");
  assert.ok(joined.includes("--model") && joined.includes("github-copilot/claude"), "passes model");
  assert.ok(joined.includes("--agent") && joined.includes("orchestrator"), "launches the orchestrator agent by default");
  assert.ok(joined.includes("herdr pane close pane-old"), "closes old pane after confirm");

  assert.deepEqual(
    { newPaneID: result.newPaneID, oldPaneID: result.oldPaneID, oldPaneClosed: result.oldPaneClosed },
    { newPaneID: "pane-new", oldPaneID: "pane-old", oldPaneClosed: true },
  );
});

test("startHandoff: non-auto omits --auto flag and sticky stamp", async () => {
  const { $, calls } = makeFake$({ waitExit: 0 });
  const { fs } = makeFakeFs();

  await startHandoff({
    $,
    directory: "/d",
    sessionID: "s",
    prompt: "B",
    model: undefined,
    auto: false,
    env: { HERDR_PANE_ID: "pane-old" },
    fs,
  });

  const runCmd = calls.find((c) => c.includes("herdr pane run"));
  assert.ok(runCmd, "issued a run command");
  assert.ok(!runCmd.includes("--auto"), "no --auto when not auto");
  assert.ok(!runCmd.includes("OPENCODE_HANDOFF_IS_AUTO=1"), "no sticky stamp when not auto");
});

test("startHandoff: keeps old pane open when new pane never confirms working", async () => {
  const { $, calls } = makeFake$({ waitExit: 1 }); // wait agent-status fails
  const { fs } = makeFakeFs();

  const result = await startHandoff({
    $,
    directory: "/d",
    sessionID: "s",
    prompt: "B",
    model: undefined,
    auto: true,
    env: { HERDR_PANE_ID: "pane-old" },
    fs,
  });

  assert.equal(result.oldPaneClosed, false);
  assert.ok(!calls.some((c) => c.includes("herdr pane close")), "does NOT close old pane on failed confirm");
});

test("startHandoff: OPENCODE_HANDOFF_AGENT overrides and empty string disables the agent flag", async () => {
  // Custom agent name is passed through.
  {
    const { $, calls } = makeFake$({ waitExit: 0 });
    const { fs } = makeFakeFs();
    await startHandoff({
      $, directory: "/d", sessionID: "s", prompt: "B", model: undefined, auto: false,
      env: { HERDR_PANE_ID: "pane-old", OPENCODE_HANDOFF_AGENT: "custom-agent" }, fs,
    });
    const runCmd = calls.find((c) => c.includes("herdr pane run"));
    assert.ok(runCmd.includes("--agent") && runCmd.includes("custom-agent"), "passes the overridden agent");
    assert.ok(!runCmd.includes("--agent") || !/--agent'? 'orchestrator/.test(runCmd), "does not launch the default orchestrator agent when overridden");
  }
  // Empty string disables the --agent flag entirely.
  {
    const { $, calls } = makeFake$({ waitExit: 0 });
    const { fs } = makeFakeFs();
    await startHandoff({
      $, directory: "/d", sessionID: "s", prompt: "B", model: undefined, auto: false,
      env: { HERDR_PANE_ID: "pane-old", OPENCODE_HANDOFF_AGENT: "" }, fs,
    });
    const runCmd = calls.find((c) => c.includes("herdr pane run"));
    assert.ok(!runCmd.includes("--agent"), "omits --agent when disabled via empty string");
  }
});

test("startHandoff: throws when HERDR_PANE_ID is missing", async () => {
  const { $ } = makeFake$();
  const { fs } = makeFakeFs();
  await assert.rejects(
    () => startHandoff({ $, directory: "/d", sessionID: "s", prompt: "B", auto: false, env: {}, fs }),
    /HERDR_PANE_ID is not set/,
  );
});
