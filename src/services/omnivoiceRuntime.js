const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ROOT_DIR } = require('../config/constants');
const { servicePythonEnv, servicePythonPath } = require('./pythonRuntime');

const OMNIVOICE_DIR = path.join(ROOT_DIR, 'vendor', 'omnivoice');
const OMNIVOICE_SOURCE_DIR = path.join(OMNIVOICE_DIR, 'source');
const OMNIVOICE_SERVER_PATH = path.join(OMNIVOICE_DIR, 'server.py');
const OMNIVOICE_VENV_DIR = path.join(OMNIVOICE_DIR, 'venv');
const DEFAULT_HOST = process.env.OMNIVOICE_HOST || '127.0.0.1';
const DEFAULT_PORT = Number(process.env.OMNIVOICE_PORT || process.env.VIBE_TOOL_OMNIVOICE_PORT || 8101);

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function pythonPath() {
  return servicePythonPath({ rootDir: ROOT_DIR, venvDir: OMNIVOICE_VENV_DIR });
}

function attachStartupOutput(child, inheritStdio) {
  if (inheritStdio) return;
  const chunks = [];
  const collect = (stream, target) => {
    if (!stream) return;
    stream.on('data', (chunk) => {
      const text = String(chunk || '');
      chunks.push(text);
      if (chunks.join('').length > 4000) chunks.shift();
      target.write(text);
    });
  };
  collect(child.stdout, process.stdout);
  collect(child.stderr, process.stderr);
  child.startupOutput = () => chunks.join('').trim().slice(-2000);
}

function childStartupOutput(child) {
  return typeof child?.startupOutput === 'function' ? child.startupOutput() : '';
}

function baseUrl({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  return `http://${host}:${port}`;
}

async function isHealthy(url = baseUrl()) {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForOmniVoice(child, url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const output = childStartupOutput(child);
      throw new Error(`OmniVoice stopped before becoming ready (exit ${child.exitCode ?? child.signalCode})${output ? `\n${output}` : ''}`);
    }
    if (await isHealthy(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`OmniVoice did not become ready within ${Math.round(timeoutMs / 1000)}s`);
}

async function startOmniVoice(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = Number(options.port || DEFAULT_PORT);
  const url = baseUrl({ host, port });

  if (!options.force && process.env.VIBE_TOOL_OMNIVOICE_AUTOSTART === '0') {
    return { child: null, url, skipped: true, reason: 'disabled' };
  }
  if (await isHealthy(url)) {
    return { child: null, url, external: true };
  }

  const python = pythonPath();
  if (!fs.existsSync(python) || !fs.existsSync(OMNIVOICE_SERVER_PATH) || !fs.existsSync(OMNIVOICE_SOURCE_DIR)) {
    const reason = `OmniVoice runtime not found. Run npm run omnivoice:setup to enable local TTS (${python}).`;
    if (options.force) throw new Error(reason);
    console.warn(reason);
    return { child: null, url, skipped: true, reason };
  }

  const env = servicePythonEnv({
    rootDir: ROOT_DIR,
    venvDir: OMNIVOICE_VENV_DIR,
    extraPaths: [OMNIVOICE_SOURCE_DIR],
    baseEnv: {
      ...process.env,
      OMNIVOICE_HOST: host,
      OMNIVOICE_PORT: String(port)
    }
  });
  const child = spawn(python, [OMNIVOICE_SERVER_PATH, '--host', host, '--port', String(port)], {
    cwd: OMNIVOICE_DIR,
    env,
    stdio: options.inheritStdio ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  attachStartupOutput(child, options.inheritStdio);
  child.on('error', (error) => {
    console.error('OmniVoice process error', error);
  });

  try {
    await waitForOmniVoice(child, url, options.timeoutMs || 15000);
  } catch (error) {
    await stopOmniVoice({ child });
    if (options.force) throw error;
    console.warn(`OmniVoice local TTS unavailable: ${error.message}`);
    return { child: null, url, skipped: true, reason: error.message };
  }

  console.log(`OmniVoice listening on ${url}`);
  return { child, url };
}

async function stopOmniVoice(handle) {
  const child = handle?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGINT');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  await waitForExit(child, 5000);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    await waitForExit(child, 1000);
  }
}

// Singleton restart lock: prevent concurrent restart attempts
let _restartPromise = null;

/**
 * Ensures OmniVoice is running. If the health check fails,
 * automatically (re)starts the server and waits up to timeoutMs
 * for it to become ready. Safe to call concurrently.
 */
async function ensureOmniVoiceRunning(options = {}) {
  const url = baseUrl();
  if (await isHealthy(url)) return; // already up

  // Deduplicate concurrent restart attempts
  if (_restartPromise) {
    await _restartPromise;
    return;
  }

  _restartPromise = (async () => {
    try {
      console.log('[OmniVoice] Server not responding – attempting auto-restart...');
      const handle = await startOmniVoice({ force: true, timeoutMs: options.timeoutMs || 30000 });
      if (handle?.skipped) {
        throw new Error(handle.reason || 'OmniVoice runtime not available');
      }
      console.log('[OmniVoice] Auto-restart successful.');
    } finally {
      _restartPromise = null;
    }
  })();

  await _restartPromise;
}

module.exports = {
  OMNIVOICE_DIR,
  OMNIVOICE_SOURCE_DIR,
  OMNIVOICE_SERVER_PATH,
  DEFAULT_HOST,
  DEFAULT_PORT,
  pythonPath,
  baseUrl,
  isHealthy,
  startOmniVoice,
  stopOmniVoice,
  ensureOmniVoiceRunning
};
