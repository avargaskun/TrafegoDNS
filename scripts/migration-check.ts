import { parse as acornParse } from 'acorn';
import type { Expression, Identifier, ImportDeclaration, Literal, MemberExpression, ModuleDeclaration, Node, Pattern, Program, Statement } from 'acorn';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Difference {
  file: string;
  path: string;
  left: string;
  right: string;
}

interface Flags {
  positional: string[];
  baseline?: string;
  rev?: string;
  from?: string;
  to?: string;
  expected?: string;
  list: boolean;
}

type ValueFlag = 'baseline' | 'rev' | 'from' | 'to' | 'expected';
type FlagName = ValueFlag | 'list';
type Loose = Record<string, unknown>;
type LockEntry = { version?: string; dev?: boolean };
type TopLevel = Statement | ModuleDeclaration;

interface Binding {
  imported: string;
  local: string;
}

type BaselinePlumbing =
  | { kind: 'require'; source: string; local: string }
  | { kind: 'require-named'; source: string; bindings: Binding[] }
  | { kind: 'exports'; target: string | null; value: Expression };

interface ImportSlot {
  index: number;
  source: string;
  clause: string;
}

interface DefaultExport {
  kind: 'default';
  index: number;
  node: Node;
}

interface NameExport {
  kind: 'name';
  index: number;
  name: string;
}

interface ConstExport {
  kind: 'const';
  index: number;
  name: string;
  node: Node;
}

type ExportSlot = DefaultExport | NameExport | ConstExport;

interface SplitFile {
  code: TopLevel[];
  imports: ImportSlot[];
  exports: ExportSlot[];
  order: string[];
  errors: string[];
}

interface Side {
  source: string;
  tree: Node;
}

interface ExportShape {
  hasDefault: boolean;
  names: Set<string>;
}

interface TreeComparison {
  count: number;
  differences: Difference[];
}

interface TestNames {
  names: string[];
  declaredCount: number | null;
}

class UsageError extends Error {}

const IGNORED_KEYS = new Set(['start', 'end', 'loc', 'range', 'raw', 'directive']);
const VALUE_FLAGS = new Set(['--baseline', '--rev', '--from', '--to', '--expected']);
const FLAG_NAMES: FlagName[] = ['baseline', 'rev', 'from', 'to', 'expected', 'list'];
const MAX_REPORTED_LINES = 5;
const FILE_LEVEL = '(file)';
const EXPECTED_TEST_COUNT = 130;
const BASELINE_TESTS = path.join('ralph', 'projects', 'typescript-migration', 'baseline-tests.txt');
const USAGE = [
  'usage: migration-check <subcommand> [options]',
  '  baseline-emit [--baseline <sha>]',
  '  syntax-map [--baseline <sha>] [--rev <ref>]',
  '  erasure --from <ref> [--to <ref>]',
  '  lockfile [--baseline <sha>]',
  '  test-names [--expected <file> | --baseline <sha>] [--list]',
  '  compare-dirs <left> <right>',
  '  final',
].join('\n');

export function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

export function repoRoot(): string {
  return git(['rev-parse', '--show-toplevel']).trim();
}

export function defaultBaseline(): string {
  return git(['merge-base', 'HEAD', 'origin/dev']).trim();
}

function resolveCommit(ref: string, cwd: string): string {
  return git(['rev-parse', '--verify', `${ref}^{commit}`], cwd).trim();
}

export function parseFlags(argv: string[]): Flags {
  const flags: Flags = { positional: [], list: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list') {
      flags.list = true;
    } else if (VALUE_FLAGS.has(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      flags[arg.slice(2) as ValueFlag] = value;
    } else if (arg.startsWith('--')) {
      throw new UsageError(`unknown option ${arg}`);
    } else {
      flags.positional.push(arg);
    }
  }
  return flags;
}

function expectFlags(flags: Flags, allowed: FlagName[], positional = 0): void {
  if (flags.positional.length > positional) throw new UsageError(`unexpected argument ${flags.positional[positional]}`);
  if (flags.positional.length < positional) throw new UsageError(`expected ${positional} arguments, found ${flags.positional.length}`);
  for (const name of FLAG_NAMES) {
    const given = name === 'list' ? flags.list : flags[name] !== undefined;
    if (given && !allowed.includes(name)) throw new UsageError(`--${name} is not supported by this subcommand`);
  }
}

export function parse(source: string, sourceType: 'script' | 'module'): Program {
  return acornParse(source, { ecmaVersion: 'latest', sourceType, locations: true });
}

function sameRegex(a: unknown, b: unknown): boolean {
  const l = a as { pattern?: string; flags?: string } | undefined;
  const r = b as { pattern?: string; flags?: string } | undefined;
  return l?.pattern === r?.pattern && l?.flags === r?.flags;
}

