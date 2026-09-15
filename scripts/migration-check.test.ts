import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkImportResolution, compareEmitToBaseline, compareSyntaxMap, compareTrees, finalViolations, firstDifference, parse, parseTapTestNames, productionClosureDiff } from './migration-check';

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

function syntaxMap(baseline: string, converted: string, named: string[] = []): string[] {
  return compareSyntaxMap(baseline, converted, { namedExportModules: new Set(named) });
}

const NOCHECK = '// @ts-nocheck\n';

test('compareSyntaxMap: a destructured require maps to named imports with renames', () => {
  assert.deepEqual(syntaxMap("const { a, b: c } = require('m');\nf(a, c);\n", "import { a, b as c } from 'm';\nf(a, c);\n"), []);
});

test('compareSyntaxMap: a single-binding require maps to a default import', () => {
  assert.deepEqual(syntaxMap("const X = require('m');\nX();\n", "import X from 'm';\nX();\n"), []);
});

test('compareSyntaxMap: the header line and comments inside import braces are ignored', () => {
  const baseline = "const {\n  a, // first\n  b: c\n} = require('m');\nf(a, c);\n";
  const converted = `${NOCHECK}import {\n  a, // first\n  b as c\n} from 'm';\nf(a, c);\n`;
  assert.deepEqual(syntaxMap(baseline, converted), []);
});

test('compareSyntaxMap: import * as is required for a named-export module and rejected otherwise', () => {
  const baseline = "const golden = require('../fixtures/golden');\ngolden.run();\n";
  const namespace = "import * as golden from '../fixtures/golden';\ngolden.run();\n";
  const plain = "import golden from '../fixtures/golden';\ngolden.run();\n";
  assert.deepEqual(syntaxMap(baseline, namespace, ['../fixtures/golden']), []);
  assert.deepEqual(syntaxMap(baseline, namespace), [
    "import #1: expected import golden from '../fixtures/golden', found import * as golden from '../fixtures/golden'",
  ]);
  assert.deepEqual(syntaxMap(baseline, plain, ['../fixtures/golden']), [
    "import #1: expected import * as golden from '../fixtures/golden', found import golden from '../fixtures/golden'",
  ]);
});

test('compareSyntaxMap: import * as is rejected where the baseline destructured', () => {
  assert.deepEqual(syntaxMap("const { a } = require('m');\na();\n", "import * as m from 'm';\na();\n", ['m']), [
    "import #1: expected import { a } from 'm', found import * as m from 'm'",
  ]);
});

test('compareSyntaxMap: reordered imports are reported', () => {
  assert.deepEqual(syntaxMap("const a = require('a');\nconst b = require('b');\nf(a, b);\n", "import b from 'b';\nimport a from 'a';\nf(a, b);\n"), [
    "import #1: expected import a from 'a', found import b from 'b'",
    "import #2: expected import b from 'b', found import a from 'a'",
  ]);
});

test('compareSyntaxMap: an import moved past a statement is reported', () => {
  assert.deepEqual(syntaxMap("const a = require('a');\nconst b = require('b');\nf(a, b);\n", "import a from 'a';\nf(a, b);\nimport b from 'b';\n"), [
    "import #2: import b from 'b' is at statement index 1, expected 0",
  ]);
});

test('compareSyntaxMap: a changed module specifier is reported', () => {
  assert.deepEqual(syntaxMap("const a = require('./a');\na();\n", "import a from './b';\na();\n"), [
    "import #1: expected import a from './a', found import a from './b'",
  ]);
});

test('compareSyntaxMap: a missing or renamed binding is reported', () => {
  assert.deepEqual(syntaxMap("const { a, b } = require('m');\nf(a, b);\n", "import { a } from 'm';\nf(a, b);\n"), [
    "import #1: expected import { a, b } from 'm', found import { a } from 'm'",
  ]);
  assert.deepEqual(syntaxMap("const { a } = require('m');\nf(a);\n", "import { a as z } from 'm';\nf(a);\n"), [
    "import #1: expected import { a } from 'm', found import { a as z } from 'm'",
  ]);
});

test('compareSyntaxMap: a missing or extra import is reported', () => {
  assert.deepEqual(syntaxMap("const a = require('a');\nconst b = require('b');\n", "import a from 'a';\n"), [
    "import #2: expected import b from 'b', found no import",
  ]);
  assert.deepEqual(syntaxMap("const a = require('a');\n", "import a from 'a';\nimport 'b';\n"), ["import #2: unexpected import 'b'"]);
});

