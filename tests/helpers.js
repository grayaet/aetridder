const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const { createApp } = require("../src/app");
const { loadConfig } = require("../src/config");

const appRoot = path.resolve(__dirname, "..");
const runtimeRoot = path.join(appRoot, "runtime", "test-runs");
const apiToken = "test-api-token";
const diagnosticsToken = "test-diagnostics-token";

function assertInsideApp(targetPath) {
  const target = path.resolve(targetPath);
  if (target !== appRoot && !target.startsWith(appRoot + path.sep)) {
    throw new Error(`Test path escaped app root: ${target}`);
  }
  return target;
}

function freshStorage(name) {
  const safeName = name.replace(/[^A-Za-z0-9_-]/g, "-");
  const dir = path.join(runtimeRoot, `${safeName}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  assertInsideApp(dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupStorage(dir) {
  const target = assertInsideApp(dir);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function fixtureJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(appRoot, "fixtures", relativePath), "utf8"));
}

function sampleRaw(overrides = {}) {
  return {
    ...fixtureJson("sample-extracted-thread.json"),
    ...overrides
  };
}

function translatedFromRaw(raw, options = {}) {
  return {
    schemaVersion: "aetridder.translated-thread.v1",
    language: "ru",
    translatedAt: "2026-06-02T18:03:00.000Z",
    sourceUrl: raw.sourceUrl,
    normalizedUrl: raw.normalizedUrl,
    finalUrlAfterRedirect: raw.finalUrlAfterRedirect,
    post: {
      ...raw.post,
      title: options.title || "Русский заголовок для проверки",
      bodyMarkdown: options.bodyMarkdown || "Русский текст для проверки."
    },
    comments: raw.comments.map((comment, index) => ({
      ...comment,
      bodyMarkdown: `Русский комментарий ${index + 1}.`
    })),
    warningCodes: raw.warningCodes || []
  };
}

function makeConfig(storageDir, overrides = {}) {
  return loadConfig({
    env: {
      AETRIDDER_API_TOKEN: apiToken,
      AETRIDDER_DIAGNOSTICS_TOKEN: diagnosticsToken,
      AETRIDDER_MAX_COMMENTS: String(overrides.maxComments || 1000),
      AETRIDDER_EXTRACTION_TIMEOUT_MS: "5000",
      AETRIDDER_TRANSLATION_TIMEOUT_MS: "5000",
      AETRIDDER_TOTAL_JOB_TIMEOUT_MS: "15000",
      AETRIDDER_MAX_INPUT_CHARS: "300000",
      AETRIDDER_MAX_ARTIFACT_BYTES: "10485760",
      AETRIDDER_REDACTED_LOG_TAIL_BYTES: "32768",
      AETRIDDER_CODEX_PROCESS_TIMEOUT_MS: "5000"
    },
    storageDir
  });
}

async function withServer(options, fn) {
  const storageDir = freshStorage(options.name || "server");
  const config = makeConfig(storageDir, options.configOverrides || {});
  const instance = createApp({
    config,
    extractor: options.extractor,
    translator: options.translator,
    autoStartWorker: options.autoStartWorker
  });
  const server = http.createServer(instance.app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await fn({ ...instance, baseUrl, storageDir, config });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupStorage(storageDir);
  }
}

async function requestJson(baseUrl, method, route, body, token = apiToken) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

async function getJson(baseUrl, route, token = diagnosticsToken) {
  return requestJson(baseUrl, "GET", route, undefined, token);
}

async function getText(baseUrl, route) {
  const response = await fetch(`${baseUrl}${route}`);
  return {
    status: response.status,
    text: await response.text()
  };
}

async function waitFor(predicate, message, timeoutMs = 2500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await predicate();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function waitForStatus(baseUrl, jobId, statuses, timeoutMs = 3000) {
  const wanted = new Set(Array.isArray(statuses) ? statuses : [statuses]);
  return waitFor(async () => {
    const response = await getJson(baseUrl, `/api/threads/${jobId}/status`);
    if (response.status === 200 && wanted.has(response.body.status)) {
      return response.body;
    }
    return null;
  }, `Timed out waiting for ${Array.from(wanted).join(", ")}`, timeoutMs);
}

module.exports = {
  apiToken,
  diagnosticsToken,
  appRoot,
  fixtureJson,
  freshStorage,
  cleanupStorage,
  makeConfig,
  sampleRaw,
  translatedFromRaw,
  withServer,
  requestJson,
  getJson,
  getText,
  waitFor,
  waitForStatus
};

