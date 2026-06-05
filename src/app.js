const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

const { loadConfig } = require("./config");
const { normalizeRedditUrl } = require("./url");
const {
  appendWorkerLog,
  buildArtifactManifest,
  ensureDir,
  readRedactedLogTail,
  resetDir,
  safeRemoveDir,
  writeJsonArtifact,
  writeManifest
} = require("./artifacts");
const { createExtractorProvider } = require("./extractors");
const { buildCommentBatches, buildTranslationInputProfile, createCodexTranslator } = require("./translator");
const {
  REPORT_FILE: CODEX_USAGE_REPORT_FILE,
  appendCodexUsageHistory,
  buildCodexUsageReport,
  readStaticResultPage,
  readCodexUsageHistory,
  renderCodexUsagePage,
  toSafeCodexUsagePayload,
  writeStaticResultPage
} = require("./codex-usage");
const {
  isTerminalStatus,
  validateExtractedThread,
  validateTranslatedCommentBatch,
  validateTranslatedPost,
  validateTranslatedThread
} = require("./validation");
const { renderReaderPage } = require("./renderer");

function nowIso() {
  return new Date().toISOString();
}

function makeJobId() {
  return crypto.randomBytes(24).toString("base64url");
}

function asTranslator(candidate) {
  if (!candidate) {
    return createCodexTranslator();
  }
  if (typeof candidate === "function") {
    return { translate: candidate };
  }
  return {
    translate: candidate.translate || candidate.translateFull,
    translatePost: candidate.translatePost,
    translateInitialBatch: candidate.translateInitialBatch,
    translateCommentsBatch: candidate.translateCommentsBatch
  };
}