function diff(a: unknown, b: unknown, at: string): { path: string } | null {
  if (a === b) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return { path: at };
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return { path: at };
    const shared = Math.min(a.length, b.length);
    for (let i = 0; i < shared; i++) {
      const d = diff(a[i], b[i], `${at}[${i}]`);
      if (d) return d;
    }
    return a.length === b.length ? null : { path: `${at}[${shared}]` };
  }
  const l = a as Loose;
  const r = b as Loose;
  if (l.regex || r.regex) return sameRegex(l.regex, r.regex) ? null : { path: at };
  if (l.type === 'TemplateElement' && r.type === 'TemplateElement') {
    const lv = l.value as { cooked?: string | null };
    const rv = r.value as { cooked?: string | null };
    return lv.cooked === rv.cooked && l.tail === r.tail ? null : { path: at };
  }
  const keys = [...new Set([...Object.keys(l), ...Object.keys(r)])].filter((k) => !IGNORED_KEYS.has(k));
  for (const k of keys) {
    const d = diff(l[k], r[k], `${at}.${k}`);
    if (d) return d;
  }
  return null;
}

export function firstDifference(a: Node, b: Node): { path: string } | null {
  return diff(a, b, '$');
}

function isLocated(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && (value as Loose).loc != null;
}

function deepestLocated(root: Node, at: string): Node {
  let current: unknown = root;
  let found = root;
  for (const match of at.matchAll(/\.([^.[\]]+)|\[(\d+)\]/g)) {
    if (current === null || typeof current !== 'object') break;
    current = (current as Loose)[match[2] ?? match[1]];
    if (isLocated(current)) found = current;
  }
  return found;
}

function excerpt(source: string, node: Node): string {
  if (!node.loc) return '';
  const lines = source.split('\n').slice(node.loc.start.line - 1, node.loc.end.line);
  if (lines.length <= MAX_REPORTED_LINES) return lines.join('\n');
  return [...lines.slice(0, MAX_REPORTED_LINES), `… (${lines.length - MAX_REPORTED_LINES} more lines)`].join('\n');
}

export function describeDifference(file: string, left: { source: string; tree: Node }, right: { source: string; tree: Node }, at: string): Difference {
  return {
    file,
    path: at,
    left: excerpt(left.source, deepestLocated(left.tree, at)),
    right: excerpt(right.source, deepestLocated(right.tree, at)),
  };
}

export function formatDifference(d: Difference, leftLabel: string, rightLabel: string): string {
  const width = Math.max(leftLabel.length, rightLabel.length) + 1;
  const side = (label: string, text: string) => `  ${`${label}:`.padEnd(width)} ${text.split('\n').join(`\n  ${' '.repeat(width)} `)}`;
  return [`${d.file}: differs at ${d.path}`, side(leftLabel, d.left), side(rightLabel, d.right)].join('\n');
}

export function compareEmitToBaseline(baseline: string, emitted: string, file = ''): Difference | 'missing-use-strict' | null {
  const left = parse(baseline, 'script');
  const right = parse(emitted, 'script');
  const first = right.body[0];
  if (!first || first.type !== 'ExpressionStatement' || first.directive !== 'use strict') return 'missing-use-strict';
  const stripped: Program = { ...right, body: right.body.slice(1) };
  const d = firstDifference(left, stripped);
  return d ? describeDifference(file, { source: baseline, tree: left }, { source: emitted, tree: stripped }, d.path) : null;
}

function nameOf(node: Identifier | Literal): string {
  return node.type === 'Identifier' ? node.name : String(node.value);
}

function braces(items: string[]): string {
  return items.length > 0 ? `{ ${items.join(', ')} }` : '{}';
}

function lineOf(node: Node): number {
  return node.loc ? node.loc.start.line : 0;
}

function requireSource(init: Expression | null | undefined): string | null {
  if (!init || init.type !== 'CallExpression' || init.optional || init.arguments.length !== 1) return null;
  if (init.callee.type !== 'Identifier' || init.callee.name !== 'require') return null;
  const [argument] = init.arguments;
  return argument.type === 'Literal' && typeof argument.value === 'string' ? argument.value : null;
}

function isModuleExports(node: Node): boolean {
  if (node.type !== 'MemberExpression') return false;
  const { object, property, computed } = node as MemberExpression;
  return !computed && object.type === 'Identifier' && object.name === 'module' && property.type === 'Identifier' && property.name === 'exports';
}

function requireBindings(pattern: Pattern): Binding[] | null {
  if (pattern.type !== 'ObjectPattern') return null;
  const bindings: Binding[] = [];
  for (const property of pattern.properties) {
    if (property.type !== 'Property' || property.computed || property.key.type !== 'Identifier' || property.value.type !== 'Identifier') return null;
    bindings.push({ imported: property.key.name, local: property.value.name });
  }
  return bindings;
}

function baselinePlumbing(statement: TopLevel): BaselinePlumbing | null {
  if (statement.type === 'VariableDeclaration') {
    if (statement.kind !== 'const' || statement.declarations.length !== 1) return null;
    const [{ id, init }] = statement.declarations;
    const source = requireSource(init);
    if (source === null) return null;
    if (id.type === 'Identifier') return { kind: 'require', source, local: id.name };
    const bindings = requireBindings(id);
    return bindings ? { kind: 'require-named', source, bindings } : null;
  }
  if (statement.type !== 'ExpressionStatement' || statement.expression.type !== 'AssignmentExpression' || statement.expression.operator !== '=') return null;
  const { left, right } = statement.expression;
  if (isModuleExports(left)) return { kind: 'exports', target: null, value: right };
  if (left.type !== 'MemberExpression' || left.computed || left.property.type !== 'Identifier' || !isModuleExports(left.object)) return null;
  return { kind: 'exports', target: left.property.name, value: right };
}

