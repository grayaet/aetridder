const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const { createApp } = require("../src/app");
const { loadConfig } = require("../src/config");
const { appRoot, sampleRaw, translatedFromRaw, apiToken } = require("./helpers");

async function main() {
  const outputDir = path.join(appRoot, "runtime", "mobile-render-check");
  fs.mkdirSync(outputDir, { recursive: true });
  const resultPath = path.join(outputDir, "mobile-render-check.json");
  const screenshotPath = path.join(outputDir, "reader-390x844.png");

  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (_error) {
    fs.writeFileSync(resultPath, JSON.stringify({ status: "skipped_due_to_host_limit", reason: "Playwright package unavailable" }, null, 2));
    return;
  }

  const config = loadConfig({
    env: {
      AETRIDDER_API_TOKEN: apiToken,
      AETRIDDER_DIAGNOSTICS_TOKEN: apiToken,
      AETRIDDER_MAX_COMMENTS: "1000"
    },
    storageDir: path.join(outputDir, "storage")
  });
  const instance = createApp({
    config,
    extractor: async () => ({ thread: sampleRaw({ warningCodes: ["partial_comments"] }) }),
    translator: async (raw) => ({ thread: translatedFromRaw(raw) })
  });
  const server = http.createServer(instance.app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  let browser;
  try {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (_error) {
      fs.writeFileSync(resultPath, JSON.stringify({ status: "skipped_due_to_host_limit", reason: "Playwright Chromium unavailable" }, null, 2));
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
    const ok = bodyText.includes("Русский заголовок для проверки") && !bodyText.includes("English title for testing");
    fs.writeFileSync(resultPath, JSON.stringify({
      status: ok ? "fixture_runtime_proof" : "failed",
      viewport: { width: 390, height: 844 },
      screenshotPath,
      russianTextVisible: bodyText.includes("Русский заголовок для проверки"),
      originalEnglishHidden: !bodyText.includes("English title for testing")
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

