const fs = require('fs/promises');
const path = require('path');
const {
  ASSETS_DIR,
  STYLE_PROMPT_DETAIL,
  STYLE_BG_MODIFIERS,
  SUBTITLE_FONT_OPTIONS,
  getAspectRatioConfig
} = require('../config/constants');
const { getVideoLanguageConfig } = require('../config/languages');
const { findAndDownloadImage } = require('./imageSearchService');
const { isImageSearchSource, isVideoSearchSource, isDirectMediaMode, getDefaultVerticalPrompt } = require('./projectService');
const { isDirectMediaSource, saveDirectMediaSource } = require('./mediaSourceService');
const { normalizeStillImageWithBlurredBackground, renderStaticHtmlToImage } = require('./renderService');

async function downloadFile(url, outputPath) {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;
  let lastError;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const bytes = Buffer.from(await response.arrayBuffer());
        await fs.writeFile(outputPath, bytes);
        return;
      }
      const err = new Error(`Failed to download file: ${response.status} ${url}`);
      // 4xx = lỗi client (sai URL, hết quyền…) — không có ích khi retry
      if (response.status >= 400 && response.status < 500) throw err;
      // 5xx = lỗi server tạm thời (502, 503…) — retry
      throw err;
    } catch (err) {
      const statusMatch = err.message.match(/Failed to download file: (\d+)/);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      if (status >= 400 && status < 500) throw err;  // 4xx — không retry
      lastError = err;                                 // 5xx hoặc network error — retry
    }
    if (attempt < MAX_RETRIES - 1) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
    }
  }

  throw lastError;
}

function getImageTextLanguageConfig(videoLanguage = 'vi') {
  const config = getVideoLanguageConfig(videoLanguage);
  return {
    name: config.englishName,
    avoid: 'no words in any other language',
    sceneExample: `1 to 2 short ${config.englishName} phrases, labels, signs, or headlines when visually useful, about 3 to 10 words total`,
    thumbnailHeadline: `${config.englishName} headline text`,
    thumbnailInstruction: `headline text must be natural ${config.englishName} with correct spelling and writing conventions`
  };
}

function applyTextDensityToStyleText(text = '', imageTextDensity = 'medium', videoLanguage = 'vi') {
  let cleaned = String(text || '');
  const language = getImageTextLanguageConfig(videoLanguage);
  
  if (imageTextDensity === 'none') {
    cleaned = cleaned
      .replace(/charts may use 1 to 2 short (?:Vietnamese|English|[A-Za-z]+) labels when useful/gi, 'charts with absolutely no labels or text')
      .replace(/with 1 to 2 short (?:Vietnamese|English|[A-Za-z]+) chalk phrases when useful/gi, 'without any text or chalk phrases')
      .replace(/1 to 2 short (?:Vietnamese|English|[A-Za-z]+) chalk phrases if useful/gi, 'no text or chalk phrases at all')
      .replace(/use 1 to 2 short (?:Vietnamese|English|[A-Za-z]+) handwritten phrases only when useful/gi, 'strictly do not write any phrases or text')
      .replace(/no English writing/gi, 'no writing of any kind, no text')
      .replace(/no English chart text/gi, 'no chart text or labels of any kind')
      .replace(/no dense writing or formulas/gi, 'no writing, no letters, no formulas')
      .replace(/no dense writing/gi, 'no writing, no text')
      .replace(/no dense text/gi, 'no text, no letters');
  } else if (imageTextDensity === 'low') {
    cleaned = cleaned
      .replace(/charts may use 1 to 2 short (?:Vietnamese|English|[A-Za-z]+) labels when useful/gi, `charts with at most 1 single very short ${language.name} word if absolutely necessary, otherwise no text`)
      .replace(/with 1 to 2 short (?:Vietnamese|English|[A-Za-z]+) chalk phrases when useful/gi, `with at most 1 very short ${language.name} chalk word only if essential, otherwise no text`)
      .replace(/1 to 2 short (?:Vietnamese|English|[A-Za-z]+) chalk phrases if useful/gi, `at most 1 very short ${language.name} chalk word only if essential`)
      .replace(/use 1 to 2 short (?:Vietnamese|English|[A-Za-z]+) handwritten phrases only when useful/gi, `strictly minimize text, use at most 1 single short ${language.name} word`);
  }
  return cleaned;
}

