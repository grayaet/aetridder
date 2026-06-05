const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const { createApp } = require("../src/app");
const { loadConfig } = require("../src/config");
const { appRoot, sampleRaw, translatedFromRaw, apiToken } = require("./helpers");

function codexReport() {
  return {
    command: "codex exec mobile-fixture",
    model: "gpt-5.5",
    reasoningEffort: "medium",
    cwd: "work",
    inputPath: "mobile.input.json",
    schemaPath: "mobile.schema.json",
    outputPath: "mobile.output.json",
    startedAt: "2026-06-05T12:00:00.000Z",
    endedAt: "2026-06-05T12:00:03.000Z",
    exitCode: 0,
    signal: null,
    timeoutState: false,
    promptDelivery: "stdin",
    stdoutRedactedAndSizeLimited: true,
    usage: {
      available: true,
      inputTokens: 1200,
      outputTokens: 300,
      cachedInputTokens: 400,
      reasoningTokens: 25,
      totalTokens: 1500,
      usageEventCount: 1
    }
  };
}

function mobileSkipAllowed() {
  return ["1", "true", "yes", "on"].includes(String(process.env.REDDIT_READER_ALLOW_MOBILE_RENDER_SKIP || "").trim().toLowerCase());
}

function writeHostLimit(resultPath, reason) {
  fs.writeFileSync(resultPath, JSON.stringify({
    status: "skipped_due_to_host_limit",
    reason,
    explicitSkipAllowed: mobileSkipAllowed()
  }, null, 2));
  if (!mobileSkipAllowed()) {
    process.exitCode = 1;
  }
}

async function main() {
  const outputDir = path.join(appRoot, "runtime", "mobile-render-check");
  const storageDir = path.join(outputDir, "storage");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.rmSync(storageDir, { recursive: true, force: true });
  const resultPath = path.join(outputDir, "mobile-render-check.json");
  const screenshotPath = path.join(outputDir, "reader-390x844.png");
  const usageScreenshotPath = path.join(outputDir, "codex-usage-390x844.png");

  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (_error) {
    writeHostLimit(resultPath, "Playwright package unavailable");
    return;
  }

  const config = loadConfig({
    env: {
      REDDIT_READER_API_TOKEN: apiToken,
      REDDIT_READER_DIAGNOSTICS_TOKEN: apiToken,
      REDDIT_READER_MAX_COMMENTS: "1000"
    },
    storageDir
  });
  const instance = createApp({
    config,
    extractor: async () => ({ thread: sampleRaw({ warningCodes: ["partial_comments"] }) }),
    translator: async (raw) => ({ thread: translatedFromRaw(raw), codex: codexReport() })
  });
  const server = http.createServer(instance.app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  let browser;
  try {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (_error) {
      writeHostLimit(resultPath, "Playwright Chromium unavailable");
      return;
    }

    const postResponse = await fetch(`${baseUrl}/api/threads`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiToken}`
      },
      body: JSON.stringify({ url: "https://www.reddit.com/r/test/comments/demo/english_title/" })
    });
    const post = await postResponse.json();
    const started = Date.now();
    while (Date.now() - started < 2500) {
      const statusResponse = await fetch(`${baseUrl}/api/threads/${post.jobId}/status`, {
        headers: { authorization: `Bearer ${apiToken}` }
      });
      const status = await statusResponse.json();
      if (status.status === "ready_with_warning" || status.status === "ready") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${baseUrl}/t/${post.jobId}`, { waitUntil: "networkidle" });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const bodyText = await page.locator("body").innerText();
    const readerOk = bodyText.includes("Перекладений заголовок для перевірки") && !bodyText.includes("English title for testing");

    await page.setExtraHTTPHeaders({ authorization: `Bearer ${apiToken}` });
    await page.goto(`${baseUrl}/codex-usage`, { waitUntil: "networkidle" });
    await page.screenshot({ path: usageScreenshotPath, fullPage: true });
    const usageText = await page.locator("body").innerText();
    const usageOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    const usageKpiCardCount = await page.locator(".kpi-card").count();
    const usageJobCardCount = await page.locator(".job-card").count();
    const usageTitleLinkCount = await page.locator(".result-title-link").count();
    const layout = await page.evaluate(() => {
      const summary = document.querySelector(".summary");
      const metrics = document.querySelector(".job-metrics");
      return {
        summaryColumns: summary ? getComputedStyle(summary).gridTemplateColumns.split(" ").filter(Boolean).length : 0,
        jobMetricColumns: metrics ? getComputedStyle(metrics).gridTemplateColumns.split(" ").filter(Boolean).length : 0
      };
    });
    const usageOk =
      usageText.includes("Codex usage telemetry") &&
      usageText.includes("Recent jobs") &&
      usageKpiCardCount >= 9 &&
      usageJobCardCount >= 1 &&
      usageTitleLinkCount >= 1 &&
      usageText.includes("Перекладений заголовок для перевірки") &&
      !usageText.includes("Open result") &&
      layout.summaryColumns === 3 &&
      layout.jobMetricColumns === 2 &&
      !usageOverflow;

    const ok = readerOk && usageOk;
    fs.writeFileSync(resultPath, JSON.stringify({
      status: ok ? "fixture_runtime_proof" : "failed",
      viewport: { width: 390, height: 844 },
      screenshotPath,
      usageScreenshotPath,
      targetTextVisible: bodyText.includes("Перекладений заголовок для перевірки"),
      originalEnglishHidden: !bodyText.includes("English title for testing"),
      codexUsageVisible: usageText.includes("Codex usage telemetry"),
      codexUsageKpiCardCount: usageKpiCardCount,
      codexUsageJobCardCount: usageJobCardCount,
      codexUsageTitleLinkCount: usageTitleLinkCount,
      codexUsageTranslatedTitleVisible: usageText.includes("Перекладений заголовок для перевірки"),
      codexUsageOldResultButtonHidden: !usageText.includes("Open result"),
      codexUsageSummaryColumns: layout.summaryColumns,
      codexUsageJobMetricColumns: layout.jobMetricColumns,
      codexUsageNoHorizontalOverflow: !usageOverflow
    }, null, 2));
    if (!ok) {
      process.exitCode = 1;
    }
  } finally {
    if (browser) {
      await browser.close();
    }
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