function plumbingOf(program: Program): BaselinePlumbing[] {
  return program.body.flatMap((statement) => baselinePlumbing(statement) ?? []);
}

function shorthandNames(value: Expression): string[] | null {
  if (value.type !== 'ObjectExpression') return null;
  const names: string[] = [];
  for (const property of value.properties) {
    if (property.type !== 'Property' || !property.shorthand || property.computed || property.value.type !== 'Identifier') return null;
    names.push(property.value.name);
  }
  return names;
}

function isNamedExportModule(program: Program): boolean {
  const exports = plumbingOf(program).flatMap((plumbing) => (plumbing.kind === 'exports' ? [plumbing] : []));
  return exports.length === 1 && exports[0].target === null && shorthandNames(exports[0].value) !== null;
}

function requireSources(program: Program): string[] {
  return plumbingOf(program).flatMap((plumbing) => (plumbing.kind === 'exports' ? [] : [plumbing.source]));
}

function renderBindings(bindings: Binding[]): string {
  return braces(bindings.map(({ imported, local }) => (imported === local ? local : `${imported} as ${local}`)));
}

function renderImport(slot: { source: string; clause: string }): string {
  return slot.clause ? `import ${slot.clause} from '${slot.source}'` : `import '${slot.source}'`;
}

function importClause(specifiers: ImportDeclaration['specifiers']): string {
  const parts: string[] = [];
  const named: Binding[] = [];
  for (const specifier of specifiers) {
    if (specifier.type === 'ImportDefaultSpecifier') parts.push(specifier.local.name);
    else if (specifier.type === 'ImportNamespaceSpecifier') parts.push(`* as ${specifier.local.name}`);
    else named.push({ imported: nameOf(specifier.imported), local: specifier.local.name });
  }
  if (named.length > 0) parts.push(renderBindings(named));
  return parts.join(', ');
}

function exportKey(slot: ExportSlot): string {
  if (slot.kind === 'default') return 'export default';
  return slot.kind === 'name' ? `export { ${slot.name} }` : `export const ${slot.name}`;
}

function emptySplit(): SplitFile {
  return { code: [], imports: [], exports: [], order: [], errors: [] };
}

function addImport(split: SplitFile, slot: ImportSlot): void {
  split.imports.push(slot);
  split.order.push(renderImport(slot));
}

function addExport(split: SplitFile, slot: ExportSlot): void {
  split.exports.push(slot);
  split.order.push(exportKey(slot));
}

function splitBaseline(program: Program, namedExportModules: Set<string>): SplitFile {
  const split = emptySplit();
  for (const statement of program.body) {
    const index = split.code.length;
    const plumbing = baselinePlumbing(statement);
    if (!plumbing) {
      split.code.push(statement);
    } else if (plumbing.kind === 'require') {
      addImport(split, { index, source: plumbing.source, clause: namedExportModules.has(plumbing.source) ? `* as ${plumbing.local}` : plumbing.local });
    } else if (plumbing.kind === 'require-named') {
      addImport(split, { index, source: plumbing.source, clause: renderBindings(plumbing.bindings) });
    } else if (plumbing.target !== null) {
      const sameName = plumbing.value.type === 'Identifier' && plumbing.value.name === plumbing.target;
      addExport(split, sameName ? { kind: 'name', index, name: plumbing.target } : { kind: 'const', index, name: plumbing.target, node: plumbing.value });
    } else {
      const names = shorthandNames(plumbing.value);
      if (names) for (const name of names) addExport(split, { kind: 'name', index, name });
      else addExport(split, { kind: 'default', index, node: plumbing.value });
    }
  }
  return split;
}

function splitConverted(program: Program, source: string): SplitFile {
  const split = emptySplit();
  for (const statement of program.body) {
    const index = split.code.length;
    if (statement.type === 'ImportDeclaration') {
      addImport(split, { index, source: String(statement.source.value), clause: importClause(statement.specifiers) });
    } else if (statement.type === 'ExportDefaultDeclaration') {
      addExport(split, { kind: 'default', index, node: statement.declaration });
    } else if (statement.type === 'ExportNamedDeclaration' && !statement.source) {
      const { declaration } = statement;
      const declarator = declaration?.type === 'VariableDeclaration' && declaration.kind === 'const' && declaration.declarations.length === 1 ? declaration.declarations[0] : null;
      if (!declaration) {
        for (const specifier of statement.specifiers) {
          const local = nameOf(specifier.local);
          const exported = nameOf(specifier.exported);
          if (local !== exported) split.errors.push(`export { ${local} as ${exported} } (line ${lineOf(statement)}): renamed exports are not allowed`);
          addExport(split, { kind: 'name', index, name: exported });
        }
      } else if (declarator && declarator.id.type === 'Identifier' && declarator.init) {
        addExport(split, { kind: 'const', index, name: declarator.id.name, node: declarator.init });
      } else {
        split.errors.push(`line ${lineOf(statement)}: unsupported export form: ${source.slice(statement.start, statement.end).split('\n')[0]}`);
      }
    } else {
      split.code.push(statement);
    }
  }
  return split;
}

