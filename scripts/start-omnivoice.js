#!/usr/bin/env node

const { startOmniVoice, stopOmniVoice } = require('../src/services/omnivoiceRuntime');

async function main() {
  const handle = await startOmniVoice({ force: true, inheritStdio: true });
  if (!handle.child) {
    console.log('OmniVoice is already running or no local runtime was started.');
    return;
  }

  const shutdown = async (exitCode = 0) => {
    await stopOmniVoice(handle).catch((error) => {
      console.error('Failed to stop OmniVoice cleanly', error);
      exitCode = 1;
    });
    process.exit(exitCode);
  };

  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));
  handle.child.once('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
