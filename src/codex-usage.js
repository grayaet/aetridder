const fs = require("node:fs");
const path = require("node:path");

const { writeJsonArtifact, writeTextArtifact } = require("./artifacts");

const HISTORY_FILE = "codex-usage-history.json";
const REPORT_FILE = "codex-usage-report.json";
const STATIC_RESULTS_DIR = "saved-results";
const USAGE_FIELDS = Object.freeze([
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "reasoningTokens",
  "totalTokens"
]);

function nowIso() {
  return new Date().toISOString();
}

function toNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function firstNumber(object, keys) {
  if (!object || typeof object !== "object") {
    return null;
  }
  for (const key of keys) {
    const value = toNumber(object[key]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function nestedNumber(object, paths) {
  for (const parts of paths) {
    let cursor = object;
    for (const part of parts) {
      if (!cursor || typeof cursor !== "object") {
        cursor = null;
        break;
      }
      cursor = cursor[part];
    }
    const value = toNumber(cursor);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function emptyUsage() {
  return {
    available: false,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    usageEventCount: 0
  };
}

function normalizeUsageObject(object) {
  const inputTokens = firstNumber(object, ["input_tokens", "prompt_tokens", "inputTokens", "promptTokens"]);
  const outputTokens = firstNumber(object, ["output_tokens", "completion_tokens", "outputTokens", "completionTokens"]);
  const cachedInputTokens =
    firstNumber(object, ["cached_input_tokens", "cachedInputTokens", "cached_tokens", "cachedTokens"]) ??
    nestedNumber(object, [
      ["input_token_details", "cached_tokens"],
      ["input_tokens_details", "cached_tokens"],
      ["prompt_token_details", "cached_tokens"],
      ["prompt_tokens_details", "cached_tokens"]
    ]);
  const reasoningTokens =
    firstNumber(object, ["reasoning_output_tokens", "reasoningTokens", "reasoning_tokens"]) ??
    nestedNumber(object, [
      ["output_token_details", "reasoning_tokens"],
      ["output_tokens_details", "reasoning_tokens"],
      ["completion_token_details", "reasoning_tokens"],
      ["completion_tokens_details", "reasoning_tokens"]
    ]);
  const explicitTotal = firstNumber(object, ["total_tokens", "totalTokens"]);
  const derivedTotal = inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
  const usage = {
    available: false,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningTokens,
    totalTokens: explicitTotal ?? derivedTotal,
    usageEventCount: 1
  };
  usage.available = USAGE_FIELDS.some((field) => usage[field] !== null);
  return usage;
}

function visitUsageObjects(value, usages, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);
  const normalized = normalizeUsageObject(value);
  if (normalized.available) {
    usages.push(normalized);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      visitUsageObjects(item, usages, seen);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    visitUsageObjects(value[key], usages, seen);
  }
}

function maxUsage(usages) {
  const result = emptyUsage();
  result.usageEventCount = usages.length;
  for (const usage of usages) {
    for (const field of USAGE_FIELDS) {
      const value = usage[field];
      if (Number.isFinite(value)) {
        result[field] = result[field] === null ? value : Math.max(result[field], value);
      }
    }
  }
  result.available = USAGE_FIELDS.some((field) => result[field] !== null);
  return result;
}

function collectCodexUsage(stdout) {
  const usages = [];
  for (const line of String(stdout || "").split(/\r?\n/).filter(Boolean)) {
    try {
      visitUsageObjects(JSON.parse(line), usages);
    } catch (_error) {
      // Non-JSON stdout is still captured as redacted evidence elsewhere.
    }
  }
  return maxUsage(usages);
}

function usageFromReport(report) {
  if (!report || typeof report !== "object" || !report.usage) {
    return emptyUsage();
  }
  return {
    ...emptyUsage(),
    ...USAGE_FIELDS.reduce((usage, field) => {
      usage[field] = toNumber(report.usage[field]);
      return usage;
    }, {}),
    available: Boolean(report.usage.available),
    usageEventCount: Number.isSafeInteger(report.usage.usageEventCount) ? report.usage.usageEventCount : 0
  };
}

function sumUsage(usages) {
  const result = emptyUsage();
  const known = Object.fromEntries(USAGE_FIELDS.map((field) => [field, false]));
  for (const usage of usages) {
    if (!usage || !usage.available) {
      result.usageEventCount += usage && Number.isSafeInteger(usage.usageEventCount) ? usage.usageEventCount : 0;
      continue;
    }
    result.available = true;
    result.usageEventCount += Number.isSafeInteger(usage.usageEventCount) ? usage.usageEventCount : 0;
    for (const field of USAGE_FIELDS) {
      if (Number.isFinite(usage[field])) {
        result[field] = (result[field] || 0) + usage[field];
        known[field] = true;
      }
    }
  }
  for (const field of USAGE_FIELDS) {
    if (!known[field]) {
      result[field] = null;
    }
  }
  return result;
}

function msBetween(startedAt, endedAt) {
  const start = Date.parse(startedAt || "");
  const end = Date.parse(endedAt || "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return end - start;
}

function codexReportsFromValidation(validationReport) {
  if (!validationReport || !validationReport.codex) {
    return [];
  }
  if (validationReport.codex.mode === "incremental") {
    const reports = [];
    if (validationReport.codex.initial) {
      reports.push({ phase: "initial", batchIndex: validationReport.codex.initial.batchIndex ?? null, report: validationReport.codex.initial });
    }
    if (validationReport.codex.post) {
      reports.push({ phase: "post", batchIndex: null, report: validationReport.codex.post });
    }
    for (const report of validationReport.codex.batches || []) {
      reports.push({
        phase: "comment_batch",
        batchIndex: Number.isSafeInteger(report.batchIndex)
          ? report.batchIndex
          : reports.filter((entry) => entry.phase === "comment_batch").length,
        report
      });
    }
    return reports;
  }
  return [{ phase: "legacy_full_thread", batchIndex: null, report: validationReport.codex }];
}

function durationFromCodexReports(entries) {
  const timestamps = entries
    .map((entry) => ({
      start: Date.parse(entry.report.startedAt || ""),
      end: Date.parse(entry.report.endedAt || "")
    }))
    .filter((entry) => Number.isFinite(entry.start) && Number.isFinite(entry.end) && entry.end >= entry.start);
  if (timestamps.length === 0) {
    return null;
  }
  return Math.max(...timestamps.map((entry) => entry.end)) - Math.min(...timestamps.map((entry) => entry.start));
}

function shortJobId(jobId) {
  return String(jobId || "").slice(0, 8) || null;
}

function safeResultId(jobId) {
  const value = String(jobId || "");
  return /^[A-Za-z0-9_-]{20,80}$/.test(value) ? value : null;
}

function staticResultPublicPath(jobId) {
  const id = safeResultId(jobId);
  return id ? `/results/${encodeURIComponent(id)}` : null;
}

function staticResultFilePath(storageDir, jobId) {
  const id = safeResultId(jobId);
  if (!id) {
    return null;
  }
  return path.join(storageDir, STATIC_RESULTS_DIR, `${id}.html`);
}

function writeStaticResultPage(storageDir, job, html, config = {}) {
  if (!job || !["ready", "ready_with_warning"].includes(job.status) || !job.translatedThread) {
    return null;
  }
  const id = safeResultId(job.jobId);
  if (!id) {
    return null;
  }
  writeTextArtifact(path.join(storageDir, STATIC_RESULTS_DIR), `${id}.html`, html, config);
  return {
    resultId: id,
    path: staticResultPublicPath(id),
    retained: true,
    translatedTitle: typeof job.translatedThread.post?.title === "string"
      ? job.translatedThread.post.title
      : null
  };
}

function readStaticResultPage(storageDir, resultId) {
  const filePath = staticResultFilePath(storageDir, resultId);
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, "utf8");
}

function pruneStaticResultPages(storageDir, history) {
  const dir = path.join(storageDir, STATIC_RESULTS_DIR);
  if (!fs.existsSync(dir)) {
    return;
  }
  const kept = new Set(
    (history.entries || [])
      .map((entry) => entry.result && entry.result.resultId)
      .filter(Boolean)
  );
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".html")) {
      continue;
    }
    const id = entry.name.slice(0, -".html".length);
    if (!kept.has(id)) {
      fs.rmSync(path.join(dir, entry.name), { force: true });
    }
  }
}

function buildCodexUsageReport(job, validationReport, config = {}, staticResult = null) {
  const entries = codexReportsFromValidation(validationReport);
  if (entries.length === 0) {
    return null;
  }
  const initialEntry = entries.find((entry) => entry.phase === "initial") || null;
  const postEntry = entries.find((entry) => entry.phase === "post") || null;
  const batchEntries = entries.filter((entry) => entry.phase === "comment_batch");
  const legacyEntry = entries.find((entry) => entry.phase === "legacy_full_thread") || null;
  const usageEntries = entries.map((entry) => usageFromReport(entry.report));
  const firstReport = entries[0].report;
  const progress = job.translationProgress || {};
  const extractorMetrics = job.extractorReport && job.extractorReport.metrics ? job.extractorReport.metrics : {};
  const translatedCommentCount = job.translatedThread && Array.isArray(job.translatedThread.comments)
    ? job.translatedThread.comments.length
    : (progress.translatedCommentCount || 0);
  const extractedCommentCount = job.rawThread && Array.isArray(job.rawThread.comments)
    ? job.rawThread.comments.length
    : (progress.totalCommentCount || 0);

  return {
    schemaVersion: "aetridder.codex-usage-report.v1",
    generatedAt: nowIso(),
    evidenceLabel: "generated_artifact",
    publicTelemetrySafe: true,
    job: {
      jobIdShort: shortJobId(job.jobId),
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      warningCodes: job.warningCodes || []
    },
    result: staticResult,
    codex: {
      model: firstReport.model || config.codexModel || "gpt-5.5",
      reasoningEffort: firstReport.reasoningEffort || config.codexReasoningEffort || "high",
      callCount: entries.length,
      succeededCallCount: entries.filter((entry) => entry.report.exitCode === 0 && !entry.report.timeoutState).length,
      failedCallCount: entries.filter((entry) => entry.report.exitCode !== 0 || entry.report.timeoutState).length,
      timedOutCallCount: entries.filter((entry) => Boolean(entry.report.timeoutState)).length
    },
    targetLanguage: {
      code: validationReport.targetLanguage?.code || job.targetLanguageCode || config.targetLanguageCode || "uk",
      name: validationReport.targetLanguage?.name || job.targetLanguageName || config.targetLanguageName || "Ukrainian"
    },
    timings: {
      extractionDurationMs: toNumber(job.extractorReport && job.extractorReport.durationMs) ??
        msBetween(job.stageTimestamps && job.stageTimestamps.extracting, job.stageTimestamps && job.stageTimestamps.extracted),
      translationDurationMs: durationFromCodexReports(entries) ??
        msBetween(job.stageTimestamps && job.stageTimestamps.translating, job.stageTimestamps && job.stageTimestamps.validating),
      totalJobDurationMs: msBetween(job.createdAt, job.updatedAt)
    },
    comments: {
      extractedCommentCount,
      translatedCommentCount,
      totalReportedCommentCount: extractorMetrics.totalCommentCount || progress.totalCommentCount || extractedCommentCount
    },
    batching: {
      mode: validationReport.codex.mode || "legacy",
      totalBatches: progress.totalBatches || batchEntries.length,
      completedBatchCount: progress.completedBatchCount || batchEntries.length,
      failedBatchCount: progress.failedBatchCount || 0,
      visibleBatchCount: progress.visibleBatchCount || batchEntries.length,
      concurrency: progress.concurrency || config.translationConcurrency || null,
      batchMaxComments: progress.batchMaxComments || config.translationBatchMaxComments || null,
      batchMaxChars: progress.batchMaxChars || config.translationBatchMaxChars || null
    },
    usage: {
      initial: usageFromReport(initialEntry && initialEntry.report),
      post: usageFromReport(postEntry && postEntry.report),
      legacy: usageFromReport(legacyEntry && legacyEntry.report),
      batches: batchEntries.map((entry) => ({
        batchIndex: entry.batchIndex,
        durationMs: msBetween(entry.report.startedAt, entry.report.endedAt),
        exitCode: Number.isFinite(entry.report.exitCode) ? entry.report.exitCode : null,
        timeoutState: Boolean(entry.report.timeoutState),
        usage: usageFromReport(entry.report)
      })),
      totals: sumUsage(usageEntries)
    }
  };
}

function historyPath(storageDir) {
  return path.join(storageDir, HISTORY_FILE);
}

function readCodexUsageHistory(storageDir) {
  const filePath = historyPath(storageDir);
  if (!fs.existsSync(filePath)) {
    return {
      schemaVersion: "aetridder.codex-usage-history.v1",
      updatedAt: null,
      entries: []
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      schemaVersion: "aetridder.codex-usage-history.v1",
      updatedAt: parsed.updatedAt || null,
      entries: Array.isArray(parsed.entries) ? parsed.entries : []
    };
  } catch (_error) {
    return {
      schemaVersion: "aetridder.codex-usage-history.v1",
      updatedAt: null,
      entries: []
    };
  }
}

function historyEntryFromReport(report) {
  return {
    reportVersion: report.schemaVersion,
    generatedAt: report.generatedAt,
    job: report.job,
    result: report.result || null,
    codex: report.codex,
    timings: report.timings,
    comments: report.comments,
    batching: report.batching,
    usageTotals: report.usage.totals
  };
}

function appendCodexUsageHistory(storageDir, report, config = {}) {
  if (!report) {
    return null;
  }
  const limit = config.codexUsageHistoryLimit || 30;
  const current = readCodexUsageHistory(storageDir);
  const withoutSameJob = current.entries.filter((entry) => entry.job.jobIdShort !== report.job.jobIdShort);
  const entries = [historyEntryFromReport(report), ...withoutSameJob].slice(0, limit);
  const history = {
    schemaVersion: "aetridder.codex-usage-history.v1",
    updatedAt: nowIso(),
    maxEntries: limit,
    entries
  };
  writeJsonArtifact(storageDir, HISTORY_FILE, history, config);
  pruneStaticResultPages(storageDir, history);
  return history;
}

function numericValues(entries, selector) {
  return entries.map(selector).filter((value) => Number.isFinite(value));
}

function sumNumbers(values) {
  return values.reduce((sum, value) => sum + value, 0);
}

function average(values) {
  if (values.length === 0) {
    return null;
  }
  return Math.round(sumNumbers(values) / values.length);
}

function summarizeHistory(history) {
  const entries = history.entries || [];
  const summary = {
    jobCount: entries.length,
    successCount: entries.filter((entry) => ["ready", "ready_with_warning"].includes(entry.job.status)).length,
    warningCount: entries.filter((entry) => Array.isArray(entry.job.warningCodes) && entry.job.warningCodes.length > 0).length,
    failedCount: entries.filter((entry) => !["ready", "ready_with_warning"].includes(entry.job.status)).length,
    usageAvailableJobCount: entries.filter((entry) => entry.usageTotals && entry.usageTotals.available).length,
    averageTranslationDurationMs: average(numericValues(entries, (entry) => entry.timings.translationDurationMs)),
    averageTotalJobDurationMs: average(numericValues(entries, (entry) => entry.timings.totalJobDurationMs))
  };
  for (const field of USAGE_FIELDS) {
    const values = numericValues(entries, (entry) => entry.usageTotals && entry.usageTotals[field]);
    summary[field] = values.length > 0 ? sumNumbers(values) : null;
  }
  return summary;
}

function toSafeCodexUsagePayload(history, config = {}) {
  return {
    schemaVersion: "aetridder.codex-usage-public.v1",
    updatedAt: history.updatedAt || null,
    maxEntries: history.maxEntries || 30,
    summary: summarizeHistory(history),
    entries: history.entries || [],
    safety: {
      containsRedditText: false,
      containsOriginalRedditText: false,
      containsTranslatedPostTitles: true,
      containsPrompts: false,
      containsLogs: false,
      containsSecrets: false,
      publicDebugPages: Boolean(config.publicDebugPages),
      unauthenticatedShakedownPage: Boolean(config.publicDebugPages)
    }
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatNumber(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat("en-US").format(value) : "unknown";
}

function formatCompactNumber(value) {
  if (!Number.isFinite(value)) {
    return "unknown";
  }
  if (Math.abs(value) < 1000000) {
    return formatNumber(value);
  }
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

function tokenCell(value) {
  return `<td class="num" title="${escapeHtml(formatNumber(value))}">${escapeHtml(formatCompactNumber(value))}</td>`;
}

function tokenMetric(label, value) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong title="${escapeHtml(formatNumber(value))}">${escapeHtml(formatCompactNumber(value))}</strong></div>`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) {
    return "unknown";
  }
  if (ms < 1000) {
    return `${ms} ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes} min ${String(rest).padStart(2, "0")} s`;
}

function formatDate(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }
  return date.toISOString().slice(0, 16).replace("T", " ");
}

function statusClass(status) {
  if (status === "ready") {
    return "ok";
  }
  if (status === "ready_with_warning") {
    return "warn";
  }
  return "fail";
}

function renderUsageIcon(name) {
  const icons = {
    jobs: '<path d="M9 6V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1"/><path d="M4 7h16v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M4 12h16"/><path d="M10 12v2h4v-2"/>',
    success: '<path d="M20 11.5a8.5 8.5 0 1 1-4.9-7.7"/><path d="m8 11.5 2.7 2.7L19 5.8"/>',
    warning: '<path d="M12 4 21 20H3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
    tokens: '<ellipse cx="12" cy="6" rx="6.5" ry="3"/><path d="M5.5 6v6c0 1.7 2.9 3 6.5 3s6.5-1.3 6.5-3V6"/><path d="M5.5 12v6c0 1.7 2.9 3 6.5 3s6.5-1.3 6.5-3v-6"/>',
    input: '<path d="M5 12h13"/><path d="m13 6 6 6-6 6"/>',
    output: '<path d="M19 12H6"/><path d="m11 6-6 6 6 6"/>',
    cache: '<path d="m12 3 8 4-8 4-8-4Z"/><path d="m4 12 8 4 8-4"/><path d="m4 17 8 4 8-4"/>',
    reasoning: '<path d="M9 4a3 3 0 0 0-3 3v1a3 3 0 0 0 0 6v1a3 3 0 0 0 5 2.2V4.8A3 3 0 0 0 9 4Z"/><path d="M15 4a3 3 0 0 1 3 3v1a3 3 0 0 1 0 6v1a3 3 0 0 1-5 2.2V4.8A3 3 0 0 1 15 4Z"/>'
  };
  const body = icons[name] || icons.tokens;
  return `<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

function renderKpiCard({ label, value, icon, tone = "accent", hook, title }) {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<article class="kpi-card kpi-card--${escapeHtml(tone)}">
    <span class="icon-well icon-well--${escapeHtml(tone)}">${renderUsageIcon(icon)}</span>
    <span class="kpi-copy">
      <span class="kpi-label">${escapeHtml(label)}</span>
      <strong class="kpi-value" ${hook}${titleAttr}>${escapeHtml(value)}</strong>
    </span>
  </article>`;
}

function renderStatusBadge(status) {
  const safeStatus = status || "unknown";
  return `<span class="status-badge status-badge--${statusClass(safeStatus)}">${escapeHtml(safeStatus)}</span>`;
}

function renderWarningChips(warningCodes) {
  const warnings = Array.isArray(warningCodes) ? warningCodes.filter(Boolean) : [];
  if (warnings.length === 0) {
    return '<span class="warning-chip warning-chip--none">none</span>';
  }
  return warnings
    .map((warning) => `<span class="warning-chip warning-chip--warn">${escapeHtml(warning)}</span>`)
    .join("");
}

function renderMetricRow(label, value, options = {}) {
  const titleAttr = options.title ? ` title="${escapeHtml(options.title)}"` : "";
  const className = options.className ? ` metric-row--${escapeHtml(options.className)}` : "";
  return `<div class="metric-row${className}">
    <span class="metric-label">${escapeHtml(label)}</span>
    <strong class="metric-value"${titleAttr}>${escapeHtml(value)}</strong>
  </div>`;
}

function renderWarningMetricRow(warningCodes) {
  return `<div class="metric-row metric-row--warnings">
    <span class="metric-label">Warnings</span>
    <span class="warning-list">${renderWarningChips(warningCodes)}</span>
  </div>`;
}

function renderJobCard(entry) {
  const status = entry.job.status || "unknown";
  const title = entry.result && typeof entry.result.translatedTitle === "string"
    ? entry.result.translatedTitle.trim()
    : "";
  const titleLink = title && entry.result && entry.result.path
    ? `<a class="result-title-link" href="${escapeHtml(entry.result.path)}">${escapeHtml(title)}</a>`
    : "";
  const metrics = [
    renderMetricRow("Model", `${entry.codex.model} / ${entry.codex.reasoningEffort}`),
    renderMetricRow("Translation", formatDuration(entry.timings.translationDurationMs)),
    renderMetricRow("Total", formatDuration(entry.timings.totalJobDurationMs)),
    renderMetricRow("Comments", `${entry.comments.translatedCommentCount}/${entry.comments.totalReportedCommentCount}`),
    renderMetricRow("Batches", `${entry.batching.completedBatchCount}/${entry.batching.totalBatches}`),
    renderMetricRow("Tokens", formatCompactNumber(entry.usageTotals.totalTokens), { title: formatNumber(entry.usageTotals.totalTokens) }),
    renderMetricRow("Input", formatCompactNumber(entry.usageTotals.inputTokens), { title: formatNumber(entry.usageTotals.inputTokens) }),
    renderMetricRow("Output", formatCompactNumber(entry.usageTotals.outputTokens), { title: formatNumber(entry.usageTotals.outputTokens) }),
    renderMetricRow("Cached input", formatCompactNumber(entry.usageTotals.cachedInputTokens), { title: formatNumber(entry.usageTotals.cachedInputTokens) }),
    renderMetricRow("Reasoning", formatCompactNumber(entry.usageTotals.reasoningTokens), { title: formatNumber(entry.usageTotals.reasoningTokens) }),
    renderWarningMetricRow(entry.job.warningCodes)
  ].join("");

  return `<article class="job-card" data-job-status="${escapeHtml(status)}">
    <header class="job-card__head">
      <div class="job-card__id-row">
        <strong class="job-id">${escapeHtml(entry.job.jobIdShort || "unknown")}</strong>
        ${renderStatusBadge(status)}
      </div>
      <time class="job-time" datetime="${escapeHtml(entry.generatedAt || "")}">${escapeHtml(formatDate(entry.generatedAt))}</time>
    </header>
    ${titleLink ? `<div class="job-card__title">${titleLink}</div>` : ""}
    <div class="job-metrics">${metrics}</div>
  </article>`;
}

function renderCodexUsagePage(history, config = {}) {
  const payload = toSafeCodexUsagePayload(history, config);
  const jobCards = payload.entries.map(renderJobCard).join("\n");
  const summary = payload.summary;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex usage telemetry</title>
  <style>
    :root {
      color-scheme: light;
      --color-canvas: oklch(0.975 0.008 245);
      --color-canvas-strong: oklch(0.955 0.012 245);
      --color-surface: oklch(0.995 0.004 245);
      --color-surface-muted: oklch(0.965 0.01 250);
      --color-ink: oklch(0.205 0.055 265);
      --color-muted: oklch(0.455 0.045 258);
      --color-muted-2: oklch(0.59 0.035 255);
      --color-border: oklch(0.89 0.018 245);
      --color-border-strong: oklch(0.81 0.025 245);
      --color-accent: oklch(0.52 0.16 258);
      --color-accent-ink: oklch(0.36 0.17 262);
      --color-accent-soft: oklch(0.93 0.045 258);
      --color-success: oklch(0.52 0.13 150);
      --color-success-ink: oklch(0.36 0.12 150);
      --color-success-soft: oklch(0.93 0.06 150);
      --color-warning: oklch(0.67 0.15 70);
      --color-warning-ink: oklch(0.48 0.12 62);
      --color-warning-soft: oklch(0.94 0.055 78);
      --color-danger: oklch(0.53 0.15 28);
      --color-danger-ink: oklch(0.39 0.14 28);
      --color-danger-soft: oklch(0.94 0.05 28);
      --color-cache: oklch(0.55 0.17 292);
      --color-cache-soft: oklch(0.94 0.05 292);
      --color-reasoning: oklch(0.58 0.16 350);
      --color-reasoning-soft: oklch(0.94 0.052 350);
      --radius-card: 8px;
      --radius-chip: 999px;
      --shadow-panel: 0 10px 30px oklch(0.25 0.04 265 / 0.07);
      --shadow-focus: 0 0 0 3px oklch(0.52 0.16 258 / 0.18);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: var(--color-canvas);
      color: var(--color-ink);
      line-height: 1.45;
      -webkit-font-smoothing: antialiased;
    }
    main {
      max-width: 1120px;
      margin: 0 auto;
      padding: 40px;
      min-width: 0;
    }
    .page-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 20px;
      align-items: start;
      margin-bottom: 18px;
    }
    h1 {
      font-size: 34px;
      line-height: 1.12;
      margin: 0 0 6px;
      letter-spacing: 0;
      font-weight: 780;
    }
    p {
      margin: 0;
      color: var(--color-muted);
      max-width: 62ch;
    }
    .api-link {
      display: inline-flex;
      align-items: center;
      min-height: 40px;
      color: var(--color-accent-ink);
      background: var(--color-accent-soft);
      border: 1px solid oklch(0.84 0.055 258);
      border-radius: 8px;
      padding: 8px 12px;
      text-decoration: none;
      white-space: nowrap;
      font-weight: 720;
    }
    .api-link:focus-visible,
    .result-title-link:focus-visible {
      outline: 0;
      box-shadow: var(--shadow-focus);
    }
    .meta-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 14px;
      color: var(--color-muted);
      font-size: 14px;
      margin-bottom: 24px;
    }
    .meta-item {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }
    .meta-icon {
      color: var(--color-muted);
      line-height: 0;
    }
    .meta-separator {
      color: var(--color-muted-2);
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 16px;
      margin: 0 0 28px;
    }
    .kpi-card,
    .job-card,
    .empty {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-card);
      box-shadow: var(--shadow-panel);
      min-width: 0;
    }
    .kpi-card {
      display: grid;
      grid-template-columns: 48px minmax(0, 1fr);
      gap: 14px;
      align-items: center;
      padding: 18px;
      min-height: 104px;
    }
    .icon-well {
      width: 44px;
      height: 44px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      color: var(--color-accent);
      background: var(--color-accent-soft);
    }
    .icon-well--success { color: var(--color-success); background: var(--color-success-soft); }
    .icon-well--warning { color: var(--color-warning); background: var(--color-warning-soft); }
    .icon-well--cache { color: var(--color-cache); background: var(--color-cache-soft); }
    .icon-well--reasoning { color: var(--color-reasoning); background: var(--color-reasoning-soft); }
    .kpi-copy {
      min-width: 0;
    }
    .kpi-label {
      display: block;
      color: var(--color-muted);
      font-size: 13px;
      font-weight: 650;
    }
    .kpi-value {
      display: block;
      margin-top: 3px;
      font-size: 28px;
      line-height: 1.12;
      font-weight: 780;
      overflow-wrap: anywhere;
      font-variant-numeric: tabular-nums;
    }
    .section-title {
      margin: 0 0 14px;
      font-size: 21px;
      line-height: 1.2;
      font-weight: 760;
    }
    .job-list {
      display: grid;
      gap: 14px;
      min-width: 0;
    }
    .job-card {
      padding: 18px;
    }
    .job-card__head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 12px;
      min-width: 0;
    }
    .job-card__id-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .job-id {
      font-size: 20px;
      line-height: 1.2;
      font-weight: 780;
      overflow-wrap: anywhere;
      min-width: 0;
    }
    .job-time {
      color: var(--color-muted);
      font-size: 14px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .status-badge,
    .warning-chip {
      display: inline-flex;
      align-items: center;
      border-radius: var(--radius-chip);
      padding: 4px 9px;
      font-size: 13px;
      line-height: 1.12;
      font-weight: 750;
      max-width: 100%;
      overflow-wrap: anywhere;
    }
    .status-badge--ok {
      color: var(--color-success-ink);
      background: var(--color-success-soft);
    }
    .status-badge--warn,
    .warning-chip--warn {
      color: var(--color-warning-ink);
      background: var(--color-warning-soft);
    }
    .status-badge--fail {
      color: var(--color-danger-ink);
      background: var(--color-danger-soft);
    }
    .warning-chip--none {
      color: var(--color-muted);
      background: var(--color-surface-muted);
    }
    .result-title-link {
      display: inline-block;
      max-width: 100%;
      font-size: 21px;
      line-height: 1.18;
      font-weight: 500;
      text-decoration-thickness: 1.5px;
      text-underline-offset: 2px;
      color: var(--color-accent-ink);
      overflow-wrap: anywhere;
    }
    .result-title-link:hover {
      color: var(--color-accent);
    }
    .job-card__title {
      margin: 4px 0 14px;
      min-width: 0;
    }
    .job-metrics {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      column-gap: 32px;
      row-gap: 0;
      min-width: 0;
    }
    .metric-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(7ch, auto);
      gap: 12px;
      align-items: center;
      min-width: 0;
      padding: 7px 0;
      border-top: 1px solid var(--color-border);
      font-size: 14px;
    }
    .metric-label {
      color: var(--color-muted);
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .metric-value {
      color: var(--color-ink);
      text-align: right;
      font-variant-numeric: tabular-nums;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .metric-row--warnings {
      grid-column: 1 / -1;
      grid-template-columns: minmax(8rem, 0.28fr) minmax(0, 1fr);
      align-items: start;
    }
    .warning-list {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
      min-width: 0;
    }
    .empty {
      padding: 28px;
      color: var(--color-muted);
    }
    .empty strong {
      display: block;
      color: var(--color-ink);
      margin-bottom: 4px;
    }
    footer {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      margin-top: 18px;
      color: var(--color-muted);
      font-size: 13px;
    }
    .refresh-state {
      color: var(--color-muted);
    }
    [hidden] { display: none !important; }
    @media (max-width: 860px) {
      main { padding: 28px 24px 38px; }
      .summary { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .kpi-card {
        grid-template-columns: 38px minmax(0, 1fr);
        gap: 10px;
        min-height: 88px;
        padding: 13px;
      }
      .icon-well {
        width: 36px;
        height: 36px;
      }
      .icon-well svg {
        width: 18px;
        height: 18px;
      }
      .kpi-label { font-size: 12px; }
      .kpi-value { font-size: 22px; }
      .job-metrics {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        column-gap: 22px;
      }
    }
    @media (max-width: 620px) {
      main { padding: 22px 16px 34px; }
      .page-header { grid-template-columns: 1fr; }
      h1 { font-size: 26px; }
      p { font-size: 14px; }
      .api-link {
        min-height: 36px;
        padding: 7px 10px;
      }
      .meta-row {
        font-size: 12px;
        gap: 6px 10px;
        margin-bottom: 18px;
      }
      .meta-icon svg {
        width: 16px;
        height: 16px;
      }
      .summary {
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
        margin-bottom: 22px;
      }
      .kpi-card {
        grid-template-columns: minmax(0, 1fr);
        justify-items: start;
        align-content: start;
        gap: 7px;
        min-height: 112px;
        padding: 10px;
      }
      .icon-well {
        width: 34px;
        height: 34px;
      }
      .icon-well svg {
        width: 17px;
        height: 17px;
      }
      .kpi-label {
        font-size: 11px;
        line-height: 1.15;
      }
      .kpi-value {
        font-size: 19px;
        line-height: 1.08;
      }
      .section-title {
        font-size: 20px;
      }
      .job-card { padding: 14px; }
      .job-card__head {
        display: flex;
        gap: 8px;
      }
      .job-card__id-row {
        gap: 7px;
      }
      .job-id {
        font-size: 18px;
      }
      .job-time { white-space: normal; }
      .status-badge,
      .warning-chip {
        font-size: 12px;
        padding: 3px 7px;
      }
      .result-title-link {
        font-size: 17px;
        line-height: 1.16;
      }
      .job-card__title {
        margin-bottom: 11px;
      }
      .job-metrics {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        column-gap: 16px;
      }
      .metric-row {
        grid-template-columns: minmax(0, 1fr) minmax(5ch, auto);
        gap: 8px;
        font-size: 12px;
        padding: 6px 0;
      }
      .metric-value {
        text-align: right;
      }
      .metric-row--warnings {
        grid-template-columns: minmax(0, 0.45fr) minmax(0, 1fr);
      }
      .warning-list {
        justify-content: flex-end;
      }
    }
  </style>
</head>
<body>
  <main data-codex-usage-page data-refresh-ms="15000">
    <header class="page-header">
      <div>
        <h1>Codex usage telemetry</h1>
        <p>Latest ${escapeHtml(payload.maxEntries)} translations: Codex metrics and translated titles, without original text, prompts, logs, or secrets.</p>
      </div>
      <a class="api-link" href="/api/codex-usage">JSON API</a>
    </header>
    <div class="meta-row" aria-label="Telemetry page metadata">
      <span class="meta-item"><span class="meta-icon">${renderUsageIcon("clock")}</span>Updated: <span id="updated-at">${escapeHtml(formatDate(payload.updatedAt))}</span></span>
      <span class="meta-separator" aria-hidden="true">.</span>
      <span class="meta-item"><span class="meta-icon">${renderUsageIcon("success")}</span>${payload.safety.publicDebugPages ? "Temporary public shakedown page" : "Protected engineering page"}</span>
    </div>
    <section class="summary" aria-label="Summary">
      ${renderKpiCard({ label: "Jobs tracked", value: formatNumber(summary.jobCount), icon: "jobs", hook: 'data-summary="jobCount"' })}
      ${renderKpiCard({ label: "Successful", value: formatNumber(summary.successCount), icon: "success", tone: "success", hook: 'data-summary="successCount"' })}
      ${renderKpiCard({ label: "With warnings", value: formatNumber(summary.warningCount), icon: "warning", tone: "warning", hook: 'data-summary="warningCount"' })}
      ${renderKpiCard({ label: "Avg translation", value: formatDuration(summary.averageTranslationDurationMs), icon: "clock", hook: 'data-summary="averageTranslationDurationMs"' })}
      ${renderKpiCard({ label: "Total tokens", value: formatCompactNumber(summary.totalTokens), icon: "tokens", hook: 'data-summary-token="totalTokens"', title: formatNumber(summary.totalTokens) })}
      ${renderKpiCard({ label: "Total input tokens", value: formatCompactNumber(summary.inputTokens), icon: "input", hook: 'data-summary-token="inputTokens"', title: formatNumber(summary.inputTokens) })}
      ${renderKpiCard({ label: "Total output tokens", value: formatCompactNumber(summary.outputTokens), icon: "output", tone: "success", hook: 'data-summary-token="outputTokens"', title: formatNumber(summary.outputTokens) })}
      ${renderKpiCard({ label: "Cached input", value: formatCompactNumber(summary.cachedInputTokens), icon: "cache", tone: "cache", hook: 'data-summary-token="cachedInputTokens"', title: formatNumber(summary.cachedInputTokens) })}
      ${renderKpiCard({ label: "Reasoning tokens", value: formatCompactNumber(summary.reasoningTokens), icon: "reasoning", tone: "reasoning", hook: 'data-summary-token="reasoningTokens"', title: formatNumber(summary.reasoningTokens) })}
    </section>
    <section aria-label="Recent jobs">
      <h2 class="section-title">Recent jobs</h2>
      <div id="usage-jobs" class="job-list"${jobCards ? "" : " hidden"}>${jobCards}</div>
      <div id="usage-empty" class="empty"${jobCards ? " hidden" : ""}>
        <strong>No Codex telemetry has been retained yet.</strong>
        <span>This page will show timing, token summaries, and translated title links after translation jobs finish.</span>
      </div>
    </section>
    <footer>
      <span class="refresh-state" id="refresh-state">Auto-refresh every 15 s.</span>
      <span><a class="api-link" href="/api/codex-usage">Open JSON API</a></span>
    </footer>
  </main>
  <script>
    (() => {
      const root = document.querySelector("[data-codex-usage-page]");
      const jobList = document.getElementById("usage-jobs");
      const empty = document.getElementById("usage-empty");
      const updatedAt = document.getElementById("updated-at");
      const refreshState = document.getElementById("refresh-state");
      const refreshMs = Math.max(5000, Number(root?.dataset.refreshMs || 15000));
      const numberFormat = new Intl.NumberFormat("en-US");
      const compactFormat = new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 1
      });
      let inFlight = false;

      function finite(value) {
        return Number.isFinite(value);
      }

      function formatNumber(value) {
        return finite(value) ? numberFormat.format(value) : "unknown";
      }

      function formatCompactNumber(value) {
        if (!finite(value)) {
          return "unknown";
        }
        return Math.abs(value) < 1000000 ? formatNumber(value) : compactFormat.format(value);
      }

      function formatDuration(ms) {
        if (!finite(ms)) {
          return "unknown";
        }
        if (ms < 1000) {
          return ms + " ms";
        }
        const seconds = ms / 1000;
        if (seconds < 60) {
          return seconds.toFixed(1) + " s";
        }
        const minutes = Math.floor(seconds / 60);
        const rest = Math.round(seconds % 60);
        return minutes + " min " + String(rest).padStart(2, "0") + " s";
      }

      function formatDate(value) {
        const date = new Date(value || "");
        if (Number.isNaN(date.getTime())) {
          return "unknown";
        }
        return date.toISOString().slice(0, 16).replace("T", " ");
      }

      function statusClass(status) {
        if (status === "ready") {
          return "ok";
        }
        if (status === "ready_with_warning") {
          return "warn";
        }
        return "fail";
      }

      function cell(row, text, className, title) {
        const item = document.createElement("div");
        item.className = "metric-row" + (className ? " " + className : "");
        const label = document.createElement("span");
        label.className = "metric-label";
        label.textContent = text.label;
        const value = document.createElement("strong");
        value.className = "metric-value";
        value.textContent = text.value;
        if (title) {
          value.title = title;
        }
        item.append(label, value);
        row.appendChild(item);
      }

      function renderWarningChips(warningCodes) {
        const list = document.createElement("span");
        list.className = "warning-list";
        const warnings = Array.isArray(warningCodes) ? warningCodes.filter(Boolean) : [];
        if (warnings.length === 0) {
          const chip = document.createElement("span");
          chip.className = "warning-chip warning-chip--none";
          chip.textContent = "none";
          list.appendChild(chip);
          return list;
        }
        for (const warning of warnings) {
          const chip = document.createElement("span");
          chip.className = "warning-chip warning-chip--warn";
          chip.textContent = warning;
          list.appendChild(chip);
        }
        return list;
      }

      function warningRow(warningCodes) {
        const item = document.createElement("div");
        item.className = "metric-row metric-row--warnings";
        const label = document.createElement("span");
        label.className = "metric-label";
        label.textContent = "Warnings";
        item.append(label, renderWarningChips(warningCodes));
        return item;
      }

      function renderJobCard(entry) {
        const card = document.createElement("article");
        card.className = "job-card";
        card.dataset.jobStatus = entry.job.status || "unknown";

        const head = document.createElement("header");
        head.className = "job-card__head";
        const idRow = document.createElement("div");
        idRow.className = "job-card__id-row";
        const jobId = document.createElement("strong");
        jobId.className = "job-id";
        jobId.textContent = entry.job.jobIdShort || "unknown";
        const status = document.createElement("span");
        status.className = "status-badge status-badge--" + statusClass(entry.job.status);
        status.textContent = entry.job.status || "unknown";
        idRow.append(jobId, status);
        const time = document.createElement("time");
        time.className = "job-time";
        time.dateTime = entry.generatedAt || "";
        time.textContent = formatDate(entry.generatedAt);
        head.append(idRow, time);

        const title = entry.result && typeof entry.result.translatedTitle === "string"
          ? entry.result.translatedTitle.trim()
          : "";
        let titleNode = null;
        if (title && entry.result && entry.result.path) {
          titleNode = document.createElement("div");
          titleNode.className = "job-card__title";
          const link = document.createElement("a");
          link.className = "result-title-link";
          link.href = entry.result.path;
          link.textContent = title;
          titleNode.appendChild(link);
        }

        const metrics = document.createElement("div");
        metrics.className = "job-metrics";
        const usage = entry.usageTotals || {};
        cell(metrics, { label: "Model", value: entry.codex.model + " / " + entry.codex.reasoningEffort });
        cell(metrics, { label: "Translation", value: formatDuration(entry.timings.translationDurationMs) });
        cell(metrics, { label: "Total", value: formatDuration(entry.timings.totalJobDurationMs) });
        cell(metrics, { label: "Comments", value: entry.comments.translatedCommentCount + "/" + entry.comments.totalReportedCommentCount });
        cell(metrics, { label: "Batches", value: entry.batching.completedBatchCount + "/" + entry.batching.totalBatches });
        for (const pair of [
          ["Tokens", "totalTokens"],
          ["Input", "inputTokens"],
          ["Output", "outputTokens"],
          ["Cached input", "cachedInputTokens"],
          ["Reasoning", "reasoningTokens"]
        ]) {
          const value = usage[pair[1]];
          cell(metrics, { label: pair[0], value: formatCompactNumber(value) }, "", formatNumber(value));
        }
        metrics.appendChild(warningRow(entry.job.warningCodes));

        card.appendChild(head);
        if (titleNode) {
          card.appendChild(titleNode);
        }
        card.appendChild(metrics);
        return card;
      }

      function setText(selector, text, title) {
        const node = document.querySelector(selector);
        if (!node) {
          return;
        }
        node.textContent = text;
        if (title !== undefined) {
          node.title = title;
        }
      }

      function render(payload) {
        const summary = payload.summary || {};
        setText('[data-summary="jobCount"]', formatNumber(summary.jobCount));
        setText('[data-summary="successCount"]', formatNumber(summary.successCount));
        setText('[data-summary="warningCount"]', formatNumber(summary.warningCount));
        setText('[data-summary="averageTranslationDurationMs"]', formatDuration(summary.averageTranslationDurationMs));
        for (const key of ["totalTokens", "inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens"]) {
          setText('[data-summary-token="' + key + '"]', formatCompactNumber(summary[key]), formatNumber(summary[key]));
        }
        if (updatedAt) {
          updatedAt.textContent = formatDate(payload.updatedAt);
        }
        const entries = Array.isArray(payload.entries) ? payload.entries : [];
        if (jobList) {
          jobList.replaceChildren(...entries.map(renderJobCard));
        }
        if (jobList && empty) {
          jobList.hidden = entries.length === 0;
          empty.hidden = entries.length !== 0;
        }
      }

      async function refresh() {
        if (inFlight || document.hidden) {
          return;
        }
        inFlight = true;
        if (refreshState) {
          refreshState.textContent = "Refreshing...";
        }
        try {
          const response = await fetch("/api/codex-usage", { cache: "no-store" });
          if (response.ok) {
            render(await response.json());
            if (refreshState) {
              refreshState.textContent = "Auto-refresh every " + Math.round(refreshMs / 1000) + " s.";
            }
          } else if (refreshState) {
            refreshState.textContent = "Last refresh failed, showing previous snapshot.";
          }
        } catch (_error) {
          if (refreshState) {
            refreshState.textContent = "Last refresh failed, showing previous snapshot.";
          }
        } finally {
          inFlight = false;
        }
      }

      window.setInterval(refresh, refreshMs);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
          refresh();
        }
      });
      refresh();
    })();
  </script>
</body>
</html>`;
}

module.exports = {
  HISTORY_FILE,
  REPORT_FILE,
  STATIC_RESULTS_DIR,
  collectCodexUsage,
  buildCodexUsageReport,
  appendCodexUsageHistory,
  readCodexUsageHistory,
  readStaticResultPage,
  renderCodexUsagePage,
  staticResultPublicPath,
  writeStaticResultPage,
  toSafeCodexUsagePayload
};