function compareImports(expected: ImportSlot[], actual: ImportSlot[]): string[] {
  const errors: string[] = [];
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
    const want: ImportSlot | undefined = expected[i];
    const got: ImportSlot | undefined = actual[i];
    const label = `import #${i + 1}`;
    if (!got) errors.push(`${label}: expected ${renderImport(want)}, found no import`);
    else if (!want) errors.push(`${label}: unexpected ${renderImport(got)}`);
    else if (renderImport(want) !== renderImport(got)) errors.push(`${label}: expected ${renderImport(want)}, found ${renderImport(got)}`);
    else if (want.index !== got.index) errors.push(`${label}: ${renderImport(got)} is at statement index ${got.index}, expected ${want.index}`);
  }
  return errors;
}

function ofKind<K extends ExportSlot['kind']>(slots: ExportSlot[], kind: K): Extract<ExportSlot, { kind: K }>[] {
  return slots.filter((slot): slot is Extract<ExportSlot, { kind: K }> => slot.kind === kind);
}

function expressionDifference(label: string, left: Side, right: Side): string | null {
  const d = firstDifference(left.tree, right.tree);
  return d ? formatDifference(describeDifference(label, left, right, d.path), 'baseline', 'converted') : null;
}

function compareExports(expected: ExportSlot[], actual: ExportSlot[], baseline: string, converted: string): string[] {
  const errors: string[] = [];
  const wantDefaults = ofKind(expected, 'default');
  const gotDefaults = ofKind(actual, 'default');
  for (let i = 0; i < Math.max(wantDefaults.length, gotDefaults.length); i++) {
    const want: DefaultExport | undefined = wantDefaults[i];
    const got: DefaultExport | undefined = gotDefaults[i];
    if (!got) errors.push(`export default: missing (baseline line ${lineOf(want.node)})`);
    else if (!want) errors.push(`export default (line ${lineOf(got.node)}): unexpected`);
    else {
      const difference = expressionDifference('export default', { source: baseline, tree: want.node }, { source: converted, tree: got.node });
      if (difference) errors.push(difference);
      else if (want.index !== got.index) errors.push(`export default: at statement index ${got.index}, expected ${want.index}`);
    }
  }
  const wantNames = ofKind(expected, 'name');
  const gotNames = ofKind(actual, 'name');
  const wantList = braces(wantNames.map((slot) => slot.name));
  const gotList = braces(gotNames.map((slot) => slot.name));
  if (wantList !== gotList) errors.push(`export list: expected ${wantList}, found ${gotList}`);
  else {
    wantNames.forEach((want, i) => {
      if (want.index !== gotNames[i].index) errors.push(`export { ${want.name} }: at statement index ${gotNames[i].index}, expected ${want.index}`);
    });
  }
  const gotConsts = new Map(ofKind(actual, 'const').map((slot) => [slot.name, slot]));
  for (const want of ofKind(expected, 'const')) {
    const got = gotConsts.get(want.name);
    gotConsts.delete(want.name);
    const label = `export const ${want.name}`;
    if (!got) {
      errors.push(`${label}: missing (baseline line ${lineOf(want.node)})`);
      continue;
    }
    const difference = expressionDifference(label, { source: baseline, tree: want.node }, { source: converted, tree: got.node });
    if (difference) errors.push(difference);
    else if (want.index !== got.index) errors.push(`${label}: at statement index ${got.index}, expected ${want.index}`);
  }
  for (const [name, slot] of gotConsts) errors.push(`export const ${name} (line ${lineOf(slot.node)}): unexpected`);
  return errors;
}

export function compareSyntaxMap(baseline: string, converted: string, opts: { namedExportModules: Set<string> }): string[] {
  let left: Program;
  let right: Program;
  try {
    left = parse(baseline, 'script');
  } catch (error) {
    return [`baseline does not parse as a script: ${error.message}`];
  }
  try {
    right = parse(converted, 'module');
  } catch (error) {
    return [`converted file does not parse as a module: ${error.message}`];
  }
  const expected = splitBaseline(left, opts.namedExportModules);
  const actual = splitConverted(right, converted);
  const errors = [...actual.errors];
  const leftCode: Program = { ...left, body: expected.code };
  const rightCode: Program = { ...right, sourceType: left.sourceType, body: actual.code };
  const code = expressionDifference('non-plumbing code', { source: baseline, tree: leftCode }, { source: converted, tree: rightCode });
  if (code) errors.push(code);
  errors.push(...compareImports(expected.imports, actual.imports));
  errors.push(...compareExports(expected.exports, actual.exports, baseline, converted));
  const at = errors.length === 0 ? firstMismatch(expected.order, actual.order) : -1;
  if (at !== -1) errors.push(`plumbing order: #${at + 1} should be ${expected.order[at] ?? 'nothing'}, found ${actual.order[at] ?? 'nothing'}`);
  return errors;
}

function firstMismatch(a: string[], b: string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return i;
  return -1;
}

