// @ts-nocheck
import logger from './logger';

// Never render config, headers, request or response.data: AxiosErrors carry the API token there.
function describeError(error) {
  if (error === null || error === undefined) return String(error);
  if (typeof error !== 'object') return String(error);
  const parts = [error.message || error.name || 'Unknown error'];
  if (error.code) parts.push(`code=${error.code}`);
  const status = error.response?.status ?? error.statusCode ?? error.status;
  if (status) parts.push(`status=${status}`);
  return parts.join(' ');
}

function runGuarded(context, fn) {
  const report = (err) => logger.error(`${context}: ${describeError(err)}`);
  try {
    const result = fn();
    if (result && typeof result.then === 'function') return Promise.resolve(result).catch(report);
    return result;
  } catch (err) {
    report(err);
    return undefined;
  }
}

export { describeError, runGuarded };
