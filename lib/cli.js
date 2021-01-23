const fs = require('fs');
const path = require('path');
const args = require('./args');
const proxy = require('./proxy');
const proxyAutoConfig = require('./proxy-auto-config');

function getUrlsConfig() {
  if (!args.urlsConfigPath) {
    return [];
  }

  try {
    const content = fs.readFileSync(path.resolve(process.cwd(), args.urlsConfigPath)).toString();
    return JSON.parse(content);
  } catch (_err) {}

  return [];
}

const config = {
  port: args.port,
  incomingSpeed: args.incomingSpeed,
  outgoingSpeed: args.outgoingSpeed,
  delay: args.delay,
  urlsConfig: getUrlsConfig()
};

proxy(config);

if (args.pacPort) {
  proxyAutoConfig({
    port: args.port,
    pacPort: args.pacPort
  });
}
