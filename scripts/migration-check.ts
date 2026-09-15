import { parse as acornParse } from 'acorn';
import type { Node, Program } from 'acorn';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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
type Loose = Record<string, unknown>;
type LockEntry = { version?: string; dev?: boolean };

class UsageError extends Error {}

const IGNORED_KEYS = new Set(['start', 'end', 'loc', 'range', 'raw', 'directive']);
const VALUE_FLAGS = new Set(['--baseline', '--rev', '--from', '--to', '--expected']);
const MAX_REPORTED_LINES = 5;
const USAGE = [
  'usage: migration-check <subcommand> [options]',
  '  baseline-emit [--baseline <sha>]',
  '  lockfile [--baseline <sha>]',
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

function expectNoPositional(flags: Flags): void {
  if (flags.positional.length > 0) throw new UsageError(`unexpected argument ${flags.positional[0]}`);
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
  expectNoPositional(flags);
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
  expectNoPositional(flags);
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

const COMMANDS = new Map<string, (flags: Flags) => number>([
  ['baseline-emit', runBaselineEmit],
  ['lockfile', runLockfile],
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
