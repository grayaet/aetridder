const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const { createApp } = require("../src/app");
const {
  cleanupStorage,
  diagnosticsToken,
  fixtureJson,
  freshStorage,
  getJson,
  getText,
  makeConfig,
  requestJson,
  sampleRaw,
  translatedFromRaw,
  waitFor,
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

function rawWithCommentCount(count) {
  const raw = sampleRaw();
  const base = raw.comments[0];
  raw.comments = Array.from({ length: count }, (_unused, index) => ({
    ...base,
    id: `t1_comment_${index}`,
    parentId: index === 0 ? raw.post.id : `t1_comment_${index - 1}`,
    order: index,
    depth: Math.min(index, 3),
    bodyMarkdown: `English comment ${index + 1}.`
  }));
  raw.parserMetrics = {
    ...(raw.parserMetrics || {}),
    totalCommentCount: count,
    extractedUniqueCommentCount: count
  };
  return raw;
}

function translatedPostPayload(raw) {
  const translated = translatedFromRaw(raw);
  return {
    schemaVersion: "aetridder.translated-post.v1",
    language: "uk",
    translatedAt: "2026-06-05T12:00:00.000Z",
    sourceUrl: raw.sourceUrl,
    normalizedUrl: raw.normalizedUrl,
    finalUrlAfterRedirect: raw.finalUrlAfterRedirect,
    post: translated.post,
    warningCodes: raw.warningCodes || []
  };
}

function translatedBatchPayload(batch) {
  return {
    schemaVersion: "aetridder.translated-comment-batch.v1",
    language: "uk",
    translatedAt: "2026-06-05T12:00:00.000Z",
    batchIndex: batch.batchIndex,
    totalBatches: batch.totalBatches,
    comments: batch.comments.map((comment, index) => ({
      id: comment.id,
      parentId: comment.parentId,
      order: comment.order,
      depth: comment.depth,
      bodyMarkdown: `Перекладений batch ${batch.batchIndex} коментар ${index + 1}.`
    })),
    warningCodes: []
  };
}

function translatedInitialCompactPayload(raw, batch) {
  const post = translatedPostPayload(raw).post;
  return {
    schemaVersion: "aetridder.translated-initial-batch.v1",
    language: "uk",
    translatedAt: "2026-06-05T12:00:00.000Z",
    post: {
      id: post.id,
      title: post.title,
      bodyMarkdown: post.bodyMarkdown
    },
    batchIndex: batch.batchIndex,
    totalBatches: batch.totalBatches,
    comments: batch.comments.map((comment, index) => ({
      id: comment.id,
      parentId: comment.parentId,
      order: comment.order,
      depth: comment.depth,
      bodyMarkdown: `Перекладений initial коментар ${index + 1}.`
    })),
    warningCodes: []
  };
}

function translatedCompactBatchPayload(batch) {
  return {
    schemaVersion: "aetridder.translated-comment-batch.v1",
    language: "uk",
    translatedAt: "2026-06-05T12:00:00.000Z",
    batchIndex: batch.batchIndex,
    totalBatches: batch.totalBatches,
    comments: batch.comments.map((comment, index) => ({
      id: comment.id,
      parentId: comment.parentId,
      order: comment.order,
      depth: comment.depth,
      bodyMarkdown: `Перекладений compact batch ${batch.batchIndex} коментар ${index + 1}.`
    })),
    warningCodes: []
  };
}

function codexReport(phase, usage, offsetMs = 0) {
  const started = new Date(Date.parse("2026-06-05T12:00:00.000Z") + offsetMs);
  const ended = new Date(started.getTime() + 1500);
  return {
    command: `codex exec ${phase}`,
    model: "gpt-5.5",
    reasoningEffort: "medium",
    cwd: "work",
    inputPath: `${phase}.input.json`,
    schemaPath: `${phase}.schema.json`,
    outputPath: `${phase}.output.json`,
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
    exitCode: 0,
    signal: null,
    timeoutState: false,
    promptDelivery: "stdin",
    stdoutRedactedAndSizeLimited: true,
    usage: {
      available: true,
      usageEventCount: 1,
      ...usage
    }
  };
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
    assert.ok(reader.body.thread.post.title.includes("Перекладений"));
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
    assert.match(reader.body.thread.post.title, /Перекладений/);

    const html = await getText(secondInstance.baseUrl, `/t/${post.body.jobId}`);
    assert.equal(html.status, 200);
    assert.match(html.text, /Перекладений заголовок/);
  } finally {
    await closeInstance(firstInstance);
    await closeInstance(secondInstance);
    cleanupStorage(storageDir);
  }
});

