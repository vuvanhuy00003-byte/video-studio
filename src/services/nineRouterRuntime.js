const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { ROOT_DIR } = require('../config/constants');

const DEFAULT_HOST = process.env.NINE_ROUTER_HOST || process.env.VIBE_TOOL_9ROUTER_HOST || '0.0.0.0';
const DEFAULT_PORT = Number(process.env.NINE_ROUTER_PORT || process.env.VIBE_TOOL_9ROUTER_PORT || 20128);
const BETTER_SQLITE3_VERSION = '12.10.1';

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

function cliPath() {
  const packageCli = path.join(ROOT_DIR, 'node_modules', '9router', 'cli.js');
  if (fs.existsSync(packageCli)) return packageCli;
  const localBin = process.platform === 'win32'
    ? path.join(ROOT_DIR, 'node_modules', '.bin', '9router.cmd')
    : path.join(ROOT_DIR, 'node_modules', '.bin', '9router');
  return fs.existsSync(localBin) ? localBin : '9router';
}

function nodeCommand() {
  if (process.env.VIBE_TOOL_NODE_PATH) return process.env.VIBE_TOOL_NODE_PATH;
  if (process.env.npm_node_execpath) return process.env.npm_node_execpath;
  if (!process.versions.electron && process.execPath) return process.execPath;
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

function sqliteRuntimeHelper() {
  const helperPath = path.join(ROOT_DIR, 'node_modules', '9router', 'hooks', 'sqliteRuntime.js');
  try {
    return require(helperPath);
  } catch {
    return null;
  }
}

function runtimeDir(helper = sqliteRuntimeHelper()) {
  if (helper?.getRuntimeDir) return helper.getRuntimeDir();
  const dataDir = process.platform === 'win32'
    ? path.join(process.env.APPDATA || os.homedir(), '9router')
    : path.join(os.homedir(), '.9router');
  return path.join(dataDir, 'runtime');
}

function runtimeNodeModules(helper = sqliteRuntimeHelper()) {
  if (helper?.getRuntimeNodeModules) return helper.getRuntimeNodeModules();
  return path.join(runtimeDir(helper), 'node_modules');
}

function ensureRuntimePackage(helper) {
  const dir = runtimeDir(helper);
  fs.mkdirSync(dir, { recursive: true });
  const packagePath = path.join(dir, 'package.json');
  let pkg = {};
  if (fs.existsSync(packagePath)) {
    try {
      pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    } catch {
      pkg = {};
    }
  }
  const dependencies = {
    ...(pkg.dependencies || {}),
    'better-sqlite3': BETTER_SQLITE3_VERSION
  };
  fs.writeFileSync(packagePath, JSON.stringify({
    name: pkg.name || '9router-runtime',
    version: pkg.version || '1.0.0',
    private: true,
    description: pkg.description || 'User-writable runtime deps for 9router',
    ...pkg,
    dependencies
  }, null, 2));
}

function buildRuntimeEnv(baseEnv) {
  const helper = sqliteRuntimeHelper();
  if (helper?.buildEnvWithRuntime) return helper.buildEnvWithRuntime(baseEnv);

  const nodePath = [
    runtimeNodeModules(helper),
    path.join(ROOT_DIR, 'node_modules', '9router', 'app', 'node_modules'),
    baseEnv.NODE_PATH || ''
  ].filter(Boolean).join(path.delimiter);
  return { ...baseEnv, NODE_PATH: nodePath };
}

function betterSqliteIsUsable(env) {
  try {
    execFileSync(nodeCommand(), ['-e', [
      'const Database = require("better-sqlite3");',
      'const db = new Database(":memory:");',
      'db.prepare("select 1").get();',
      'db.close();'
    ].join(' ')], {
      cwd: ROOT_DIR,
      env,
      stdio: 'pipe',
      timeout: 15000,
      windowsHide: true
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function summarizeRuntimeLoadError(error) {
  const stderr = error?.stderr ? String(error.stderr).trim() : '';
  const stdout = error?.stdout ? String(error.stdout).trim() : '';
  const message = [stderr, stdout, error?.message].filter(Boolean).join('\n');
  return message || 'Unknown error';
}

function linkBetterSqliteForStandalone(helper) {
  const source = path.join(runtimeNodeModules(helper), 'better-sqlite3');
  if (!fs.existsSync(path.join(source, 'package.json'))) return;

  const appNodeModules = path.join(ROOT_DIR, 'node_modules', '9router', 'app', 'node_modules');
  if (!fs.existsSync(appNodeModules)) return;

  const dest = path.join(appNodeModules, 'better-sqlite3');
  try {
    const stat = fs.lstatSync(dest);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(dest);
      const resolvedTarget = path.resolve(path.dirname(dest), target);
      if (resolvedTarget === source) return;
      fs.unlinkSync(dest);
    } else {
      return;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') return;
  }

  fs.symlinkSync(source, dest, process.platform === 'win32' ? 'junction' : 'dir');
}

function ensureSqliteRuntime(options = {}) {
  const helper = sqliteRuntimeHelper();
  ensureRuntimePackage(helper);

  let env = buildRuntimeEnv(process.env);
  let runtimeCheck = betterSqliteIsUsable(env);
  if (runtimeCheck.ok) {
    linkBetterSqliteForStandalone(helper);
    return env;
  }

  if (process.env.VIBE_TOOL_REQUIRE_BUNDLED_RUNTIME === '1') {
    return env;
  }

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npmCmd, [
    'install',
    `better-sqlite3@${BETTER_SQLITE3_VERSION}`,
    '--no-audit',
    '--no-fund',
    '--prefer-online'
  ], {
    cwd: runtimeDir(helper),
    env: process.env,
    stdio: options.inheritStdio ? 'inherit' : 'pipe',
    timeout: 180000,
    windowsHide: true
  });

  env = buildRuntimeEnv(process.env);
  runtimeCheck = betterSqliteIsUsable(env);
  if (!runtimeCheck.ok) {
    const reason = summarizeRuntimeLoadError(runtimeCheck.error);
    throw new Error(`better-sqlite3 runtime is installed but cannot be loaded: ${reason}`);
  }
  linkBetterSqliteForStandalone(helper);
  return env;
}

function baseUrl({ host = 'localhost', port = DEFAULT_PORT } = {}) {
  return `http://${host}:${port}`;
}

async function isHealthy(url = baseUrl()) {
  try {
    const response = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForNineRouter(child, url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`9Router stopped before becoming ready (exit ${child.exitCode ?? child.signalCode})`);
  }
  throw new Error(`9Router did not become ready within ${Math.round(timeoutMs / 1000)}s`);
}

async function startNineRouter(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = Number(options.port || DEFAULT_PORT);
  const url = baseUrl({ port });

  if (!options.force && process.env.VIBE_TOOL_9ROUTER_AUTOSTART === '0') {
    return { child: null, url, skipped: true, reason: 'disabled' };
  }
  if (await isHealthy(url)) {
    console.log(`9Router already listening on ${url}`);
    return { child: null, url, external: true };
  }

  const cli = cliPath();
  const command = path.isAbsolute(cli) && fs.existsSync(cli) ? nodeCommand() : cli;
  const commandArgs = command === cli
    ? ['--skip-update', '--no-browser', '--log', '--port', String(port), '--host', host]
    : [cli, '--skip-update', '--no-browser', '--log', '--port', String(port), '--host', host];
  const runtimeEnv = ensureSqliteRuntime({ inheritStdio: options.inheritStdio });
  const env = {
    ...runtimeEnv,
    PORT: String(port),
    HOSTNAME: host,
    BASE_URL: url,
    NEXT_PUBLIC_BASE_URL: url
  };
  const child = spawn(command, commandArgs, {
    cwd: ROOT_DIR,
    env,
    stdio: options.inheritStdio ? 'inherit' : 'ignore',
    windowsHide: true
  });
  child.on('error', (error) => {
    console.error('9Router process error', error);
  });

  try {
    await waitForNineRouter(child, url, options.timeoutMs || 60000);
  } catch (error) {
    await stopNineRouter({ child });
    throw error;
  }

  console.log(`9Router listening on ${url}`);
  return { child, url };
}

async function stopNineRouter(handle) {
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

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  cliPath,
  baseUrl,
  isHealthy,
  startNineRouter,
  stopNineRouter
};