test('compareSyntaxMap: an all-shorthand module.exports maps to an export list in the same order', () => {
  const baseline = 'const a = 1;\nconst b = 2;\nmodule.exports = { a, b };\n';
  assert.deepEqual(syntaxMap(baseline, 'const a = 1;\nconst b = 2;\nexport { a, b };\n'), []);
  assert.deepEqual(syntaxMap(baseline, 'const a = 1;\nconst b = 2;\nexport { b, a };\n'), ['export list: expected { a, b }, found { b, a }']);
});

test('compareSyntaxMap: an all-shorthand module.exports must not become a default export', () => {
  const errors = syntaxMap('const a = 1;\nmodule.exports = { a };\n', 'const a = 1;\nexport default { a };\n');
  assert.deepEqual(errors, ['export default (line 2): unexpected', 'export list: expected { a }, found {}']);
});

test('compareSyntaxMap: a default export, an export list and an export const map together', () => {
  const baseline = 'const X = { j: 1 };\nconst k = 2;\nmodule.exports = X;\nmodule.exports.k = k;\nmodule.exports.j = X.j;\n';
  const converted = 'const X = { j: 1 };\nconst k = 2;\nexport default X;\nexport { k };\nexport const j = X.j;\n';
  assert.deepEqual(syntaxMap(baseline, converted), []);
});

test('compareSyntaxMap: a run of module.exports.k = k statements may become one export list', () => {
  const baseline = 'class D {}\nconst T = {};\nfunction c() {}\nmodule.exports = D;\nmodule.exports.T = T;\nmodule.exports.c = c;\nmodule.exports.classify = D.classify;\n';
  const converted = 'class D {}\nconst T = {};\nfunction c() {}\nexport default D;\nexport { T, c };\nexport const classify = D.classify;\n';
  assert.deepEqual(syntaxMap(baseline, converted), []);
});

test('compareSyntaxMap: an export list must not merge names across another export', () => {
  const baseline = 'const a = 1;\nconst b = 2;\nconst X = {};\nmodule.exports.a = a;\nmodule.exports.j = X.j;\nmodule.exports.b = b;\n';
  const converted = 'const a = 1;\nconst b = 2;\nconst X = {};\nexport { a, b };\nexport const j = X.j;\n';
  assert.deepEqual(syntaxMap(baseline, converted), ['plumbing order: #2 should be export const j, found export { b }']);
});

test('compareSyntaxMap: an export statement moved to a different index is reported', () => {
  assert.deepEqual(syntaxMap('const a = 1;\nmodule.exports = { a };\nf();\n', 'const a = 1;\nf();\nexport { a };\n'), [
    'export { a }: at statement index 2, expected 1',
  ]);
  assert.deepEqual(syntaxMap('class A {}\nmodule.exports = A;\nf();\n', 'class A {}\nf();\nexport default A;\n'), [
    'export default: at statement index 2, expected 1',
  ]);
});

test('compareSyntaxMap: a renamed export is reported', () => {
  assert.deepEqual(syntaxMap('const a = 1;\nmodule.exports = { a };\n', 'const a = 1;\nexport { a as b };\n'), [
    'export { a as b } (line 2): renamed exports are not allowed',
    'export list: expected { a }, found { b }',
  ]);
});

test('compareSyntaxMap: a changed default or const export expression is reported', () => {
  const baseline = "module.exports = {\n  A: 'a',\n  B: 'b'\n};\n";
  assert.deepEqual(syntaxMap(baseline, "export default {\n  A: 'a',\n  B: 'b'\n};\n"), []);
  const [changed] = syntaxMap(baseline, "export default {\n  A: 'a',\n  B: 'c'\n};\n");
  assert.match(changed, /^export default: differs at \$\.properties\[1\]\.value\.value\n/);
  assert.match(changed, /B: 'b'/);
  assert.match(changed, /B: 'c'/);
  const [constant] = syntaxMap('class D {}\nmodule.exports.x = D.x;\n', 'class D {}\nexport const x = D.y;\n');
  assert.match(constant, /^export const x: differs at \$\.property\.name/);
});

test('compareSyntaxMap: a missing or unexpected export const is reported', () => {
  assert.deepEqual(syntaxMap('class D {}\nmodule.exports.x = D.x;\n', 'class D {}\n'), ['export const x: missing (baseline line 2)']);
  assert.deepEqual(syntaxMap('class D {}\n', 'class D {}\nexport const x = D.x;\n'), ['export const x (line 2): unexpected']);
});

