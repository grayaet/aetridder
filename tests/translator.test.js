const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const fs = require("node:fs");
const test = require("node:test");

const {
  buildCommentBatches,
  buildCommentBatchInput,
  buildInitialBatchInput,
  buildPostTranslationInput,
  buildTranslationInputProfile,
  collectCodexUsage,
  sanitizeCodexStdoutJsonl,
  shouldUseShellForCommand,
  spawnSpecForCommand,
  translateWithCodexCli,
  translationPrompt
} = require("../src/translator");
const { redactText } = require("../src/artifacts");
const { cleanupStorage, freshStorage, makeConfig, sampleRaw, translatedFromRaw } = require("./helpers");

test("Codex event sanitizer removes usage and reasoning telemetry", () => {
  const stdout = [
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "{\"language\":\"uk\"}"
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

test("Codex usage collector extracts numeric usage without summing cumulative events", () => {
  const stdout = [
    JSON.stringify({
      type: "turn.started",
      usage: {
        input_tokens: 100,
        output_tokens: 5,
        input_token_details: { cached_tokens: 40 }
      }
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 125,
        output_tokens: 42,
        total_tokens: 167,
        prompt_tokens_details: { cached_tokens: 80 },
        output_tokens_details: { reasoning_tokens: 11 }
      }
    }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "not usage" }
    })
  ].join("\n");

  const usage = collectCodexUsage(stdout);

  assert.equal(usage.available, true);
  assert.equal(usage.inputTokens, 125);
  assert.equal(usage.outputTokens, 42);
  assert.equal(usage.cachedInputTokens, 80);
  assert.equal(usage.reasoningTokens, 11);
  assert.equal(usage.totalTokens, 167);
  assert.equal(usage.usageEventCount >= 2, true);
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

test("log redaction removes local paths and fixed-output argv values", () => {
  const text = [
    "codex exec --output-schema D:\\Codex\\Shipyard\\schemas\\translated.schema.json --output-last-message D:\\Codex\\Shipyard\\runtime\\out.json",
    "cwd=/srv/reddit-reader/app/runtime/work/job"
  ].join("\n");
  const redacted = redactText(text, {});

  assert.equal(redacted.includes("D:\\Codex"), false);
  assert.equal(redacted.includes("/srv/reddit-reader"), false);
  assert.equal(redacted.includes("translated.schema.json"), false);
  assert.equal(redacted.includes("out.json"), false);
  assert.equal(redacted.includes("[REDACTED_LOCAL_PATH]"), true);
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

test("Codex CLI model and reasoning effort are configurable", async () => {
  const workDir = freshStorage("codex-configurable-model");
  const raw = sampleRaw();
  const translated = translatedFromRaw(raw);
  const captured = {
    command: null,
    args: null,
    stdin: ""
  };
  const fakeSpawn = (command, args) => {
    captured.command = command;
    captured.args = args;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write(text) {
        captured.stdin += text;
      },
      end() {
        setImmediate(() => {
          const outputPath = args[args.indexOf("--output-last-message") + 1];
          fs.writeFileSync(outputPath, JSON.stringify(translated), "utf8");
          child.emit("close", 0, null);
        });
      }
    };
    child.kill = () => {};
    return child;
  };

  try {
    const result = await translateWithCodexCli(raw, {
      config: makeConfig(workDir, {
        extraEnv: {
          CODEX_MODEL: "gpt-5.4",
          CODEX_REASONING_EFFORT: "medium",
          CODEX_CLI_EXTRA_ARGS: "--some-extra-flag"
        }
      }),
      workDir,
      log: () => {},
      spawnImpl: fakeSpawn
    });

    assert.equal(captured.command, "codex");
    assert.equal(captured.args.includes("model_reasoning_effort=\"medium\""), true);
    assert.equal(captured.args[captured.args.indexOf("--model") + 1], "gpt-5.4");
    assert.equal(captured.args.at(-1), "--some-extra-flag");
    assert.equal(result.codex.model, "gpt-5.4");
    assert.equal(result.codex.reasoningEffort, "medium");
    const promptText = fs.readFileSync(path.join(workDir, "translation-contract-prompt.txt"), "utf8");
    assert.equal(promptText.includes("model gpt-5.4"), true);
    assert.equal(promptText.includes("reasoning effort medium"), true);
    assert.equal(captured.stdin.includes("model gpt-5.4"), true);
    assert.equal(captured.stdin.includes("reasoning effort medium"), true);
    assert.equal(captured.stdin.includes("configured target language"), false);
  } finally {
    cleanupStorage(workDir);
  }
});

test("translation prompt defaults preserve GPT-5.5 high", () => {
  const prompt = translationPrompt("thread.translated.json");
  assert.equal(prompt.includes("model gpt-5.5"), true);
  assert.equal(prompt.includes("reasoning effort high"), true);
  assert.equal(prompt.includes("Ukrainian"), true);
  assert.equal(prompt.includes("configured target language"), false);
  assert.equal(prompt.includes("language to \"uk\""), true);
});

test("translation prompt and compact inputs honor configured target language", () => {
  const raw = sampleRaw();
  const batches = buildCommentBatches(raw.comments, {
    translationBatchMaxComments: 1,
    translationBatchMaxChars: 5000
  });
  const config = {
    targetLanguageCode: "es",
    targetLanguageName: "Spanish",
    codexModel: "gpt-5.5",
    codexReasoningEffort: "medium"
  };
  const prompt = translationPrompt("thread.translated.json", config);
  const postInput = buildPostTranslationInput(raw, config);
  const initialInput = buildInitialBatchInput(raw, batches[0], config);
  const profile = buildTranslationInputProfile(raw, batches, config);

  assert.equal(prompt.includes("Spanish"), true);
  assert.equal(prompt.includes("language to \"es\""), true);
  assert.deepEqual(postInput.targetLanguage, { code: "es", name: "Spanish" });
  assert.deepEqual(initialInput.targetLanguage, { code: "es", name: "Spanish" });
  assert.deepEqual(profile.targetLanguage, { code: "es", name: "Spanish" });
});

test("translation input builders use compact text-only payloads and numeric profile", () => {
  const raw = sampleRaw();
  const batches = buildCommentBatches(raw.comments, {
    translationBatchMaxComments: 1,
    translationBatchMaxChars: 5000
  });
  const postInput = buildPostTranslationInput(raw);
  const initialInput = buildInitialBatchInput(raw, batches[0]);
  const batchInput = buildCommentBatchInput(raw, raw.post, batches[0]);
  const profile = buildTranslationInputProfile(raw, batches, {
    codexModel: "gpt-5.5",
    codexReasoningEffort: "medium"
  });

  assert.deepEqual(Object.keys(postInput.post).sort(), ["bodyMarkdown", "id", "title"]);
  assert.deepEqual(Object.keys(initialInput.batch.comments[0]).sort(), ["bodyMarkdown", "depth", "id", "order", "parentId"]);
  assert.deepEqual(Object.keys(batchInput.batch.comments[0]).sort(), ["bodyMarkdown", "depth", "id", "order", "parentId"]);

  const compactText = JSON.stringify({ postInput, initialInput, batchInput });
  assert.equal(compactText.includes("authorProfileUrl"), false);
  assert.equal(compactText.includes("\"score\""), false);
  assert.equal(compactText.includes("\"timestamp\""), false);
  assert.equal(compactText.includes("\"metadata\""), false);

  assert.equal(profile.publicTelemetrySafe, true);
  assert.equal(profile.model, "gpt-5.5");
  assert.equal(profile.reasoningEffort, "medium");
  assert.equal(Number.isFinite(profile.totals.rawCommentBodyBytes), true);
  assert.equal(Number.isFinite(profile.totals.estimatedInitialPlusRemainingInputJsonBytes), true);
  assert.equal(JSON.stringify(profile).includes(raw.comments[0].bodyMarkdown), false);
  assert.equal(JSON.stringify(profile).includes(raw.post.title), false);
});

test("comment batch splitter respects count and character limits", () => {
  const raw = sampleRaw();
  const comments = Array.from({ length: 5 }, (_unused, index) => ({
    ...raw.comments[0],
    id: `t1_split_${index}`,
    order: index,
    bodyMarkdown: index === 2 ? "x".repeat(200) : "short"
  }));

  const batches = buildCommentBatches(comments, {
    translationBatchMaxComments: 2,
    translationBatchMaxChars: 300
  });

  assert.equal(batches.length, 3);
  assert.deepEqual(batches.map((batch) => batch.comments.length), [2, 1, 2]);
  assert.deepEqual(batches.map((batch) => batch.batchIndex), [0, 1, 2]);
  assert.equal(batches.every((batch) => batch.totalBatches === 3), true);
});
