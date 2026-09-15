import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareEmitToBaseline, firstDifference, parse, productionClosureDiff } from './migration-check';

function differ(a: string, b: string): { path: string } | null {
  return firstDifference(parse(a, 'script'), parse(b, 'script'));
}

test('compareEmitToBaseline: an identical file emitted with "use strict" is equal', () => {
  const baseline = "const x = require('y');\n\nmodule.exports = x;\n";
  assert.equal(compareEmitToBaseline(baseline, `"use strict";\n${baseline}`), null);
});

test('compareEmitToBaseline: a missing "use strict" is reported', () => {
  const baseline = "const x = require('y');\n";
  assert.equal(compareEmitToBaseline(baseline, baseline), 'missing-use-strict');
  assert.equal(compareEmitToBaseline(baseline, `${baseline}"use strict";\n`), 'missing-use-strict');
  assert.equal(compareEmitToBaseline(baseline, `("use strict");\n${baseline}`), 'missing-use-strict');
});

test('compareEmitToBaseline: a changed literal after "use strict" names the file, path and both lines', () => {
  const baseline = 'const T = {\n  a: 1,\n  eventDebounceMs: 3000,\n};\n';
  const emitted = '"use strict";\nconst T = {\n  a: 1,\n  eventDebounceMs: 3001,\n};\n';
  assert.deepEqual(compareEmitToBaseline(baseline, emitted, 'src/x.js'), {
    file: 'src/x.js',
    path: '$.body[0].declarations[0].init.properties[1].value.value',
    left: '  eventDebounceMs: 3000,',
    right: '  eventDebounceMs: 3001,',
  });
});

test('firstDifference: formatting-only differences are ignored', () => {
  assert.equal(differ('function f(a,b){return a+b}', 'function f(a, b) {\n  return a + b;\n}\n'), null);
});

test('firstDifference: comments are ignored', () => {
  assert.equal(differ('const a = 1; // one\n/* block */ f(a);', 'const a = 1;\nf(/* arg */ a);'), null);
});

test('firstDifference: quote style and escapes are ignored', () => {
  assert.equal(differ("f('a', \"b\");", "f(\"a\", '\\x62');"), null);
});

test('firstDifference: redundant parentheses are ignored', () => {
  assert.equal(differ('const a = (b + c) * d; f((x));', 'const a = ((b + c)) * (d); f(x);'), null);
});

test('firstDifference: template literals compare cooked values', () => {
  assert.equal(differ('const s = `a${b}c`;', 'const s = `a${ b }c`;'), null);
  assert.notEqual(differ('const s = `a${b}c`;', 'const s = `a${b}d`;'), null);
});

test('firstDifference: a changed literal is reported with its path', () => {
  assert.deepEqual(differ('const a = 1;', 'const a = 2;'), { path: '$.body[0].declarations[0].init.value' });
  assert.deepEqual(differ("f('a');", "f('b');"), { path: '$.body[0].expression.arguments[0].value' });
});

test('firstDifference: a changed operator is reported', () => {
  assert.deepEqual(differ('x = a + b;', 'x = a - b;'), { path: '$.body[0].expression.right.operator' });
  assert.notEqual(differ('x = a ?? b;', 'x = a || b;'), null);
});

test('firstDifference: a changed identifier is reported', () => {
  assert.deepEqual(differ('foo(a);', 'bar(a);'), { path: '$.body[0].expression.callee.name' });
});

test('firstDifference: a changed property name is reported', () => {
  assert.notEqual(differ('x = o.a;', 'x = o.b;'), null);
  assert.notEqual(differ('x = { a: 1 };', 'x = { b: 1 };'), null);
});

test('firstDifference: a changed regex flag or pattern is reported', () => {
  assert.deepEqual(differ('x = /a/g;', 'x = /a/i;'), { path: '$.body[0].expression.right' });
  assert.notEqual(differ('x = /a/g;', 'x = /b/g;'), null);
  assert.equal(differ('x = /a/g;', 'x = /a/g;'), null);
});

test('firstDifference: reordered statements are reported', () => {
  assert.deepEqual(differ('a();\nb();', 'b();\na();'), { path: '$.body[0].expression.callee.name' });
});

test('firstDifference: an added statement is reported', () => {
  assert.deepEqual(differ('a();\nb();', 'a();\nc();\nb();'), { path: '$.body[1].expression.callee.name' });
  assert.deepEqual(differ('a();', 'a();\nb();'), { path: '$.body[1]' });
});

test('firstDifference: a removed statement is reported', () => {
  assert.deepEqual(differ('a();\nb();', 'a();'), { path: '$.body[1]' });
});

test('firstDifference: (a?.b).c differs from a?.b.c', () => {
  assert.notEqual(differ('x = (a?.b).c;', 'x = a?.b.c;'), null);
});

test('firstDifference: an added class field is reported', () => {
  assert.notEqual(differ('class A {\n  m() {}\n}', 'class A {\n  x;\n  m() {}\n}'), null);
});

const baselineLock = {
  lockfileVersion: 3,
  packages: {
    '': { name: 'app', version: '1.0.0' },
    'node_modules/axios': { version: '1.8.4', integrity: 'sha512-a' },
    'node_modules/ms': { version: '2.1.3', integrity: 'sha512-b' },
    'node_modules/typescript': { version: '7.0.2', dev: true },
  },
};

function withPackages(packages: Record<string, unknown>): unknown {
  return { ...baselineLock, packages };
}

test('productionClosureDiff: identical locks have no differences', () => {
  assert.deepEqual(productionClosureDiff(baselineLock, structuredClone(baselineLock)), []);
});

test('productionClosureDiff: dev-only and root changes are ignored', () => {
  const current = withPackages({
    '': { name: 'app', version: '1.0.0', devDependencies: { acorn: '^8.18.0' } },
    'node_modules/axios': { version: '1.8.4', integrity: 'sha512-a' },
    'node_modules/ms': { version: '2.1.3', integrity: 'sha512-b' },
    'node_modules/acorn': { version: '8.18.0', dev: true },
  });
  assert.deepEqual(productionClosureDiff(baselineLock, current), []);
});

test('productionClosureDiff: changed, added and removed production entries are listed', () => {
  const current = withPackages({
    '': { name: 'app', version: '1.0.0' },
    'node_modules/axios': { version: '1.9.0', integrity: 'sha512-c' },
    'node_modules/left-pad': { version: '1.3.0' },
    'node_modules/typescript': { version: '7.0.2', dev: true },
  });
  assert.deepEqual(productionClosureDiff(baselineLock, current), [
    'changed node_modules/axios: 1.8.4 -> 1.9.0',
    'added node_modules/left-pad',
    'removed node_modules/ms',
  ]);
});

test('productionClosureDiff: a field change without a version change is listed', () => {
  const current = withPackages({ ...baselineLock.packages, 'node_modules/ms': { version: '2.1.3', integrity: 'sha512-z' } });
  assert.deepEqual(productionClosureDiff(baselineLock, current), ['changed node_modules/ms: 2.1.3 -> 2.1.3']);
});

test('productionClosureDiff: an entry that becomes dev-only leaves the production closure', () => {
  const current = withPackages({ ...baselineLock.packages, 'node_modules/ms': { version: '2.1.3', integrity: 'sha512-b', dev: true } });
  assert.deepEqual(productionClosureDiff(baselineLock, current), ['removed node_modules/ms']);
});
