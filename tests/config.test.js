const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { loadConfig } = require("../src/config");

test("neutral REDDIT_READER env aliases override legacy deployment names", () => {
  const config = loadConfig({
    storageDir: path.join(__dirname, "..", "runtime", "config-test"),
    env: {
      REDDIT_RU_API_TOKEN: "legacy-api-token",
      REDDIT_READER_API_TOKEN: "neutral-api-token",
      REDDIT_RU_HTTP_HOST: "0.0.0.0",
      REDDIT_READER_HTTP_HOST: "127.0.0.2",
      REDDIT_RU_HTTP_PORT: "4173",
      REDDIT_READER_HTTP_PORT: "4174",
      REDDIT_RU_TARGET_LANGUAGE_CODE: "de",
      REDDIT_READER_TARGET_LANGUAGE_CODE: "es",
      REDDIT_RU_TARGET_LANGUAGE_NAME: "German",
      REDDIT_READER_TARGET_LANGUAGE_NAME: "Spanish",
      REDDIT_RU_TARGET_LOCALE: "de-DE",
      REDDIT_READER_TARGET_LOCALE: "es-ES"
    }
  });

  assert.equal(config.apiToken, "neutral-api-token");
  assert.equal(config.httpHost, "127.0.0.2");
  assert.equal(config.httpPort, 4174);
  assert.equal(config.targetLanguageCode, "es");
  assert.equal(config.targetLanguageName, "Spanish");
  assert.equal(config.targetLocale, "es-ES");
});

test("public debug pages are protected unless explicitly enabled", () => {
  const protectedConfig = loadConfig({
    storageDir: path.join(__dirname, "..", "runtime", "config-test-debug-protected"),
    env: {}
  });
  assert.equal(protectedConfig.httpHost, "127.0.0.1");
  assert.equal(protectedConfig.publicDebugPages, false);

  const publicConfig = loadConfig({
    storageDir: path.join(__dirname, "..", "runtime", "config-test-debug-public"),
    env: {
      REDDIT_READER_PUBLIC_DEBUG_PAGES: "1"
    }
  });
  assert.equal(publicConfig.publicDebugPages, true);
});