function buildSceneTextCue(videoLanguage, imageTextDensity = 'medium') {
  if (imageTextDensity === 'none') {
    return 'no readable text in the image, no letters, no words, no signs, no captions, no subtitles, no speech bubbles, no UI text';
  }
  const language = getImageTextLanguageConfig(videoLanguage);
  if (imageTextDensity === 'low') {
    return [
      `extremely minimal readable text, only if absolutely necessary for the setting (like a subtle sign or background element)`,
      `all readable text in the image must be in ${language.name}, ${language.avoid}, no pseudo-text, no gibberish lettering`,
      `limit to at most 1 short word or extremely brief phrase (maximum 1 to 3 words total) in ${language.name}`,
      `strictly avoid captions, subtitles, speech bubbles, book pages with text, blocks of text, paragraphs, or multiple signs/labels`,
      `keep the image clean, focusing entirely on visual elements, characters, action, and environment rather than written language`
    ].join(', ');
  }
  if (imageTextDensity === 'high') {
    return [
      `prominent and frequent readable text in ${language.name} across the scene (e.g. signs, charts, labels, screen UI, documents, or overlays)`,
      `all readable text in the image must be clearly written in ${language.name}, ${language.avoid}, no gibberish or fake symbols`,
      `include multiple relevant labels or headlines in ${language.name} (about 5 to 20 words total)`,
      `make sure the text is clean, readable, high-contrast, and integrated naturally into the environment or UI`,
      `avoid giant blocks of dense paragraphs or columns of text, keeping the writing structured as clear labels, signs, or charts`
    ].join(', ');
  }
  // Default to medium
  return [
    `balanced visual illustration with meaningful ${language.name} text only when it helps the scene`,
    `all readable text in the image must be ${language.name}, ${language.avoid}, no pseudo-text, no fake alphabet`,
    `include ${language.sceneExample}, clear and meaningful`,
    'avoid too little text when text would make the scene more attention-grabbing, but avoid too much text, paragraphs, captions, subtitles, narration boxes, speech bubbles, UI text, many small labels, repeated words, random letters, watermarks, logos, posters full of text, book pages full of text, or newspaper columns',
    `if the scene naturally includes screens, books, documents, posters, or signs but the writing is not central, keep only a small readable ${language.name} phrase and make the rest blank, abstract, blurred, or symbolic`,
    'the main story should still be communicated through characters, objects, environment, lighting, action, mood, and composition'
  ].join(', ');
}

function buildThumbnailTextCue(videoLanguage) {
  const language = getImageTextLanguageConfig(videoLanguage);
  return [
    `YouTube thumbnail design with bold readable ${language.thumbnailHeadline}`,
    'include one short main headline in large high-contrast typography, 2 to 7 words, easy to read on a phone screen',
    `${language.thumbnailInstruction} and placed inside the safe area with strong contrast from the background, ${language.avoid}`,
    'use dramatic visual illustration plus expressive subject, clean composition, no tiny paragraphs, no subtitles, no watermarks, no logos, no UI screenshots',
    'for thumbnail generation only, ignore any earlier instruction that forbids readable text or text overlays'
  ].join(', ');
}