function isRelative(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

function resolveRelative(files: { has(file: string): boolean }, from: string, specifier: string, extension: string): string | null {
  const base = path.posix.join(path.posix.dirname(from), specifier);
  return [`${base}${extension}`, `${base}/index${extension}`].find((candidate) => files.has(candidate)) ?? null;
}

function exportShape(program: Program): ExportShape {
  const shape: ExportShape = { hasDefault: false, names: new Set() };
  for (const statement of program.body) {
    if (statement.type === 'ExportDefaultDeclaration') shape.hasDefault = true;
    if (statement.type !== 'ExportNamedDeclaration') continue;
    for (const specifier of statement.specifiers) {
      const name = nameOf(specifier.exported);
      if (name === 'default') shape.hasDefault = true;
      else shape.names.add(name);
    }
    const { declaration } = statement;
    if (declaration?.type === 'VariableDeclaration') {
      for (const { id } of declaration.declarations) if (id.type === 'Identifier') shape.names.add(id.name);
    } else if (declaration) {
      shape.names.add(declaration.id.name);
    }
  }
  return shape;
}

export function checkImportResolution(files: Map<string, string>): string[] {
  const errors: string[] = [];
  const programs = new Map<string, Program>();
  for (const [file, source] of files) {
    try {
      programs.set(file, parse(source, 'module'));
    } catch (error) {
      errors.push(`${file}: does not parse as a module: ${error.message}`);
    }
  }
  const shapes = new Map([...programs].map(([file, program]) => [file, exportShape(program)]));
  for (const [file, program] of programs) {
    for (const statement of program.body) {
      if (statement.type !== 'ImportDeclaration') continue;
      const specifier = String(statement.source.value);
      if (!isRelative(specifier)) continue;
      const where = `${file}: ${renderImport({ source: specifier, clause: importClause(statement.specifiers) })}`;
      const target = resolveRelative(files, file, specifier, '.ts');
      if (target === null) {
        errors.push(`${where}: does not resolve to a .ts file`);
        continue;
      }
      const shape = shapes.get(target);
      if (!shape) continue;
      for (const s of statement.specifiers) {
        if (s.type === 'ImportDefaultSpecifier') {
          if (!shape.hasDefault) errors.push(`${where}: ${target} has no default export`);
        } else if (s.type === 'ImportNamespaceSpecifier') {
          if (shape.hasDefault) errors.push(`${where}: ${target} has a default export`);
        } else {
          const name = nameOf(s.imported);
          if (name === 'default' ? !shape.hasDefault : !shape.names.has(name)) errors.push(`${where}: ${target} does not export ${name}`);
        }
      }
    }
  }
  return errors;
}

function productionEntries(lock: unknown): Map<string, LockEntry> {
  const packages = (lock as { packages?: Record<string, LockEntry> } | null)?.packages ?? {};
  return new Map(Object.entries(packages).filter(([key, entry]) => key !== '' && entry.dev !== true));
}

export function productionClosureDiff(baselineLock: unknown, currentLock: unknown): string[] {
  const before = productionEntries(baselineLock);
  const after = productionEntries(currentLock);
  const differences: string[] = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(key);
    const cur = after.get(key);
    if (!cur) differences.push(`removed ${key}`);
    else if (!old) differences.push(`added ${key}`);
    else if (JSON.stringify(old) !== JSON.stringify(cur)) differences.push(`changed ${key}: ${old.version} -> ${cur.version}`);
  }
  return differences;
}

function listTree(root: string, dir = ''): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(dir, entry.name);
    return entry.isDirectory() ? listTree(root, file) : [file];
  });
}

function expectDirectory(dir: string): void {
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`not a directory: ${dir}`);
}

function parseScript(source: string): Program | string {
  try {
    return parse(source, 'script');
  } catch (error) {
    return `does not parse as a script: ${error.message}`;
  }
}

function compareTreeFile(file: string, leftDir: string, rightDir: string): Difference | null {
  const leftBytes = fs.readFileSync(path.join(leftDir, file));
  const rightBytes = fs.readFileSync(path.join(rightDir, file));
  if (!file.endsWith('.js')) {
    return leftBytes.equals(rightBytes) ? null : { file, path: '(content)', left: `${leftBytes.length} bytes`, right: `${rightBytes.length} bytes` };
  }
  const leftSource = leftBytes.toString('utf8');
  const rightSource = rightBytes.toString('utf8');
  const left = parseScript(leftSource);
  const right = parseScript(rightSource);
  if (typeof left === 'string' || typeof right === 'string') {
    return { file, path: '(parse)', left: typeof left === 'string' ? left : 'parses', right: typeof right === 'string' ? right : 'parses' };
  }
  const d = firstDifference(left, right);
  return d ? describeDifference(file, { source: leftSource, tree: left }, { source: rightSource, tree: right }, d.path) : null;
}

function diffTrees(leftDir: string, rightDir: string): TreeComparison {
  expectDirectory(leftDir);
  expectDirectory(rightDir);
  const left = new Set(listTree(leftDir));
  const right = new Set(listTree(rightDir));
  const files = [...new Set([...left, ...right])].sort();
  const differences: Difference[] = [];
  for (const file of files) {
    if (!right.has(file)) differences.push({ file, path: FILE_LEVEL, left: 'present', right: 'missing' });
    else if (!left.has(file)) differences.push({ file, path: FILE_LEVEL, left: 'missing', right: 'present' });
    else {
      const d = compareTreeFile(file, leftDir, rightDir);
      if (d) differences.push(d);
    }
  }
  return { count: files.length, differences };
}

export function compareTrees(leftDir: string, rightDir: string): Difference[] {
  return diffTrees(leftDir, rightDir).differences;
}

