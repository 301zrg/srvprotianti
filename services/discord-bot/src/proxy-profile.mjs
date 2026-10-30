const loopback = server => /^(localhost|127\.|::1$|\[::1\]$)/i.test(String(server));

export function createDiscordClashProfile(proxies, {proxyPassword, controllerSecret, port = 17890, controllerPort = 19090} = {}) {
  if (!Array.isArray(proxies) || !proxies.length) throw new Error('No proxy nodes supplied');
  if (!proxyPassword || !controllerSecret || proxyPassword.length < 24 || controllerSecret.length < 24) {
    throw new Error('Private proxy and controller credentials are required');
  }
  for (const value of [port, controllerPort]) {
    if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error('Invalid loopback port');
  }
  if (port === controllerPort) throw new Error('Proxy and controller ports must differ');
  const names = new Set();
  for (const node of proxies) {
    if (!node || !node.name || names.has(node.name) || !['ss', 'vmess'].includes(node.type) || !node.server || loopback(node.server)) {
      throw new Error('Invalid, duplicate or nonportable iKuuu node');
    }
    names.add(node.name);
  }
  return {
    'mixed-port': port, 'allow-lan': false, 'bind-address': '127.0.0.1',
    'external-controller': `127.0.0.1:${controllerPort}`, secret: controllerSecret,
    authentication: [`discord-bot:${proxyPassword}`], mode: 'rule', 'log-level': 'warning', ipv6: false,
    tun: {enable: false}, dns: {enable: false},
    proxies: structuredClone(proxies),
    'proxy-groups': [{name: 'DISCORD_AUTO', type: 'url-test', proxies: [...names],
      url: 'https://discord.com/api/v10/gateway', interval: 60, tolerance: 150, lazy: false}],
    rules: ['MATCH,DISCORD_AUTO']
  };
}
