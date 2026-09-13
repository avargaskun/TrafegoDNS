const { after } = require('node:test');

/**
 * Fails a test file whose servers, sockets or timers outlive its tests, instead of letting the runner hang.
 * Registers a file-level `after` hook that arms an unref'd timer, so a file that tears down cleanly exits before it fires.
 * Call it once at the top level of every test file that starts monitors, fakes or timers.
 * @param {number} [graceMs=10000] - How long the process may stay alive after the file's last test.
 * @returns {void}
 */
function installExitWatchdog(graceMs = 10000) {
  after(() => {
    setTimeout(() => {
      const resources = process.getActiveResourcesInfo().join(', ');
      console.error(`Test file still alive ${graceMs} ms after its last test; open resources: ${resources}`);
      process.exit(1);
    }, graceMs).unref();
  });
}

module.exports = { installExitWatchdog };
