const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { ROOT_DIR } = require('../config/constants');
const { VIDEO_LANGUAGE_CONFIGS } = require('../config/languages');

const TARGET = `${process.platform}-${process.arch}`;
const VENDOR_WHISPER_DIR = path.join(ROOT_DIR, 'vendor', 'whisper');
const MODEL_DIR = process.env.VIBE_TOOL_WHISPER_MODEL_DIR || path.join(VENDOR_WHISPER_DIR, 'models');
const SCRIPT_PATH = path.join(ROOT_DIR, 'src', 'python', 'whisper_transcribe.py');
const DEFAULT_MODEL_SIZE = process.env.VIBE_TOOL_WHISPER_MODEL || 'small';
const DEFAULT_DEVICE = process.env.VIBE_TOOL_WHISPER_DEVICE || 'cpu';
const DEFAULT_COMPUTE_TYPE = process.env.VIBE_TOOL_WHISPER_COMPUTE_TYPE || 'int8';
const REQUIRE_BUNDLED_RUNTIME = process.env.VIBE_TOOL_REQUIRE_BUNDLED_RUNTIME === '1';

let resolvedRuntimePromise = null;

function executableName() {
  return process.platform === 'win32' ? 'whisper-transcribe.exe' : 'whisper-transcribe';
}

function pythonExecutableName() {
  return process.platform === 'win32' ? 'python.exe' : 'python';
}

function bundledBinaryPath() {
  return path.join(VENDOR_WHISPER_DIR, TARGET, executableName());
}

function bundledVenvPythonPath() {
  const binDir = process.platform === 'win32' ? 'Scripts' : 'bin';
  return path.join(VENDOR_WHISPER_DIR, TARGET, 'venv', binDir, pythonExecutableName());
}

function modelFolderName(modelSize) {
  const normalized = String(modelSize || DEFAULT_MODEL_SIZE).replace(/\\/g, '/').replace(/\/+$/, '');
  const folderName = normalized.includes('/') ? normalized.split('/').pop() : `faster-whisper-${normalized}`;
  return folderName.replace(/:/g, '-');
}

function commandRuntime(command, args = [], label = command) {
  return { command, args, label };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function spawnCollect(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        VIBE_TOOL_WHISPER_MODEL_DIR: MODEL_DIR
      },
      windowsHide: true,
      ...options
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`${command} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`);
        error.stdout = stdout;
        error.stderr = stderr;
        error.exitCode = code;
        reject(error);
      }
    });
  });
}

async function candidateRuntimes() {
  const candidates = [];
  if (process.env.VIBE_TOOL_WHISPER_TRANSCRIBE) {
    candidates.push(commandRuntime(process.env.VIBE_TOOL_WHISPER_TRANSCRIBE, [], 'env:VIBE_TOOL_WHISPER_TRANSCRIBE'));
  }

  const bundledBinary = bundledBinaryPath();
  if (await pathExists(bundledBinary)) {
    candidates.push(commandRuntime(bundledBinary, [], `vendored:${TARGET}`));
  }

  if (!REQUIRE_BUNDLED_RUNTIME) {
    const bundledPython = bundledVenvPythonPath();
    if (await pathExists(bundledPython) && await pathExists(SCRIPT_PATH)) {
      candidates.push(commandRuntime(bundledPython, [SCRIPT_PATH], `vendored-python:${TARGET}`));
    }
  }

  if (!REQUIRE_BUNDLED_RUNTIME && await pathExists(SCRIPT_PATH)) {
    for (const command of ['python3.11', 'python3.12', 'python3.10', 'python3']) {
      candidates.push(commandRuntime(command, [SCRIPT_PATH], `system:${command}`));
    }
  }
  return candidates;
}

async function checkRuntime(runtime) {
  await spawnCollect(runtime.command, [...runtime.args, '--self-test']);
  return runtime;
}

async function resolveWhisperRuntime() {
  const candidates = await candidateRuntimes();
  const failures = [];
  for (const runtime of candidates) {
    try {
      return await checkRuntime(runtime);
    } catch (error) {
      failures.push(`${runtime.label}: ${String(error?.stderr || error?.message || error).slice(0, 600)}`);
    }
  }
  const error = new Error([
    'faster_whisper runtime unavailable.',
    `Expected vendored binary at: ${bundledBinaryPath()}`,
    'Run: npm run prepare:vendor-whisper',
    failures.length ? `Checked candidates:\n- ${failures.join('\n- ')}` : ''
  ].filter(Boolean).join('\n'));
  error.code = 'FASTER_WHISPER_UNAVAILABLE';
  throw error;
}

function getResolvedWhisperRuntime() {
  if (!resolvedRuntimePromise) {
    resolvedRuntimePromise = resolveWhisperRuntime().catch((error) => {
      resolvedRuntimePromise = null;
      throw error;
    });
  }
  return resolvedRuntimePromise;
}

function getWhisperLanguage(settings = {}) {
  const language = String(settings.videoLanguage || '').trim().toLowerCase();
  if (VIDEO_LANGUAGE_CONFIGS[language]) return VIDEO_LANGUAGE_CONFIGS[language].whisperLanguage;
  return process.env.VIBE_TOOL_WHISPER_LANGUAGE || 'auto';
}

async function resolveModelSize(settings = {}) {
  const requestedModelSize = process.env.VIBE_TOOL_WHISPER_MODEL || settings.whisperModelSize || DEFAULT_MODEL_SIZE;
  if (!REQUIRE_BUNDLED_RUNTIME) return requestedModelSize;

  const requestedModelPath = path.join(MODEL_DIR, modelFolderName(requestedModelSize), 'model.bin');
  if (await pathExists(requestedModelPath)) return requestedModelSize;

  const defaultModelPath = path.join(MODEL_DIR, modelFolderName(DEFAULT_MODEL_SIZE), 'model.bin');
  if (await pathExists(defaultModelPath)) return DEFAULT_MODEL_SIZE;

  const error = new Error(`Bundled Whisper model is missing at: ${defaultModelPath}`);
  error.code = 'FASTER_WHISPER_UNAVAILABLE';
  throw error;
}

async function runWhisperTranscription({ audioPath, outputSrtPath, outputWordsPath, metadataPath, settings = {} }) {
  const runtime = await getResolvedWhisperRuntime();
  await fs.mkdir(path.dirname(outputSrtPath), { recursive: true });
  if (!REQUIRE_BUNDLED_RUNTIME) {
    await fs.mkdir(MODEL_DIR, { recursive: true });
  }
  const modelSize = await resolveModelSize(settings);
  const args = [
    ...runtime.args,
    audioPath,
    '--output-srt', outputSrtPath,
    '--output-words', outputWordsPath,
    '--metadata', metadataPath,
    '--model-size', modelSize,
    '--model-dir', MODEL_DIR,
    '--language', getWhisperLanguage(settings),
    '--device', process.env.VIBE_TOOL_WHISPER_DEVICE || settings.whisperDevice || DEFAULT_DEVICE,
    '--compute-type', process.env.VIBE_TOOL_WHISPER_COMPUTE_TYPE || settings.whisperComputeType || DEFAULT_COMPUTE_TYPE
  ];
  const result = await spawnCollect(runtime.command, args);
  return {
    runtime: runtime.label,
    stdout: result.stdout,
    stderr: result.stderr,
    outputSrtPath,
    outputWordsPath,
    metadataPath
  };
}

module.exports = {
  TARGET,
  VENDOR_WHISPER_DIR,
  MODEL_DIR,
  SCRIPT_PATH,
  bundledBinaryPath,
  getWhisperLanguage,
  resolveWhisperRuntime,
  runWhisperTranscription
};
