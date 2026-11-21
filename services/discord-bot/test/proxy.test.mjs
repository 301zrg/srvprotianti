import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {once} from 'node:events';
import WebSocket from 'ws';
import {fetch} from 'undici';
import {createDiscordProxyTransport} from '../src/proxy.mjs';
import {DiscordAdapter} from '../src/discord.mjs';

test('proxy is optional, loopback only, and invalid private URLs are not echoed', async () => {
  const previous = https.globalAgent;
  const direct = createDiscordProxyTransport('');
  assert.deepEqual(direct.restOptions, {});
  assert.equal(https.globalAgent, previous);
  await direct.close();
  for (const value of ['not-a-url-secret', 'socks5://127.0.0.1:7890', 'http://secret:password@example.com:7890',
    'http://127.0.0.1:7890/?token=secret']) {
    assert.throws(() => createDiscordProxyTransport(value), error => error.message.includes('loopback') && !error.message.includes('secret'));
  }
  assert.equal(https.globalAgent, previous);
});

test('Discord REST and unmodified ws use the same proxy while game fetch stays direct', async () => {
  const connects = [];
  const proxy = http.createServer();
  proxy.on('connect', (request, socket) => {
    assert.equal(request.headers['proxy-authorization'], 'Basic ' + Buffer.from('fixture:password').toString('base64'));
    connects.push(request.url);
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
  });
  const game = http.createServer((request, response) => { response.end('direct-game-api'); });
  proxy.listen(0, '127.0.0.1'); game.listen(0, '127.0.0.1');
  await Promise.all([once(proxy, 'listening'), once(game, 'listening')]);
  const previous = https.globalAgent;
  const transport = createDiscordProxyTransport(`http://fixture:password@127.0.0.1:${proxy.address().port}`);
  const gatewayTls = [];
  const connectGateway = https.globalAgent.createConnection;
  https.globalAgent.createConnection = function(options, callback) {
    gatewayTls.push(options.tls);
    return connectGateway.call(this, options, callback);
  };
  const adapter = new DiscordAdapter({guilds: []}, {}, {write: async () => {}}, {transport});
  try {
    assert.equal(adapter.client.rest.agent, transport.restOptions.agent);
    await assert.rejects(fetch('https://discord.com/api/v10/gateway', {dispatcher: transport.restOptions.agent, signal: AbortSignal.timeout(2000)}));
    const socket = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('WSS proxy did not receive the test handshake')); }, 2000);
      socket.once('error', () => { clearTimeout(timer); resolve(); });
    });
    const response = await globalThis.fetch(`http://127.0.0.1:${game.address().port}/`);
    assert.equal(await response.text(), 'direct-game-api');
    assert.deepEqual(connects, ['discord.com:443', 'gateway.discord.gg:443']);
    assert.equal(gatewayTls[0].servername, 'gateway.discord.gg', 'Gateway TLS must validate the destination rather than localhost');
    assert.equal(gatewayTls[0].rejectUnauthorized, true, 'proxying must preserve certificate verification');
  } finally {
    adapter.stop();
    await transport.close();
    await transport.close();
    assert.equal(https.globalAgent, previous);
    game.closeAllConnections();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => game.close(resolve))]);
  }
});
