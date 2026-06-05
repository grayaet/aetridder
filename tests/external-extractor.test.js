const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createExtractorAgent } = require("../src/extractor-agent");
const { extractWithExternalExtractor } = require("../src/external-extractor");
const { loadConfig } = require("../src/config");
const {
  diagnosticsToken,
  freshStorage,
  cleanupStorage,
  makeConfig,
  sampleRaw,
  translatedFromRaw,
  withServer,
  requestJson,
  getJson,
  waitForStatus
} = require("./helpers");

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test("external extractor endpoint feeds the existing translation/render pipeline", async () => {
  const externalToken = "external-token";
  const raw = sampleRaw();
  let requestBody = null;
  let requestAuth = null;
  const remote = await listen((req, res) => {
    if (req.method !== "POST" || req.url !== "/extract") {
      res.writeHead(404);
      res.end();
      return;
    }
    requestAuth = req.headers.authorization || "";
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requestBody = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        protocolVersion: requestBody.protocolVersion,
        ok: true,
        jobId: requestBody.jobId,
        generation: requestBody.generation,
        requestId: requestBody.requestId,
        rawThread: raw,
        extractor: {
          provider: "local-playwright",
          agentVersion: "test-extractor-agent.v1",
          startedAt: "2026-06-03T00:00:00.000Z",
          endedAt: "2026-06-03T00:00:01.000Z",
          browserReady: true
        }
      }));
    });
  });

  try {
    await withServer({
      name: "external-extractor-pipeline",
      configOverrides: {
        extraEnv: {
          REDDIT_READER_EXTRACTION_MODE: "external",
          REDDIT_READER_EXTERNAL_EXTRACTOR_URL: `${remote.baseUrl}/extract`,
          REDDIT_READER_EXTERNAL_EXTRACTOR_TOKEN: externalToken
        }
      },
      translator: async (thread) => translatedFromRaw(thread)
    }, async ({ baseUrl }) => {
      const created = await requestJson(baseUrl, "POST", "/api/threads", { url: raw.sourceUrl });
      assert.equal(created.status, 202);
      const status = await waitForStatus(baseUrl, created.body.jobId, "ready");
      assert.equal(status.status, "ready");
      assert.equal(requestAuth, `Bearer ${externalToken}`);
      assert.equal(requestBody.protocolVersion, "extractor.v1");
      assert.equal(requestBody.normalizedUrl, raw.normalizedUrl);
      assert.equal(requestBody.limits.maxComments, 1000);
      assert.equal(status.extractor.provider, "remote-http");
      assert.equal(status.extractor.agentVersion, "test-extractor-agent.v1");
      const reader = await getJson(baseUrl, `/api/view/${created.body.jobId}`, diagnosticsToken);
      assert.equal(reader.status, 200);
      assert.equal(reader.body.thread.post.title, "Перекладений заголовок для перевірки");
      const diagnostics = await getJson(baseUrl, "/api/diagnostics/extractor", diagnosticsToken);
      assert.equal(diagnostics.status, 200);
      assert.equal(diagnostics.body.configuredProvider, "remote-http");
      assert.equal(JSON.stringify(diagnostics.body).includes(externalToken), false);
    });
  } finally {
    await remote.close();
  }
});

test("missing tunnel endpoint fails quickly as extractor_unavailable", async () => {
  const storageDir = freshStorage("external-extractor-offline");
  try {
    const config = makeConfig(storageDir, {
      extraEnv: {
        REDDIT_READER_EXTERNAL_EXTRACTOR_URL: "http://127.0.0.1:1/extract"
      }
    });
    await assert.rejects(
      () => extractWithExternalExtractor({
        jobId: "offline-test-job",
        sourceUrl: "https://www.reddit.com/r/redditdev/comments/1oxazn8/need_api_access/",
        normalizedUrl: "https://www.reddit.com/r/redditdev/comments/1oxazn8/need_api_access/"
      }, { config, log: () => {} }),
      (error) => {
        assert.equal(error.status, "extraction_unavailable");
        assert.equal(error.errorCode, "extractor_unavailable");
        return true;
      }
    );
  } finally {
    cleanupStorage(storageDir);
  }
});

test("remote extractor rejects mismatched job protocol response", async () => {
  const raw = sampleRaw();
  const remote = await listen((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const requestBody = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        protocolVersion: requestBody.protocolVersion,
        ok: true,
        jobId: "different-job",
        generation: requestBody.generation,
        requestId: requestBody.requestId,
        rawThread: raw
      }));
    });
  });
  const storageDir = freshStorage("external-extractor-wrong-job");
  try {
    const config = makeConfig(storageDir, {
      extraEnv: {
        REDDIT_READER_EXTERNAL_EXTRACTOR_URL: `${remote.baseUrl}/extract`
      }
    });
    await assert.rejects(
      () => extractWithExternalExtractor({
        jobId: "requested-job",
        generation: 12,
        sourceUrl: raw.sourceUrl,
        normalizedUrl: raw.normalizedUrl
      }, { config, log: () => {} }),
      (error) => {
        assert.equal(error.status, "extraction_failed");
        assert.equal(error.errorCode, "extractor_schema_invalid");
        return true;
      }
    );
  } finally {
    await remote.close();
    cleanupStorage(storageDir);
  }
});

test("remote extractor maps Reddit verification page as reddit_unavailable", async () => {
  const raw = sampleRaw();
  const remote = await listen((_req, res) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: false,
      errorCode: "reddit_verification_or_block_page",
      errorMessageSafe: "Reddit returned a verification or block page."
    }));
  });
  const storageDir = freshStorage("external-extractor-reddit-blocked");
  try {
    const config = makeConfig(storageDir, {
      extraEnv: {
        REDDIT_READER_EXTERNAL_EXTRACTOR_URL: `${remote.baseUrl}/extract`
      }
    });
    await assert.rejects(
      () => extractWithExternalExtractor({
        jobId: "reddit-blocked-job",
        generation: 1,
        sourceUrl: raw.sourceUrl,
        normalizedUrl: raw.normalizedUrl
      }, { config, log: () => {} }),
      (error) => {
        assert.equal(error.status, "reddit_unavailable");
        assert.equal(error.errorCode, "reddit_verification_or_block_page");
        return true;
      }
    );
  } finally {
    await remote.close();
    cleanupStorage(storageDir);
  }
});

test("local extractor agent requires token when configured and returns extracted thread", async () => {
  const storageDir = freshStorage("extractor-agent");
  const raw = sampleRaw();
  const config = loadConfig({
    storageDir,
    env: {
      REDDIT_READER_EXTRACTOR_AGENT_TOKEN: "agent-token",
      REDDIT_READER_API_TOKEN: "unused-api",
      REDDIT_READER_DIAGNOSTICS_TOKEN: "unused-diagnostics"
    }
  });
  const agent = createExtractorAgent({
    config,
    extractor: async () => ({ thread: raw })
  });
  const server = await listen(agent.app);
  try {
    const unauthorized = await fetch(`${server.baseUrl}/extract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: raw.sourceUrl })
    });
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${server.baseUrl}/extract`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer agent-token"
      },
      body: JSON.stringify({ url: raw.sourceUrl, jobId: "agenttest123" })
    });
    assert.equal(authorized.status, 200);
    const body = await authorized.json();
    assert.equal(body.protocolVersion, "extractor.v1");
    assert.equal(body.ok, true);
    assert.equal(body.rawThread.post.id, raw.post.id);
  } finally {
    await server.close();
    cleanupStorage(storageDir);
  }
});
