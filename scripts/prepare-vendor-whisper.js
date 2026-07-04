#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const TARGET = process.argv[2] || process.env.VIBE_VENDOR_WHISPER_PLATFORM || `${process.platform}-${process.arch}`;
const CURRENT_TARGET = `${process.platform}-${process.arch}`;
const VENDOR_WHISPER_DIR = path.join(ROOT_DIR, 'vendor', 'whisper');
const BUILD_DIR = path.join(ROOT_DIR, 'build', 'whisper', TARGET);
const SCRIPT_PATH = path.join(ROOT_DIR, 'src', 'python', 'whisper_transcribe.py');
// faster-whisper-small is multilingual; one bundled model covers every
// language exposed by the app. Language selection is passed at transcription.
const MODEL_SIZE = 'small';

const TARGETS = {
  'darwin-arm64': { binName: 'whisper-transcribe' },
  'darwin-x64': { binName: 'whisper-transcribe' },
  'win32-x64': { binName: 'whisper-transcribe.exe' }
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT_DIR,
    stdio: options.stdio || 'inherit',
    env: { ...process.env, ...(options.env || {}) },
    shell: false
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result;
}

function output(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.status !== 0) return '';
  return String(result.stdout || '').trim();
}

function pythonVersion(candidate) {
  const text = output(candidate.command, [...candidate.args, '-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")']);
  const [major, minor] = text.split('.').map(Number);
  return Number.isFinite(major) && Number.isFinite(minor) ? { major, minor } : null;
}

function findBuildPython() {
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
    if (!version) continue;
    if (version.major === 3 && version.minor >= 10 && version.minor <= 12) {
      return candidate;
    }
  }
  throw new Error('Need Python 3.10-3.12 to build faster-whisper. Install Python 3.11 or set PYTHON=/path/to/python and rerun.');
}

function venvPaths() {
  const venvDir = path.join(BUILD_DIR, 'venv');
  const binDir = process.platform === 'win32' ? 'Scripts' : 'bin';
  const python = path.join(venvDir, binDir, process.platform === 'win32' ? 'python.exe' : 'python');
  const pyinstaller = path.join(venvDir, binDir, process.platform === 'win32' ? 'pyinstaller.exe' : 'pyinstaller');
  return { venvDir, python, pyinstaller };
}

function ensureVenv(buildPython) {
  const { venvDir, python } = venvPaths();
  if (!fs.existsSync(python)) {
    fs.mkdirSync(BUILD_DIR, { recursive: true });
    run(buildPython.command, [...buildPython.args, '-m', 'venv', venvDir]);
  }
  run(python, ['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel', 'setuptools']);
  run(python, [
    '-m', 'pip', 'install',
    'faster-whisper==1.2.1',
    'pyinstaller==6.11.1'
  ]);
}

function buildBinary() {
  const { pyinstaller } = venvPaths();
  const distDir = path.join(BUILD_DIR, 'dist');
  const workDir = path.join(BUILD_DIR, 'pyinstaller');
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
  run(pyinstaller, [
    '--clean',
    '--onedir',
    '--contents-directory', '.',
    '--name', 'whisper-transcribe',
    '--distpath', distDir,
    '--workpath', workDir,
    '--specpath', BUILD_DIR,
    '--collect-all', 'faster_whisper',
    '--collect-all', 'ctranslate2',
    '--collect-all', 'tokenizers',
    '--collect-all', 'numpy',
    '--collect-all', 'av',
    '--hidden-import', 'numpy._core._exceptions',
    SCRIPT_PATH
  ]);
  return path.join(distDir, 'whisper-transcribe', TARGETS[TARGET].binName);
}

function copyRuntime(binaryPath) {
  const builtRuntimeDir = path.dirname(binaryPath);
  const outDir = path.join(VENDOR_WHISPER_DIR, TARGET);
  const outPath = path.join(outDir, TARGETS[TARGET].binName);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  fs.cpSync(builtRuntimeDir, outDir, { recursive: true, verbatimSymlinks: true });
  assertPortableRuntimeLinks(outDir);
  try {
    fs.chmodSync(outPath, 0o755);
  } catch {}
  pruneOtherRuntimeTargets(TARGET);
  return outPath;
}

