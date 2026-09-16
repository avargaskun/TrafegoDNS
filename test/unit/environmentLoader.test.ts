import { test } from 'node:test';
import assert from 'node:assert/strict';
import EnvironmentLoader from '../../src/config/EnvironmentLoader';
import { withEnv } from '../helpers/env';
import { captureLogs } from '../helpers/logCapture';

const FALSY_SPELLINGS = ['false', 'FALSE', 'False', '0', 'no', 'NO', 'off', 'Off', ' false '];
const TRUTHY_SPELLINGS = ['true', 'TRUE', 'True', '1', 'yes', 'YES', 'on', 'On', ' true '];
const BLANK_SPELLINGS = ['', '   '];

test('every falsy spelling is read as false', () => {
  for (const value of FALSY_SPELLINGS) {
    const actual = withEnv({ TEST_FLAG: value }, () => EnvironmentLoader.getBool('TEST_FLAG', true));
    assert.equal(actual, false, `TEST_FLAG=${JSON.stringify(value)} should be false`);
  }
});

test('every truthy spelling is read as true', () => {
  for (const value of TRUTHY_SPELLINGS) {
    const actual = withEnv({ TEST_FLAG: value }, () => EnvironmentLoader.getBool('TEST_FLAG', false));
    assert.equal(actual, true, `TEST_FLAG=${JSON.stringify(value)} should be true`);
  }
});

test('an unset variable uses the declared default', (t) => {
  const { entries } = captureLogs(t);

  withEnv({}, () => {
    assert.equal(EnvironmentLoader.getBool('TEST_FLAG', true), true);
    assert.equal(EnvironmentLoader.getBool('TEST_FLAG', false), false);
  });

  assert.deepEqual(entries.filter((entry) => entry.level === 'WARN'), []);
});

test('an unrecognised value warns and uses the declared default', (t) => {
  const { entries } = captureLogs(t);

  const actual = withEnv({ TEST_FLAG: 'orange' }, () => EnvironmentLoader.getBool('TEST_FLAG', false));

  assert.equal(actual, false);
  const warnings = entries.filter((entry) => entry.level === 'WARN');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].text, /TEST_FLAG/);
  assert.match(warnings[0].text, /orange/);
});

test('an unrecognised value honours a true default', () => {
  const actual = withEnv({ TEST_FLAG: 'orange' }, () => EnvironmentLoader.getBool('TEST_FLAG', true));
  assert.equal(actual, true);
});

test('a blank value uses the declared default', (t) => {
  const { entries } = captureLogs(t);

  for (const value of BLANK_SPELLINGS) {
    withEnv({ TEST_FLAG: value }, () => {
      assert.equal(EnvironmentLoader.getBool('TEST_FLAG', true), true, `TEST_FLAG=${JSON.stringify(value)} should keep a true default`);
      assert.equal(EnvironmentLoader.getBool('TEST_FLAG', false), false, `TEST_FLAG=${JSON.stringify(value)} should keep a false default`);
    });
  }

  assert.deepEqual(entries.filter((entry) => entry.level === 'WARN'), []);
});

test('a blank integer uses the declared default', () => {
  for (const value of BLANK_SPELLINGS) {
    const actual = withEnv({ TEST_INT: value }, () => EnvironmentLoader.getInt('TEST_INT', 7));
    assert.equal(actual, 7, `TEST_INT=${JSON.stringify(value)} should keep the declared default`);
  }
});

test('a non-integer still fails fast', () => {
  withEnv({ TEST_INT: 'abc' }, () => {
    assert.throws(
      () => EnvironmentLoader.getInt('TEST_INT', 7),
      /Invalid format for environment variable TEST_INT: Expected an integer/
    );
  });
});
