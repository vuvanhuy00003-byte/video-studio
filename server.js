const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { createApiRouter } = require('./src/routes/api');
const { ensureAppDirectories } = require('./src/services/settingsService');
const { startOmniVoice, stopOmniVoice } = require('./src/services/omnivoiceRuntime');
const { isHealthy: nineRouterIsHealthy, startNineRouter, stopNineRouter } = require('./src/services/nineRouterRuntime');
const { servicePythonEnv, servicePythonPath } = require('./src/services/pythonRuntime');
const { PROJECTS_DIR, PUBLIC_DIR } = require('./src/config/constants');

const FLOWKIT_DIR = path.join(__dirname, 'flowkit');
const FLOWKIT_VENV_DIR = path.join(FLOWKIT_DIR, 'venv');
const FLOWKIT_HEALTH_URL = 'http://localhost:8100/health';

function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout || '');
    });
  });
}

function uniquePids(values) {
  return [...new Set(values.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))];
}

async function listeningPidsOnPort(port) {
  const targetPort = Number(port);
  if (!targetPort) return [];
  if (process.platform === 'win32') {
    const output = await execFileText('netstat', ['-ano']).catch(() => '');
    return uniquePids(output.split(/\r?\n/).flatMap((line) => {
      if (!/\bLISTENING\b/i.test(line)) return [];
      const parts = line.trim().split(/\s+/);
      const localAddress = parts[1] || '';
      const pid = parts[parts.length - 1];
      return localAddress.endsWith(`:${targetPort}`) ? [pid] : [];
    }));
  }
  const output = await execFileText('lsof', ['-nP', `-iTCP:${targetPort}`, '-sTCP:LISTEN', '-t']).catch(() => '');
  return uniquePids(output.split(/\s+/));
}