function assertPortableRuntimeLinks(rootDir) {
  const visit = (dirPath) => {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      const resolvedTarget = path.resolve(path.dirname(fullPath), fs.readlinkSync(fullPath));
      const isInternal = resolvedTarget === rootDir || resolvedTarget.startsWith(`${rootDir}${path.sep}`);
      if (!isInternal) {
        throw new Error(`Whisper runtime contains non-portable symlink: ${fullPath} -> ${fs.readlinkSync(fullPath)}`);
      }
    }
  };
  visit(rootDir);
}

function pruneOtherRuntimeTargets(target) {
  if (!fs.existsSync(VENDOR_WHISPER_DIR)) return;
  for (const entry of fs.readdirSync(VENDOR_WHISPER_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === target || entry.name === 'models') continue;
    fs.rmSync(path.join(VENDOR_WHISPER_DIR, entry.name), { recursive: true, force: true });
  }
}

function modelFolderName(modelSize) {
  const normalized = String(modelSize || 'small').replace(/\\/g, '/').replace(/\/+$/, '');
  const folderName = normalized.includes('/') ? normalized.split('/').pop() : `faster-whisper-${normalized}`;
  return folderName.replace(/:/g, '-');
}

function pruneLegacyModelCache(modelDir) {
  const flatModelDir = path.join(modelDir, modelFolderName(MODEL_SIZE));
  if (!fs.existsSync(path.join(flatModelDir, 'model.bin')) || !fs.existsSync(path.join(flatModelDir, 'config.json'))) {
    throw new Error(`Whisper model download did not create a portable model directory at ${flatModelDir}`);
  }

  for (const entry of fs.readdirSync(modelDir)) {
    if (entry.startsWith('models--') || entry === '.locks' || entry === 'CACHEDIR.TAG') {
      fs.rmSync(path.join(modelDir, entry), { recursive: true, force: true });
    }
  }
}

function bundledModelReady() {
  const modelDir = path.join(VENDOR_WHISPER_DIR, 'models', modelFolderName(MODEL_SIZE));
  return fs.existsSync(path.join(modelDir, 'model.bin'))
    && fs.existsSync(path.join(modelDir, 'config.json'))
    && fs.existsSync(path.join(modelDir, 'tokenizer.json'))
    && fs.existsSync(path.join(modelDir, 'vocabulary.txt'));
}

function downloadModel(binaryPath) {
  const modelDir = path.join(VENDOR_WHISPER_DIR, 'models');
  fs.mkdirSync(modelDir, { recursive: true });
  run(binaryPath, [
    '--download-model',
    '--model-size', MODEL_SIZE,
    '--model-dir', modelDir,
    '--device', 'cpu',
    '--compute-type', 'int8'
  ]);
  pruneLegacyModelCache(modelDir);
}

function main() {
  const targetConfig = TARGETS[TARGET];
  if (!targetConfig) {
    throw new Error(`Unsupported whisper target: ${TARGET}`);
  }

  const existingBinary = path.join(VENDOR_WHISPER_DIR, TARGET, targetConfig.binName);
  if (TARGET === CURRENT_TARGET && fs.existsSync(existingBinary) && bundledModelReady()) {
    run(existingBinary, ['--self-test']);
    console.log(`Whisper runtime already ready: ${existingBinary}`);
    return;
  }

  if (TARGET !== CURRENT_TARGET) {
    if (fs.existsSync(existingBinary)) {
      console.log(`Using existing cross-target whisper runtime: ${existingBinary}`);
      return;
    }
    const message = `Cannot build whisper runtime for ${TARGET} on ${CURRENT_TARGET}. PyInstaller must run on the target OS/arch. Build it on ${TARGET} or pre-seed ${existingBinary}.`;
    fs.rmSync(VENDOR_WHISPER_DIR, { recursive: true, force: true });
    console.warn(`${message} Packaging without Whisper; subtitle generation will use the built-in fallback.`);
    return;
  }

  const buildPython = findBuildPython();
  console.log(`Preparing faster-whisper runtime for ${TARGET} with ${buildPython.label}`);
  ensureVenv(buildPython);
  try {
    const builtBinary = buildBinary();
    const vendoredBinary = copyRuntime(builtBinary);
    run(vendoredBinary, ['--self-test']);
    downloadModel(vendoredBinary);
    console.log(`Whisper runtime ready: ${vendoredBinary}`);
  } catch (error) {
    fs.rmSync(path.join(VENDOR_WHISPER_DIR, TARGET), { recursive: true, force: true });
    console.warn(`Whisper runtime build failed for ${TARGET}; subtitle generation will use the built-in fallback.`);
    console.warn(error?.message || String(error));
  }
}

try {
  main();
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
}
