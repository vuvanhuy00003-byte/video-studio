const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function windowsPortablePythonDir(rootDir) {
  return path.join(rootDir, 'vendor', 'python', 'win32-x64');
}

function windowsPortablePythonPath(rootDir) {
  return path.join(windowsPortablePythonDir(rootDir), 'python.exe');
}

function pythonVersion(command, args = [], cwd = process.cwd()) {
  const result = spawnSync(command, [
    ...args,
    '-c',
    'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")'
  ], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function inspectPython(command, args = [], cwd = process.cwd()) {
  const result = spawnSync(command, [
    ...args,
    '-c',
    [
      'import json, sys;',
      'print(json.dumps({',
      '"basePrefix": sys.base_prefix,',
      '"prefix": sys.prefix,',
      '"executable": sys.executable,',
      '"version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"',
      '}))'
    ].join(' ')
  ], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `Unable to inspect Python runtime: ${command}`);
  }
  return JSON.parse(result.stdout);
}

function shouldCopyPythonPath(sourceRoot, sourcePath) {
  const rel = path.relative(sourceRoot, sourcePath).replaceAll(path.sep, '/');
  if (!rel || rel === '.') return true;
  const lower = rel.toLowerCase();
  if (lower.includes('/__pycache__/') || lower.endsWith('/__pycache__')) return false;
  if (lower === 'scripts' || lower.startsWith('scripts/')) return false;
  if (lower === 'doc' || lower.startsWith('doc/')) return false;
  if (lower === 'tools' || lower.startsWith('tools/')) return false;
  if (lower === 'libs' || lower.startsWith('libs/')) return false;
  if (lower === 'lib/site-packages' || lower.startsWith('lib/site-packages/')) return false;
  if (lower.endsWith('._pth')) return false;
  return true;
}

function copyPythonTree(sourceRoot, targetRoot) {
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.cpSync(sourceRoot, targetRoot, {
    recursive: true,
    filter: (sourcePath) => shouldCopyPythonPath(sourceRoot, sourcePath)
  });
}

function ensureWindowsPortablePython({ rootDir, pythonCommand, pythonArgs = [], cwd = rootDir }) {
  if (process.platform !== 'win32') return null;
  const targetDir = windowsPortablePythonDir(rootDir);
  const targetPython = windowsPortablePythonPath(rootDir);
  const sourceInfo = inspectPython(pythonCommand, pythonArgs, cwd);
  const currentVersion = fs.existsSync(targetPython) ? pythonVersion(targetPython, [], cwd) : '';

  if (currentVersion !== sourceInfo.version) {
    copyPythonTree(sourceInfo.basePrefix, targetDir);
  }

  const marker = {
    version: sourceInfo.version,
    copiedAt: new Date().toISOString(),
    source: sourceInfo.basePrefix
  };
  fs.writeFileSync(path.join(targetDir, 'kstudio-python-runtime.json'), `${JSON.stringify(marker, null, 2)}\n`);
  if (!fs.existsSync(targetPython)) {
    throw new Error(`Portable Windows Python was not created: ${targetPython}`);
  }
  return targetPython;
}

function venvSitePackagesDir(venvDir) {
  if (process.platform === 'win32') {
    return path.join(venvDir, 'Lib', 'site-packages');
  }
  const libDir = path.join(venvDir, 'lib');
  if (!fs.existsSync(libDir)) return '';
  const pythonDir = fs.readdirSync(libDir).find((entry) => /^python\d+\.\d+$/.test(entry));
  return pythonDir ? path.join(libDir, pythonDir, 'site-packages') : '';
}

function servicePythonPath({ rootDir, venvDir }) {
  const portable = windowsPortablePythonPath(rootDir);
  if (process.platform === 'win32' && fs.existsSync(portable)) {
    return portable;
  }
  const binDir = process.platform === 'win32' ? 'Scripts' : 'bin';
  return path.join(venvDir, binDir, process.platform === 'win32' ? 'python.exe' : 'python');
}

function servicePythonEnv({ rootDir, venvDir, extraPaths = [], baseEnv = process.env }) {
  const env = { ...baseEnv };
  const sitePackages = venvSitePackagesDir(venvDir);
  const pythonPaths = [sitePackages, ...extraPaths, env.PYTHONPATH].filter(Boolean);
  env.PYTHONPATH = pythonPaths.join(path.delimiter);
  env.PYTHONUNBUFFERED = env.PYTHONUNBUFFERED || '1';

  const portableDir = windowsPortablePythonDir(rootDir);
  if (process.platform === 'win32' && fs.existsSync(windowsPortablePythonPath(rootDir))) {
    env.PYTHONHOME = portableDir;
    env.PYTHONNOUSERSITE = '1';
    env.PATH = [
      portableDir,
      path.join(portableDir, 'DLLs'),
      sitePackages,
      sitePackages ? path.join(sitePackages, 'torch', 'lib') : '',
      path.join(venvDir, 'Scripts'),
      env.PATH
    ]
      .filter(Boolean)
      .join(path.delimiter);
  }
  return env;
}

module.exports = {
  ensureWindowsPortablePython,
  servicePythonEnv,
  servicePythonPath,
  venvSitePackagesDir,
  windowsPortablePythonDir,
  windowsPortablePythonPath
};
