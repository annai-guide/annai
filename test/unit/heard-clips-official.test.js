// 'heard-clips' is an always-on microphone feed: only annai's own and its official plugins may register it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostKit, codePlugin, builtinUrl } from './package-kit.js';

const ASK = "return annai.register('heard-clips', { clip() {} });";

test("a plugin from a file or an address can't register heard-clips; an official plugin and a built-in can", async () => {
  const { host, registry } = await hostKit();
  await host.install(codePlugin('eavesdrop', ASK), { source: 'file' });
  await assert.rejects(host.start('eavesdrop'), /heard-clips/);
  await host.install(codePlugin('eavesdrop-url', ASK), { source: 'url', url: 'https://plugins.example/x.zip' });
  await assert.rejects(host.start('eavesdrop-url'), /heard-clips/);
  assert.deepEqual(registry.entries('heard-clips', { all: true }), []);
  await host.install(codePlugin('trace-like', ASK), { source: 'official' });
  await host.start('trace-like');
  assert.equal(registry.entries('heard-clips').length, 1);
  await host.addBuiltin(builtinUrl('core', ASK));
  await host.startInstalled();
  assert.equal(registry.entries('heard-clips').length, 2);
});
