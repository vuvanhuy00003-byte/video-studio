#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const VENDOR_TOOLS_DIR = path.join(ROOT_DIR, 'vendor', 'tools');
const TARGET = process.argv[2] || process.env.VIBE_VENDOR_TOOLS_PLATFORM || `${process.platform}-${process.arch}`;

const TARGETS = {
  'darwin-arm64': {
    npmPlatform: 'darwin',
    npmArch: 'arm64',
    ffmpegName: 'ffmpeg',
    ffprobeSource: path.join(ROOT_DIR, 'node_modules', 'ffprobe-static', 'ffprobe'),
    ffprobeName: 'ffprobe',
    ytDlpUrl: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
    ytDlpName: 'yt-dlp'
  },
  'darwin-x64': {
    npmPlatform: 'darwin',
    npmArch: 'x64',
    ffmpegName: 'ffmpeg',
    ffprobeSource: path.join(ROOT_DIR, 'node_modules', 'ffprobe-static', 'ffprobe'),
    ffprobeName: 'ffprobe',
    ytDlpUrl: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
    ytDlpName: 'yt-dlp'
  },
  'win32-x64': {
    npmPlatform: 'win32',
    npmArch: 'x64',
    ffmpegName: 'ffmpeg.exe',
    ffprobeSource: path.join(ROOT_DIR, 'node_modules', 'ffprobe-static', 'ffprobe.exe'),
    ffprobeName: 'ffprobe.exe',
    ytDlpUrl: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
    ytDlpName: 'yt-dlp.exe'
  }
};

function assertTarget(target) {
  const config = TARGETS[target];
  if (!config) {
    throw new Error(`Unsupported vendor tools target: ${target}`);
  }
  return config;
}

function ensureFfmpeg(config) {
  const ffmpegDir = path.join(ROOT_DIR, 'node_modules', 'ffmpeg-static');
  const source = path.join(ffmpegDir, config.ffmpegName);
  if (fs.existsSync(source)) return source;

  const installScript = path.join(ffmpegDir, 'install.js');
  if (!fs.existsSync(installScript)) {
    throw new Error(`ffmpeg-static install script not found: ${installScript}`);
  }

  const result = spawnSync(process.execPath, [installScript], {
    cwd: ffmpegDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_platform: config.npmPlatform,
      npm_config_arch: config.npmArch
    }
  });
  if (result.status !== 0 || !fs.existsSync(source)) {
    throw new Error(`Unable to prepare ffmpeg for ${config.npmPlatform}-${config.npmArch}`);
  }
  return source;
}

function ensureFfprobe(config) {
  if (fs.existsSync(config.ffprobeSource)) return config.ffprobeSource;

  const ffprobeDir = path.join(ROOT_DIR, 'node_modules', 'ffprobe-static');
  const installScript = path.join(ffprobeDir, 'install.js');
  if (!fs.existsSync(installScript)) {
    throw new Error(`ffprobe-static install script not found: ${installScript}`);
  }

  const result = spawnSync(process.execPath, [installScript], {
    cwd: ffprobeDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_platform: config.npmPlatform,
      npm_config_arch: config.npmArch
    }
  });
  if (result.status !== 0 || !fs.existsSync(config.ffprobeSource)) {
    throw new Error(`Unable to prepare ffprobe for ${config.npmPlatform}-${config.npmArch}`);
  }
  return config.ffprobeSource;
}

function copyExecutable(source, destination) {
  if (!fs.existsSync(source)) {
    throw new Error(`Missing runtime tool: ${source}`);
  }
  fs.copyFileSync(source, destination);
  try {
    fs.chmodSync(destination, 0o755);
  } catch {}
}

async function downloadFile(url, destination) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Unable to download ${url}: HTTP ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destination, buffer);
  try {
    fs.chmodSync(destination, 0o755);
  } catch {}
}

function assertDarwinArchitecture(source, target) {
  if (process.platform !== 'darwin' || !target.startsWith('darwin-')) return;
  const expected = target === 'darwin-arm64' ? 'arm64' : 'x86_64';
  const result = spawnSync('lipo', ['-archs', source], { encoding: 'utf8' });
  const architectures = String(result.stdout || '').trim().split(/\s+/).filter(Boolean);
  if (result.status !== 0 || !architectures.includes(expected)) {
    throw new Error(`Runtime tool has wrong architecture for ${target}: ${source} (${architectures.join(', ') || 'unknown'})`);
  }
}

function pruneOtherToolTargets(target) {
  if (!fs.existsSync(VENDOR_TOOLS_DIR)) return;
  for (const entry of fs.readdirSync(VENDOR_TOOLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === target) continue;
    fs.rmSync(path.join(VENDOR_TOOLS_DIR, entry.name), { recursive: true, force: true });
  }
}

async function main() {
  const config = assertTarget(TARGET);
  const outDir = path.join(VENDOR_TOOLS_DIR, TARGET);
  fs.mkdirSync(outDir, { recursive: true });

  const ffmpegSource = ensureFfmpeg(config);
  const ffprobeSource = ensureFfprobe(config);
  assertDarwinArchitecture(ffmpegSource, TARGET);
  assertDarwinArchitecture(ffprobeSource, TARGET);
  copyExecutable(ffmpegSource, path.join(outDir, config.ffmpegName));
  copyExecutable(ffprobeSource, path.join(outDir, config.ffprobeName));
  await downloadFile(config.ytDlpUrl, path.join(outDir, config.ytDlpName));
  pruneOtherToolTargets(TARGET);

  console.log(`Runtime tools ready: ${outDir}`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
