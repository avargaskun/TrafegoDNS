// @ts-nocheck
import logger from './logger';
import { describeError } from './errors';

function installProcessGuards({ exit = (code) => process.exit(code) } = {}) {
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled promise rejection: ${describeError(reason)}`);
    exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${describeError(err)}`);
    exit(1);
  });
}

export { installProcessGuards };