test('compareSyntaxMap: a change to a non-plumbing statement is reported', () => {
  const errors = syntaxMap("const a = require('a');\nf(a, 1);\n", "import a from 'a';\nf(a, 2);\n");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^non-plumbing code: differs at \$\.body\[0\]\.expression\.arguments\[1\]\.value\n/);
});

test('compareSyntaxMap: a changed inline require inside a function is reported', () => {
  const baseline = "function g() {\n  const fs = require('fs');\n  return fs;\n}\n";
  assert.deepEqual(syntaxMap(baseline, baseline), []);
  assert.equal(syntaxMap(baseline, "function g() {\n  const fs = require('node:fs');\n  return fs;\n}\n").length, 1);
  assert.notDeepEqual(syntaxMap(baseline, "import fs from 'fs';\nfunction g() {\n  return fs;\n}\n"), []);
});

test('compareSyntaxMap: an unsupported export form is reported', () => {
  const errors = syntaxMap('function f() {}\nmodule.exports = { f };\n', 'export function f() {}\n');
  assert.ok(errors.includes('line 1: unsupported export form: export function f() {}'), errors.join('\n'));
});

test('compareSyntaxMap: a converted file that does not parse is reported, not thrown', () => {
  const errors = syntaxMap("const a = require('a');\n", "import a from 'a';\nconst n: number = a;\n");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^converted file does not parse as a module: /);
});

function resolutionTree(overrides: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries({
    'src/app.ts': "import Service from './service';\nimport { helper } from './lib';\nimport * as lib from './lib';\nimport { extra } from './service';\nimport fs from 'node:fs';\nnew Service(helper, lib, extra, fs);\n",
    'src/service.ts': "import { helper } from './lib';\nclass Service {}\nexport default Service;\nexport const extra = helper;\n",
    'src/lib/index.ts': 'function helper() {}\nexport { helper };\n',
    ...overrides,
  }));
}

test('checkImportResolution: a consistent tree has no errors', () => {
  assert.deepEqual(checkImportResolution(resolutionTree()), []);
});

test('checkImportResolution: a default import of a named-only module is reported', () => {
  assert.deepEqual(checkImportResolution(resolutionTree({ 'src/app.ts': "import helper from './lib';\nhelper();\n" })), [
    "src/app.ts: import helper from './lib': src/lib/index.ts has no default export",
  ]);
});

test('checkImportResolution: a named import of a missing name is reported', () => {
  assert.deepEqual(checkImportResolution(resolutionTree({ 'src/app.ts': "import { missing } from './lib';\nmissing();\n" })), [
    "src/app.ts: import { missing } from './lib': src/lib/index.ts does not export missing",
  ]);
});

test('checkImportResolution: a namespace import of a module with a default export is reported', () => {
  assert.deepEqual(checkImportResolution(resolutionTree({ 'src/app.ts': "import * as service from './service';\nservice.run();\n" })), [
    "src/app.ts: import * as service from './service': src/service.ts has a default export",
  ]);
});

test('checkImportResolution: an unresolvable relative import is reported', () => {
  assert.deepEqual(checkImportResolution(resolutionTree({ 'src/app.ts': "import x from './nowhere';\nimport y from '../lib';\nx(y);\n" })), [
    "src/app.ts: import x from './nowhere': does not resolve to a .ts file",
    "src/app.ts: import y from '../lib': does not resolve to a .ts file",
  ]);
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

const TREE = {
  'app.js': '"use strict";\nconst a = require("./lib/b");\na(1);\n',
  'lib/b.js': '"use strict";\nmodule.exports = function b(n) {\n  return n + 1;\n};\n',
  'data.json': '{ "a": 1 }\n',
};

function makeTree(t: TestContext, files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-trees-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), source);
  }
  return dir;
}

test('compareTrees: identical trees have no differences', (t) => {
  assert.deepEqual(compareTrees(makeTree(t, TREE), makeTree(t, TREE)), []);
});

test('compareTrees: a formatting-only difference passes', (t) => {
  const reformatted = { ...TREE, 'lib/b.js': "'use strict';\nmodule.exports = function b(n) { return (n + 1); }; // one\n" };
  assert.deepEqual(compareTrees(makeTree(t, TREE), makeTree(t, reformatted)), []);
});

