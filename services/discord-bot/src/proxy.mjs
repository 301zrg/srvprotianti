import http from 'node:http';
import https from 'node:https';
import {ProxyAgent} from 'undici';
import {createGlobalProxyAgent} from 'global-agent';

export function createDiscordProxyTransport(value = process.env.DISCORD_PROXY_URL) {
  if (!value) return {restOptions: {}, close: async () => {}};
  let url;
  try { url = new URL(value); } catch { throw new Error('DISCORD_PROXY_URL must be a loopback HTTP(S) proxy URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/' || url.search || url.hash) {
    // Never echo the input: private proxy URLs may contain authentication.
    throw new Error('DISCORD_PROXY_URL must be a loopback HTTP(S) proxy URL');
  }
  const previous = [http, https].map(module => ({module, agent: module.globalAgent, request: module.request, get: module.get}));
  const restAgent = new ProxyAgent(url.href);
  // ws supplies createConnection, which bypasses Node's default agent. The
  // documented global-agent integration handles that inside this worker only.
  const controller = createGlobalProxyAgent({environmentVariableNamespace: 'DISCORD_PROXY_INTERNAL_',
    forceGlobalAgent: true, socketConnectionTimeout: 10000});
  controller.HTTP_PROXY = undefined;
  controller.HTTPS_PROXY = url.href;
  controller.NO_PROXY = 'localhost,127.0.0.1,::1';
  const gatewayAgent = https.globalAgent;
  const addRequest = gatewayAgent.addRequest;
  // global-agent 4.x needs this HTTPS marker to forward SNI and certificate
  // verification options when ws supplies its own createConnection function.
  gatewayAgent.addRequest = function(request, options) {
    return addRequest.call(this, request, {...options, secureEndpoint: true});
  };
  let closed = false;
  return {
    restOptions: {agent: restAgent},
    async close() {
      if (closed) return;
      closed = true;
      controller.HTTPS_PROXY = undefined;
      for (const {module, agent, request, get} of previous) {
        module.globalAgent = agent; module.request = request; module.get = get;
      }
      await restAgent.close();
    }
  };
}
