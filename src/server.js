const { createApp } = require("./app");
const { loadConfig } = require("./config");

const config = loadConfig();
const { app } = createApp({ config });

app.listen(config.httpPort, config.httpHost, () => {
  const authState = config.apiToken ? "configured" : "missing";
  console.log(`Aetridder listening on http://${config.httpHost}:${config.httpPort}`);
  console.log(`API auth: ${authState}. Sensitive values are not logged.`);
});
