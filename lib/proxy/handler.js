const { resolve } = require('dns').promises;
const debug = require('debug')('throttle-proxy:handler');
const socks = require('socks-handler');
const Channel = require('./throttle');
const createUpstream = require('./upstream');

function replyStatusError(version, err) {
  if (version === 5) {
    switch (err.code) {
      case 'EHOSTUNREACH':
        return socks[5].REQUEST_STATUS.HOST_UNREACHABLE;
      case 'ECONNREFUSED':
        return socks[5].REQUEST_STATUS.CONNECTION_REFUSED;
      case 'ENETUNREACH':
        return socks[5].REQUEST_STATUS.NETWORK_UNREACHABLE;
      default:
        return socks[5].REQUEST_STATUS.SERVER_FAILURE;
    }
  }

  return socks[4].REQUEST_STATUS.FAILED;
}

function replyStatusUnsupported(version) {
  return version === 5
    ? socks[5].REQUEST_STATUS.COMMAND_NOT_SUPPORTED
    : socks[4].REQUEST_STATUS.REFUSED;

}

function replyStatusSuccess(version) {
  return version === 5
    ? socks[5].REQUEST_STATUS.SUCCESS
    : socks[4].REQUEST_STATUS.GRANTED;
}

function createVersionedReply(version) {
  return callback => (fn, data) => {
    const statuses = socks[version].REQUEST_STATUS;
    const statusCode = fn(version, data);
    const statusText = Object.keys(statuses).find(k => statuses[k] === statusCode);

    debug(`sending status ${statusText}`);

    callback(statusCode);
  }
}

module.exports = async options => {
  const channels = {
    [options.incomingSpeed]: new Channel(options.incomingSpeed),
    [options.outgoingSpeed]: new Channel(options.outgoingSpeed),
    Infinity: new Channel(Infinity),
  };

  // Initialize channels, resolve DNS to speed up request processing.
  for (const urlConfig of options.urlsConfig) {
    if (urlConfig.incomingSpeed && !channels[urlConfig.incomingSpeed]) channels[urlConfig.incomingSpeed] = new Channel(urlConfig.incomingSpeed);
    if (urlConfig.outgoingSpeed && !channels[urlConfig.outgoingSpeed]) channels[urlConfig.outgoingSpeed] = new Channel(urlConfig.outgoingSpeed);

    // Resolve IP for URL to match by IP if we receive IP by Sock protocol.
    try {
      urlConfig.ips = await resolve(new URL(urlConfig.url).host, 'A')
    } catch (_err) {
      debug(`can't resolve IPs for ${urlConfig.url}`);
    }
  }

  /**
   * Try to find configuration for host:port.
   *
   * @param {string} host Host
   * @param {string} port Port
   * @returns {object} Config
   */
  const getConfigForHost = (host, port) => {
    const isReqHostIP = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(host); // Check DST address is IPv4.

    return options.urlsConfig.find(({ url, ips }) => {
      const parsedUrl = new URL(url);

      return (isReqHostIP ? (ips || []).some(ip => ip === host) : parsedUrl.host === host)
        && (Number(port) === (parsedUrl.protocol === 'https:' ? 443 : 80))
    }) || {};
  }

  const createChannelsForHost = (host, port) => {
    if (!options.urlsConfig.length) {
      return { 
        in: channels[options.incomingSpeed],
        out: channels[options.outgoingSpeed]
      };
    }

    const config = getConfigForHost(host, port);

    return {
        in: channels[config.incomingSpeed || options.incomingSpeed],
        out: channels[config.outgoingSpeed || options.outgoingSpeed]
    };
  }

  return clientConnection => (
    (arg, callback) => {
      let {version, command, host, port} = arg;
      const doReply = createVersionedReply(version)(callback);

      // only "CONNECT" command is supported
      if (command !== socks[5].COMMAND.CONNECT) {
        debug(`unknown command "${command}"`);

        return doReply(replyStatusUnsupported);
      }

      debug(`version: ${version}`);
      debug(`connect to ${host}:${port}`);

      const upstream = createUpstream({host, port, timeout: 3000});
      const channels = createChannelsForHost(host, port);

      clientConnection
        .pipe(channels.out.createThrottle())
        .pipe(upstream)
        .pipe(channels.in.createThrottle())
        .pipe(clientConnection);

      function onConnectError(err) {
        debug(`error ${err.code}, ${host}:${port}`);

        doReply(replyStatusError, err);
      }

      upstream
        .on('close', () => {
          debug('close');
        })
        .on('error', onConnectError)
        .on('connect', socket => {
          debug('connection established');

          upstream.removeListener('error', onConnectError);

          return doReply(replyStatusSuccess);
        });
    }
  );
};