function buildLanguageOverrideCue(videoLanguage, imageTextDensity = 'medium') {
  if (imageTextDensity === 'none') {
    return 'FINAL TEXT OVERRIDE: do not render readable text anywhere in the image, even if style instructions mention labels or headlines.';
  }
  if (imageTextDensity === 'low') {
    return 'FINAL TEXT OVERRIDE: strictly minimize text rendering, limit to at most 1 short word or very short phrase if absolutely required, otherwise no text.';
  }
  const language = getImageTextLanguageConfig(videoLanguage);
  return `FINAL TEXT LANGUAGE OVERRIDE: all readable text, labels, signs, charts, posters, screens, and headlines in this image must be ${language.name}; ${language.avoid}; ignore any earlier style instruction that asks for another written language.`;
}

function localizeStyleTextRules(text = '', videoLanguage = 'vi') {
  const language = getImageTextLanguageConfig(videoLanguage);
  if (videoLanguage === 'vi') return text;
  return String(text || '')
    .replace(/Vietnamese labels/gi, `${language.name} labels`)
    .replace(/Vietnamese chalk phrases/gi, `${language.name} chalk phrases`)
    .replace(/Vietnamese phrases/gi, `${language.name} phrases`)
    .replace(/Vietnamese text/gi, `${language.name} text`)
    .replace(/Vietnamese writing/gi, `${language.name} writing`)
    .replace(/Vietnamese words/gi, `${language.name} words`)
    .replace(/no English chart text/gi, 'no chart text in any other language')
    .replace(/no English writing/gi, 'no writing in any other language')
    .replace(/no English text/gi, 'no text in any other language')
    .replace(/no English words/gi, 'no words in any other language');
}

// Enrich bất kỳ imagePrompt nào với framing theo tỉ lệ, style detail và bg modifier.
// Áp dụng cho cả JSON input lẫn prompt AI-generated để đảm bảo nhất quán.
function buildEnrichedImagePrompt(basePrompt, imageStyle, aspectRatio, imageStylePrompt = '', options = {}) {
  const ratioConfig = getAspectRatioConfig(aspectRatio);
  const parts = [basePrompt.trim()];
  parts.push(ratioConfig.framingCue);
  parts.push(buildSceneTextCue(options.videoLanguage, options.imageTextDensity));
  let bgMod = STYLE_BG_MODIFIERS[imageStyle];
  if (bgMod) {
    if (aspectRatio === '9:16') {
      bgMod = getDefaultVerticalPrompt(bgMod);
    }
    const sanitizedBg = applyTextDensityToStyleText(bgMod, options.imageTextDensity, options.videoLanguage);
    parts.push(localizeStyleTextRules(sanitizedBg, options.videoLanguage));
  }
  let styleDetail = imageStylePrompt || STYLE_PROMPT_DETAIL[imageStyle];
  if (styleDetail) {
    if (aspectRatio === '9:16') {
      styleDetail = getDefaultVerticalPrompt(styleDetail);
    }
    const sanitizedStyle = applyTextDensityToStyleText(styleDetail, options.imageTextDensity, options.videoLanguage);
    parts.push(localizeStyleTextRules(sanitizedStyle, options.videoLanguage));
  }
  parts.push(buildLanguageOverrideCue(options.videoLanguage, options.imageTextDensity));
  return parts.join(', ');
}

