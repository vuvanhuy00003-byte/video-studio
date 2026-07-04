const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { ROOT_DIR, TMP_DIR } = require('../config/constants');
const { parseSrtBlocks } = require('./subtitleService');
const { runWhisperTranscription } = require('./whisperRuntime');
const { sanitizeApiKeyError, withApiKeyFallback } = require('./providerUtils');

const TARGET = `${process.platform}-${process.arch}`;

function executableName(baseName) {
  return process.platform === 'win32' ? `${baseName}.exe` : baseName;
}

function normalizeHttpUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Thiếu URL');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('URL không hợp lệ');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('URL phải bắt đầu bằng http:// hoặc https://');
  }
  return parsed.href;
}

async function scrapeSerperUrl(url, settings = {}) {
  const normalizedUrl = normalizeHttpUrl(url);
  return withApiKeyFallback(settings.serperKeysText, async (apiKey, keyMeta) => {
    const res = await fetch('https://scrape.serper.dev', {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url: normalizedUrl }),
      signal: AbortSignal.timeout(60000)
    });
    const raw = await res.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { error: raw }; }
    if (!res.ok) {
      const error = new Error(`Scrape API HTTP ${res.status} (key=${keyMeta.maskedKey}): ${sanitizeApiKeyError(data?.message || data?.error || raw, [apiKey]).slice(0, 500)}`);
      error.status = res.status;
      throw error;
    }
    const text = String(data?.text || data?.markdown || data?.content || '').trim();
    if (!text) throw new Error('Scrape API không trả về nội dung đọc được');
    return text.replace(/\n{3,}/g, '\n\n').slice(0, 60000);
  }, { label: 'Serper Scrape' });
}

function getSupportedVideoPlatform(url) {
  const parsed = new URL(normalizeHttpUrl(url));
  const host = parsed.hostname.replace(/^www\./, '').replace(/^m\./, '').replace(/^web\./, '').toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  if (host === 'youtu.be') return 'youtube';
  if (host.endsWith('youtube.com') && (
    pathname.startsWith('/watch')
    || pathname.startsWith('/shorts/')
    || pathname.startsWith('/live/')
  )) {
    return 'youtube';
  }
  if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com' || (host.endsWith('tiktok.com') && pathname.includes('/video/'))) {
    return 'tiktok';
  }
  if (host === 'fb.watch' || (host.endsWith('facebook.com') && (
    pathname.startsWith('/reel/')
    || pathname.startsWith('/reels/')
    || pathname.startsWith('/watch')
    || pathname.includes('/videos/')
    || pathname.startsWith('/share/v/')
  ))) {
    return 'facebook';
  }
  return '';
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

async function getVendorToolCandidates(toolName) {
  const toolsDir = path.join(ROOT_DIR, 'vendor', 'tools');
  const targetDirs = uniqueValues([
    TARGET,
    process.platform === 'darwin' ? 'darwin-arm64' : '',
    process.platform === 'darwin' ? 'darwin-x64' : ''
  ]);
  const candidates = targetDirs.map((target) => path.join(toolsDir, target, executableName(toolName)));
  const entries = await fs.readdir(toolsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) {
      candidates.push(path.join(toolsDir, entry.name, executableName(toolName)));
    }
  }
  return uniqueValues(candidates);
}

async function resolveYtDlpCommand() {
  const candidates = uniqueValues([
    process.env.VIBE_TOOL_YT_DLP_PATH,
    ...(await getVendorToolCandidates('yt-dlp')),
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    'yt-dlp'
  ]);
  for (const command of candidates) {
    if (path.isAbsolute(command) && !(await pathExists(command))) {
      continue;
    }
    try {
      await spawnCollect(command, ['--no-update', '--version'], { timeoutMs: 15000 });
      return command;
    } catch {}
  }
  const error = new Error('Không tìm thấy yt-dlp. Hãy cài yt-dlp hoặc đặt VIBE_TOOL_YT_DLP_PATH tới binary yt-dlp.');
  error.code = 'YTDLP_UNAVAILABLE';
  throw error;
}

