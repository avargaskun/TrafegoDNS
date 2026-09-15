import logger from '../../src/utils/logger';
import { LOG_LEVELS } from '../../src/utils/logger';
import type { TestContext } from 'node:test';
import type { CapturedLogs, LogEntry, LogLevelName } from '../../types/test';

const TAGGED_LINE = /^\S+ \[(ERROR|WARN|INFO|DEBUG|TRACE)\] /;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z /;

/**
 * @param {string} text
 * @returns {LogLevelName | null}
 */
function parseLevel(text: string): LogLevelName | null {
  const tagged = TAGGED_LINE.exec(text);
  if (tagged) return (tagged[1] as LogLevelName);
  // INFO lines are printed with a symbol instead of an [INFO] tag.
  if (ISO_TIMESTAMP.test(text)) return 'INFO';
  return null;
}

/**
 * Captures everything the logger prints for the rest of the test.
 * @param {import('node:test').TestContext} t - Test context; restores the logger level and console.log afterwards.
 * @param {LogLevelName} [level='DEBUG'] - Logger level to use while capturing.
 * @returns {CapturedLogs}
 */
function captureLogs(t: TestContext, level: LogLevelName = 'DEBUG'): CapturedLogs {
  const lines: string[] = [];
  const entries: LogEntry[] = [];
  const savedLevel = logger.level;
  logger.level = LOG_LEVELS[level];
  t.mock.method(console, 'log', (...args: unknown[]) => {
    const text = args.join(' ');
    lines.push(text);
    entries.push({ level: parseLevel(text), text });
  });
  t.after(() => {
    logger.level = savedLevel;
  });
  return { lines, entries };
}

export { captureLogs, parseLevel };
