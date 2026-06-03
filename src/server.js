const { createApp } = require("./app");
const { loadConfig } = require("./config");

const config = loadConfig();
const { app } = createApp({ config });

app.listen(config.httpPort, () => {
  const authState = config.apiToken ? "configured" : "missing";
  console.log(`Aetridder listening on http://127.0.0.1:${config.httpPort}`);
  console.log(`API auth: ${authState}. Sensitive values are not logged.`);
});

