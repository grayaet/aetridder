const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const { createApp } = require("../src/app");
const {
  cleanupStorage,
  fixtureJson,
  freshStorage,
  getJson,
  getText,
  makeConfig,
  requestJson,
  sampleRaw,
  translatedFromRaw,
  waitForStatus,
  withServer
} = require("./helpers");

async function startInstance(config, options = {}) {
  const instance = createApp({
    config,
    extractor: options.extractor,
    translator: options.translator,
    autoStartWorker: options.autoStartWorker
  });
  const server = http.createServer(instance.app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    ...instance,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function closeInstance(instance) {
  if (instance && instance.server) {
    await new Promise((resolve) => instance.server.close(resolve));
  }
}

test("POST rejects invalid and non-Reddit URL fixtures", async () => {
  await withServer({
    name: "url-rejects",
    extractor: async () => sampleRaw(),
    translator: async (raw) => ({ thread: translatedFromRaw(raw) })
  }, async ({ baseUrl }) => {
    const invalid = fixtureJson("cases/invalid-url.json");
    const nonReddit = fixtureJson("cases/non-reddit-url.json");

    const invalidResponse = await requestJson(baseUrl, "POST", "/api/threads", invalid.requestBody);
    assert.equal(invalidResponse.status, invalid.expectedStatus);
    assert.equal(invalidResponse.body.errorCode, invalid.expectedErrorCode);

    const nonRedditResponse = await requestJson(baseUrl, "POST", "/api/threads", nonReddit.requestBody);
    assert.equal(nonRedditResponse.status, nonReddit.expectedStatus);
    assert.equal(nonRedditResponse.body.errorCode, nonReddit.expectedErrorCode);
  });
});

test("ready job writes status fields and latest artifact manifest", async () => {
  await withServer({
    name: "ready-job",
    extractor: async () => ({ thread: sampleRaw() }),
    translator: async (raw) => ({ thread: translatedFromRaw(raw) })
  }, async ({ baseUrl, storageDir }) => {
    const post = await requestJson(baseUrl, "POST", "/api/threads", {
      url: "https://www.reddit.com/r/test/comments/demo/english_title/"
    });
    assert.equal(post.status, 202);
    assert.ok(post.body.jobId);
    assert.ok(post.body.viewUrl.endsWith(`/t/${post.body.jobId}`));

    const status = await waitForStatus(baseUrl, post.body.jobId, "ready");
    assert.equal(status.status, "ready");
    assert.equal(status.isCurrentLatestJob, true);
    for (const field of [
      "jobId",
      "status",
      "sourceUrl",
      "normalizedUrl",
      "finalUrlAfterRedirect",
      "createdAt",
      "updatedAt",
      "stageTimestamps",
      "warningCodes",
      "errorCode",
      "errorMessageSafe",
      "artifactManifest",
      "isCurrentLatestJob"
    ]) {
      assert.ok(Object.prototype.hasOwnProperty.call(status, field), `missing ${field}`);
    }
    const names = status.artifactManifest.entries.map((entry) => entry.name);
    assert.ok(names.includes("thread.raw.json"));
    assert.ok(names.includes("thread.translated.json"));
    assert.ok(names.includes("worker.log"));
    assert.ok(names.includes("validation-report.json"));
    assert.ok(names.includes("artifact-manifest.json"));

    const reader = await requestJson(baseUrl, "GET", `/api/view/${post.body.jobId}`, undefined, "");
    assert.equal(reader.status, 200);
    assert.equal(reader.body.status, "ready");
    assert.ok(reader.body.thread.post.title.includes("Русский"));
    assert.equal(reader.body.thread.post.bodyMarkdown.includes("English body"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(reader.body, "artifactManifest"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(reader.body, "redactedLogTail"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(reader.body, "workerHeartbeat"), false);

    const statePath = path.join(storageDir, "latest-job-state.json");
    assert.equal(fs.existsSync(statePath), true);
    const persistedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(persistedState.currentJobId, post.body.jobId);
    assert.equal(persistedState.generation, 1);
    assert.equal(persistedState.job.status, "ready");
    assert.equal(persistedState.job.isCurrentLatestJob, true);
  });
});

test("latest ready job reloads from persisted state and latest artifacts after restart", async () => {
  const storageDir = freshStorage("latest-state-reload");
  const config = makeConfig(storageDir);
  let firstInstance;
  let secondInstance;
  try {
    firstInstance = await startInstance(config, {
      extractor: async () => ({ thread: sampleRaw() }),
      translator: async (raw) => ({ thread: translatedFromRaw(raw) })
    });
    const post = await requestJson(firstInstance.baseUrl, "POST", "/api/threads", {
      url: "https://www.reddit.com/r/test/comments/demo/english_title/"
    });
    await waitForStatus(firstInstance.baseUrl, post.body.jobId, "ready");
    await closeInstance(firstInstance);
    firstInstance = null;

    secondInstance = await startInstance(config, { autoStartWorker: false });
    const status = await getJson(secondInstance.baseUrl, `/api/threads/${post.body.jobId}/status`);
    assert.equal(status.status, 200);
    assert.equal(status.body.status, "ready");
    assert.equal(status.body.isCurrentLatestJob, true);

    const reader = await requestJson(secondInstance.baseUrl, "GET", `/api/view/${post.body.jobId}`, undefined, "");
    assert.equal(reader.status, 200);
    assert.equal(reader.body.status, "ready");
    assert.match(reader.body.thread.post.title, /Русский/);

    const html = await getText(secondInstance.baseUrl, `/t/${post.body.jobId}`);
    assert.equal(html.status, 200);
    assert.match(html.text, /Русский заголовок/);
  } finally {
    await closeInstance(firstInstance);
    await closeInstance(secondInstance);
    cleanupStorage(storageDir);
  }
});

test("artifact manifest includes additional files copied to latest", async () => {
  await withServer({
    name: "manifest-additional-artifacts",
    extractor: async () => ({ thread: sampleRaw() }),
    translator: async (raw, { workDir }) => {
      fs.writeFileSync(path.join(workDir, "reddit-comments-partial-1.html"), "<div>partial</div>", "utf8");
      return { thread: translatedFromRaw(raw) };
    }
  }, async ({ baseUrl }) => {
    const post = await requestJson(baseUrl, "POST", "/api/threads", {
      url: "https://www.reddit.com/r/test/comments/demo/english_title/"
    });
    const status = await waitForStatus(baseUrl, post.body.jobId, "ready");
    assert.ok(status.artifactManifest.additionalArtifacts.some((entry) => entry.relativePath === "reddit-comments-partial-1.html"));
  });
});

test("partial extraction is ready_with_warning with visible warning code", async () => {
  await withServer({
    name: "partial-extraction",
    extractor: async () => ({ thread: sampleRaw({ warningCodes: ["partial_comments"] }) }),
    translator: async (raw) => ({ thread: translatedFromRaw(raw) })
  }, async ({ baseUrl }) => {
    const post = await requestJson(baseUrl, "POST", "/api/threads", {
      url: "https://www.reddit.com/r/test/comments/demo/english_title/"
    });
    const status = await waitForStatus(baseUrl, post.body.jobId, "ready_with_warning");
    assert.deepEqual(status.warningCodes, ["partial_comments"]);
  });
});

test("comments beyond max_comments are truncated with warning", async () => {
  await withServer({
    name: "truncated-thread",
    configOverrides: { maxComments: 1 },
    extractor: async () => ({ thread: sampleRaw() }),
    translator: async (raw) => ({ thread: translatedFromRaw(raw) })
  }, async ({ baseUrl }) => {
    const post = await requestJson(baseUrl, "POST", "/api/threads", {
      url: "https://www.reddit.com/r/test/comments/demo/english_title/"
    });
    const status = await waitForStatus(baseUrl, post.body.jobId, "ready_with_warning");
    assert.deepEqual(status.warningCodes, ["truncated_comments"]);
  });
});

test("translation failure is a clear translation_failed state", async () => {
  await withServer({
    name: "translation-failure",
    extractor: async () => ({ thread: sampleRaw() }),
    translator: async () => {
      const error = new Error("codex_nonzero_exit");
      error.status = "translation_failed";
      error.code = "codex_nonzero_exit";
      error.errorMessageSafe = "Codex CLI translation failed.";
      error.codex = {
        command: "codex exec --model gpt-5.5",
        model: "gpt-5.5",
        reasoningEffort: "high",
        exitCode: 1,
        signal: null,
        timeoutState: false,
        outputPath: "thread.translated.json"
      };
      throw error;
    }
  }, async ({ baseUrl, storageDir }) => {
    const post = await requestJson(baseUrl, "POST", "/api/threads", {
      url: "https://www.reddit.com/r/test/comments/demo/english_title/"
    });
    const status = await waitForStatus(baseUrl, post.body.jobId, "translation_failed");
    assert.equal(status.errorCode, "codex_nonzero_exit");
    const validationReport = JSON.parse(fs.readFileSync(path.join(storageDir, "latest", "validation-report.json"), "utf8"));
    assert.equal(validationReport.codex.model, "gpt-5.5");
    assert.equal(validationReport.codex.reasoningEffort, "high");
    assert.equal(validationReport.codex.exitCode, 1);
  });
});

test("validation failure is not repaired by another GPT call", async () => {
  let translationCalls = 0;
  await withServer({
    name: "validation-failure",
    extractor: async () => ({ thread: sampleRaw() }),
    translator: async () => {
      translationCalls += 1;
      return { thread: fixtureJson("cases/validation-failure-translated.json") };
    }
  }, async ({ baseUrl }) => {
    const post = await requestJson(baseUrl, "POST", "/api/threads", {
      url: "https://www.reddit.com/r/test/comments/demo/english_title/"
    });
    const status = await waitForStatus(baseUrl, post.body.jobId, "validation_failed");
    assert.equal(status.errorCode, "post_metadata_mismatch");
    assert.equal(translationCalls, 1);
  });
});

test("missing GPT-5.5 is a clear translation failure fixture", async () => {
  await withServer({
    name: "missing-gpt55",
    extractor: async () => ({ thread: sampleRaw() }),
    translator: async () => {
      const error = new Error("missing_gpt55");
      error.status = "translation_failed";
      error.code = "missing_gpt55";
      error.errorMessageSafe = "GPT-5.5 is unavailable to Codex CLI.";
      throw error;
    }
  }, async ({ baseUrl }) => {
    const post = await requestJson(baseUrl, "POST", "/api/threads", {
      url: "https://www.reddit.com/r/test/comments/demo/english_title/"
    });
    const status = await waitForStatus(baseUrl, post.body.jobId, "translation_failed");
    assert.equal(status.errorCode, "missing_gpt55");
  });
});