function spawnCollect(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        PATH: uniqueValues([
          process.env.PATH,
          '/opt/homebrew/bin',
          '/usr/local/bin',
          '/usr/bin',
          '/bin',
          '/usr/sbin',
          '/sbin'
        ]).join(':')
      },
      windowsHide: true
    });
    const timeoutMs = options.timeoutMs || 180000;
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`${command} quá thời gian xử lý`));
    }, timeoutMs);
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = String(stderr || stdout || '').trim().slice(0, 1200);
      reject(new Error(`${command} exited with code ${code}${detail ? `: ${detail}` : ''}`));
    });
  });
}

function srtToPlainText(srtText) {
  return parseSrtBlocks(srtText)
    .map((block) => block.text)
    .join('\n')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function downloadVideoAudio({ url, outputPath, settings = {} }) {
  const ytDlp = await resolveYtDlpCommand();
  const args = [
    '--no-playlist',
    '--extract-audio',
    '--audio-format', 'mp3',
    '--audio-quality', '0',
    '--output', outputPath,
    '--no-update',
    '--newline'
  ];
  if (settings.ffmpegPath && path.isAbsolute(settings.ffmpegPath)) {
    args.push('--ffmpeg-location', settings.ffmpegPath);
  }
  args.push(url);
  await spawnCollect(ytDlp, args, { timeoutMs: 10 * 60 * 1000 });
}

async function resolveDownloadedAudio(workDir, preferredPath) {
  if (await pathExists(preferredPath)) return preferredPath;
  const files = await fs.readdir(workDir).catch(() => []);
  const audioFile = files.find((file) => /\.(mp3|m4a|webm|opus|wav)$/i.test(file));
  if (!audioFile) {
    throw new Error('yt-dlp không tạo được file audio để trích phụ đề');
  }
  return path.join(workDir, audioFile);
}

async function scrapeVideoTranscript(url, settings = {}) {
  const normalizedUrl = normalizeHttpUrl(url);
  const platform = getSupportedVideoPlatform(normalizedUrl);
  if (!platform) {
    throw new Error('URL không thuộc nền tảng video được hỗ trợ');
  }
  const workDir = await fs.mkdtemp(path.join(TMP_DIR, 'crawl-video-'));
  const audioPath = path.join(workDir, 'audio.mp3');
  const srtPath = path.join(workDir, 'transcript.srt');
  const wordsPath = path.join(workDir, 'transcript.words.json');
  const metadataPath = path.join(workDir, 'transcript.whisper.json');
  try {
    await downloadVideoAudio({ url: normalizedUrl, outputPath: path.join(workDir, 'audio.%(ext)s'), settings });
    const downloadedAudioPath = await resolveDownloadedAudio(workDir, audioPath);
    await runWhisperTranscription({
      audioPath: downloadedAudioPath,
      outputSrtPath: srtPath,
      outputWordsPath: wordsPath,
      metadataPath,
      settings
    });
    const text = srtToPlainText(await fs.readFile(srtPath, 'utf8'));
    if (!text) {
      throw new Error('Không trích xuất được phụ đề từ audio video');
    }
    return {
      text: text.slice(0, 60000),
      sourceUrl: normalizedUrl,
      sourceType: 'video',
      platform
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function crawlUrlContent(url, settings = {}) {
  const normalizedUrl = normalizeHttpUrl(url);
  const platform = getSupportedVideoPlatform(normalizedUrl);
  if (platform) {
    return scrapeVideoTranscript(normalizedUrl, settings);
  }
  return {
    text: await scrapeSerperUrl(normalizedUrl, settings),
    sourceUrl: normalizedUrl,
    sourceType: 'article',
    platform: ''
  };
}

module.exports = {
  normalizeHttpUrl,
  scrapeSerperUrl,
  getSupportedVideoPlatform,
  scrapeVideoTranscript,
  crawlUrlContent
};
