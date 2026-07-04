const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const puppeteer = require('puppeteer-core');
const { buildImageSceneHtml, renderHyperframesComposition } = require('./hyperframesRender');
const { ASSETS_DIR, getAspectRatioConfig } = require('../config/constants');

const execFileAsync = promisify(execFile);
const SCENE_FPS = 30;
const XFADE_TRANSITIONS = new Set([
  'fade', 'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'slideleft', 'slideright', 'slideup', 'slidedown',
  'circlecrop', 'rectcrop', 'distance', 'fadeblack', 'fadewhite',
  'radial', 'smoothleft', 'smoothright', 'smoothup', 'smoothdown',
  'circleopen', 'circleclose', 'vertopen', 'vertclose',
  'horzopen', 'horzclose', 'dissolve', 'pixelize',
  'diagtl', 'diagtr', 'diagbl', 'diagbr', 'hlslice',
  'hrslice', 'vuslice', 'vdslice'
]);
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.HYPERFRAMES_BROWSER_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'
].filter(Boolean);

async function runFfmpeg(ffmpegPath, args) {
  const safeArgs = ['-nostdin', '-loglevel', 'error', ...args];
  try {
    await execFileAsync(ffmpegPath, safeArgs, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    // execFile puts stderr on err.stderr — include last 800 chars for context
    const detail = (err.stderr || err.message || '').slice(-800).trim();
    throw new Error(`ffmpeg error: ${detail}`);
  }
}

async function measureMeanVolumeDb(ffmpegPath, inputPath) {
  try {
    const { stderr } = await execFileAsync(ffmpegPath, [
      '-hide_banner',
      '-nostats',
      '-i', inputPath,
      '-vn',
      '-af', 'volumedetect',
      '-f', 'null',
      '-'
    ], { windowsHide: true });
    const match = String(stderr || '').match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function dbToLinear(db) {
  return 10 ** (db / 20);
}

function linearToDb(linear) {
  return 20 * Math.log10(Math.max(0.000001, linear));
}

function escapeFilterPath(p) {
  return p.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
}

function getSubtitleFilter(subtitlePath) {
  if (!subtitlePath) {
    return '';
  }
  const fontsDir = path.join(ASSETS_DIR, 'fonts');
  return subtitlePath.endsWith('.ass')
    ? `ass=filename='${escapeFilterPath(subtitlePath)}':fontsdir='${escapeFilterPath(fontsDir)}'`
    : `subtitles='${escapeFilterPath(subtitlePath)}':force_style='Fontsize=52,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=1,Bold=1'`;
}

function hashString(input) {
  return Array.from(String(input || '')).reduce((acc, char) => (
    ((acc * 31) + char.charCodeAt(0)) >>> 0
  ), 7);
}

function resolveSceneMotionPreset(mode, sceneNumber, projectId = '') {
  switch (mode) {
    case 'none':
      return 'none';
    case 'zoom-in':
      return 'zoom-in';
    case 'zoom-out':
      return 'zoom-out';
    case 'pan-left':
      return 'pan-left';
    case 'pan-right':
      return 'pan-right';
    case 'pan-up':
      return 'pan-up';
    case 'pan-down':
      return 'pan-down';
    case 'random': {
      const options = ['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down'];
      const index = hashString(`${projectId}:${sceneNumber}`) % options.length;
      return options[index];
    }
    default:
      return 'zoom-in';
  }
}

function getRenderSize(aspectRatio = '16:9') {
  const { width, height } = getAspectRatioConfig(aspectRatio);
  return { width, height };
}

// Màu nền đặc biệt — các style này giữ toàn bộ hình gốc, bù bằng nền màu thay vì cắt
const STYLE_BG_PAD_COLOR = {
  'finance-cartoon': 'white',
  'chalk-dark':      '0x1a3320ff'
};

// Chuẩn bị ảnh trước khi render: upscale Lanczos cho tất cả style, pad nền màu cho style đặc biệt
async function prepareImageForRender(ffmpegPath, imagePath, outputPath, imageStyle, aspectRatio) {
  const { width, height } = getRenderSize(aspectRatio);
  const padColor = STYLE_BG_PAD_COLOR[imageStyle];

  if (padColor) {
    // Giữ tỉ lệ gốc, scale để vừa khung, bù phần trống bằng màu nền của style
    // force_original_aspect_ratio=decrease: co ảnh cho vừa trong WxH, không cắt
    await runFfmpeg(ffmpegPath, [
      '-y', '-i', imagePath,
      '-vf', [
        `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:${padColor}`
      ].join(','),
      outputPath
    ]);
  } else {
    // Upscale bằng Lanczos để ảnh đủ phủ khung render theo tỉ lệ đã chọn.
    await runFfmpeg(ffmpegPath, [
      '-y', '-i', imagePath,
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos`,
      outputPath
    ]);
  }
}

async function normalizeStillImageToAspect(ffmpegPath, inputPath, outputPath, aspectRatio = '16:9') {
  const { width, height } = getRenderSize(aspectRatio);
  const tmpPath = outputPath === inputPath
    ? path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.tmp${path.extname(outputPath)}`)
    : outputPath;

  await runFfmpeg(ffmpegPath, [
    '-y', '-i', inputPath,
    '-vf', [
      `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos`,
      `crop=${width}:${height}`
    ].join(','),
    '-frames:v', '1',
    '-update', '1',
    tmpPath
  ]);

  if (tmpPath !== outputPath) {
    await fs.rename(tmpPath, outputPath);
  }
  return outputPath;
}

async function normalizeStillImageWithBlurredBackground(ffmpegPath, inputPath, outputPath, aspectRatio = '16:9', options = {}) {
  const { width, height } = getRenderSize(aspectRatio);
  const tmpPath = outputPath === inputPath
    ? path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.tmp${path.extname(outputPath)}`)
    : outputPath;

  let filterComplex = '';
  if (aspectRatio === '9:16') {
    const blurPercent = options.blurPercent ?? 50;
    const blurSigma = (blurPercent / 100) * 40;
    const bgFilterSteps = [
      `scale=1512:850:force_original_aspect_ratio=increase:flags=lanczos,crop=1512:850`
    ];
    if (blurPercent > 0) {
      bgFilterSteps.push(`gblur=sigma=${blurSigma}`);
    }
    bgFilterSteps.push(`crop=1080:850,pad=1080:1920:0:535:black`);
    const bgFilter = bgFilterSteps.join(',');

    const drawtextFilters = [];
    if (options.topText || options.bottomText) {
      const { SUBTITLE_FONT_OPTIONS } = require('../config/constants');
      const fontFamily = options.fontFamily || 'Arial';
      const fontOption = SUBTITLE_FONT_OPTIONS.find(opt => opt.value === fontFamily);
      let fontFile = fontOption ? fontOption.file : 'Arial.ttf';
      const boldMapping = {
        'BeVietnamPro-Regular.ttf': 'BeVietnamPro-Bold.ttf',
        'NotoSans-Regular.ttf': 'NotoSans-Bold.ttf',
        'NotoSerif-Regular.ttf': 'NotoSerif-Bold.ttf',
        'Arial.ttf': 'Arial-Bold.ttf',
        'Tahoma.ttf': 'Tahoma-Bold.ttf',
        'Verdana.ttf': 'Verdana-Bold.ttf',
        'Georgia.ttf': 'Georgia-Bold.ttf'
      };
      if (boldMapping[fontFile]) {
        fontFile = boldMapping[fontFile];
      }
      const { ASSETS_DIR } = require('../config/constants');
      const fontFilePath = path.join(ASSETS_DIR, 'fonts', fontFile);
      const escapedFont = fontFilePath.replace(/\\/g, '/').replace(/:/g, '\\:');

      const escapeText = (txt) => {
        return txt
          .replace(/\\/g, '\\\\')
          .replace(/'/g, "'\\\\''")
          .replace(/:/g, '\\:')
          .replace(/%/g, '\\\\%');
      };

      const topText = options.topText || '';
      const bottomText = options.bottomText || '';
      const topFontSize = options.topFontSize || 64;
      const bottomFontSize = options.bottomFontSize || 64;
      const topPositionY = options.topPositionY ?? 18;
      const bottomPositionY = options.bottomPositionY ?? 83;
      const topColor = options.topColor || 'white';
      const bottomColor = options.bottomColor || 'yellow';
      const topLineHeight = options.topLineHeight ?? 1.4;
      const bottomLineHeight = options.bottomLineHeight ?? 1.4;

      if (topText) {
        const lines = topText.split('\n');
        const N = lines.length;
        const FS = topFontSize;
        const LH = FS * topLineHeight;
        const TH = FS + (N - 1) * LH;
        lines.forEach((lineText, idx) => {
          const escaped = escapeText(lineText);
          const yVal = Math.round(1920 * (topPositionY / 100) - (TH / 2) + (idx * LH));
          drawtextFilters.push(
            `drawtext=fontfile='${escapedFont}':text='${escaped}':fontsize=${FS}:fontcolor=${topColor}:x=(w-text_w)/2:y=${yVal}`
          );
        });
      }
      if (bottomText) {
        const lines = bottomText.split('\n');
        const N = lines.length;
        const FS = bottomFontSize;
        const LH = FS * bottomLineHeight;
        const TH = FS + (N - 1) * LH;
        lines.forEach((lineText, idx) => {
          const escaped = escapeText(lineText);
          const yVal = Math.round(1920 * (bottomPositionY / 100) - (TH / 2) + (idx * LH));
          drawtextFilters.push(
            `drawtext=fontfile='${escapedFont}':text='${escaped}':fontsize=${FS}:fontcolor=${bottomColor}:x=(w-text_w)/2:y=${yVal}`
          );
        });
      }
    }

    filterComplex = [
      `[0:v]split=2[bg][fg]`,
      `[bg]${bgFilter}[bg_final]`,
      `[fg]scale=1134:638:force_original_aspect_ratio=increase:flags=lanczos,crop=1134:638[fg_scaled]`,
      `[bg_final][fg_scaled]overlay=(W-w)/2:(H-h)/2[merged]`,
      `[merged]drawbox=y=0:h=1920*27.86/100:color=black@0.95:t=fill[top_pane]`,
      `[top_pane]drawbox=y=1920*(100-27.86)/100:h=1920*27.86/100:color=black@0.95:t=fill${drawtextFilters.length ? '[text_base]' : ''}`,
      drawtextFilters.length ? `[text_base]${drawtextFilters.join(',')}` : ''
    ].filter(Boolean).join(';');
  } else {
    filterComplex = [
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},boxblur=36:2,eq=brightness=-0.04:saturation=0.85[bg]`,
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1`
    ].join(';');
  }

  await runFfmpeg(ffmpegPath, [
    '-y',
    '-i', inputPath,
    '-filter_complex', filterComplex,
    '-frames:v', '1',
    '-update', '1',
    tmpPath
  ]);

  if (tmpPath !== outputPath) {
    await fs.rename(tmpPath, outputPath);
  }
  return outputPath;
}

function getImageMime(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

async function getChromeExecutablePath() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error('Chrome executable not found. Set CHROME_PATH or install Google Chrome.');
}

function buildSceneHtml({ imageDataUrl, width, height, motionPreset, duration }) {
  // bg overflow: 12% mỗi phía → che được pan an toàn mà không lộ nền đen
  const bgOverflow = 12;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body {
        margin: 0;
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
        background: #050505;
      }
      .stage {
        position: relative;
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
      }
      /* bg: tĩnh, blur mạnh, rộng hơn frame 12% mỗi phía → luôn che overflow của fg */
      .bg {
        position: absolute;
        left: -${bgOverflow}%;
        top: -${bgOverflow}%;
        width: ${100 + bgOverflow * 2}%;
        height: ${100 + bgOverflow * 2}%;
        object-fit: cover;
        object-position: center center;
        filter: blur(52px) brightness(0.52) saturate(0.8);
      }
      /* fg: full-frame, transform-origin center — scale 1.0 = ảnh vừa khít, không cắt */
      .fg {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: center center;
        transform-origin: center center;
        will-change: transform;
      }
      .vignette {
        position: absolute;
        inset: 0;
        background:
          radial-gradient(circle at center, rgba(0,0,0,0) 42%, rgba(0,0,0,0.16) 100%),
          linear-gradient(180deg, rgba(0,0,0,0.18), rgba(0,0,0,0.06) 18%, rgba(0,0,0,0.26));
        pointer-events: none;
      }
    </style>
  </head>
  <body>
    <div class="stage">
      <img class="bg" src="${imageDataUrl}" />
      <img class="fg" id="fg" src="${imageDataUrl}" />
      <div class="vignette"></div>
    </div>
    <script>
      const fg = document.getElementById('fg');
      const width = ${width};
      const height = ${height};
      const preset = ${JSON.stringify(motionPreset)};

      // 1 chu kỳ mỗi 8s → tốc độ cố định bất kể cảnh dài hay ngắn
      const CYCLE_SEC = 8;
      const sceneDuration = ${JSON.stringify(duration)};
      // Số nguyên → p=0 và p=1 đồng trạng thái, lặp không giật
      const n = Math.max(1, Math.round(sceneDuration / CYCLE_SEC));

      function stateAt(progress) {
        const p = Math.max(0, Math.min(1, progress));
        // Pan dùng ảnh phóng to 1.12, trượt trong vùng an toàn để không lộ nền.
        const panScale = 1.12;
        const panX = width * 0.048;
        const panY = height * 0.048;

        function pulse() { return (1 - Math.cos(p * Math.PI * 2 * n)) / 2; }

        switch (preset) {
          case 'none':
            return { scale: 1.0, x: 0, y: 0, rotate: 0 };

          // Zoom: fg scale 1.0→1.04→1.0, bg che phần overflow nhỏ ở cạnh
          case 'zoom-in':
          default:
            return { scale: 1.0 + 0.04 * pulse(), x: 0, y: 0, rotate: 0 };

          case 'zoom-out':
            return { scale: 1.04 - 0.04 * pulse(), x: 0, y: 0, rotate: 0 };

          // Pan: fg phóng to trước rồi trượt giữa hai mép an toàn.
          case 'pan-left':
            return { scale: panScale, x: panX - (panX * 2 * p), y: 0, rotate: 0 };

          case 'pan-right':
            return { scale: panScale, x: -panX + (panX * 2 * p), y: 0, rotate: 0 };

          case 'pan-up':
            return { scale: panScale, x: 0, y: panY - (panY * 2 * p), rotate: 0 };

          case 'pan-down':
            return { scale: panScale, x: 0, y: -panY + (panY * 2 * p), rotate: 0 };
        }
      }

      window.__renderFrame = (progress) => {
        const s = stateAt(progress);
        fg.style.transform =
          'translate(' + s.x + 'px,' + s.y + 'px) scale(' + s.scale + ') rotate(' + s.rotate + 'deg)';
      };

      Promise.all(Array.from(document.images).map((img) => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        });
      })).then(() => {
        window.__renderFrame(0);
        window.__rendererReady = true;
      });
    </script>
  </body>
</html>`;
}

async function renderFramesWithBrowser({ imagePath, framesDir, duration, motionPreset, aspectRatio }) {
  const { width, height } = getRenderSize(aspectRatio);
  const frameCount = Math.max(2, Math.round(Number(duration || 0) * SCENE_FPS));
  const executablePath = await getChromeExecutablePath();
  const imageBuffer = await fs.readFile(imagePath);
  const imageDataUrl = `data:${getImageMime(imagePath)};base64,${imageBuffer.toString('base64')}`;
  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(buildSceneHtml({ imageDataUrl, width, height, motionPreset, duration }), {
      waitUntil: 'load'
    });
    await page.waitForFunction(() => window.__rendererReady === true, { timeout: 15000 });

    for (let index = 0; index < frameCount; index += 1) {
      const progress = frameCount === 1 ? 1 : index / (frameCount - 1);
      await page.evaluate((p) => window.__renderFrame(p), progress);
      const framePath = path.join(framesDir, `frame_${String(index).padStart(5, '0')}.jpg`);
      await page.screenshot({
        path: framePath,
        type: 'jpeg',
        quality: 95
      });
    }
  } finally {
    await browser.close();
  }
}

async function renderStaticHtmlToImage({ html, outputPath, aspectRatio = '16:9' }) {
  const { width, height } = getRenderSize(aspectRatio);
  const executablePath = await getChromeExecutablePath();
  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none']
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    const isJpg = String(outputPath).toLowerCase().endsWith('.jpg') || String(outputPath).toLowerCase().endsWith('.jpeg');
    const type = isJpg ? 'jpeg' : 'png';
    await page.screenshot({ path: outputPath, type, quality: isJpg ? 90 : undefined });
  } finally {
    await browser.close();
  }
  return outputPath;
}

async function encodeFramesToVideo({ ffmpegPath, framesDir, audioPath, duration, outputPath }) {
  await runFfmpeg(ffmpegPath, [
    '-y',
    '-framerate', String(SCENE_FPS),
    '-i', path.join(framesDir, 'frame_%05d.jpg'),
    '-i', audioPath,
    '-t', String(duration),
    '-map', '0:v',
    '-map', '1:a',
    '-c:v', 'libx264',
    '-preset', 'fast', // intermediate step — will be concat + music encoded again
    '-crf', '18',
    '-r', String(SCENE_FPS),
    '-c:a', 'aac',
    '-pix_fmt', 'yuv420p',
    '-shortest',
    outputPath
  ]);
}

async function burnSubtitleTrack({ ffmpegPath, inputPath, subtitlePath, outputPath }) {
  const subtitleFilter = getSubtitleFilter(subtitlePath);
  if (!subtitleFilter) {
    await fs.copyFile(inputPath, outputPath);
    return;
  }
  await runFfmpeg(ffmpegPath, [
    '-y',
    '-i', inputPath,
    '-vf', subtitleFilter,
    '-map', '0:v',
    '-map', '0:a',
    '-c:v', 'libx264',
    '-preset', 'fast', // intermediate step — feeds into music/logo encode
    '-crf', '16',
    '-c:a', 'aac',
    '-pix_fmt', 'yuv420p',
    outputPath
  ]);
}

async function renderSceneVideo({
  ffmpegPath,
  imagePath,
  audioPath,
  outputPath,
  duration,
  aspectRatio,
  subtitlePath,
  motionMode,
  sceneNumber,
  projectId,
  imageStyle
}) {
  const motionPreset = resolveSceneMotionPreset(motionMode, sceneNumber, projectId);
  const sceneDir = path.dirname(outputPath);
  const baseName = path.basename(outputPath, path.extname(outputPath));
  const rawVideoPath = subtitlePath ? path.join(sceneDir, `${baseName}.raw.mp4`) : outputPath;
  const processedImagePath = path.join(sceneDir, `${baseName}.prepared.png`);
  const htmlPath = path.join(sceneDir, `${baseName}.hyperframes.html`);

  await fs.rm(rawVideoPath, { force: true });
  if (rawVideoPath !== outputPath) {
    await fs.rm(outputPath, { force: true });
  }

  try {
    const { width, height } = getRenderSize(aspectRatio);
    await prepareImageForRender(ffmpegPath, imagePath, processedImagePath, imageStyle, aspectRatio);
    await fs.writeFile(htmlPath, buildImageSceneHtml({
      imagePath: processedImagePath,
      duration,
      motionPreset,
      sceneNumber,
      width,
      height
    }), 'utf8');
    await renderHyperframesComposition(htmlPath, rawVideoPath, duration, null, { voiceAudioPath: audioPath });
    if (subtitlePath) {
      await burnSubtitleTrack({
        ffmpegPath,
        inputPath: rawVideoPath,
        subtitlePath,
        outputPath
      });
    }
  } finally {
    if (rawVideoPath !== outputPath) {
      await fs.rm(rawVideoPath, { force: true }).catch(() => {});
    }
    await fs.rm(processedImagePath, { force: true }).catch(() => {});
  }
  return outputPath;
}

async function renderSceneVideoFromSourceVideo({
  ffmpegPath,
  sourceVideoPath,
  audioPath,
  outputPath,
  duration,
  sourceDuration,
  aspectRatio,
  subtitlePath
}) {
  const sceneDir = path.dirname(outputPath);
  const baseName = path.basename(outputPath, path.extname(outputPath));
  const rawVideoPath = subtitlePath ? path.join(sceneDir, `${baseName}.raw.mp4`) : outputPath;
  const { width, height } = getRenderSize(aspectRatio);
  const targetDuration = Math.max(0.1, Number(duration) || 1);
  const inputDuration = Math.max(0.1, Number(sourceDuration) || targetDuration);
  const ptsFactor = targetDuration / inputDuration;
  const videoFilters = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${width}:${height}`,
    'setsar=1',
    `fps=${SCENE_FPS}`,
    `setpts=${ptsFactor.toFixed(6)}*PTS`
  ];

  await fs.rm(rawVideoPath, { force: true });
  if (rawVideoPath !== outputPath) {
    await fs.rm(outputPath, { force: true });
  }

  try {
    await runFfmpeg(ffmpegPath, [
      '-y',
      '-i', sourceVideoPath,
      '-i', audioPath,
      '-filter_complex', `[0:v]${videoFilters.join(',')}[v]`,
      '-map', '[v]',
      '-map', '1:a',
      '-t', targetDuration.toFixed(3),
      '-c:v', 'libx264',
      '-preset', 'fast', // intermediate step — will be concat + music encoded again
      '-crf', '18',
      '-c:a', 'aac',
      '-pix_fmt', 'yuv420p',
      '-shortest',
      rawVideoPath
    ]);
    if (subtitlePath) {
      await burnSubtitleTrack({
        ffmpegPath,
        inputPath: rawVideoPath,
        subtitlePath,
        outputPath
      });
    }
  } finally {
    if (rawVideoPath !== outputPath) {
      await fs.rm(rawVideoPath, { force: true }).catch(() => {});
    }
  }
  return outputPath;
}

async function renderSceneVideoWithOriginalAudio({
  ffmpegPath,
  sourceVideoPath,
  outputPath,
  duration,
  aspectRatio
}) {
  const { width, height } = getRenderSize(aspectRatio);
  const targetDuration = Math.max(0.1, Number(duration) || 1);
  await fs.rm(outputPath, { force: true });
  await runFfmpeg(ffmpegPath, [
    '-y',
    '-i', sourceVideoPath,
    '-vf', [
      `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=bicubic`,
      `crop=${width}:${height}`,
      'setsar=1',
      `fps=${SCENE_FPS}`
    ].join(','),
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-t', targetDuration.toFixed(3),
    '-c:v', 'libx264',
    '-preset', 'fast', // intermediate step — will be concat + music encoded again
    '-crf', '18',
    '-c:a', 'aac',
    '-ar', '48000',
    '-ac', '2',
    '-pix_fmt', 'yuv420p',
    '-shortest',
    outputPath
  ]);
  return outputPath;
}

async function extractLastVideoFrame({ ffmpegPath, inputPath, outputPath }) {
  await fs.rm(outputPath, { force: true });
  await runFfmpeg(ffmpegPath, [
    '-y',
    '-sseof', '-0.05',
    '-i', inputPath,
    '-frames:v', '1',
    '-update', '1',
    outputPath
  ]);
  return outputPath;
}

async function renderSceneVideoFromHtml({
  ffmpegPath,
  htmlPath,
  audioPath,
  outputPath,
  duration,
  subtitlePath,
  sfxVolume
}) {
  const sceneDir = path.dirname(outputPath);
  const baseName = path.basename(outputPath, path.extname(outputPath));
  const rawVideoPath = subtitlePath ? path.join(sceneDir, `${baseName}.raw.mp4`) : outputPath;

  await fs.rm(rawVideoPath, { force: true });
  if (rawVideoPath !== outputPath) {
    await fs.rm(outputPath, { force: true });
  }

  try {
    await renderHyperframesComposition(htmlPath, rawVideoPath, duration, null, { voiceAudioPath: audioPath, sfxVolume });
    if (subtitlePath) {
      await burnSubtitleTrack({
        ffmpegPath,
        inputPath: rawVideoPath,
        subtitlePath,
        outputPath
      });
    }
  } finally {
    if (rawVideoPath !== outputPath) {
      await fs.rm(rawVideoPath, { force: true }).catch(() => {});
    }
  }
  return outputPath;
}

function safeXfadeTransition(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return XFADE_TRANSITIONS.has(normalized) ? normalized : 'fade';
}

function usesNoTransitions(transitions, sceneCount) {
  const boundaryCount = Math.max(0, sceneCount - 1);
  return boundaryCount > 0 && Array.from({ length: boundaryCount }).every((_, index) => (
    String(transitions[index] || '').trim().toLowerCase() === 'none'
  ));
}

async function concatSceneVideosWithoutTransitions({ ffmpegPath, scenes, outputPath }) {
  const args = ['-y'];
  for (const scene of scenes) args.push('-i', scene.path);

  const inputs = scenes.map((_, index) => `[${index}:v][${index}:a]`).join('');
  args.push(
    '-filter_complex', `${inputs}concat=n=${scenes.length}:v=1:a=1[vout][aout]`,
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'superfast', '-crf', '20',
    '-c:a', 'aac',
    outputPath
  );
  await runFfmpeg(ffmpegPath, args);
  return outputPath;
}

async function concatSceneVideos({
  ffmpegPath,
  scenes,
  outputPath,
  xfadeDurationSec = 0.5,
  transitions = [],
  transitionSoundPaths = [],
  transitionSoundVolume = 0.45
}) {
  if (!scenes.length) throw new Error('No scene videos to merge');

  if (scenes.length === 1) {
    await fs.copyFile(scenes[0].path, outputPath);
    return outputPath;
  }

  if (usesNoTransitions(transitions, scenes.length)) {
    return concatSceneVideosWithoutTransitions({ ffmpegPath, scenes, outputPath });
  }

  const args = ['-y'];
  for (const scene of scenes) args.push('-i', scene.path);
  for (const soundPath of transitionSoundPaths) args.push('-i', soundPath);

  let videoLabel = '[0:v]';
  let audioLabel = '[0:a]';
  let elapsed = Number(scenes[0].duration || 0);
  const filters = [];
  const transitionOffsets = [];

  for (let index = 1; index < scenes.length; index += 1) {
    const videoOut = index === scenes.length - 1 ? '[vout]' : `[v${index}]`;
    const audioOut = index === scenes.length - 1 ? '[aout]' : `[a${index}]`;
    const offset = Math.max(0, elapsed - xfadeDurationSec * index);
    transitionOffsets.push(offset);
    const transition = safeXfadeTransition(transitions[index - 1]);
    filters.push(
      `${videoLabel}[${index}:v]xfade=transition=${transition}:duration=${xfadeDurationSec}:offset=${offset}${videoOut}`
    );
    // Keep the incoming scene at full volume so the first spoken word is not faded down.
    filters.push(
      `${audioLabel}[${index}:a]acrossfade=d=${xfadeDurationSec}:c1=tri:c2=nofade${audioOut}`
    );
    videoLabel = videoOut;
    audioLabel = audioOut;
    elapsed += Number(scenes[index].duration || 0);
  }

  let finalAudioLabel = '[aout]';
  if (transitionSoundPaths.length) {
    const sfxLabels = [];
    const sfxVolume = Math.max(0, Math.min(1, Number(transitionSoundVolume) || 0.45));
    transitionSoundPaths.forEach((_, soundIndex) => {
      const inputIndex = scenes.length + soundIndex;
      const offsetSec = transitionOffsets[soundIndex] ?? 0;
      const delayMs = Math.max(0, Math.round(offsetSec * 1000));
      const label = `[transition_sfx_${soundIndex}]`;
      filters.push(`[${inputIndex}:a]volume=${sfxVolume},adelay=${delayMs}:all=1${label}`);
      sfxLabels.push(label);
    });
    finalAudioLabel = '[aout_with_transitions]';
    filters.push(`[aout]${sfxLabels.join('')}amix=inputs=${sfxLabels.length + 1}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.98${finalAudioLabel}`);
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-map', finalAudioLabel,
    '-c:v', 'libx264', '-preset', 'superfast', '-crf', '20',
    '-c:a', 'aac',
    outputPath
  );
  await runFfmpeg(ffmpegPath, args);
  return outputPath;
}

// musicPaths: string[] — one or more audio files; looped automatically if shorter than video
function logoOverlayPosition(position) {
  const padding = 18;
  const positions = {
    'top-left': `${padding}:${padding}`,
    'top-right': `W-w-${padding}:${padding}`,
    'bottom-left': `${padding}:H-h-${padding}`,
    'bottom-right': `W-w-${padding}:H-h-${padding}`
  };
  return positions[position] || positions['top-right'];
}

function clampAudioVolume(value, fallback = 0.18) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

async function calculateRelativeMusicGain({ ffmpegPath, voicePath, musicPaths, musicVolume }) {
  // #perf: measure voice + all music files in parallel instead of sequentially
  const [voiceMeanDb, ...rawMusicDbs] = await Promise.all([
    measureMeanVolumeDb(ffmpegPath, voicePath),
    ...musicPaths.map((p) => measureMeanVolumeDb(ffmpegPath, p))
  ]);
  const musicMeanDbs = rawMusicDbs.filter((db) => Number.isFinite(db));
  if (!Number.isFinite(voiceMeanDb) || !musicMeanDbs.length || musicVolume <= 0) {
    return musicVolume;
  }
  const musicMeanLinear = musicMeanDbs.reduce((sum, db) => sum + dbToLinear(db), 0) / musicMeanDbs.length;
  const musicMeanDb = linearToDb(musicMeanLinear);
  const targetMusicMeanDb = voiceMeanDb + linearToDb(musicVolume);
  const gain = dbToLinear(targetMusicMeanDb - musicMeanDb);
  return Math.max(0, Math.min(4, gain));
}

async function checkHasAudio(ffmpegPath, inputPath) {
  try {
    const { stderr } = await execFileAsync(ffmpegPath, [
      '-hide_banner',
      '-i', inputPath
    ], { windowsHide: true });
    return String(stderr || '').includes('Audio:');
  } catch (err) {
    const stderr = err.stderr || err.message || '';
    return stderr.includes('Audio:');
  }
}

async function addBackgroundMusicAndLogo({
  ffmpegPath,
  inputPath,
  musicPaths = [],
  logoPath,
  outputPath,
  musicVolume = 0.18,
  logoSize = 120,
  logoPosition = 'top-right',
  logoOpacity = 1,
  watermarkText,
  watermarkFontSize = 24,
  watermarkOpacity = 30,
  watermarkBehavior = 'interval',
  watermarkInterval = 5,
  watermarkSpeed = 'medium',
  renderPreset = 'fast'
}) {
  const hasMusicPaths = musicPaths.length > 0;
  const hasLogo = Boolean(logoPath);
  const hasWatermark = Boolean(watermarkText);
  const safeMusicVolume = clampAudioVolume(musicVolume, 0.18);
  const relativeMusicGain = hasMusicPaths
    ? await calculateRelativeMusicGain({
      ffmpegPath,
      voicePath: inputPath,
      musicPaths,
      musicVolume: safeMusicVolume
    })
    : safeMusicVolume;

  if (!hasMusicPaths && !hasLogo && !hasWatermark) {
    // Nothing to add — just copy
    await fs.copyFile(inputPath, outputPath);
    return outputPath;
  }

  const inputHasAudio = await checkHasAudio(ffmpegPath, inputPath);

  const args = ['-y', '-i', inputPath];
  for (const mp of musicPaths) args.push('-i', mp);
  if (hasLogo) args.push('-i', logoPath);

  const musicCount = musicPaths.length;
  const logoIndex  = hasMusicPaths ? 1 + musicCount : 1;

  const filters = [];

  if (hasMusicPaths) {
    // Concat all music tracks in sequence
    if (musicCount > 1) {
      const musicInputs = musicPaths.map((_, i) => `[${i + 1}:a]`).join('');
      filters.push(`${musicInputs}concat=n=${musicCount}:v=0:a=1[all_music]`);
      // Loop indefinitely then let amix trim to video duration
      filters.push('[all_music]aloop=loop=-1:size=2147483647[music_loop]');
    } else {
      filters.push('[1:a]aloop=loop=-1:size=2147483647[music_loop]');
    }
    if (inputHasAudio) {
      filters.push('[0:a]aformat=sample_rates=48000:channel_layouts=stereo,asplit=2[voice_main1][voice_main2]');
      filters.push(`[music_loop]aformat=sample_rates=48000:channel_layouts=stereo,volume=${relativeMusicGain.toFixed(6)}[music_pre]`);
      filters.push('[music_pre][voice_main1]sidechaincompress=threshold=0.15:ratio=3.5:attack=25:release=300:makeup=1.2[music_ducked]');
      filters.push('[voice_main2][music_ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.98[aout]');
    } else {
      filters.push(`[music_loop]aformat=sample_rates=48000:channel_layouts=stereo,volume=${relativeMusicGain.toFixed(6)}[aout]`);
    }
  }

  let currentVideoLabel = '[0:v]';

  if (hasLogo) {
    const logoIn = `[${logoIndex}:v]`;
    const safeLogoSize = Math.min(360, Math.max(40, Math.round(Number(logoSize) || 120)));
    const safeLogoOpacity = Math.min(1, Math.max(0.1, Number(logoOpacity) || 1));
    filters.push(`${logoIn}scale=${safeLogoSize}:-1,format=rgba,colorchannelmixer=aa=${safeLogoOpacity}[logo_scaled]`);
    filters.push(`${currentVideoLabel}[logo_scaled]overlay=${logoOverlayPosition(logoPosition)}[v_logo]`);
    currentVideoLabel = '[v_logo]';
  }

  if (hasWatermark) {
    const fontFile = 'BeVietnamPro-Regular.ttf';
    const fontFilePath = path.join(ASSETS_DIR, 'fonts', fontFile);
    const escapedFont = escapeFilterPath(fontFilePath);
    const alpha = (Math.min(100, Math.max(10, Number(watermarkOpacity) || 30)) / 100).toFixed(2);
    const fontColor = `white@${alpha}`;

    let xExpr = '';
    let yExpr = '';
    if (watermarkBehavior === 'interval') {
      const intervalSec = Math.min(30, Math.max(1, Math.round(Number(watermarkInterval) || 5)));
      xExpr = `(w-text_w)*(sin(trunc(t/${intervalSec})*12345.67)+1)/2`;
      yExpr = `(h-text_h)*(sin(trunc(t/${intervalSec})*76543.21)+1)/2`;
    } else {
      let speedX = 1.0;
      let speedY = 0.7;
      if (watermarkSpeed === 'slow') {
        speedX = 0.5;
        speedY = 0.35;
      } else if (watermarkSpeed === 'fast') {
        speedX = 2.0;
        speedY = 1.4;
      }
      xExpr = `(w-text_w)*(sin(t*${speedX.toFixed(2)})+1)/2`;
      yExpr = `(h-text_h)*(sin(t*${speedY.toFixed(2)})+1)/2`;
    }

    const escapedText = String(watermarkText)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "'\\\\''")
      .replace(/:/g, '\\:');

    filters.push(`${currentVideoLabel}drawtext=fontfile='${escapedFont}':text='${escapedText}':fontsize=${watermarkFontSize}:fontcolor=${fontColor}:x='${xExpr}':y='${yExpr}'[v_watermark]`);
    currentVideoLabel = '[v_watermark]';
  }

  const hasVideoFilter = currentVideoLabel !== '[0:v]';

  if (filters.length > 0) {
    args.push('-filter_complex', filters.join(';'));
  }

  // When filter_complex exists but no video filter was applied, ffmpeg requires
  // the raw stream notation '0:v' (no brackets). Using '[0:v]' would make ffmpeg
  // look for a filter output label named '0:v' which doesn't exist.
  const videoMapArg = hasVideoFilter ? currentVideoLabel : '0:v';

  if (hasMusicPaths) {
    args.push('-map', videoMapArg, '-map', '[aout]');
  } else {
    if (inputHasAudio) {
      args.push('-map', videoMapArg, '-map', '0:a');
    } else {
      args.push('-map', videoMapArg);
    }
  }

  if (hasVideoFilter) {
    args.push('-c:v', 'libx264', '-preset', renderPreset, '-crf', '20');
  } else {
    args.push('-c:v', 'copy');
  }
  args.push('-c:a', 'aac', '-shortest', outputPath);
  await runFfmpeg(ffmpegPath, args);
  return outputPath;
}

async function appendOutroVideo({ ffmpegPath, inputPath, outroPath, outputPath, aspectRatio = '16:9' }) {
  if (!outroPath) {
    await fs.copyFile(inputPath, outputPath);
    return outputPath;
  }

  const { width, height } = getRenderSize(aspectRatio);
  const tempDir = path.dirname(outputPath);
  const mainNormalized = path.join(tempDir, 'video.main-normalized.mp4');
  const outroNormalized = path.join(tempDir, 'video.outro-normalized.mp4');
  const concatList = path.join(tempDir, 'video.concat-list.txt');

  // #perf: bicubic is ~10% faster than lanczos for these intermediate normalize steps
  // (final quality is irrelevant here — the concat step uses -c copy so no re-encode)
  const normalizeArgs = (source, dest) => [
    '-y',
    '-i', source,
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=bicubic,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${SCENE_FPS}`,
    '-af', 'aformat=sample_rates=48000:channel_layouts=stereo',
    '-c:v', 'libx264', '-preset', 'superfast', '-crf', '20',
    '-c:a', 'aac',
    '-ar', '48000',
    '-ac', '2',
    '-movflags', '+faststart',
    dest
  ];

  const normalizeArgsWithSilentAudio = (source, dest) => [
    '-y',
    '-i', source,
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=bicubic,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${SCENE_FPS}`,
    '-shortest',
    '-c:v', 'libx264', '-preset', 'superfast', '-crf', '20',
    '-c:a', 'aac',
    '-ar', '48000',
    '-ac', '2',
    '-movflags', '+faststart',
    dest
  ];

  await runFfmpeg(ffmpegPath, normalizeArgs(inputPath, mainNormalized));
  try {
    await runFfmpeg(ffmpegPath, normalizeArgs(outroPath, outroNormalized));
  } catch (error) {
    await runFfmpeg(ffmpegPath, normalizeArgsWithSilentAudio(outroPath, outroNormalized));
  }

  const escapeConcatPath = (filePath) => filePath.replace(/'/g, "'\\''");
  await fs.writeFile(
    concatList,
    `file '${escapeConcatPath(mainNormalized)}'\nfile '${escapeConcatPath(outroNormalized)}'\n`
  );

  await runFfmpeg(ffmpegPath, [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatList,
    '-c', 'copy',
    outputPath
  ]);
  await Promise.all([
    fs.unlink(mainNormalized).catch(() => {}),
    fs.unlink(outroNormalized).catch(() => {}),
    fs.unlink(concatList).catch(() => {})
  ]);
  return outputPath;
}

async function prependIntroVideo({ ffmpegPath, inputPath, introPath, outputPath, aspectRatio = '16:9' }) {
  if (!introPath) {
    await fs.copyFile(inputPath, outputPath);
    return outputPath;
  }

  const { width, height } = getRenderSize(aspectRatio);
  const tempDir = path.dirname(outputPath);
  const introNormalized = path.join(tempDir, 'video.intro-normalized.mp4');
  const mainNormalized = path.join(tempDir, 'video.main-normalized.mp4');
  const concatList = path.join(tempDir, 'video.intro-concat-list.txt');

  // #perf: bicubic is ~10% faster than lanczos for these intermediate normalize steps
  const normalizeArgs = (source, dest) => [
    '-y',
    '-i', source,
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=bicubic,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${SCENE_FPS}`,
    '-af', 'aformat=sample_rates=48000:channel_layouts=stereo',
    '-c:v', 'libx264', '-preset', 'superfast', '-crf', '20',
    '-c:a', 'aac',
    '-ar', '48000',
    '-ac', '2',
    '-movflags', '+faststart',
    dest
  ];

  const normalizeArgsWithSilentAudio = (source, dest) => [
    '-y',
    '-i', source,
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=bicubic,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${SCENE_FPS}`,
    '-shortest',
    '-c:v', 'libx264', '-preset', 'superfast', '-crf', '20',
    '-c:a', 'aac',
    '-ar', '48000',
    '-ac', '2',
    '-movflags', '+faststart',
    dest
  ];

  try {
    await runFfmpeg(ffmpegPath, normalizeArgs(introPath, introNormalized));
  } catch (error) {
    await runFfmpeg(ffmpegPath, normalizeArgsWithSilentAudio(introPath, introNormalized));
  }
  await runFfmpeg(ffmpegPath, normalizeArgs(inputPath, mainNormalized));

  const escapeConcatPath = (filePath) => filePath.replace(/'/g, "'\\''");
  await fs.writeFile(
    concatList,
    `file '${escapeConcatPath(introNormalized)}'\nfile '${escapeConcatPath(mainNormalized)}'\n`
  );

  await runFfmpeg(ffmpegPath, [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatList,
    '-c', 'copy',
    outputPath
  ]);
  await Promise.all([
    fs.unlink(introNormalized).catch(() => {}),
    fs.unlink(mainNormalized).catch(() => {}),
    fs.unlink(concatList).catch(() => {})
  ]);
  return outputPath;
}

module.exports = {
  renderSceneVideo,
  renderSceneVideoFromSourceVideo,
  renderSceneVideoWithOriginalAudio,
  renderSceneVideoFromHtml,
  concatSceneVideos,
  addBackgroundMusicAndLogo,
  prependIntroVideo,
  appendOutroVideo,
  renderStaticHtmlToImage,
  normalizeStillImageToAspect,
  normalizeStillImageWithBlurredBackground,
  extractLastVideoFrame
};


// [PATCHED] convertToVerticalVideo from Vibe Tool Video
async function convertToVerticalVideo({
  ffmpegPath,
  inputPath,
  outputPath,
  topText = '',
  bottomText = '',
  fontFilePath,
  topFontSize = 64,
  bottomFontSize = 64,
  topPositionY = 18,
  bottomPositionY = 83,
  blurPercent = 50,
  topColor = 'white',
  bottomColor = 'yellow',
  topLineHeight = 1.4,
  bottomLineHeight = 1.4
}) {
  const blurSigma = (blurPercent / 100) * 40;
  const escapedFont = fontFilePath.replace(/\\/g, '/').replace(/:/g, '\\:');

  const escapeText = (txt) => {
    return txt
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "'\\\\''")
      .replace(/:/g, '\\:')
      .replace(/%/g, '\\\\%');
  };

  const drawtextFilters = [];
  if (topText) {
    const lines = topText.split('\n');
    const N = lines.length;
    const FS = topFontSize;
    const LH = FS * topLineHeight;
    const TH = FS + (N - 1) * LH;
    lines.forEach((lineText, idx) => {
      const escaped = escapeText(lineText);
      const yVal = Math.round(1920 * (topPositionY / 100) - (TH / 2) + (idx * LH));
      drawtextFilters.push(
        `drawtext=fontfile='${escapedFont}':text='${escaped}':fontsize=${FS}:fontcolor=${topColor}:x=(w-text_w)/2:y=${yVal}`
      );
    });
  }
  if (bottomText) {
    const lines = bottomText.split('\n');
    const N = lines.length;
    const FS = bottomFontSize;
    const LH = FS * bottomLineHeight;
    const TH = FS + (N - 1) * LH;
    lines.forEach((lineText, idx) => {
      const escaped = escapeText(lineText);
      const yVal = Math.round(1920 * (bottomPositionY / 100) - (TH / 2) + (idx * LH));
      drawtextFilters.push(
        `drawtext=fontfile='${escapedFont}':text='${escaped}':fontsize=${FS}:fontcolor=${bottomColor}:x=(w-text_w)/2:y=${yVal}`
      );
    });
  }

  const bgFilterSteps = [
    `scale=1512:850:force_original_aspect_ratio=increase:flags=bicubic,crop=1512:850`
  ];
  if (blurPercent > 0) {
    bgFilterSteps.push(`gblur=sigma=${blurSigma}`);
  }
  bgFilterSteps.push(`crop=1080:850,pad=1080:1920:0:535:black`);
  const bgFilter = `[bg]${bgFilterSteps.join(',')}[bg_final]`;

  const complexFilter = [
    `[0:v]split=2[bg][fg]`,
    bgFilter,
    `[fg]scale=1134:638:force_original_aspect_ratio=increase:flags=bicubic,crop=1134:638[fg_scaled]`,
    `[bg_final][fg_scaled]overlay=(W-w)/2:(H-h)/2[merged]`,
    `[merged]drawbox=y=0:h=1920*27.86/100:color=black@0.95:t=fill[top_pane]`,
    `[top_pane]drawbox=y=1920*(100-27.86)/100:h=1920*27.86/100:color=black@0.95:t=fill${drawtextFilters.length ? '[text_base]' : ''}`,
    drawtextFilters.length ? `[text_base]${drawtextFilters.join(',')}` : ''
  ].filter(Boolean).join(';');

  const args = [
    '-y',
    '-i', inputPath,
    '-filter_complex', complexFilter,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-c:a', 'copy',
    outputPath
  ];

  await runFfmpeg(ffmpegPath, args);
  return outputPath;
}

module.exports.convertToVerticalVideo = convertToVerticalVideo;