test("configured target language code is enforced and surfaced", async () => {
  await withServer({
    name: "configured-target-language",
    configOverrides: {
      extraEnv: {
        REDDIT_READER_TARGET_LANGUAGE_CODE: "es",
        REDDIT_READER_TARGET_LANGUAGE_NAME: "Spanish",
        REDDIT_READER_TARGET_LOCALE: "es-ES"
      }
    },
    extractor: async () => ({ thread: sampleRaw() }),
    translator: async (raw) => ({ thread: translatedFromRaw(raw, { language: "es" }) })
  }, async ({ baseUrl, storageDir }) => {
    const post = await requestJson(baseUrl, "POST", "/api/threads", {
      url: "https://www.reddit.com/r/test/comments/demo/english_title/"
    });
    const status = await waitForStatus(baseUrl, post.body.jobId, "ready");
    assert.equal(status.targetLanguage.code, "es");
    assert.equal(status.targetLanguage.name, "Spanish");

    const reader = await requestJson(baseUrl, "GET", `/api/view/${post.body.jobId}`, undefined, "");
    assert.equal(reader.body.thread.language, "es");
    assert.equal(reader.body.metadata.targetLanguage.code, "es");

    const validationReport = JSON.parse(fs.readFileSync(path.join(storageDir, "latest", "validation-report.json"), "utf8"));
    assert.equal(validationReport.targetLanguage.code, "es");
    assert.equal(validationReport.targetLanguage.name, "Spanish");
  });
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

test("incremental translation exposes post first and only contiguous comment batches", async () => {
  const raw = rawWithCommentCount(4);
  let releaseFirstBatch;
  const firstBatchGate = new Promise((resolve) => {
    releaseFirstBatch = resolve;
  });
  const translator = {
    translatePost: async (thread) => ({ post: translatedPostPayload(thread) }),
    translateCommentsBatch: async (_thread, _post, batch) => {
      if (batch.batchIndex === 0) {
        await firstBatchGate;
      }
      return { batch: translatedBatchPayload(batch) };
    }
  };

  await withServer({
    name: "incremental-ordered-batches",
    configOverrides: {
      extraEnv: {
        REDDIT_READER_TRANSLATION_BATCH_MAX_COMMENTS: "2",
        REDDIT_READER_TRANSLATION_BATCH_MAX_CHARS: "5000",
        REDDIT_READER_TRANSLATION_CONCURRENCY: "2"
      }
    },
    extractor: async () => ({ thread: raw }),
    translator
  }, async ({ baseUrl, storageDir }) => {
    const post = await requestJson(baseUrl, "POST", "/api/threads", {
      url: "https://www.reddit.com/r/test/comments/demo/english_title/"
    });

    const postOnly = await waitFor(async () => {
      const response = await requestJson(baseUrl, "GET", `/api/view/${post.body.jobId}`, undefined, "");
      if (response.body.translationProgress?.postTranslated && response.body.thread) {
        return response.body;
      }
      return null;
    }, "Timed out waiting for translated post");
    assert.equal(postOnly.status, "translating");
    assert.match(postOnly.thread.post.title, /Перекладений/);
    assert.equal(postOnly.thread.comments.length, 0);

    const outOfOrder = await waitFor(async () => {
      const response = await requestJson(baseUrl, "GET", `/api/view/${post.body.jobId}`, undefined, "");
      const progress = response.body.translationProgress;
      if (progress?.completedBatchCount === 1 && progress.visibleBatchCount === 0) {
        return response.body;
      }
      return null;
    }, "Timed out waiting for out-of-order batch evidence");
    assert.equal(outOfOrder.thread.comments.length, 0);

    releaseFirstBatch();
    const status = await waitForStatus(baseUrl, post.body.jobId, "ready");
    assert.equal(status.translationProgress.visibleBatchCount, 2);
    assert.equal(status.translationProgress.totalBatches, 2);
    assert.equal(status.translationProgress.translatedCommentCount, 4);

    const reader = await requestJson(baseUrl, "GET", `/api/view/${post.body.jobId}`, undefined, "");
    assert.equal(reader.body.thread.comments.length, 4);
    assert.match(reader.body.thread.comments[0].bodyMarkdown, /Перекладений batch 0/);
    assert.match(reader.body.thread.comments[2].bodyMarkdown, /Перекладений batch 1/);
    assert.equal(fs.existsSync(path.join(storageDir, "latest", "translated-batches", "000.json")), true);
    assert.equal(fs.existsSync(path.join(storageDir, "latest", "translated-batches", "001.json")), true);
  });
});

test("incremental initial compact translation exposes post and first comments together", async () => {
  const raw = rawWithCommentCount(4);
  let releaseSecondBatch;
  const secondBatchGate = new Promise((resolve) => {
    releaseSecondBatch = resolve;
  });
  const translator = {
    translateInitialBatch: async (thread, batch) => ({
      initial: translatedInitialCompactPayload(thread, batch),
      codex: codexReport("initial", {
        inputTokens: 80,
        outputTokens: 25,
        cachedInputTokens: 8,
        reasoningTokens: 4,
        totalTokens: 105
      })
    }),
    translateCommentsBatch: async (_thread, _post, batch) => {
      if (batch.batchIndex === 1) {
        await secondBatchGate;
      }
      return {
        batch: translatedCompactBatchPayload(batch),
        codex: codexReport(`batch-${batch.batchIndex}`, {
          inputTokens: 40,
          outputTokens: 12,
          cachedInputTokens: 4,
          reasoningTokens: 2,
          totalTokens: 52
        }, 2000)
      };
    }
  };

  await withServer({
    name: "incremental-initial-compact",
    configOverrides: {
      extraEnv: {
        REDDIT_READER_TRANSLATION_BATCH_MAX_COMMENTS: "2",
        REDDIT_READER_TRANSLATION_BATCH_MAX_CHARS: "5000",
        REDDIT_READER_TRANSLATION_CONCURRENCY: "2"
      }
    },
    extractor: async () => ({ thread: raw }),
    translator
  }, async ({ baseUrl, storageDir }) => {
    const post = await requestJson(baseUrl, "POST", "/api/threads", {
      url: "https://www.reddit.com/r/test/comments/demo/english_title/"
    });

    const firstVisible = await waitFor(async () => {
      const response = await requestJson(baseUrl, "GET", `/api/view/${post.body.jobId}`, undefined, "");
      const progress = response.body.translationProgress;
      if (progress?.postTranslated && progress.visibleBatchCount === 1 && response.body.thread?.comments.length === 2) {
        return response.body;
      }
      return null;
    }, "Timed out waiting for initial compact post and comments");
    assert.equal(firstVisible.status, "translating");
    assert.match(firstVisible.thread.post.title, /Перекладений/);
    assert.equal(firstVisible.thread.comments.length, 2);
    assert.equal(firstVisible.thread.comments[0].author, raw.comments[0].author);
    assert.equal(firstVisible.thread.comments[0].parentId, raw.comments[0].parentId);
    assert.match(firstVisible.thread.comments[0].bodyMarkdown, /Перекладений initial/);
    assert.equal(firstVisible.thread.comments.some((comment) => /English/.test(comment.bodyMarkdown)), false);

    releaseSecondBatch();
    const status = await waitForStatus(baseUrl, post.body.jobId, "ready");
    assert.equal(status.translationProgress.visibleBatchCount, 2);
    assert.equal(status.translationProgress.completedBatchCount, 2);
    assert.equal(status.translationProgress.translatedCommentCount, 4);

    const reader = await requestJson(baseUrl, "GET", `/api/view/${post.body.jobId}`, undefined, "");
    assert.equal(reader.body.thread.comments.length, 4);
    assert.match(reader.body.thread.comments[2].bodyMarkdown, /Перекладений compact batch 1/);

    const profilePath = path.join(storageDir, "latest", "translation-input-profile.json");
    assert.equal(fs.existsSync(profilePath), true);
    const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    assert.equal(profile.publicTelemetrySafe, true);
    assert.equal(profile.compactContracts.initialPostAndFirstBatch, true);
    assert.equal(Number.isFinite(profile.totals.estimatedInitialPlusRemainingInputJsonBytes), true);
    assert.equal(JSON.stringify(profile).includes("English comment"), false);

    const validationReport = JSON.parse(fs.readFileSync(path.join(storageDir, "latest", "validation-report.json"), "utf8"));
    assert.equal(validationReport.codex.initial.batchIndex, 0);
    assert.equal(validationReport.codex.batches[0].batchIndex, 1);
    assert.equal(fs.existsSync(path.join(storageDir, "latest", "initial.translated.json")), true);
    assert.equal(fs.existsSync(path.join(storageDir, "latest", "translated-batches", "000.json")), true);
    assert.equal(fs.existsSync(path.join(storageDir, "latest", "translated-batches", "001.json")), true);
  });
});

test("Codex usage telemetry writes report, rolling history, and public numeric page", async () => {
  let usageSeed = 0;
  const longTranslatedTitle = "Приклад довгого текстового заголовка, який буде акуратно переноситися на кілька рядків без поломки інтерфейсу";
  const translator = {
    translatePost: async (thread) => {
      usageSeed += 1;
      const post = translatedPostPayload(thread);
      post.post.title = longTranslatedTitle;
      return {
        post,
        codex: codexReport("post", {
          inputTokens: 100 + usageSeed,
          outputTokens: 20,
          cachedInputTokens: 10,
          reasoningTokens: 5,
          totalTokens: 120 + usageSeed
        }, usageSeed * 1000)
      };
    },
    translateCommentsBatch: async (_thread, _post, batch) => ({
      batch: translatedBatchPayload(batch),
      codex: codexReport(`batch-${batch.batchIndex}`, {
        inputTokens: 50,
        outputTokens: 10,
        cachedInputTokens: 2,
        reasoningTokens: 3,
        totalTokens: 60
      }, 10000 + batch.batchIndex * 1000)
    })
  };

  await withServer({
    name: "codex-usage-telemetry",
    configOverrides: {
      extraEnv: {
        REDDIT_READER_CODEX_USAGE_HISTORY_LIMIT: "2",
        REDDIT_READER_TRANSLATION_BATCH_MAX_COMMENTS: "2",
        CODEX_REASONING_EFFORT: "medium"
      }
    },
    extractor: async () => ({ thread: rawWithCommentCount(2) }),
    translator
  }, async ({ baseUrl, storageDir }) => {
    let latestJobId = null;
    const jobIds = [];
    for (let index = 0; index < 3; index += 1) {
      const post = await requestJson(baseUrl, "POST", "/api/threads", {
        url: "https://www.reddit.com/r/test/comments/demo/english_title/"
      });
      latestJobId = post.body.jobId;
      jobIds.push(latestJobId);
      await waitForStatus(baseUrl, latestJobId, "ready");
    }

    const reportPath = path.join(storageDir, "latest", "codex-usage-report.json");
    assert.equal(fs.existsSync(reportPath), true);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.publicTelemetrySafe, true);
    assert.equal(report.codex.model, "gpt-5.5");
    assert.equal(report.codex.reasoningEffort, "medium");
    assert.equal(report.usage.totals.available, true);
    assert.equal(report.usage.totals.outputTokens, 30);
    assert.equal(report.comments.translatedCommentCount, 2);

    const status = await getJson(baseUrl, `/api/threads/${latestJobId}/status`);
    assert.equal(status.body.artifactManifest.additionalArtifacts.some((entry) => entry.relativePath === "codex-usage-report.json"), true);

    const unauthApi = await requestJson(baseUrl, "GET", "/api/codex-usage", undefined, "");
    assert.equal(unauthApi.status, 401);
    const basicApi = await fetch(`${baseUrl}/api/codex-usage`, {
      headers: {
        authorization: `Basic ${Buffer.from(`debug:${diagnosticsToken}`).toString("base64")}`
      }
    });
    assert.equal(basicApi.status, 200);
    const api = await requestJson(baseUrl, "GET", "/api/codex-usage", undefined, diagnosticsToken);
    assert.equal(api.status, 200);
    assert.equal(api.body.entries.length, 2);
    assert.equal(api.body.summary.jobCount, 2);
    assert.equal(api.body.summary.totalTokens, 365);
    assert.equal(api.body.summary.outputTokens, 60);
    assert.ok(api.body.entries[0].result.path.startsWith("/results/"));
    assert.ok(api.body.entries[1].result.path.startsWith("/results/"));
    assert.equal(api.body.entries[0].result.translatedTitle, longTranslatedTitle);
    assert.equal(api.body.entries[0].usageTotals.totalTokens, 183);
    const apiText = JSON.stringify(api.body);
    assert.equal(apiText.includes("English comment"), false);
    assert.equal(apiText.includes("English title"), false);
    assert.equal(apiText.includes("reddit.com"), false);
    assert.equal(apiText.includes("codex exec"), false);
    assert.equal(apiText.includes("sourceUrl"), false);

    const unauthPage = await getText(baseUrl, "/codex-usage");
    assert.equal(unauthPage.status, 401);
    const page = await getText(baseUrl, "/codex-usage", diagnosticsToken);
    assert.equal(page.status, 200);
    assert.match(page.text, /Codex usage telemetry/);
    assert.match(page.text, /gpt-5\.5 \/ medium/);
    assert.match(page.text, /data-codex-usage-page/);
    assert.match(page.text, /fetch\("\/api\/codex-usage"/);
    assert.match(page.text, /setInterval\(refresh/);
    assert.match(page.text, /kpi-card/);
    assert.match(page.text, /job-card/);
    assert.match(page.text, /data-job-status="ready"/);
    assert.match(page.text, /warning-chip/);
    assert.match(page.text, /result-title-link/);
    assert.match(page.text, new RegExp(longTranslatedTitle));
    assert.doesNotMatch(page.text, /Open result/);
    assert.match(page.text, /\/results\//);
    assert.match(page.text, /Total tokens/);
    assert.match(page.text, /Warnings/);
    assert.equal(page.text.includes("English comment"), false);
    assert.equal(page.text.includes("reddit.com"), false);

    const unauthCurrentResult = await getText(baseUrl, api.body.entries[0].result.path);
    assert.equal(unauthCurrentResult.status, 401);
    const currentResult = await getText(baseUrl, api.body.entries[0].result.path, diagnosticsToken);
    assert.equal(currentResult.status, 200);
    assert.match(currentResult.text, new RegExp(longTranslatedTitle));
    assert.doesNotMatch(currentResult.text, /English title/);

    const prunedResult = await getText(baseUrl, `/results/${jobIds[0]}`, diagnosticsToken);
    assert.equal(prunedResult.status, 404);
  });
});

test("incremental batch failure finishes ready_with_warning with safe diagnostics", async () => {
  const raw = rawWithCommentCount(6);
  const translator = {
    translatePost: async (thread) => ({ post: translatedPostPayload(thread) }),
    translateCommentsBatch: async (_thread, _post, batch) => {
      if (batch.batchIndex === 1) {
        const error = new Error("codex_nonzero_exit");
        error.status = "translation_failed";
        error.code = "codex_nonzero_exit";
        error.errorMessageSafe = "Codex CLI translation failed.";
        throw error;
      }
      return { batch: translatedBatchPayload(batch) };
    }
  };

  await withServer({
    name: "incremental-batch-failure",
    configOverrides: {
      extraEnv: {
        REDDIT_READER_TRANSLATION_BATCH_MAX_COMMENTS: "2",
        REDDIT_READER_TRANSLATION_CONCURRENCY: "3"
      }
    },
    extractor: async () => ({ thread: raw }),
    translator
  }, async ({ baseUrl }) => {
    const post = await requestJson(baseUrl, "POST", "/api/threads", {
      url: "https://www.reddit.com/r/test/comments/demo/english_title/"
    });

    const status = await waitForStatus(baseUrl, post.body.jobId, "ready_with_warning");
    assert.ok(status.warningCodes.includes("partial_translation"));
    assert.equal(status.translationProgress.totalBatches, 3);
    assert.equal(status.translationProgress.failedBatchCount, 1);
    assert.equal(status.translationProgress.visibleBatchCount, 1);
    assert.equal(status.translationProgress.batchErrors[0].batchIndex, 1);
    assert.equal(status.translationProgress.batchErrors[0].errorCode, "codex_nonzero_exit");

    const reader = await requestJson(baseUrl, "GET", `/api/view/${post.body.jobId}`, undefined, "");
    assert.equal(reader.body.thread.comments.length, 2);
    assert.equal(reader.body.thread.comments.some((comment) => /English/.test(comment.bodyMarkdown)), false);
    assert.equal(Object.prototype.hasOwnProperty.call(reader.body, "artifactManifest"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(reader.body, "redactedLogTail"), false);
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