function errorPayload(errorCode, errorMessageSafe) {
  return { errorCode, errorMessageSafe };
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function toSafeTranslationProgress(progress) {
  if (!progress || typeof progress !== "object") {
    return null;
  }
  return {
    mode: progress.mode || "incremental",
    stage: progress.stage || null,
    postTranslated: Boolean(progress.postTranslated),
    translatedCommentCount: progress.translatedCommentCount || 0,
    totalCommentCount: progress.totalCommentCount || 0,
    visibleBatchCount: progress.visibleBatchCount || 0,
    completedBatchCount: progress.completedBatchCount || 0,
    failedBatchCount: progress.failedBatchCount || 0,
    inFlightBatchCount: progress.inFlightBatchCount || 0,
    totalBatches: progress.totalBatches || 0,
    currentBatch: progress.currentBatch || 0,
    progressPercent: progress.progressPercent || 0,
    batchMaxComments: progress.batchMaxComments || 0,
    batchMaxChars: progress.batchMaxChars || 0,
    concurrency: progress.concurrency || 0,
    batchTimeoutMs: progress.batchTimeoutMs || 0,
    batchErrors: Array.isArray(progress.batchErrors)
      ? progress.batchErrors.map((error) => ({
        batchIndex: error.batchIndex,
        errorCode: error.errorCode || "translation_failed",
        errorMessageSafe: error.errorMessageSafe || "Comment batch translation failed."
      }))
      : []
  };
}

function tokenFromHeader(req) {
  const header = req.get("authorization") || "";
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  if (bearer) {
    return bearer[1];
  }
  const basic = header.match(/^Basic\s+(.+)$/i);
  if (!basic) {
    return "";
  }
  try {
    const decoded = Buffer.from(basic[1], "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator === -1) {
      return decoded;
    }
    return decoded.slice(separator + 1);
  } catch (_error) {
    return "";
  }
}

function authMiddleware(expectedToken, authName) {
  return (req, res, next) => {
    if (!expectedToken) {
      res.status(503).json(errorPayload(`${authName}_token_not_configured`, "Bearer token is not configured on the server."));
      return;
    }
    if (tokenFromHeader(req) !== expectedToken) {
      res.set("WWW-Authenticate", `Basic realm="Aetridder ${authName}", charset="UTF-8"`);
      res.status(401).json(errorPayload("unauthorized", "Authorization header is required."));
      return;
    }
    next();
  };
}

function publicOrAuth(isPublic, auth) {
  return (req, res, next) => {
    if (isPublic) {
      next();
      return;
    }
    auth(req, res, next);
  };
}

function withTimeout(promise, timeoutMs, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(code);
      error.code = code;
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function toSafeStatus(job, state) {
  return {
    jobId: job.jobId,
    status: job.status,
    sourceUrl: job.sourceUrl,
    normalizedUrl: job.normalizedUrl || undefined,
    finalUrlAfterRedirect: job.finalUrlAfterRedirect || undefined,
    targetLanguage: {
      code: job.targetLanguageCode || state.config.targetLanguageCode,
      name: job.targetLanguageName || state.config.targetLanguageName
    },
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    stageTimestamps: job.stageTimestamps,
    warningCodes: job.warningCodes || [],
    errorCode: job.errorCode || null,
    errorMessageSafe: job.errorMessageSafe || null,
    artifactManifest: job.artifactManifest || buildArtifactManifest(path.join(state.config.storageDir, "latest")),
    translationProgress: toSafeTranslationProgress(job.translationProgress),
    extractor: job.extractorReport ? {
      provider: job.extractorReport.extractorProvider,
      protocolVersion: job.extractorReport.protocolVersion,
      agentVersion: job.extractorReport.agentVersion,
      durationMs: job.extractorReport.durationMs,
      metrics: job.extractorReport.metrics,
      warningCodes: job.extractorReport.warningCodes,
      errorCode: job.extractorReport.errorCode || null
    } : null,
    isCurrentLatestJob: state.currentJobId === job.jobId && state.generation === job.generation
  };
}

function toReaderPayload(job, isCurrentLatestJob = false) {
  if (!job) {
    return {
      status: "expired",
      warningCodes: [],
      errorMessageSafe: "This link is no longer available.",
      thread: null,
      translationProgress: null,
      commentSummary: {
        translatedCommentCount: 0,
        extractedCommentCount: 0,
        totalCommentCount: 0
      },
      metadata: {
        isCurrentLatestJob: false
      }
    };
  }
  return {
    jobId: job.jobId,
    status: job.status,
    warningCodes: job.warningCodes || [],
    errorMessageSafe: job.errorMessageSafe || null,
    thread: job.translatedThread && ["translating", "validating", "ready", "ready_with_warning"].includes(job.status)
      ? job.translatedThread
      : null,
    translationProgress: toSafeTranslationProgress(job.translationProgress),
    commentSummary: {
      translatedCommentCount: job.translatedThread && Array.isArray(job.translatedThread.comments)
        ? job.translatedThread.comments.length
        : 0,
      extractedCommentCount: job.rawThread && Array.isArray(job.rawThread.comments)
        ? job.rawThread.comments.length
        : 0,
      totalCommentCount: job.extractorReport && job.extractorReport.metrics
        ? job.extractorReport.metrics.totalCommentCount || 0
        : 0
    },
    metadata: {
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      targetLanguage: {
        code: job.targetLanguageCode || null,
        name: job.targetLanguageName || null
      },
      isCurrentLatestJob
    }
  };
}

function createJob(sourceUrl, normalizedUrl, generation, config = {}) {
  const timestamp = nowIso();
  return {
    jobId: makeJobId(),
    generation,
    status: "queued",
    sourceUrl,
    normalizedUrl,
    finalUrlAfterRedirect: null,
    targetLanguageCode: config.targetLanguageCode || "uk",
    targetLanguageName: config.targetLanguageName || "Ukrainian",
    createdAt: timestamp,
    updatedAt: timestamp,
    stageTimestamps: { queued: timestamp },
    warningCodes: [],
    errorCode: null,
    errorMessageSafe: null,
    artifactManifest: null,
    extractorReport: null,
    rawThread: null,
    translatedThread: null,
    translationProgress: null
  };
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function createApp(options = {}) {
  const config = options.config || loadConfig(options);
  const extractorProvider = createExtractorProvider(config, options.extractor);
  const translate = asTranslator(options.translator);
  const app = express();
  const latestDir = path.join(config.storageDir, "latest");
  const workRoot = path.join(config.storageDir, "work");
  const state = {
    config,
    currentJobId: null,
    generation: 0,
    jobs: new Map(),
    workerHeartbeat: null,
    lastError: null
  };

  function persistStateSnapshot() {
    const currentJob = state.currentJobId ? state.jobs.get(state.currentJobId) : null;
    return writeJsonArtifact(config.storageDir, "latest-job-state.json", {
      schemaVersion: "aetridder.latest-job-state.v1",
      persistedAt: nowIso(),
      currentJobId: state.currentJobId,
      generation: state.generation,
      job: currentJob ? toSafeStatus(currentJob, state) : null,
      storage: {
        latestJobArtifactsOnly: true
      }
    }, config);
  }

  function hydrateLatestJobFromSnapshot() {
    const snapshot = readJsonIfExists(path.join(config.storageDir, "latest-job-state.json"));
    if (!snapshot || !snapshot.currentJobId || !snapshot.job) {
      return;
    }

    const rawThread = readJsonIfExists(path.join(latestDir, "thread.raw.json"));
    const translatedThread = readJsonIfExists(path.join(latestDir, "thread.translated.json"));
    const restoredJob = {
      ...snapshot.job,
      generation: snapshot.generation || 0,
      rawThread,
      translatedThread: ["ready", "ready_with_warning"].includes(snapshot.job.status) ? translatedThread : null,
      artifactManifest: buildArtifactManifest(latestDir)
    };
    if (["ready", "ready_with_warning"].includes(restoredJob.status) && !restoredJob.translatedThread) {
      restoredJob.status = "expired";
      restoredJob.errorCode = "latest_artifact_missing_after_restart";
      restoredJob.errorMessageSafe = "This link is no longer available.";
      restoredJob.warningCodes = restoredJob.warningCodes || [];
    }

    state.currentJobId = snapshot.currentJobId;
    state.generation = snapshot.generation || restoredJob.generation || 0;
    state.jobs.set(restoredJob.jobId, restoredJob);
    state.workerHeartbeat = {
      activeJobId: null,
      status: restoredJob.status,
      lastSeenAt: nowIso()
    };
  }

  ensureDir(config.storageDir);
  ensureDir(latestDir);
  ensureDir(workRoot);
  hydrateLatestJobFromSnapshot();
  persistStateSnapshot();

  app.use(express.json({ limit: `${config.maxInputChars}b` }));

  function isCurrent(job) {
    return state.currentJobId === job.jobId && state.generation === job.generation;
  }

  function touch(job, status, extra = {}) {
    if (!isCurrent(job)) {
      return false;
    }
    const timestamp = nowIso();
    job.status = status;
    job.updatedAt = timestamp;
    job.stageTimestamps[status] = timestamp;
    Object.assign(job, extra);
    state.workerHeartbeat = {
      activeJobId: job.jobId,
      status,
      lastSeenAt: timestamp
    };
    persistStateSnapshot();
    return true;
  }

  function failCurrentJob(job, status, errorCode, errorMessageSafe) {
    if (!isCurrent(job)) {
      return false;
    }
    const timestamp = nowIso();
    job.status = status;
    job.updatedAt = timestamp;
    job.stageTimestamps[status] = timestamp;
    job.errorCode = errorCode;
    job.errorMessageSafe = errorMessageSafe;
    state.lastError = {
      jobId: job.jobId,
      errorCode,
      errorMessageSafe,
      at: timestamp
    };
    state.workerHeartbeat = {
      activeJobId: job.jobId,
      status,
      lastSeenAt: timestamp
    };
    persistStateSnapshot();
    return true;
  }

  function publishArtifacts(job, workDir) {
    if (!isCurrent(job)) {
      return false;
    }
    resetDir(config.storageDir, latestDir);
    if (fs.existsSync(workDir)) {
      for (const entry of fs.readdirSync(workDir)) {
        fs.cpSync(path.join(workDir, entry), path.join(latestDir, entry), { recursive: true });
      }
    }
    job.artifactManifest = writeManifest(latestDir, config);
    persistStateSnapshot();
    return true;
  }

  function writeValidationReport(workDir, report) {
    writeJsonArtifact(workDir, "validation-report.json", report, config);
  }

  function recordCodexUsage(job, workDir, report) {
    const staticResult = ["ready", "ready_with_warning"].includes(job.status) && job.translatedThread
      ? writeStaticResultPage(config.storageDir, job, renderReaderPage(job), config)
      : null;
    const usageReport = buildCodexUsageReport(job, report, config, staticResult);
    if (!usageReport) {
      return null;
    }
    writeJsonArtifact(workDir, CODEX_USAGE_REPORT_FILE, usageReport, config);
    appendCodexUsageHistory(config.storageDir, usageReport, config);
    return usageReport;
  }

  function statusFromThrown(error, fallbackStatus) {
    if (error.code === "extraction_timeout" || error.code === "translation_timeout" || error.code === "total_job_timeout") {
      return "timeout";
    }
    if (error.status && [
      "invalid_url",
      "extraction_unavailable",
      "reddit_unavailable",
      "extraction_failed",
      "translation_failed",
      "validation_failed",
      "timeout"
    ].includes(error.status)) {
      return error.status;
    }
    return fallbackStatus;
  }

  function writeTranslationProgress(workDir, job) {
    if (job.translationProgress) {
      writeJsonArtifact(workDir, "translation-progress.json", toSafeTranslationProgress(job.translationProgress), config);
    }
    if (job.translatedThread) {
      writeJsonArtifact(workDir, "thread.translated.partial.json", job.translatedThread, config);
    }
  }

  function updateTranslationProgress(job, workDir, patch = {}) {
    if (!isCurrent(job)) {
      return false;
    }
    const timestamp = nowIso();
    job.updatedAt = timestamp;
    job.translationProgress = {
      ...(job.translationProgress || {}),
      ...patch
    };
    state.workerHeartbeat = {
      activeJobId: job.jobId,
      status: job.status,
      lastSeenAt: timestamp
    };
    writeTranslationProgress(workDir, job);
    persistStateSnapshot();
    return true;
  }

  function translatedThreadFromParts(rawThread, translatedPost, comments, warningCodes) {
    return {
      schemaVersion: "aetridder.translated-thread.v1",
      language: config.targetLanguageCode,
      translatedAt: nowIso(),
      sourceUrl: rawThread.sourceUrl,
      normalizedUrl: rawThread.normalizedUrl,
      finalUrlAfterRedirect: rawThread.finalUrlAfterRedirect,
      post: translatedPost,
      comments,
      warningCodes: unique(warningCodes)
    };
  }

  function progressForBatches(job, batches, batchResults, patch = {}) {
    let visibleBatchCount = 0;
    const visibleComments = [];
    while (visibleBatchCount < batches.length && batchResults[visibleBatchCount] && batchResults[visibleBatchCount].ok) {
      visibleComments.push(...batchResults[visibleBatchCount].comments);
      visibleBatchCount += 1;
    }
    const completedBatchCount = batchResults.filter((result) => result && result.ok).length;
    const failed = batchResults.filter((result) => result && !result.ok);
    const totalBatches = batches.length;
    const progressPercent = totalBatches === 0 ? 100 : Math.floor((visibleBatchCount / totalBatches) * 100);
    return {
      ...job.translationProgress,
      ...patch,
      visibleBatchCount,
      completedBatchCount,
      failedBatchCount: failed.length,
      translatedCommentCount: visibleComments.length,
      currentBatch: visibleBatchCount,
      progressPercent,
      batchErrors: failed.map((result) => ({
        batchIndex: result.batchIndex,
        errorCode: result.errorCode,
        errorMessageSafe: result.errorMessageSafe
      }))
    };
  }

  function safeBatchError(error, batchIndex) {
    return {
      ok: false,
      batchIndex,
      errorCode: error.errorCode || error.code || "batch_translation_failed",
      errorMessageSafe: error.errorMessageSafe || "Comment batch translation failed."
    };
  }

  async function translateLegacy(rawThread, job, workDir, validationReport, deadline) {
    const translated = await withTimeout(
      Promise.resolve(translate.translate(rawThread, { config, workDir, log: (line) => appendWorkerLog(workDir, line, config) })),
      Math.max(1, Math.min(config.translationTimeoutMs, deadline - Date.now())),
      "translation_timeout"
    );
    if (!isCurrent(job)) {
      return null;
    }
    const translatedCandidate = translated.thread || translated;
    if (translated.codex) {
      validationReport.codex = translated.codex;
    }
    writeJsonArtifact(workDir, "thread.translated.json", translatedCandidate, config);
    return translatedCandidate;
  }

  async function translateIncremental(rawThread, job, workDir, validationReport, deadline) {
    const batches = buildCommentBatches(rawThread.comments, config);
    const batchResults = new Array(batches.length);
    validationReport.codex = {
      mode: "incremental",
      initial: null,
      post: null,
      batches: []
    };
    writeJsonArtifact(workDir, "translation-input-profile.json", buildTranslationInputProfile(rawThread, batches, config), config);

    job.translationProgress = {
      mode: "incremental",
      stage: translate.translateInitialBatch && batches.length > 0 ? "initial" : "post",
      postTranslated: false,
      translatedCommentCount: 0,
      totalCommentCount: rawThread.comments.length,
      visibleBatchCount: 0,
      completedBatchCount: 0,
      failedBatchCount: 0,
      inFlightBatchCount: 0,
      totalBatches: batches.length,
      currentBatch: 0,
      progressPercent: batches.length === 0 ? 100 : 0,
      batchMaxComments: config.translationBatchMaxComments,
      batchMaxChars: config.translationBatchMaxChars,
      concurrency: config.translationConcurrency,
      batchTimeoutMs: config.codexBatchTimeoutMs,
      batchErrors: []
    };
    updateTranslationProgress(job, workDir);

    let postValidation;
    let nextBatch = 0;
    if (translate.translateInitialBatch && batches.length > 0) {
      const initialResult = await withTimeout(
        Promise.resolve(translate.translateInitialBatch(rawThread, batches[0], {
          config,
          workDir,
          log: (line) => appendWorkerLog(workDir, line, config)
        })),
        Math.max(1, Math.min(config.codexBatchTimeoutMs, deadline - Date.now())),
        "translation_timeout"
      );
      if (!isCurrent(job)) {
        return null;
      }
      const initialCandidate = initialResult.initial || initialResult.thread || initialResult;
      if (initialResult.codex) {
        validationReport.codex.initial = {
          ...initialResult.codex,
          batchIndex: batches[0].batchIndex
        };
      }
      writeJsonArtifact(workDir, "initial.translated.json", initialCandidate, config);
      const postCandidate = {
        schemaVersion: "aetridder.translated-post.v1",
        language: initialCandidate.language,
        translatedAt: initialCandidate.translatedAt,
        post: initialCandidate.post,
        warningCodes: initialCandidate.warningCodes || []
      };
      writeJsonArtifact(workDir, "post.translated.json", postCandidate, config);
      postValidation = validateTranslatedPost(postCandidate, rawThread, config);
      validationReport.checks.push({
        name: "translated_post_schema_and_invariants",
        ok: postValidation.ok,
        errorCode: postValidation.errorCode || null
      });
      if (!postValidation.ok) {
        const error = new Error(postValidation.errorCode);
        error.status = "validation_failed";
        error.errorCode = postValidation.errorCode;
        error.errorMessageSafe = postValidation.errorMessageSafe;
        throw error;
      }

      const batchCandidate = {
        schemaVersion: "aetridder.translated-comment-batch.v1",
        language: initialCandidate.language,
        translatedAt: initialCandidate.translatedAt,
        batchIndex: initialCandidate.batchIndex ?? batches[0].batchIndex,
        totalBatches: initialCandidate.totalBatches ?? batches[0].totalBatches,
        comments: initialCandidate.comments || [],
        warningCodes: initialCandidate.warningCodes || []
      };
      writeJsonArtifact(path.join(workDir, "translated-batches"), "000.json", batchCandidate, config);
      const batchValidation = validateTranslatedCommentBatch(
        batchCandidate,
        batches[0].comments,
        batches[0].batchIndex,
        batches[0].totalBatches,
        config
      );
      validationReport.checks.push({
        name: "translated_comment_batch_000",
        ok: batchValidation.ok,
        errorCode: batchValidation.errorCode || null
      });
      if (batchValidation.ok) {
        batchResults[0] = {
          ok: true,
          batchIndex: 0,
          comments: batchValidation.comments,
          warningCodes: batchValidation.warningCodes
        };
      } else {
        batchResults[0] = {
          ok: false,
          batchIndex: 0,
          errorCode: batchValidation.errorCode,
          errorMessageSafe: batchValidation.errorMessageSafe
        };
      }

      job.warningCodes = unique([
        ...postValidation.warningCodes,
        ...(batchValidation.ok ? batchValidation.warningCodes : ["partial_translation"])
      ]);
      const initialProgress = progressForBatches(job, batches, batchResults, {
        stage: "comments",
        postTranslated: true,
        totalCommentCount: rawThread.comments.length,
        totalBatches: batches.length,
        inFlightBatchCount: 0
      });
      const visibleComments = [];
      for (let index = 0; index < initialProgress.visibleBatchCount; index += 1) {
        visibleComments.push(...batchResults[index].comments);
      }
      job.translatedThread = translatedThreadFromParts(rawThread, postValidation.post, visibleComments, job.warningCodes);
      updateTranslationProgress(job, workDir, initialProgress);
      nextBatch = 1;
    } else {
      const postResult = await withTimeout(
        Promise.resolve(translate.translatePost(rawThread, { config, workDir, log: (line) => appendWorkerLog(workDir, line, config) })),
        Math.max(1, Math.min(config.codexBatchTimeoutMs, deadline - Date.now())),
        "translation_timeout"
      );
      if (!isCurrent(job)) {
        return null;
      }
      const postCandidate = postResult.post || postResult.thread || postResult;
      if (postResult.codex) {
        validationReport.codex.post = postResult.codex;
      }
      writeJsonArtifact(workDir, "post.translated.json", postCandidate, config);
      postValidation = validateTranslatedPost(postCandidate, rawThread, config);
      validationReport.checks.push({
        name: "translated_post_schema_and_invariants",
        ok: postValidation.ok,
        errorCode: postValidation.errorCode || null
      });
      if (!postValidation.ok) {
        const error = new Error(postValidation.errorCode);
        error.status = "validation_failed";
        error.errorCode = postValidation.errorCode;
        error.errorMessageSafe = postValidation.errorMessageSafe;
        throw error;
      }

      job.warningCodes = unique(postValidation.warningCodes);
      job.translatedThread = translatedThreadFromParts(rawThread, postValidation.post, [], job.warningCodes);
      updateTranslationProgress(job, workDir, {
        stage: batches.length > 0 ? "comments" : "complete",
        postTranslated: true,
        progressPercent: batches.length === 0 ? 100 : 0
      });
    }

    if (batches.length === 0) {
      return job.translatedThread;
    }

    let inFlightBatchCount = 0;
    const concurrency = Math.min(config.translationConcurrency, batches.length);

    const refreshVisibleThread = (patch = {}) => {
      const progress = progressForBatches(job, batches, batchResults, {
        ...patch,
        stage: "comments",
        postTranslated: true,
        totalCommentCount: rawThread.comments.length,
        totalBatches: batches.length,
        inFlightBatchCount
      });
      const visibleComments = [];
      for (let index = 0; index < progress.visibleBatchCount; index += 1) {
        visibleComments.push(...batchResults[index].comments);
      }
      const warningCodes = unique([
        ...job.warningCodes,
        ...(progress.failedBatchCount > 0 ? ["partial_translation"] : [])
      ]);
      job.warningCodes = warningCodes;
      job.translatedThread = translatedThreadFromParts(rawThread, postValidation.post, visibleComments, warningCodes);
      updateTranslationProgress(job, workDir, progress);
    };

    async function runOneBatch(batch) {
      inFlightBatchCount += 1;
      refreshVisibleThread();
      try {
        const result = await withTimeout(
          Promise.resolve(translate.translateCommentsBatch(rawThread, postValidation.post, batch, {
            config,
            workDir,
            log: (line) => appendWorkerLog(workDir, line, config)
          })),
          Math.max(1, Math.min(config.codexBatchTimeoutMs, deadline - Date.now())),
          "translation_timeout"
        );
        if (!isCurrent(job)) {
          return;
        }
        const batchCandidate = result.batch || result.thread || result;
        if (result.codex) {
          validationReport.codex.batches.push({
            ...result.codex,
            batchIndex: batch.batchIndex
          });
        }
        writeJsonArtifact(path.join(workDir, "translated-batches"), `${String(batch.batchIndex).padStart(3, "0")}.json`, batchCandidate, config);
        const batchValidation = validateTranslatedCommentBatch(
          batchCandidate,
          batch.comments,
          batch.batchIndex,
          batch.totalBatches,
          config
        );
        validationReport.checks.push({
          name: `translated_comment_batch_${String(batch.batchIndex).padStart(3, "0")}`,
          ok: batchValidation.ok,
          errorCode: batchValidation.errorCode || null
        });
        if (!batchValidation.ok) {
          batchResults[batch.batchIndex] = {
            ok: false,
            batchIndex: batch.batchIndex,
            errorCode: batchValidation.errorCode,
            errorMessageSafe: batchValidation.errorMessageSafe
          };
          return;
        }
        batchResults[batch.batchIndex] = {
          ok: true,
          batchIndex: batch.batchIndex,
          comments: batchValidation.comments,
          warningCodes: batchValidation.warningCodes
        };
      } catch (error) {
        if (isCurrent(job)) {
          batchResults[batch.batchIndex] = safeBatchError(error, batch.batchIndex);
          validationReport.checks.push({
            name: `translated_comment_batch_${String(batch.batchIndex).padStart(3, "0")}`,
            ok: false,
            errorCode: batchResults[batch.batchIndex].errorCode
          });
        }
      } finally {
        inFlightBatchCount -= 1;
        if (isCurrent(job)) {
          refreshVisibleThread();
        }
      }
    }

    async function workerLoop() {
      while (isCurrent(job)) {
        const batchIndex = nextBatch;
        nextBatch += 1;
        if (batchIndex >= batches.length) {
          return;
        }
        await runOneBatch(batches[batchIndex]);
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => workerLoop()));
    if (!isCurrent(job)) {
      return null;
    }

    const finalProgress = progressForBatches(job, batches, batchResults, {
      stage: "complete",
      inFlightBatchCount: 0
    });
    const visibleComments = [];
    for (let index = 0; index < finalProgress.visibleBatchCount; index += 1) {
      visibleComments.push(...batchResults[index].comments);
    }
    const finalWarnings = unique([
      ...job.warningCodes,
      ...(finalProgress.visibleBatchCount < batches.length ? ["partial_translation"] : [])
    ]);
    job.warningCodes = finalWarnings;
    job.translatedThread = translatedThreadFromParts(rawThread, postValidation.post, visibleComments, finalWarnings);
    updateTranslationProgress(job, workDir, {
      ...finalProgress,
      stage: "complete"
    });
    return job.translatedThread;
  }

  async function processJob(job) {
    const workDir = path.join(workRoot, job.jobId);
    const deadline = Date.now() + config.totalJobTimeoutMs;
    const validationReport = {
      schemaVersion: "aetridder.validation-report.v1",
      jobId: job.jobId,
      startedAt: nowIso(),
      targetLanguage: {
        code: config.targetLanguageCode,
        name: config.targetLanguageName
      },
      checks: [],
      extractor: null,
      codex: null
    };

    resetDir(config.storageDir, workDir);
    appendWorkerLog(workDir, `job ${job.jobId} started`, config);

    function remaining(stageLimit) {
      return Math.max(1, Math.min(stageLimit, deadline - Date.now()));
    }

    try {
      if (!touch(job, "extracting")) {
        return;
      }
      const extracted = await withTimeout(
        Promise.resolve(extractorProvider.extract(job, { config, workDir, log: (line) => appendWorkerLog(workDir, line, config) })),
        remaining(config.extractionTimeoutMs),
        "extraction_timeout"
      );
      if (!isCurrent(job)) {
        return;
      }
      if (extracted.extractorReport) {
        job.extractorReport = extracted.extractorReport;
        validationReport.extractor = extracted.extractorReport;
        writeJsonArtifact(workDir, "extractor-report.json", extracted.extractorReport, config);
      }

      const extractionValidation = validateExtractedThread(extracted.thread || extracted, config);
      validationReport.checks.push({
        name: "extracted_thread_schema_and_usability",
        ok: extractionValidation.ok,
        errorCode: extractionValidation.errorCode || null
      });
      if (!extractionValidation.ok) {
        failCurrentJob(job, "extraction_failed", extractionValidation.errorCode, extractionValidation.errorMessageSafe);
        writeValidationReport(workDir, validationReport);
        publishArtifacts(job, workDir);
        return;
      }

      const rawThread = extractionValidation.thread;
      job.normalizedUrl = rawThread.normalizedUrl || job.normalizedUrl;
      job.finalUrlAfterRedirect = rawThread.finalUrlAfterRedirect || null;
      job.warningCodes = rawThread.warningCodes;
      job.rawThread = rawThread;
      writeJsonArtifact(workDir, "thread.raw.json", rawThread, config);

      if (!touch(job, "extracted")) {
        return;
      }
      if (Date.now() >= deadline) {
        const error = new Error("total_job_timeout");
        error.code = "total_job_timeout";
        throw error;
      }

      if (!touch(job, "translating")) {
        return;
      }
      const translatedCandidate = translate.translateCommentsBatch && (translate.translateInitialBatch || translate.translatePost)
        ? await translateIncremental(rawThread, job, workDir, validationReport, deadline)
        : await translateLegacy(rawThread, job, workDir, validationReport, deadline);
      if (!isCurrent(job)) {
        return;
      }
      if (!translatedCandidate) {
        return;
      }

      if (!touch(job, "validating")) {
        return;
      }
      const translationValidation = validateTranslatedThread(translatedCandidate, rawThread, {
        allowPartialComments: Boolean(job.translationProgress),
        targetLanguageCode: config.targetLanguageCode
      });
      validationReport.checks.push({
        name: "translated_thread_schema_and_invariants",
        ok: translationValidation.ok,
        errorCode: translationValidation.errorCode || null
      });
      if (!translationValidation.ok) {
        validationReport.completedAt = nowIso();
        validationReport.ok = false;
        validationReport.errorCode = translationValidation.errorCode;
        failCurrentJob(job, "validation_failed", translationValidation.errorCode, translationValidation.errorMessageSafe);
        writeValidationReport(workDir, validationReport);
        recordCodexUsage(job, workDir, validationReport);
        publishArtifacts(job, workDir);
        return;
      }

      job.translatedThread = translationValidation.thread;
      job.warningCodes = translationValidation.thread.warningCodes;
      writeJsonArtifact(workDir, "thread.translated.json", translationValidation.thread, config);
      validationReport.completedAt = nowIso();
      validationReport.ok = true;
      writeValidationReport(workDir, validationReport);
      const readyStatus = job.warningCodes.length > 0 ? "ready_with_warning" : "ready";
      touch(job, readyStatus);
      recordCodexUsage(job, workDir, validationReport);
      publishArtifacts(job, workDir);
    } catch (error) {
      if (isCurrent(job)) {
        const status = statusFromThrown(error, "translation_failed");
        const code = error.errorCode || error.code || status;
        const safe = error.errorMessageSafe || "The worker could not complete this job.";
        if (error.extractorReport) {
          job.extractorReport = error.extractorReport;
          validationReport.extractor = error.extractorReport;
          writeJsonArtifact(workDir, "extractor-report.json", error.extractorReport, config);
        }
        if (error.codex) {
          validationReport.codex = error.codex;
        }
        appendWorkerLog(workDir, `job failed with ${code}`, config);
        validationReport.completedAt = nowIso();
        validationReport.ok = false;
        validationReport.errorCode = code;
        writeValidationReport(workDir, validationReport);
        failCurrentJob(job, status, code, safe);
        recordCodexUsage(job, workDir, validationReport);
        publishArtifacts(job, workDir);
      }
    } finally {
      if (isCurrent(job)) {
        state.workerHeartbeat = {
          activeJobId: null,
          status: job.status,
          lastSeenAt: nowIso()
        };
        persistStateSnapshot();
      }
      safeRemoveDir(config.storageDir, workDir);
    }
  }

  function scheduleJob(job) {
    if (options.autoStartWorker === false) {
      return;
    }
    setImmediate(() => {
      processJob(job).catch((error) => {
        state.lastError = {
          jobId: job.jobId,
          errorCode: error.code || "worker_unhandled_error",
          errorMessageSafe: "The worker failed unexpectedly.",
          at: nowIso()
        };
      });
    });
  }

  const requireApiAuth = authMiddleware(config.apiToken, "api");
  const requireDiagnosticsAuth = authMiddleware(config.diagnosticsToken || config.apiToken, "diagnostics");
  const requireDebugPageAuth = publicOrAuth(config.publicDebugPages, requireDiagnosticsAuth);

  app.post("/api/threads", requireApiAuth, (req, res) => {
    const sourceUrl = req.body && (req.body.url || req.body.redditUrl);
    const normalized = normalizeRedditUrl(sourceUrl, config.allowedHosts);
    if (!normalized.ok) {
      res.status(400).json(errorPayload(normalized.errorCode, normalized.errorMessageSafe));
      return;
    }

    if (state.currentJobId) {
      const previous = state.jobs.get(state.currentJobId);
      if (previous && previous.status !== "replaced") {
        const timestamp = nowIso();
        previous.status = "replaced";
        previous.updatedAt = timestamp;
        previous.stageTimestamps.replaced = timestamp;
        previous.errorCode = null;
        previous.errorMessageSafe = null;
        previous.rawThread = null;
        previous.translatedThread = null;
      }
    }

    state.generation += 1;
    const job = createJob(sourceUrl, normalized.normalizedUrl, state.generation, config);
    state.currentJobId = job.jobId;
    state.jobs.set(job.jobId, job);
    resetDir(config.storageDir, latestDir);
    persistStateSnapshot();

    const baseUrl = config.publicBaseUrl || `${req.protocol}://${req.get("host")}`;
    const viewUrl = `${baseUrl}/t/${job.jobId}`;
    scheduleJob(job);
    res.status(202).json({ jobId: job.jobId, viewUrl });
  });

  app.get("/api/view/:jobId", (req, res) => {
    const job = state.jobs.get(req.params.jobId) || null;
    res.json(toReaderPayload(job, job ? isCurrent(job) : false));
  });

  app.get("/api/codex-usage", requireDebugPageAuth, (_req, res) => {
    res.json(toSafeCodexUsagePayload(readCodexUsageHistory(config.storageDir), config));
  });

  app.get("/codex-usage", requireDebugPageAuth, (_req, res) => {
    res.type("html").send(renderCodexUsagePage(readCodexUsageHistory(config.storageDir), config));
  });

  app.get("/results/:resultId", requireDebugPageAuth, (req, res) => {
    const html = readStaticResultPage(config.storageDir, req.params.resultId);
    if (!html) {
      res.status(404).type("text").send("Saved result not found.");
      return;
    }
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.type("html").send(html);
  });

  app.get("/api/threads/:jobId/status", requireDiagnosticsAuth, (req, res) => {
    const job = state.jobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json(errorPayload("expired", "The requested job is no longer available."));
      return;
    }
    res.json(toSafeStatus(job, state));
  });

  app.get("/api/diagnostics/health", requireDiagnosticsAuth, (_req, res) => {
    const currentJob = state.currentJobId ? state.jobs.get(state.currentJobId) : null;
    res.json({
      ok: true,
      storage: {
        reachable: fs.existsSync(config.storageDir),
        latestArtifactsOnly: true
      },
      workerHeartbeat: state.workerHeartbeat,
      queue: {
        model: "single_slot_latest_job",
        currentJobId: state.currentJobId,
        length: currentJob && !isTerminalStatus(currentJob.status) ? 1 : 0
      },
      currentJob: currentJob ? toSafeStatus(currentJob, state) : null,
      extractor: typeof extractorProvider.diagnostics === "function"
        ? extractorProvider.diagnostics()
        : { configuredProvider: config.extractorProvider },
      lastError: state.lastError,
      artifactManifest: currentJob ? currentJob.artifactManifest || buildArtifactManifest(latestDir) : buildArtifactManifest(latestDir),
      redactedLogTail: readRedactedLogTail(latestDir, config)
    });
  });

  app.get("/api/diagnostics/extractor", requireDiagnosticsAuth, (_req, res) => {
    res.json({
      schemaVersion: "aetridder.extractor-diagnostics.v1",
      extractionMode: config.extractionMode,
      configuredProvider: config.extractorProvider,
      diagnostics: typeof extractorProvider.diagnostics === "function"
        ? extractorProvider.diagnostics()
        : { configuredProvider: config.extractorProvider }
    });
  });

  app.get("/api/diagnostics/job", requireDiagnosticsAuth, (_req, res) => {
    const currentJob = state.currentJobId ? state.jobs.get(state.currentJobId) : null;
    res.json({
      currentJob: currentJob ? toSafeStatus(currentJob, state) : null,
      workerHeartbeat: state.workerHeartbeat,
      lastError: state.lastError
    });
  });

  app.get("/api/diagnostics/artifacts", requireDiagnosticsAuth, (_req, res) => {
    res.json({
      artifactManifest: buildArtifactManifest(latestDir),
      redactedLogTail: readRedactedLogTail(latestDir, config)
    });
  });

  app.get("/t/:jobId", (req, res) => {
    const job = state.jobs.get(req.params.jobId) || null;
    res.type("html").send(renderReaderPage(job));
  });

  return {
    app,
    config,
    state,
    extractorProvider,
    processJob,
    toSafeStatus: (job) => toSafeStatus(job, state)
  };
}

module.exports = {
  createApp
};
