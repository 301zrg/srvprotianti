import test from 'node:test';
import assert from 'node:assert/strict';
import {createDiscordClashProfile} from '../src/proxy-profile.mjs';

const credentials = {proxyPassword: 'test-password-24-characters', controllerSecret: 'test-controller-24-characters'};
const nodes = [{name: 'route-a', type: 'ss', server: 'a.example.invalid', password: 'fixture-a'},
  {name: 'route-b', type: 'vmess', server: 'b.example.invalid', uuid: 'fixture-b'}];

test('private Clash profile uses only supplied nodes, loopback/auth and Discord URL testing', () => {
  const profile = createDiscordClashProfile(nodes, credentials);
  assert.deepEqual(profile.proxies, nodes);
  assert.notEqual(profile.proxies, nodes);
  assert.equal(profile['allow-lan'], false);
  assert.equal(profile['bind-address'], '127.0.0.1');
  assert.equal(profile['external-controller'], '127.0.0.1:19090');
  assert.equal(profile.authentication.length, 1);
  assert.equal(profile.tun.enable, false);
  assert.equal(profile.dns.enable, false);
  const group = profile['proxy-groups'][0];
  assert.equal(group.type, 'url-test');
  assert.deepEqual(group.proxies, ['route-a', 'route-b']);
  assert.equal(group.url, 'https://discord.com/api/v10/gateway');
  assert.equal(group.interval, 60);
  assert.equal(group.tolerance, 150);
  assert.equal(group.lazy, false);
  assert.deepEqual(profile.rules, ['MATCH,DISCORD_AUTO']);
});

test('unusable or duplicate nodes, weak secrets and overlapping ports fail without exposing credentials', () => {
  for (const value of [[], [...nodes, nodes[0]], [{...nodes[0], server: '127.0.0.1'}], [{...nodes[0], type: 'unknown'}]]) {
    assert.throws(() => createDiscordClashProfile(value, credentials));
  }
  assert.throws(() => createDiscordClashProfile(nodes, {...credentials, proxyPassword: 'secret'}), /credentials/);
  assert.throws(() => createDiscordClashProfile(nodes, {...credentials, controllerPort: 17890}), /must differ/);
});
