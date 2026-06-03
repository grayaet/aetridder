const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const fs = require("node:fs");
const test = require("node:test");

const {
  sanitizeCodexStdoutJsonl,
  shouldUseShellForCommand,
  spawnSpecForCommand,
  translateWithCodexCli
} = require("../src/translator");
const { cleanupStorage, freshStorage, makeConfig, sampleRaw, translatedFromRaw } = require("./helpers");

test("Codex event sanitizer removes usage and reasoning telemetry", () => {
  const stdout = [
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "{\"language\":\"ru\"}"
      }
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 12,
        reasoning_output_tokens: 7,
        cached_input_tokens: 3
      }
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "Get-Content secret.txt",
        aggregated_output: "secret"
      }
    })
  ].join("\n");

  const lines = sanitizeCodexStdoutJsonl(stdout, {
    apiToken: "token",
    diagnosticsToken: "diag"
  });
  const text = lines.join("\n");

  assert.equal(text.includes("reasoning_output_tokens"), false);
  assert.equal(text.includes("cached_input_tokens"), false);
  assert.equal(text.includes("input_tokens"), false);
  assert.equal(text.includes("Get-Content secret.txt"), false);
  assert.equal(text.includes("secret"), false);
  assert.equal(text.includes("fixed output captured separately"), true);
  assert.equal(text.includes("redacted_command_execution"), true);
});

test("Windows cmd shim uses shell spawn mode", () => {
  assert.equal(shouldUseShellForCommand("D:\\Codex\\_opscontrol\\bin\\codex.cmd", "win32"), true);
  assert.equal(shouldUseShellForCommand("codex", "win32"), false);
  assert.equal(shouldUseShellForCommand("/usr/local/bin/codex.cmd", "linux"), false);

  const spec = spawnSpecForCommand("D:\\Codex\\_opscontrol\\bin\\codex.cmd", ["--version"], "win32", "cmd.exe");
  assert.equal(spec.command, "cmd.exe");
  assert.deepEqual(spec.args, ["/d", "/s", "/c", "D:\\Codex\\_opscontrol\\bin\\codex.cmd --version"]);
  assert.equal(spawnSpecForCommand("C:\\Program Files\\codex.cmd", ["--version"], "win32", "cmd.exe").unsupportedReason, "windows_cmd_path_contains_whitespace");
});

test("Codex CLI must write translated JSON to the fixed output path", async () => {
  const workDir = freshStorage("codex-fixed-output-missing");
  const raw = sampleRaw();
  const stdoutThread = translatedFromRaw(raw);
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write() {},
      end() {
        setImmediate(() => {
          child.stdout.emit("data", Buffer.from(`${JSON.stringify(stdoutThread)}\n`, "utf8"));
          child.emit("close", 0, null);
        });
      }
    };
    child.kill = () => {};
    return child;
  };

  try {
    await assert.rejects(
      () => translateWithCodexCli(raw, {
        config: makeConfig(workDir),
        workDir,
        log: () => {},
        spawnImpl: fakeSpawn
      }),
      (error) => {
        assert.equal(error.status, "translation_failed");
        assert.equal(error.errorCode, "codex_output_missing");
        assert.equal(error.errorMessageSafe, "Codex CLI returned no translated JSON.");
        return true;
      }
    );
    assert.equal(fs.existsSync(path.join(workDir, "thread.translated.json")), false);
    assert.equal(fs.existsSync(path.join(workDir, "codex-events.jsonl")), true);
  } finally {
    cleanupStorage(workDir);
  }
});

