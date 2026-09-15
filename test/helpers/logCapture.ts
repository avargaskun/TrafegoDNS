// @ts-nocheck
import logger from '../../src/utils/logger';
import { LOG_LEVELS } from '../../src/utils/logger';

/**
 * @typedef {'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE'} LogLevelName
 */

/**
 * @typedef {Object} LogEntry
 * @property {LogLevelName | null} level - Parsed level, or null for raw console output.
 * @property {string} text - The full line as printed.
 */

/**
 * @typedef {Object} CapturedLogs
 * @property {string[]} lines - Raw printed lines (live array).
 * @property {LogEntry[]} entries - Printed lines with their parsed level (live array).
 */

const TAGGED_LINE = /^\S+ \[(ERROR|WARN|INFO|DEBUG|TRACE)\] /;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z /;

/**
 * @param {string} text
 * @returns {LogLevelName | null}
 */
function parseLevel(text) {
  const tagged = TAGGED_LINE.exec(text);
  if (tagged) return /** @type {LogLevelName} */ (tagged[1]);
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
function captureLogs(t, level = 'DEBUG') {
  /** @type {string[]} */
  const lines = [];
  /** @type {LogEntry[]} */
  const entries = [];
  const savedLevel = logger.level;
  logger.level = LOG_LEVELS[level];
  t.mock.method(console, 'log', (...args) => {
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
