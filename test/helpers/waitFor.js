/**
 * Polls `predicate` every 10 ms until it returns a truthy value.
 * @template T
 * @param {() => T | Promise<T>} predicate - Sync or async condition; a truthy result ends the wait.
 * @param {number} [timeoutMs=2000] - Maximum time to wait.
 * @param {string} [description='condition'] - Used in the timeout error message.
 * @returns {Promise<T>} The first truthy value returned by `predicate`.
 */
async function waitFor(predicate, timeoutMs = 2000, description = 'condition') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

module.exports = { waitFor };