function formatTreeDifference(d: Difference, leftLabel: string, rightLabel: string): string {
  if (d.path !== FILE_LEVEL) return formatDifference(d, leftLabel, rightLabel);
  return `${d.file}: only in ${d.left === 'present' ? leftLabel : rightLabel}`;
}

function popFrom(stack: { indent: number }[], indent: number): void {
  while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
}

export function parseTapTestNames(tap: string): TestNames {
  const names: string[] = [];
  const stack: { indent: number; name: string }[] = [];
  let declaredCount: number | null = null;
  let yamlEnd: string | null = null;
  for (const line of tap.split(/\r?\n/)) {
    if (yamlEnd !== null) {
      if (line === yamlEnd) yamlEnd = null;
      continue;
    }
    const indent = /^ */.exec(line)![0].length;
    const text = line.slice(indent);
    if (text === '---') {
      yamlEnd = `${' '.repeat(indent)}...`;
      continue;
    }
    const subtest = /^# Subtest: (.*)$/.exec(text);
    if (subtest) {
      popFrom(stack, indent);
      stack.push({ indent, name: subtest[1] });
      continue;
    }
    const result = /^(?:not )?ok \d+(?: - (.*))?$/.exec(text);
    if (result) {
      popFrom(stack, indent);
      const own = (result[1] ?? '').replace(/ # (?:SKIP|TODO)\b.*$/i, '');
      names.push([...stack.map((entry) => entry.name), own].join(' > '));
      continue;
    }
    const count = indent === 0 ? /^# tests (\d+)$/.exec(text) : null;
    if (count) declaredCount = Number(count[1]);
  }
  return { names: names.sort(), declaredCount };
}

function multisetMinus(a: string[], b: string[]): string[] {
  const counts = new Map<string, number>();
  for (const item of b) counts.set(item, (counts.get(item) ?? 0) + 1);
  return a.filter((item) => {
    const left = counts.get(item) ?? 0;
    counts.set(item, left - 1);
    return left <= 0;
  });
}

export function finalViolations(input: { trackedFiles: string[]; read: (p: string) => string; tsconfig: string }): string[] {
  const violations: string[] = [];
  for (const file of input.trackedFiles) {
    if (file.endsWith('.js')) violations.push(`${file}: tracked .js file`);
    input.read(file).split('\n').forEach((line, i) => {
      if (/^\/\/ @ts-nocheck/.test(line)) violations.push(`${file}:${i + 1}: // @ts-nocheck`);
    });
  }
  if (input.tsconfig.includes('"allowJs"')) violations.push('tsconfig.json: "allowJs" is present');
  return violations;
}

function checkEmittedFile(root: string, sha: string, file: string): string | null {
  const emittedPath = path.join(root, 'dist', file);
  if (!fs.existsSync(emittedPath)) return `${file}: missing dist/${file}`;
  try {
    const result = compareEmitToBaseline(git(['show', `${sha}:${file}`], root), fs.readFileSync(emittedPath, 'utf8'), file);
    if (result === null) return null;
    if (result === 'missing-use-strict') return `${file}: dist/${file} does not start with a "use strict" directive`;
    return formatDifference(result, 'baseline', 'emitted');
  } catch (error) {
    return `${file}: ${error.message}`;
  }
}

function runBaselineEmit(flags: Flags): number {
  expectFlags(flags, ['baseline']);
  const root = repoRoot();
  const sha = resolveCommit(flags.baseline ?? defaultBaseline(), root);
  const files = git(['ls-tree', '-r', '--name-only', sha, '--', 'src', 'test'], root).split('\n').filter((f) => f.endsWith('.js'));
  let ok = 0;
  for (const file of files) {
    const failure = checkEmittedFile(root, sha, file);
    if (failure) console.log(failure);
    else ok++;
  }
  console.log(`baseline-emit: ${ok}/${files.length} structurally identical (baseline ${sha})`);
  return files.length > 0 && ok === files.length ? 0 : 1;
}

function runLockfile(flags: Flags): number {
  expectFlags(flags, ['baseline']);
  const root = repoRoot();
  const sha = resolveCommit(flags.baseline ?? defaultBaseline(), root);
  const baselineLock = JSON.parse(git(['show', `${sha}:package-lock.json`], root));
  const currentLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const baselinePackage = JSON.parse(git(['show', `${sha}:package.json`], root));
  const currentPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const differences = productionClosureDiff(baselineLock, currentLock);
  if (productionEntries(baselineLock).size === 0) differences.push('baseline package-lock.json has no production entries');
  const dependencies = [JSON.stringify(baselinePackage.dependencies), JSON.stringify(currentPackage.dependencies)];
  if (dependencies[0] !== dependencies[1]) differences.push(`package.json dependencies: ${dependencies[0]} -> ${dependencies[1]}`);
  if (baselinePackage.version !== currentPackage.version) differences.push(`package.json version: ${baselinePackage.version} -> ${currentPackage.version}`);
  for (const line of differences) console.log(line);
  if (differences.length > 0) {
    console.log(`lockfile: ${differences.length} differences (baseline ${sha})`);
    return 1;
  }
  console.log(`lockfile: ${productionEntries(currentLock).size} production entries identical; dependencies and version identical`);
  return 0;
}

function hasExtension(file: string, extensions: string[]): boolean {
  return extensions.some((extension) => file.endsWith(extension));
}

function readTree(root: string, ref: string, extensions: string[]): Map<string, string> {
  const files = git(['ls-tree', '-r', '--name-only', ref, '--', 'src', 'test'], root).split('\n').filter((file) => hasExtension(file, extensions));
  return new Map(files.map((file) => [file, git(['show', `${ref}:${file}`], root)]));
}

function walkFiles(root: string, dir: string): string[] {
  const absolute = path.join(root, dir);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(root, file);
    return entry.isFile() ? [file] : [];
  });
}

