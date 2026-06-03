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
const { extractWithPlaywright } = require("./extractor");
const { translateWithCodexCli } = require("./translator");
const { isTerminalStatus, validateExtractedThread, validateTranslatedThread } = require("./validation");
const { renderReaderPage } = require("./renderer");

function nowIso() {
  return new Date().toISOString();
}

function makeJobId() {
  return crypto.randomBytes(24).toString("base64url");
}

function asExtractor(candidate) {
  if (!candidate) {
    return extractWithPlaywright;
  }
  return typeof candidate === "function" ? candidate : candidate.extract;
}

function asTranslator(candidate) {
  if (!candidate) {
    return translateWithCodexCli;
  }
  return typeof candidate === "function" ? candidate : candidate.translate;
}

function errorPayload(errorCode, errorMessageSafe) {
  return { errorCode, errorMessageSafe };
}

function tokenFromHeader(req) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function authMiddleware(expectedToken, authName) {
  return (req, res, next) => {
    if (!expectedToken) {
      res.status(503).json(errorPayload(`${authName}_token_not_configured`, "Bearer token is not configured on the server."));
      return;
    }
    if (tokenFromHeader(req) !== expectedToken) {
      res.status(401).json(errorPayload("unauthorized", "Authorization header is required."));
      return;
    }
    next();
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
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    stageTimestamps: job.stageTimestamps,
    warningCodes: job.warningCodes || [],
    errorCode: job.errorCode || null,
    errorMessageSafe: job.errorMessageSafe || null,
    artifactManifest: job.artifactManifest || buildArtifactManifest(path.join(state.config.storageDir, "latest")),
    isCurrentLatestJob: state.currentJobId === job.jobId && state.generation === job.generation
  };
}

function toReaderPayload(job, isCurrentLatestJob = false) {
  if (!job) {
    return {
      status: "expired",
      warningCodes: [],
      errorMessageSafe: "Эта ссылка больше не доступна.",
      thread: null,
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
    thread: (job.status === "ready" || job.status === "ready_with_warning") ? job.translatedThread : null,
    metadata: {
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      isCurrentLatestJob
    }
  };
}

function createJob(sourceUrl, normalizedUrl, generation) {
  const timestamp = nowIso();
  return {
    jobId: makeJobId(),
    generation,
    status: "queued",
    sourceUrl,
    normalizedUrl,
    finalUrlAfterRedirect: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    stageTimestamps: { queued: timestamp },
    warningCodes: [],
    errorCode: null,
    errorMessageSafe: null,
    artifactManifest: null,
    rawThread: null,
    translatedThread: null
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
  const extract = asExtractor(options.extractor);
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
      restoredJob.errorMessageSafe = "Эта ссылка больше не доступна.";
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

  function statusFromThrown(error, fallbackStatus) {
    if (error.code === "extraction_timeout" || error.code === "translation_timeout" || error.code === "total_job_timeout") {
      return "timeout";
    }
    if (error.status && [
      "invalid_url",
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

  async function processJob(job) {
    const workDir = path.join(workRoot, job.jobId);
    const deadline = Date.now() + config.totalJobTimeoutMs;
    const validationReport = {
      schemaVersion: "aetridder.validation-report.v1",
      jobId: job.jobId,
      startedAt: nowIso(),
      checks: [],
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
        Promise.resolve(extract(job, { config, workDir, log: (line) => appendWorkerLog(workDir, line, config) })),
        remaining(config.extractionTimeoutMs),
        "extraction_timeout"
      );
      if (!isCurrent(job)) {
        return;
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
      const translated = await withTimeout(
        Promise.resolve(translate(rawThread, { config, workDir, log: (line) => appendWorkerLog(workDir, line, config) })),
        remaining(config.translationTimeoutMs),
        "translation_timeout"
      );
      if (!isCurrent(job)) {
        return;
      }
      const translatedCandidate = translated.thread || translated;
      if (translated.codex) {
        validationReport.codex = translated.codex;
      }
      writeJsonArtifact(workDir, "thread.translated.json", translatedCandidate, config);

      if (!touch(job, "validating")) {
        return;
      }
      const translationValidation = validateTranslatedThread(translatedCandidate, rawThread);
      validationReport.checks.push({
        name: "translated_thread_schema_and_invariants",
        ok: translationValidation.ok,
        errorCode: translationValidation.errorCode || null
      });
      if (!translationValidation.ok) {
        failCurrentJob(job, "validation_failed", translationValidation.errorCode, translationValidation.errorMessageSafe);
        writeValidationReport(workDir, validationReport);
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
      publishArtifacts(job, workDir);
    } catch (error) {
      if (isCurrent(job)) {
        const status = statusFromThrown(error, "translation_failed");
        const code = error.errorCode || error.code || status;
        const safe = error.errorMessageSafe || "The worker could not complete this job.";
        if (error.codex) {
          validationReport.codex = error.codex;
        }
        appendWorkerLog(workDir, `job failed with ${code}`, config);
        validationReport.completedAt = nowIso();
        validationReport.ok = false;
        validationReport.errorCode = code;
        writeValidationReport(workDir, validationReport);
        failCurrentJob(job, status, code, safe);
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
    const job = createJob(sourceUrl, normalized.normalizedUrl, state.generation);
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
      lastError: state.lastError,
      artifactManifest: currentJob ? currentJob.artifactManifest || buildArtifactManifest(latestDir) : buildArtifactManifest(latestDir),
      redactedLogTail: readRedactedLogTail(latestDir, config)
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
    processJob,
    toSafeStatus: (job) => toSafeStatus(job, state)
  };
}

module.exports = {
  createApp
};