function buildThumbnailImagePrompt(basePrompt, project, imageStyle, aspectRatio, imageStylePrompt = '', options = {}) {
  const ratioConfig = getAspectRatioConfig(aspectRatio);
  const title = String(project?.title || '').trim();
  const language = getImageTextLanguageConfig(options.videoLanguage || project?.settings?.videoLanguage);
  const headlineCue = title
    ? `Use the project title as inspiration for the headline; if it is too long, shorten it to a punchy ${language.name} headline: "${title.replace(/"/g, '\\"')}"`
    : `Create a punchy ${language.name} headline that summarizes the video topic`;
  const parts = [basePrompt.trim()];
  parts.push(`${ratioConfig.framingCue}, final thumbnail MUST use ${ratioConfig.value} aspect ratio (${ratioConfig.width}x${ratioConfig.height}), bold editorial thumbnail layout, subject and headline both clearly visible, safe margins on all four edges`);
  let bgMod = STYLE_BG_MODIFIERS[imageStyle];
  if (bgMod) {
    if (aspectRatio === '9:16') {
      bgMod = getDefaultVerticalPrompt(bgMod);
    }
    parts.push(localizeStyleTextRules(bgMod, options.videoLanguage || project?.settings?.videoLanguage));
  }
  let styleDetail = imageStylePrompt || STYLE_PROMPT_DETAIL[imageStyle];
  if (styleDetail) {
    if (aspectRatio === '9:16') {
      styleDetail = getDefaultVerticalPrompt(styleDetail);
    }
    
    // Relax chart-only or notebook-only rules for thumbnail generations
    const lowerStyle = styleDetail.toLowerCase();
    if (imageStyle === 'custom:richard-wyckoff' || lowerStyle.includes('wyckoff')) {
      styleDetail = styleDetail
        .replace(/create a FULL CHART POSTER ONLY/gi, 'create a character-centric scene')
        .replace(/Chart-only means poster fills the whole frame/gi, '')
        .replace(/Strict chart negatives: no book, notebook spread, desk, table, paper stack, lamp, hand, teacher, portrait, crowd, room background\./gi, '');
      styleDetail += ' Thumbnail Layout Rule: Ignore any "FULL CHART ONLY" or "no portrait/character/teacher" rules. The thumbnail MUST be a professional YouTube thumbnail layout. It must feature a large, sharp portrait of Richard Wyckoff (matching reference image, optionally grayscale) positioned prominently on the right side, left side, or center of the frame. The background must vary flexibly and look professional: EITHER a dark, high-contrast, moody charcoal black background showing a 1930s Wall Street trading floor with traders, OR a vintage cream aged paper background with retro market charts. Headline text must be in large, bold, high-contrast gold/yellow and white colors.';
    } else if (imageStyle === 'custom:huyen-thoai-au-tu-jesse-livermore' || lowerStyle.includes('livermore')) {
      styleDetail = styleDetail
        .replace(/create a FULL CHART or FULL NOTEBOOK STUDY PAGE as main subject/gi, 'create a character-centric scene')
        .replace(/Chart rule: if scene is about chart analysis, price action, tape-reading, market behavior, or a lesson through price movement, create a FULL CHART or FULL NOTEBOOK STUDY PAGE as main subject\./gi, '');
      styleDetail += ' Thumbnail Layout Rule: Ignore any "FULL CHART ONLY" or "no portrait/character" rules. The thumbnail MUST be a character-centric layout with Jesse Livermore (matching reference image) as the large main subject focused in the center of the frame, and a vintage trading board or chart in the background.';
    }

    parts.push(localizeStyleTextRules(styleDetail, options.videoLanguage || project?.settings?.videoLanguage));
  }
  parts.push(headlineCue);
  parts.push(buildThumbnailTextCue(options.videoLanguage || project?.settings?.videoLanguage));
  parts.push(buildLanguageOverrideCue(options.videoLanguage || project?.settings?.videoLanguage, 'medium'));
  return parts.join(', ');
}

async function generateImageWithClient(aiClient, prompt, refUrl, outputPath) {
  if (typeof aiClient.generateImageBuffer === 'function') {
    const buffer = await aiClient.generateImageBuffer(prompt, refUrl);
    if (buffer) {
      await fs.writeFile(outputPath, buffer);
      return null;
    }
  }
  const imageUrl = await aiClient.generateImage(prompt, refUrl);
  await downloadFile(imageUrl, outputPath);
  return imageUrl;
}

function getProjectAspectRatio(project, settings) {
  return project.settings?.aspectRatio || settings.aspectRatio;
}

function getImageSearchRuntimeSettings(project, settings) {
  const source = isVideoSearchSource(project.settings.imageSource) ? 'pexels' : project.settings.imageSource;
  return {
    ...settings,
    imageSource: source,
    videoLanguage: project.settings.videoLanguage || settings.videoLanguage
  };
}