function signalPid(pid, signal) {
  if (!pid || pid === process.pid) return;
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function waitForPortToClose(port, timeoutMs = 5000, excludePids = []) {
  const deadline = Date.now() + timeoutMs;
  const excluded = new Set(excludePids.map(Number));
  while (Date.now() < deadline) {
    const pids = (await listeningPidsOnPort(port)).filter((pid) => !excluded.has(pid));
    if (!pids.length) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function stopPortListeners(port, options = {}) {
  const excluded = new Set([process.pid, ...(options.excludePids || []).map(Number)]);
  const pids = (await listeningPidsOnPort(port)).filter((pid) => !excluded.has(pid));
  if (!pids.length) return [];
  for (const pid of pids) signalPid(pid, 'SIGTERM');
  if (!(await waitForPortToClose(port, options.timeoutMs || 5000, [...excluded]))) {
    const remaining = (await listeningPidsOnPort(port)).filter((pid) => !excluded.has(pid));
    for (const pid of remaining) signalPid(pid, 'SIGKILL');
    await waitForPortToClose(port, 1000, [...excluded]);
  }
  return pids;
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function signalChildProcess(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function stopChildProcess(child) {
  signalChildProcess(child, 'SIGINT');
  await waitForExit(child, 5000);
  if (child.exitCode === null && child.signalCode === null) {
    signalChildProcess(child, 'SIGKILL');
    await waitForExit(child, 1000);
  }
}

function attachStartupOutput(child) {
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

async function flowkitIsHealthy() {
  try {
    const response = await fetch(FLOWKIT_HEALTH_URL, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForFlowkit(child, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const output = childStartupOutput(child);
      throw new Error(`FlowKit stopped before becoming ready (exit ${child.exitCode ?? child.signalCode})${output ? `\n${output}` : ''}`);
    }
    if (await flowkitIsHealthy()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`FlowKit did not become ready within ${Math.round(timeoutMs / 1000)}s`);
}

async function startFlowkit() {
  const pythonPath = servicePythonPath({ rootDir: __dirname, venvDir: FLOWKIT_VENV_DIR });
  if (!fs.existsSync(pythonPath)) {
    throw new Error(`FlowKit runtime not found: ${pythonPath}. Run npm run flowkit:setup first.`);
  }
  if (await flowkitIsHealthy()) {
    console.log('FlowKit already listening on http://localhost:8100');
    return {
      child: null,
      external: true,
      close: async () => {}
    };
  }

  const flowkitDataDir = path.join(process.env.VIBE_TOOL_DATA_DIR || FLOWKIT_DIR, 'flowkit');
  fs.mkdirSync(flowkitDataDir, { recursive: true });
  const child = spawn(pythonPath, ['-m', 'agent.main'], {
    cwd: FLOWKIT_DIR,
    env: servicePythonEnv({
      rootDir: __dirname,
      venvDir: FLOWKIT_VENV_DIR,
      extraPaths: [FLOWKIT_DIR],
      baseEnv: {
        ...process.env,
        FLOW_AGENT_DIR: flowkitDataDir
      }
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  attachStartupOutput(child);
  child.on('error', (error) => {
    console.error('FlowKit process error', error);
  });

  try {
    await waitForFlowkit(child);
  } catch (error) {
    await stopChildProcess(child);
    throw error;
  }
  console.log('FlowKit listening on http://localhost:8100');

  return {
    child,
    close: () => stopChildProcess(child)
  };
}

function createLocalServiceManager(options = {}) {
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  const stopExternal = options.stopExternal === true;
  const handles = {
    nineRouter: null,
    flowkit: null,
    omnivoice: null
  };
  const starting = new Map();
  const stopping = new Set();
  const logs = [];
  const serviceConfig = {
    nineRouter: {
      label: '9Router',
      port: 20128,
      url: 'http://localhost:20128',
      dashboardUrl: 'http://localhost:20128/dashboard',
      apiUrl: 'http://localhost:20128/v1',
      health: () => nineRouterIsHealthy('http://localhost:20128'),
      start: () => startNineRouter({ force: true }),
      stop: stopNineRouter
    },
    flowkit: {
      label: 'FlowKit',
      port: 8100,
      url: 'http://localhost:8100',
      health: flowkitIsHealthy,
      start: startFlowkit,
      stop: (handle) => handle?.close?.()
    },
    omnivoice: {
      label: 'OmniVoice',
      port: 8101,
      url: 'http://localhost:8101',
      health: () => fetch('http://localhost:8101/health', { signal: AbortSignal.timeout(1000) })
        .then((response) => response.ok)
        .catch(() => false),
      start: () => startOmniVoice({ force: true }),
      stop: stopOmniVoice
    }
  };

  const log = (service, message, level = 'info') => {
    const entry = {
      time: new Date().toISOString(),
      service,
      level,
      message
    };
    logs.push(entry);
    if (logs.length > 500) logs.shift();
    onLog(`[${serviceConfig[service]?.label || service}] ${message}`);
  };

  const requireService = (name) => {
    const config = serviceConfig[name];
    if (!config) throw new Error(`Unknown local service: ${name}`);
    return config;
  };

  const attachExitLogger = (name, handle) => {
    const child = handle?.child;
    if (!child) return;
    child.once('exit', (code, signal) => {
      handles[name] = null;
      if (stopping.has(name)) return;
      log(name, `Stopped unexpectedly (exit ${code ?? signal})`, 'error');
    });
  };

  const status = async (name) => {
    const config = requireService(name);
    const running = await config.health();
    const handle = handles[name];
    const isStarting = starting.has(name);
    return {
      name,
      label: config.label,
      url: config.url,
      dashboardUrl: config.dashboardUrl || '',
      apiUrl: config.apiUrl || config.url,
      running,
      starting: isStarting,
      managed: Boolean(handle?.child),
      external: running && !handle?.child && !isStarting,
      skipped: Boolean(handle?.skipped),
      reason: handle?.reason || ''
    };
  };

  const start = async (name) => {
    const config = requireService(name);
    if (starting.has(name)) return starting.get(name);
    const startPromise = (async () => {
      try {
        if (await config.health()) {
          log(name, 'Already running');
        } else {
          log(name, 'Starting...');
          const handle = await config.start();
          handles[name] = handle;
          attachExitLogger(name, handle);
          if (handle?.skipped) {
            log(name, handle.reason || 'Skipped', 'warn');
          } else {
            log(name, `Listening on ${config.url}`);
          }
        }
      } finally {
        starting.delete(name);
      }
      return status(name);
    })();
    starting.set(name, startPromise);
    return startPromise;
  };

  const stopExternalService = async (name, config) => {
    if (!stopExternal || !config.port) {
      log(name, 'Running outside this app; stop it from the process that started it.', 'warn');
      return;
    }
    log(name, `Stopping external listener on port ${config.port}...`);
    const pids = await stopPortListeners(config.port);
    if (pids.length) {
      log(name, `Stopped external process ${pids.join(', ')}`);
    }
    if (await config.health()) {
      log(name, `Port ${config.port} is still busy after stop attempt.`, 'warn');
    } else {
      log(name, 'Stopped');
    }
  };

  const stop = async (name) => {
    const config = requireService(name);
    if (starting.has(name)) {
      await starting.get(name).catch(() => {});
    }
    const handle = handles[name];
    if (!handle?.child) {
      if (await config.health()) {
        await stopExternalService(name, config);
      } else {
        log(name, 'Already stopped');
      }
      handles[name] = null;
      return status(name);
    }
    stopping.add(name);
    log(name, 'Stopping...');
    try {
      await config.stop(handle);
      handles[name] = null;
      if (stopExternal && await config.health()) {
        await stopExternalService(name, config);
      } else {
        log(name, 'Stopped');
      }
    } finally {
      stopping.delete(name);
    }
    return status(name);
  };

  const restart = async (name) => {
    requireService(name);
    await stop(name);
    return start(name);
  };

  const list = async () => ({
    services: await Promise.all(Object.keys(serviceConfig).map(status)),
    logs
  });

  const stopAll = async () => {
    const results = await Promise.allSettled(Object.keys(serviceConfig).reverse().map(stop));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  };

  const startAll = async () => {
    for (const name of Object.keys(serviceConfig)) {
      await start(name);
    }
    return list();
  };

  return {
    list,
    start,
    stop,
    restart,
    startAll,
    stopAll,
    forceKillAll: async () => {
      for (const name of Object.keys(handles)) {
        const handle = handles[name];
        const child = handle?.child;
        if (child && child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL');
          } catch (e) {}
        }
        handles[name] = null;
      }
      for (const name of Object.keys(serviceConfig)) {
        const config = serviceConfig[name];
        if (config.port) {
          try {
            const pids = await listeningPidsOnPort(config.port);
            for (const pid of pids) {
              if (pid && pid !== process.pid) {
                try {
                  process.kill(pid, 'SIGKILL');
                } catch (e) {}
              }
            }
          } catch (e) {}
        }
      }
    },
    clearLogs: () => {
      logs.length = 0;
    }
  };
}

async function startServer(options = {}) {
  await ensureAppDirectories();
  const localServices = options.localServices || createLocalServiceManager();

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  app.use((req, res, next) => {
    const p = req.path;
    if (p.endsWith('.js') || p.endsWith('.css') || p === '/' || p.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    }
    next();
  });

  app.use('/projects', express.static(PROJECTS_DIR));
  app.use('/assets', express.static(path.join(__dirname, 'assets')));
  app.use('/api', createApiRouter({ localServices }));
  app.use(express.static(PUBLIC_DIR));

  const port = options.port ?? process.env.PORT ?? 3000;
  const host = options.host ?? 'localhost';

  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, host, () => resolve(listener));
    listener.on('error', reject);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host}:${actualPort}`;
  console.log(`Server listening on ${url}`);

  return {
    app,
    server,
    port: actualPort,
    url,
    localServices,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })
  };
}

async function startStack(options = {}) {
  let nineRouter = { child: null };
  let flowkit = { child: null, close: async () => {} };
  let omnivoice = { child: null };
  let serverHandle;
  let closing = false;
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  const onServiceExit = typeof options.onServiceExit === 'function' ? options.onServiceExit : null;

  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await serverHandle?.close();
      await stopOmniVoice(omnivoice);
      await flowkit.close();
      await stopNineRouter(nineRouter);
    } catch (error) {
      closing = false;
      throw error;
    }
  };

  const notifyServiceExit = (name, code, signal) => {
    if (!closing && onServiceExit) {
      onServiceExit(name, code, signal);
    }
  };

  try {
    onLog('Starting 9Router...');
    nineRouter = await startNineRouter();
    onLog(`9Router listening on ${nineRouter.url}`);
    onLog('Starting FlowKit...');
    flowkit = await startFlowkit();
    onLog('FlowKit listening on http://localhost:8100');
    onLog('Starting OmniVoice...');
    omnivoice = await startOmniVoice();
    onLog(`OmniVoice listening on ${omnivoice.url}`);
    onLog('Starting web app...');
    serverHandle = await startServer({
      host: options.host,
      port: options.port
    });
    onLog(`Web app listening on ${serverHandle.url}`);

    omnivoice.child?.once('exit', (code, signal) => {
      notifyServiceExit('OmniVoice', code, signal);
    });
    flowkit.child?.once('exit', (code, signal) => {
      notifyServiceExit('FlowKit', code, signal);
    });
    nineRouter.child?.once('exit', async (code, signal) => {
      if (!closing) {
        if (await nineRouterIsHealthy(nineRouter.url)) {
          console.warn(`9Router wrapper exited (exit ${code ?? signal}), but the service is still healthy.`);
          return;
        }
        notifyServiceExit('9Router', code, signal);
      }
    });
  } catch (error) {
    await close().catch((stopError) => {
      console.error('Failed to stop services cleanly after startup error', stopError);
    });
    throw error;
  }

  return {
    nineRouter,
    flowkit,
    omnivoice,
    serverHandle,
    urls: {
      app: serverHandle.url,
      nineRouter: nineRouter.url,
      flowkit: FLOWKIT_HEALTH_URL.replace('/health', ''),
      omnivoice: omnivoice.url
    },
    close
  };
}

async function main() {
  let serverHandle;
  let shuttingDown = false;

  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await serverHandle?.localServices?.stopAll();
      await serverHandle?.close();
    } catch (error) {
      console.error('Failed to stop services cleanly', error);
      exitCode = 1;
    }
    process.exit(exitCode);
  };

  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));
  process.once('uncaughtException', (error) => {
    console.error(error);
    shutdown(1);
  });
  process.once('unhandledRejection', (error) => {
    console.error(error);
    shutdown(1);
  });

  serverHandle = await startServer();
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Failed to start server', error);
    process.exit(1);
  });
}

module.exports = {
  startServer,
  startStack,
  createLocalServiceManager,
  stopPortListeners
};
