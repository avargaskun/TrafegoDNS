// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const guardsPath = path.resolve(__dirname, '../../src/utils/processGuards.js');

function runGuardedChild(failure) {
  const code = [
    `require(${JSON.stringify(guardsPath)}).installProcessGuards();`,
    "const err = Object.assign(new Error('Request failed'), { config: { headers: { Authorization: 'Bearer SYNTHETIC-TOKEN' } }, response: { status: 525 } });",
    failure
  ].join('\n');
  return spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, LOG_LEVEL: 'INFO' }
  });
}

function assertNoToken(result) {
  assert.ok(!result.stdout.includes('SYNTHETIC-TOKEN'), `stdout leaked token: ${result.stdout}`);
  assert.ok(!result.stderr.includes('SYNTHETIC-TOKEN'), `stderr leaked token: ${result.stderr}`);
}

test('an unhandled rejection is logged sanitised and exits with status 1', () => {
  const result = runGuardedChild('Promise.reject(err);');
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes('Unhandled promise rejection: Request failed status=525'), result.stdout);
  assertNoToken(result);
});

test('an uncaught exception is logged sanitised and exits with status 1', () => {
  const result = runGuardedChild('throw err;');
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes('Uncaught exception: Request failed status=525'), result.stdout);
  assertNoToken(result);
});
