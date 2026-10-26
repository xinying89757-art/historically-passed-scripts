import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, main } from './run-live.mjs';

test('nested placeholder reports key paths without printing credential values', () => {
  const errors = validateConfig({ sites: [{ url: 'https://site.example.invalid' }], password: 'do-not-log-this' });
  assert.deepEqual(errors, ['sites[0].url: 仍为归档占位值']);
  assert.ok(!errors.join('').includes('do-not-log-this'));
});
test('blank credential fields are rejected and optional empty proxy is accepted', () => {
  assert.deepEqual(validateConfig({ account: '', password: '', proxy: '' }), ['account: 缺少本机凭据', 'password: 缺少本机凭据']);
});
test('configured values are preserved and not included in diagnostics', () => {
  assert.deepEqual(validateConfig({ baseURL: 'https://qa.test', password: 'local-value' }), []);
});
test('missing configuration stops before starting a command or browser', async () => {
  await assert.rejects(main(['block-page', 'plan']), /缺少配置/);
});