test('compareTrees: a changed literal names the file, path and both lines', (t) => {
  const changed = { ...TREE, 'app.js': '"use strict";\nconst a = require("./lib/b");\na(2);\n' };
  assert.deepEqual(compareTrees(makeTree(t, TREE), makeTree(t, changed)), [
    { file: 'app.js', path: '$.body[2].expression.arguments[0].value', left: 'a(1);', right: 'a(2);' },
  ]);
});

test('compareTrees: an extra file is reported', (t) => {
  assert.deepEqual(compareTrees(makeTree(t, TREE), makeTree(t, { ...TREE, 'lib/c.js': '"use strict";\n' })), [
    { file: 'lib/c.js', path: '(file)', left: 'missing', right: 'present' },
  ]);
});

test('compareTrees: a missing file is reported', (t) => {
  const { 'lib/b.js': _removed, ...rest } = TREE;
  assert.deepEqual(compareTrees(makeTree(t, TREE), makeTree(t, rest)), [
    { file: 'lib/b.js', path: '(file)', left: 'present', right: 'missing' },
  ]);
});

test('compareTrees: a non-JavaScript file must be byte-identical', (t) => {
  assert.deepEqual(compareTrees(makeTree(t, TREE), makeTree(t, { ...TREE, 'data.json': '{"a":1}\n' })), [
    { file: 'data.json', path: '(content)', left: '11 bytes', right: '8 bytes' },
  ]);
});

test('compareTrees: a missing directory is an error', (t) => {
  const dir = makeTree(t, TREE);
  assert.throws(() => compareTrees(dir, path.join(dir, 'nowhere')), /not a directory/);
});

const TAP_SAMPLE = [
  'TAP version 13',
  '# Logger initialised with level: INFO (2)',
  '# Subtest: A',
  '    # Subtest: sever',
  '    ok 1 - sever # SKIP not on this platform',
  '      ---',
  '      duration_ms: 0.5',
  "      type: 'test'",
  '      ...',
  '    1..1',
  'ok 1 - A',
  '  ---',
  '  duration_ms: 1.5',
  '  ...',
  '# Subtest: B',
  '    # Subtest: sever',
  '        # Subtest: deep',
  '        not ok 1 - deep',
  '          ---',
  '          error: |-',
  '            ok 9 - not a test result',
  '          ...',
  '        1..1',
  '    ok 1 - sever',
  '    1..1',
  'ok 2 - B',
  '1..2',
  '# tests 5',
  '# suites 0',
  '# pass 4',
  '',
].join('\n');

test('parseTapTestNames: nested names are joined, directives stripped and YAML blocks skipped', () => {
  assert.deepEqual(parseTapTestNames(TAP_SAMPLE), {
    names: ['A', 'A > sever', 'B', 'B > sever', 'B > sever > deep'],
    declaredCount: 5,
  });
});

test('parseTapTestNames: a missing summary gives a null declared count', () => {
  assert.deepEqual(parseTapTestNames('ok 1 - x\n    # tests 9\n'), { names: ['x'], declaredCount: null });
});

function final(files: Record<string, string>, tsconfig = '{ "compilerOptions": { "strict": true } }'): string[] {
  return finalViolations({ trackedFiles: Object.keys(files), read: (p) => files[p], tsconfig });
}

test('finalViolations: a clean tree has no violations', () => {
  assert.deepEqual(final({ 'src/app.ts': "import x from './x';\nconst s = '// @ts-nocheck';\n  // @ts-nocheck\n", 'scripts/c.ts': 'export {};\n' }), []);
});

test('finalViolations: a tracked .js file is reported', () => {
  assert.deepEqual(final({ 'src/app.js': 'module.exports = {};\n' }), ['src/app.js: tracked .js file']);
});

test('finalViolations: a line starting with the nocheck directive is reported', () => {
  assert.deepEqual(final({ 'src/app.ts': `${NOCHECK}import x from './x';\n`, 'types/t.ts': `export {};\n${NOCHECK}` }), [
    'src/app.ts:1: // @ts-nocheck',
    'types/t.ts:2: // @ts-nocheck',
  ]);
});

test('finalViolations: allowJs in tsconfig.json is reported', () => {
  assert.deepEqual(final({}, '{\n  "compilerOptions": {\n    "allowJs": true\n  }\n}\n'), ['tsconfig.json: "allowJs" is present']);
});
