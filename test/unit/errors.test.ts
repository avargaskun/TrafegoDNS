// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeError, runGuarded } from '../../src/utils/errors';
import { captureLogs } from '../helpers/logCapture';

function axiosLikeError() {
  return Object.assign(new Error('Request failed with status code 525'), {
    name: 'AxiosError',
    code: 'ERR_BAD_RESPONSE',
    config: { headers: { Authorization: 'Bearer SYNTHETIC-TOKEN' } },
    request: { _header: 'Authorization: Bearer SYNTHETIC-TOKEN' },
    response: { status: 525, data: { token: 'SYNTHETIC-TOKEN' } }
  });
}

function assertNoSecrets(text) {
  assert.ok(!text.includes('SYNTHETIC-TOKEN'), `leaked token: ${text}`);
  assert.ok(!text.includes('Authorization'), `leaked header name: ${text}`);
  assert.ok(!text.includes('Bearer'), `leaked auth scheme: ${text}`);
}

test('describeError renders message, code and status of an AxiosError-like object without secrets', () => {
  const text = describeError(axiosLikeError());
  assert.ok(text.includes('Request failed with status code 525'));
  assert.ok(text.includes('code=ERR_BAD_RESPONSE'));
  assert.ok(text.includes('status=525'));
  assertNoSecrets(text);
});

test('describeError handles null, undefined and non-object values', () => {
  assert.equal(describeError(null), 'null');
  assert.equal(describeError(undefined), 'undefined');
  assert.equal(describeError('plain failure'), 'plain failure');
  assert.equal(describeError(42), '42');
});

test('describeError falls back to name, then a generic label, and reads statusCode', () => {
  assert.equal(describeError({ name: 'TimeoutError' }), 'TimeoutError');
  assert.equal(describeError({}), 'Unknown error');
  assert.equal(describeError({ message: 'socket hang up', code: 'ECONNRESET' }), 'socket hang up code=ECONNRESET');
  assert.equal(describeError({ message: 'bad gateway', statusCode: 502 }), 'bad gateway status=502');
});

test('runGuarded logs a synchronous throw and does not rethrow', (t) => {
  const { entries } = captureLogs(t);
  const result = runGuarded('Sync context', () => {
    throw axiosLikeError();
  });
  assert.equal(result, undefined);
  const errors = entries.filter((e) => e.level === 'ERROR');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].text.includes('Sync context: Request failed with status code 525 code=ERR_BAD_RESPONSE status=525'));
  assertNoSecrets(errors[0].text);
});

test('runGuarded logs an async rejection and resolves instead of rejecting', async (t) => {
  const { entries } = captureLogs(t);
  const result = await runGuarded('Async context', async () => {
    throw axiosLikeError();
  });
  assert.equal(result, undefined);
  const errors = entries.filter((e) => e.level === 'ERROR');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].text.includes('Async context: Request failed with status code 525'));
  assertNoSecrets(errors[0].text);
});

test('runGuarded returns the result of a successful call without logging', async (t) => {
  const { entries } = captureLogs(t);
  assert.equal(runGuarded('ok', () => 7), 7);
  assert.equal(await runGuarded('ok', async () => 8), 8);
  assert.equal(entries.filter((e) => e.level === 'ERROR').length, 0);
});
