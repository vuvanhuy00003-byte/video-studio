#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ensureWindowsPortablePython,
  servicePythonEnv,
  servicePythonPath
} = require('../src/services/pythonRuntime');

const ROOT_DIR = path.resolve(__dirname, '..');
const FLOWKIT_DIR = path.join(ROOT_DIR, 'flowkit');
const VENV_DIR = path.join(FLOWKIT_DIR, 'venv');
const REQUIREMENTS_FILE = path.join(FLOWKIT_DIR, 'requirements.txt');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || FLOWKIT_DIR,
    stdio: options.stdio || 'inherit',
    env: { ...process.env, ...(options.env || {}) },
    shell: false
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result;
}

function runVenvPython(args) {
  return run(venvPython(), args, {
    env: { PIP_BREAK_SYSTEM_PACKAGES: '1' }
  });
}

function runPackagedPython(args) {
  return run(servicePythonPath({ rootDir: ROOT_DIR, venvDir: VENV_DIR }), args, {
    env: servicePythonEnv({
      rootDir: ROOT_DIR,
      venvDir: VENV_DIR,
      extraPaths: [FLOWKIT_DIR],
      baseEnv: { ...process.env, PIP_BREAK_SYSTEM_PACKAGES: '1' }
    })
  });
}

function output(command, args) {
  const result = spawnSync(command, args, {
    cwd: FLOWKIT_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function pythonVersion(candidate) {
  const text = output(candidate.command, [...candidate.args, '-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")']);
  const [major, minor] = text.split('.').map(Number);
  return Number.isFinite(major) && Number.isFinite(minor) ? { major, minor } : null;
}

function venvVersion() {
  if (!fs.existsSync(venvPython())) {
    return null;
  }
  const text = output(venvPython(), ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")']);
  const [major, minor] = text.split('.').map(Number);
  return Number.isFinite(major) && Number.isFinite(minor) ? { major, minor } : null;
}

function supportedVersion(version) {
  return version?.major === 3 && version.minor >= 10 && version.minor <= 12;
}

function findPython() {
  const candidates = [
    process.env.PYTHON && { command: process.env.PYTHON, args: [], label: process.env.PYTHON },
    { command: 'python3.12', args: [], label: 'python3.12' },
    { command: 'python3.11', args: [], label: 'python3.11' },
    { command: 'python3.10', args: [], label: 'python3.10' },
    { command: 'python3', args: [], label: 'python3' },
    { command: 'python', args: [], label: 'python' },
    ...(process.platform === 'win32'
      ? [
          { command: 'py', args: ['-3.12'], label: 'py -3.12' },
          { command: 'py', args: ['-3.11'], label: 'py -3.11' },
          { command: 'py', args: ['-3.10'], label: 'py -3.10' }
        ]
      : [])
  ].filter(Boolean);

  for (const candidate of candidates) {
    const version = pythonVersion(candidate);
    if (supportedVersion(version)) {
      return candidate;
    }
  }
  throw new Error('Need Python 3.10-3.12 for FlowKit. Install Python 3.11 or set PYTHON=/path/to/python.');
}

function venvPython() {
  const binDir = process.platform === 'win32' ? 'Scripts' : 'bin';
  return path.join(VENV_DIR, binDir, process.platform === 'win32' ? 'python.exe' : 'python');
}

function pythonSysconfig() {
  const result = spawnSync(venvPython(), [
    '-c',
    'import json, sys, sysconfig; print(json.dumps({"executable": sys.executable, "libdir": sysconfig.get_config_var("LIBDIR"), "ldlibrary": sysconfig.get_config_var("LDLIBRARY")}))'
  ], {
    cwd: FLOWKIT_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'Failed to inspect FlowKit Python runtime.');
  }
  return JSON.parse(result.stdout);
}

function copyIfExists(source, target) {
  if (!source || !fs.existsSync(source)) {
    return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { force: true });
  fs.copyFileSync(source, target);
  fs.chmodSync(target, fs.statSync(source).mode);
  return true;
}

function pythonLibVersion(config) {
  const text = `${config.ldlibrary || ''} ${config.libdir || ''}`;
  const match = text.match(/python(\d+\.\d+)/i);
  return match ? match[1] : null;
}

function copyStdlib(config, version) {
  const stdlibSource = path.join(config.libdir || '', `python${version}`);
  const stdlibTarget = path.join(VENV_DIR, 'lib', `python${version}`);
  if (!fs.existsSync(stdlibSource)) {
    return false;
  }
  fs.mkdirSync(stdlibTarget, { recursive: true });
  fs.cpSync(stdlibSource, stdlibTarget, { recursive: true });
  return true;
}

function writePythonWrapper(name, pythonName) {
  const wrapperPath = path.join(VENV_DIR, 'bin', name);
  const script = `#!/bin/sh
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VENV=$(dirname "$DIR")
export PYTHONHOME="$VENV"
exec "$DIR/${pythonName}" "$@"
`;
  fs.rmSync(wrapperPath, { force: true });
  fs.writeFileSync(wrapperPath, script);
  fs.chmodSync(wrapperPath, 0o755);
}

function makeDarwinVenvPortable() {
  if (process.platform !== 'darwin') {
    return;
  }

  const binDir = path.join(VENV_DIR, 'bin');
  const config = pythonSysconfig();
  const resolvedPython = fs.realpathSync(config.executable);
  const pythonName = path.basename(resolvedPython);
  const localPython = path.join(binDir, pythonName);
  if (!resolvedPython.startsWith(VENV_DIR)) {
    copyIfExists(resolvedPython, localPython);
  }

  for (const linkName of ['python', 'python3']) {
    const linkPath = path.join(binDir, linkName);
    try {
      fs.rmSync(linkPath, { force: true });
      fs.symlinkSync(pythonName, linkPath);
    } catch {
      copyIfExists(localPython, linkPath);
    }
  }

  if (config.ldlibrary && !config.ldlibrary.includes('/')) {
    copyIfExists(path.join(config.libdir || '', config.ldlibrary), path.join(VENV_DIR, 'lib', config.ldlibrary));
  }

  const version = pythonLibVersion(config);
  if (version) {
    copyStdlib(config, version);
  }

  writePythonWrapper('python', pythonName);
  writePythonWrapper('python3', pythonName);
}

function main() {
  if (!fs.existsSync(REQUIREMENTS_FILE)) {
    throw new Error(`Missing FlowKit requirements: ${REQUIREMENTS_FILE}`);
  }

  const python = findPython();
  if (fs.existsSync(venvPython()) && !supportedVersion(venvVersion())) {
    fs.rmSync(VENV_DIR, { recursive: true, force: true });
  }
  if (!fs.existsSync(venvPython())) {
    fs.mkdirSync(FLOWKIT_DIR, { recursive: true });
    const venvArgs = [...python.args, '-m', 'venv'];
    if (process.platform === 'win32') venvArgs.push('--copies');
    venvArgs.push(VENV_DIR);
    run(python.command, venvArgs);
  }

  runVenvPython(['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel', 'setuptools']);
  runVenvPython(['-m', 'pip', 'install', '-r', REQUIREMENTS_FILE]);
  runVenvPython(['-c', 'from agent.main import app; print("FlowKit import ok")']);
  ensureWindowsPortablePython({
    rootDir: ROOT_DIR,
    pythonCommand: python.command,
    pythonArgs: python.args,
    cwd: FLOWKIT_DIR
  });
  if (process.platform === 'win32') {
    runPackagedPython(['-c', 'from agent.main import app; print("FlowKit portable Python import ok")']);
  }
  makeDarwinVenvPortable();
  console.log(`FlowKit runtime ready: ${venvPython()}`);
}

try {
  main();
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
}