function readWorkingTree(root: string, extensions: string[]): Map<string, string> {
  const files = ['src', 'test'].flatMap((dir) => walkFiles(root, dir)).filter((file) => hasExtension(file, extensions)).sort();
  return new Map(files.map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
}

function runSyntaxMap(flags: Flags): number {
  expectFlags(flags, ['baseline', 'rev']);
  const root = repoRoot();
  const sha = resolveCommit(flags.baseline ?? defaultBaseline(), root);
  const baseline = readTree(root, sha, ['.js']);
  const rev = flags.rev === undefined ? readWorkingTree(root, ['.ts', '.js']) : readTree(root, resolveCommit(flags.rev, root), ['.ts', '.js']);
  const files = [...baseline].map(([file, source]) => ({ file, source, program: parse(source, 'script') }));
  const namedModules = new Set(files.filter(({ program }) => isNamedExportModule(program)).map(({ file }) => file));
  const errors: string[] = [];
  let ok = 0;
  for (const { file, source, program } of files) {
    const tsFile = `${file.slice(0, -'.js'.length)}.ts`;
    const converted = rev.get(tsFile);
    if (converted === undefined) {
      errors.push(`${tsFile}: missing (baseline ${file})`);
      continue;
    }
    const namedExportModules = new Set(requireSources(program).filter((specifier) => isRelative(specifier) && namedModules.has(resolveRelative(baseline, file, specifier, '.js') ?? '')));
    const fileErrors = compareSyntaxMap(source, converted, { namedExportModules });
    for (const error of fileErrors) errors.push(`${tsFile}: ${error}`);
    if (fileErrors.length === 0) ok++;
  }
  let unexpected = 0;
  for (const file of rev.keys()) {
    const jsFile = `${file.slice(0, -'.ts'.length)}.js`;
    const reason = file.endsWith('.js') ? 'unexpected .js file (every baseline file must become .ts)' : baseline.has(jsFile) ? null : `unexpected .ts file (no baseline ${jsFile})`;
    if (reason === null) continue;
    errors.push(`${file}: ${reason}`);
    unexpected++;
  }
  const resolution = checkImportResolution(new Map([...rev].filter(([file]) => file.endsWith('.ts'))));
  for (const line of [...errors, ...resolution]) console.log(line);
  const extra = unexpected > 0 ? `; ${unexpected} unexpected files` : '';
  console.log(`syntax-map: ${ok}/${baseline.size} files mapped${extra}; import resolution: ${resolution.length} errors`);
  return baseline.size > 0 && errors.length === 0 && resolution.length === 0 ? 0 : 1;
}

function isSymlink(file: string): boolean {
  return fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
}

function withWorktree<T>(ref: string, options: { build: boolean }, fn: (dir: string) => T): T {
  const root = repoRoot();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'migration-check-')));
  const dir = path.join(tmp, 'wt');
  const link = path.join(dir, 'node_modules');
  try {
    git(['worktree', 'add', '--quiet', '--detach', dir, ref], root);
    fs.symlinkSync(path.join(root, 'node_modules'), link, 'dir');
    if (options.build) execFileSync(path.join(root, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], { cwd: dir, stdio: 'inherit' });
    return fn(dir);
  } finally {
    if (isSymlink(link)) fs.unlinkSync(link);
    if (fs.existsSync(dir)) git(['worktree', 'remove', '--force', dir], root);
    git(['worktree', 'prune'], root);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function compareDists(fromDist: string, toDist: string): TreeComparison {
  const total: TreeComparison = { count: 0, differences: [] };
  for (const sub of ['src', 'test']) {
    const { count, differences } = diffTrees(path.join(fromDist, sub), path.join(toDist, sub));
    total.count += count;
    total.differences.push(...differences.map((d) => ({ ...d, file: `dist/${sub}/${d.file}` })));
  }
  return total;
}

function runErasure(flags: Flags): number {
  expectFlags(flags, ['from', 'to']);
  if (flags.from === undefined) throw new UsageError('erasure needs --from <ref>');
  const root = repoRoot();
  const from = resolveCommit(flags.from, root);
  const to = flags.to === undefined ? null : resolveCommit(flags.to, root);
  const { count, differences } = withWorktree(from, { build: true }, (fromDir) => {
    const fromDist = path.join(fromDir, 'dist');
    if (to === null) return compareDists(fromDist, path.join(root, 'dist'));
    return withWorktree(to, { build: true }, (toDir) => compareDists(fromDist, path.join(toDir, 'dist')));
  });
  const range = `(${from} → ${to ?? 'working tree'})`;
  for (const d of differences) console.log(formatTreeDifference(d, 'from', 'to'));
  if (differences.length > 0 || count === 0) {
    console.log(`erasure: ${differences.length} differences in ${count} emitted files ${range}`);
    return 1;
  }
  console.log(`erasure: ${count} emitted files identical ${range}`);
  return 0;
}

function runCompareDirs(flags: Flags): number {
  expectFlags(flags, [], 2);
  const [left, right] = flags.positional.map((dir) => path.resolve(dir));
  const { count, differences } = diffTrees(left, right);
  for (const d of differences) console.log(formatTreeDifference(d, 'left', 'right'));
  if (differences.length > 0 || count === 0) {
    console.log(`compare-dirs: ${differences.length} differences in ${count} files (left ${left}, right ${right})`);
    return 1;
  }
  console.log(`compare-dirs: ${count} files structurally identical`);
  return 0;
}

function runTap(cwd: string, pattern: string): string {
  try {
    return execFileSync(process.execPath, ['--test', '--test-reporter=tap', pattern], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (error) {
    if (typeof error.stdout !== 'string') throw error;
    console.error(`test-names: node --test exited with status ${error.status} in ${cwd}`);
    return error.stdout;
  }
}

function runTestNames(flags: Flags): number {
  expectFlags(flags, ['expected', 'baseline', 'list']);
  if (flags.expected !== undefined && flags.baseline !== undefined) throw new UsageError('--expected and --baseline cannot be combined');
  if (flags.expected !== undefined && flags.list) throw new UsageError('--expected and --list cannot be combined');
  const root = repoRoot();
  const baseline = flags.baseline === undefined ? null : resolveCommit(flags.baseline, root);
  const baselineRun = (sha: string) => withWorktree(sha, { build: false }, (dir) => parseTapTestNames(runTap(dir, 'test/**/*.test.js')));
  const currentRun = () => parseTapTestNames(runTap(root, 'dist/test/**/*.test.js'));
  if (flags.list) {
    const run = baseline === null ? currentRun() : baselineRun(baseline);
    for (const name of run.names) console.log(name);
    console.error(`test-names: listed ${run.names.length} names (# tests ${run.declaredCount ?? 'missing'}) from ${baseline ?? 'dist/test'}`);
    return run.names.length > 0 ? 0 : 1;
  }
  const problems: string[] = [];
  let expected: string[];
  let source: string;
  if (baseline !== null) {
    const run = baselineRun(baseline);
    expected = run.names;
    source = `baseline ${baseline}`;
    if (run.declaredCount !== EXPECTED_TEST_COUNT) problems.push(`baseline run declares # tests ${run.declaredCount ?? 'missing'}, expected ${EXPECTED_TEST_COUNT}`);
  } else {
    source = path.resolve(root, flags.expected ?? BASELINE_TESTS);
    expected = fs.readFileSync(source, 'utf8').split('\n').filter((line) => line !== '').sort();
  }
  const current = currentRun();
  for (const name of multisetMinus(expected, current.names)) problems.push(`missing: ${name}`);
  for (const name of multisetMinus(current.names, expected)) problems.push(`extra: ${name}`);
  if (current.names.length !== EXPECTED_TEST_COUNT) problems.push(`found ${current.names.length} test names, expected ${EXPECTED_TEST_COUNT}`);
  if (current.declaredCount !== EXPECTED_TEST_COUNT) problems.push(`dist/test run declares # tests ${current.declaredCount ?? 'missing'}, expected ${EXPECTED_TEST_COUNT}`);
  for (const line of problems) console.log(line);
  if (problems.length > 0) {
    console.log(`test-names: ${problems.length} problems against ${source}`);
    return 1;
  }
  console.log(`test-names: ${current.names.length}/${expected.length} names identical to ${source} (# tests ${current.declaredCount})`);
  return 0;
}

function runFinal(flags: Flags): number {
  expectFlags(flags, []);
  const root = repoRoot();
  const trackedFiles = git(['ls-files', '-z', '--', 'src', 'test', 'types', 'scripts'], root).split('\0').filter((file) => file !== '');
  const violations = finalViolations({
    trackedFiles,
    read: (file) => fs.readFileSync(path.join(root, file), 'utf8'),
    tsconfig: fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'),
  });
  if (trackedFiles.length === 0) violations.push('no tracked files under src, test, types or scripts');
  for (const line of violations) console.log(line);
  console.log(violations.length > 0 ? `final: ${violations.length} violations in ${trackedFiles.length} tracked files` : 'final: clean');
  return violations.length > 0 ? 1 : 0;
}

const COMMANDS = new Map<string, (flags: Flags) => number>([
  ['baseline-emit', runBaselineEmit],
  ['syntax-map', runSyntaxMap],
  ['erasure', runErasure],
  ['lockfile', runLockfile],
  ['test-names', runTestNames],
  ['compare-dirs', runCompareDirs],
  ['final', runFinal],
]);

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const run = command === undefined ? undefined : COMMANDS.get(command);
  if (!run) {
    console.error(USAGE);
    return 2;
  }
  try {
    return run(parseFlags(rest));
  } catch (error) {
    console.error(`migration-check ${command}: ${error.message}`);
    if (error instanceof UsageError) console.error(USAGE);
    return 2;
  }
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