function getSceneImageKeyword(project, scene) {
  return scene.imageKeyword || scene.imageSearchKeyword || scene.searchKeyword || scene.voiceText || project.title;
}

async function generateSceneSearchImage({ project, scene, settings, outputPath }) {
  const aspectRatio = getProjectAspectRatio(project, settings);
  const query = getSceneImageKeyword(project, scene);
  if (isDirectMediaSource(query)) {
    const candidatePath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.direct`);
    let result;
    try {
      result = await saveDirectMediaSource(query, candidatePath, {
        accept: 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8',
        expectedType: 'image'
      });
      await normalizeStillImageWithBlurredBackground(
        settings.ffmpegPath,
        candidatePath,
        outputPath,
        aspectRatio
      );
    } finally {
      await fs.unlink(candidatePath).catch(() => {});
    }
    return {
      outputPath,
      imageUrl: result.sourceUrl || '',
      imageSearch: {
        provider: 'direct-url',
        query,
        selected: result,
        failedCandidates: []
      }
    };
  }
  const result = await findAndDownloadImage({
    query,
    settings: getImageSearchRuntimeSettings(project, settings),
    outputPath,
    aspectRatio,
    validateDownloadedImage: (candidatePath) => normalizeStillImageWithBlurredBackground(
      settings.ffmpegPath,
      candidatePath,
      candidatePath,
      aspectRatio
    )
  });
  return {
    outputPath: result.outputPath,
    imageUrl: result.imageUrl,
    imageSearch: {
      provider: project.settings.imageSource,
      query,
      selected: result.candidate,
      failedCandidates: result.failedCandidates
    }
  };
}

function cleanPromptIfNoReferenceImage(prompt) {
  let cleaned = prompt;
  cleaned = cleaned.replace(/Use the provided .*? reference image as the identity anchor[.:]?/gi, '');
  cleaned = cleaned.replace(/Use the provided reference image as the identity anchor[.:]?/gi, '');
  cleaned = cleaned.replace(/Use the provided .*? character reference image[.:]?/gi, '');
  cleaned = cleaned.replace(/Use the provided .*? reference image[.:]?/gi, '');
  cleaned = cleaned.replace(/\s+/g, ' ');
  cleaned = cleaned.replace(/,\s*,/g, ',');
  cleaned = cleaned.replace(/\.\s*\./g, '.');
  cleaned = cleaned.replace(/\s*,\s*/g, ', ');
  cleaned = cleaned.replace(/\s*\.\s*/g, '. ');
  return cleaned.trim();
}

async function generateSceneAiImage({ chat01Client, project, scene, settings, outputPath }) {
  const enrichedPrompt = buildEnrichedImagePrompt(
    scene.imagePrompt,
    project.settings?.imageStyle,
    project.settings?.aspectRatio,
    project.settings?.imageStylePrompt,
    {
      videoLanguage: project.settings?.videoLanguage || settings.videoLanguage,
      imageTextDensity: project.settings?.imageTextDensity || settings.imageTextDensity
    }
  );
  let refUrl = '';
  if (scene.sceneReferenceImageUrl) {
    refUrl = scene.sceneReferenceImageUrl;
  } else if (typeof scene.useReferenceImage === 'string' && scene.useReferenceImage) {
    refUrl = scene.useReferenceImage;
  } else if (scene.useReferenceImage === true) {
    refUrl = settings.referenceImageUrl || '';
  }
  let finalPrompt = enrichedPrompt;
  if (!refUrl) {
    finalPrompt = cleanPromptIfNoReferenceImage(enrichedPrompt);
  }
  const imageUrl = await generateImageWithClient(chat01Client, finalPrompt, refUrl, outputPath);
  return { imageUrl, outputPath };
}

async function generateSceneImage({ chat01Client, project, scene, settings, sceneDir }) {
  const outputPath = path.join(sceneDir, 'image.png');
  if (isImageSearchSource(project.settings?.imageSource) || isDirectMediaMode(project.settings?.imageSource)) {
    return generateSceneSearchImage({ project, scene, settings, outputPath });
  }
  return generateSceneAiImage({ chat01Client, project, scene, settings, outputPath });
}

async function generateThumbnailSearchImage({ project, settings, outputPath }) {
  const aspectRatio = getProjectAspectRatio(project, settings);
  const result = await findAndDownloadImage({
    query: project.thumbnailKeyword || project.title,
    settings: getImageSearchRuntimeSettings(project, settings),
    outputPath,
    aspectRatio,
    validateDownloadedImage: (candidatePath) => normalizeStillImageWithBlurredBackground(
      settings.ffmpegPath,
      candidatePath,
      candidatePath,
      aspectRatio
    )
  });
  return {
    outputPath: result.outputPath,
    imageUrl: result.imageUrl,
    imageSearch: {
      selected: result.candidate,
      failedCandidates: result.failedCandidates
    }
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildStaticThumbnailHtml(project, settings, fontDataUrl = '') {
  const ratio = getAspectRatioConfig(project.settings?.aspectRatio || settings.aspectRatio);
  const language = getVideoLanguageConfig(project.settings?.videoLanguage || settings.videoLanguage);
  const direction = language.value === 'ar' ? 'rtl' : 'ltr';
  const title = String(project.title || 'Video').trim();
  const words = title.split(/\s+/).filter(Boolean);
  
  let headline = title;
  if (words.length > 14) {
    headline = words.slice(0, 14).join(' ') + '...';
  }
  
  let fontSizeMultiplier = 0.058;
  if (ratio.width < ratio.height) {
    fontSizeMultiplier = 0.072;
    if (headline.length > 50) fontSizeMultiplier = 0.05;
    else if (headline.length > 30) fontSizeMultiplier = 0.06;
  } else {
    if (headline.length > 60) fontSizeMultiplier = 0.04;
    else if (headline.length > 40) fontSizeMultiplier = 0.048;
  }
  
  const fontSize = Math.round(ratio.width * fontSizeMultiplier);
  const subSize = Math.round(ratio.width * 0.032);
  return `<!doctype html>
<html lang="${language.value}" dir="${direction}">
<head>
  <meta charset="utf-8">
  <style>
    ${fontDataUrl ? `@font-face { font-family: "${language.subtitleFontFamily}"; src: url("${fontDataUrl}"); }` : ''}
    * { box-sizing: border-box; }
    html, body { margin: 0; width: ${ratio.width}px; height: ${ratio.height}px; overflow: hidden; font-family: "${language.subtitleFontFamily}", Arial, sans-serif; background: #07111f; }
    .stage { position: relative; width: 100%; height: 100%; overflow: hidden; background:
      radial-gradient(circle at 20% 18%, rgba(250,204,21,.95) 0 8%, transparent 28%),
      radial-gradient(circle at 82% 28%, rgba(45,212,191,.8) 0 10%, transparent 30%),
      linear-gradient(135deg, #07111f 0%, #123047 52%, #312e81 100%); }
    .grid { position: absolute; inset: 0; opacity: .18; background-image: linear-gradient(rgba(255,255,255,.35) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.35) 1px, transparent 1px); background-size: 72px 72px; transform: rotate(-7deg) scale(1.2); }
    .panel { position: absolute; left: 7%; right: 7%; bottom: 10%; padding: ${Math.round(ratio.width * 0.045)}px; border-radius: 28px; background: rgba(3,7,18,.76); border: 3px solid rgba(255,255,255,.18); box-shadow: 0 28px 80px rgba(0,0,0,.4); }
    .badge { display: inline-block; padding: 12px 20px; border-radius: 999px; background: #facc15; color: #111827; font-size: ${Math.round(subSize * .85)}px; font-weight: 900; margin-bottom: 24px; }
    h1 { margin: 0; color: #fff; font-size: ${fontSize}px; line-height: 1.12; letter-spacing: 0; text-wrap: balance; text-shadow: 0 8px 0 rgba(0,0,0,.2); }
    p { margin: 22px 0 0; color: rgba(255,255,255,.82); font-size: ${subSize}px; line-height: 1.35; max-width: 88%; }
    .slash { position: absolute; width: 34%; height: 130%; top: -15%; right: -8%; background: rgba(255,255,255,.12); transform: rotate(14deg); border-left: 3px solid rgba(255,255,255,.25); }
  </style>
</head>
<body>
  <div class="stage">
    <div class="grid"></div>
    <div class="slash"></div>
    <div class="panel">
      <div class="badge">${escapeHtml(language.videoLabel)}</div>
      <h1>${escapeHtml(headline)}</h1>
    </div>
  </div>
</body>
</html>`;
}

async function generateThumbnailStaticHtmlImage({ project, settings, outputPath }) {
  const language = getVideoLanguageConfig(project.settings?.videoLanguage || settings.videoLanguage);
  const font = SUBTITLE_FONT_OPTIONS.find((option) => option.value === language.subtitleFontFamily);
  const fontDataUrl = font
    ? `data:font/${path.extname(font.file).slice(1)};base64,${(await fs.readFile(path.join(ASSETS_DIR, 'fonts', font.file))).toString('base64')}`
    : '';
  await renderStaticHtmlToImage({
    html: buildStaticThumbnailHtml(project, settings, fontDataUrl),
    outputPath,
    aspectRatio: project.settings?.aspectRatio || settings.aspectRatio
  });
  return { outputPath, imageUrl: null, fallback: 'static-html' };
}

async function generateThumbnailAiImage({ chat01Client, project, settings, outputPath, targetAspectRatio, targetPrompt }) {
  const finalAspectRatio = targetAspectRatio || project.settings?.aspectRatio || '16:9';
  const basePrompt = targetPrompt
    || project.thumbnailPrompt
    || (project.thumbnailKeyword ? `Create a clean ${project.settings?.aspectRatio || '16:9'} video thumbnail using this visual idea: ${project.thumbnailKeyword}` : '')
    || `Create a clean ${project.settings?.aspectRatio || '16:9'} video thumbnail for: ${project.title}`;
  const enrichedPrompt = buildThumbnailImagePrompt(
    basePrompt,
    project,
    project.settings?.imageStyle,
    finalAspectRatio,
    project.settings?.imageStylePrompt,
    {
      videoLanguage: project.settings?.videoLanguage || settings.videoLanguage
    }
  );
  const refUrl = settings.referenceImageUrl || '';
  let finalPrompt = enrichedPrompt;
  if (!refUrl) {
    finalPrompt = cleanPromptIfNoReferenceImage(enrichedPrompt);
  }
  const imageUrl = await generateImageWithClient(chat01Client, finalPrompt, refUrl, outputPath);
  return { imageUrl, outputPath };
}

async function generateThumbnailImage({ chat01Client, project, settings, outputPath, targetAspectRatio, targetPrompt }) {
  return generateThumbnailAiImage({ chat01Client, project, settings, outputPath, targetAspectRatio, targetPrompt });
}

async function generateThumbnailFallbackImage({ project, settings, outputPath }) {
  if (isImageSearchSource(project.settings?.imageSource) || isVideoSearchSource(project.settings?.imageSource)) {
    try {
      return await generateThumbnailSearchImage({ project, settings, outputPath });
    } catch {}
  }
  return generateThumbnailStaticHtmlImage({ project, settings, outputPath });
}

module.exports = {
  generateSceneImage,
  generateThumbnailImage,
  generateThumbnailFallbackImage,
  buildEnrichedImagePrompt,
  buildThumbnailImagePrompt,
  downloadFile
};
