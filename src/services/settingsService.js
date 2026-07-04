const fs = require('fs/promises');
const path = require('path');
const {
  ASSETS_DIR,
  STORAGE_DIR,
  PROJECTS_DIR,
  TMP_DIR,
  OMNIVOICE_VOICES_DIR,
  SETTINGS_FILE,
  HISTORY_FILE,
  CUSTOM_STYLES_FILE,
  DEFAULT_APP_SETTINGS,
  STYLE_OPTIONS,
  STYLE_PROMPT_DETAIL,
  MOTION_OPTIONS,
  VIDEO_LANGUAGE_OPTIONS,
  IMAGE_TEXT_DENSITY_OPTIONS,
  AI_PROVIDER_OPTIONS,
  IMAGE_SOURCE_OPTIONS,
  FLOW_IMAGE_MODEL_OPTIONS,
  FLOW_VIDEO_MODEL_OPTIONS,
  FLOW_VIDEO_DURATION_OPTIONS,
  IMAGE_GENERATION_PROVIDER_OPTIONS,
  HTML_GENERATION_PROVIDER_OPTIONS,
  TTS_PROVIDER_OPTIONS,
  SUBTITLE_FONT_OPTIONS,
  SUBTITLE_EFFECT_OPTIONS,
  SUBTITLE_TEXT_CASE_OPTIONS,
  TRANSITION_OPTIONS,
  normalizeAspectRatio
} = require('../config/constants');
const { ensureDir, readJson, writeJson } = require('../lib/fs');
const { getSafeSubtitleFont, isOmniVoiceDefaultVoiceId } = require('../config/languages');

const WORKSPACE_SETTINGS_DIR = path.join(STORAGE_DIR, 'workspace-settings');

function normalizeWorkspaceId(workspaceId = '') {
  const normalized = String(workspaceId || '').trim();
  return /^[a-zA-Z0-9_-]{8,80}$/.test(normalized) ? normalized : '';
}

function getSettingsFile(workspaceId = '') {
  return SETTINGS_FILE;
}

async function ensureAppDirectories() {
  await Promise.all([
    ensureDir(STORAGE_DIR),
    ensureDir(PROJECTS_DIR),
    ensureDir(TMP_DIR),
    ensureDir(OMNIVOICE_VOICES_DIR),
    ensureDir(WORKSPACE_SETTINGS_DIR)
  ]);

  const settings = await readJson(SETTINGS_FILE, null);
  if (!settings) {
    const defaultSettingsPath = path.join(ASSETS_DIR, 'default-settings.json');
    let baseSettings = null;
    try {
      const content = await fs.readFile(defaultSettingsPath, 'utf8');
      baseSettings = JSON.parse(content);
    } catch {
      baseSettings = sanitizeSettings(await withBundledHtmlMedia(DEFAULT_APP_SETTINGS));
    }

    if (baseSettings && Array.isArray(baseSettings.omnivoiceVoices)) {
      const defaultVoicesSourceDir = path.join(ASSETS_DIR, 'default-voices');
      const files = await fs.readdir(defaultVoicesSourceDir).catch(() => []);
      for (const file of files) {
        const srcFile = path.join(defaultVoicesSourceDir, file);
        const destFile = path.join(OMNIVOICE_VOICES_DIR, file);
        await fs.copyFile(srcFile, destFile).catch(() => {});
      }
      baseSettings.omnivoiceVoices.forEach(voice => {
        voice.refAudioPath = path.join(OMNIVOICE_VOICES_DIR, voice.refAudioPath);
      });
    }
    await writeJson(SETTINGS_FILE, baseSettings);
  }

  const history = await readJson(HISTORY_FILE, null);
  if (!history) {
    await writeJson(HISTORY_FILE, { projects: [] });
  }

  const customStyles = await readJson(CUSTOM_STYLES_FILE, null);
  if (!customStyles) {
    await writeJson(CUSTOM_STYLES_FILE, { styles: [], deletedValues: [] });
  }
}

function mediaKindFromFileName(fileName = '') {
  const lower = String(fileName || '').toLowerCase();
  if (/\.(mp3|wav|m4a|aac|ogg)$/i.test(lower)) return 'audio';
  if (/\.(png|jpe?g|webp|gif|avif|svg)$/i.test(lower)) return 'image';
  if (/\.(mp4|mov|m4v|webm)$/i.test(lower)) return 'video';
  return 'file';
}

function describeBundledMedia(fileName = '') {
  return path.basename(fileName, path.extname(fileName))
    .replace(/^\d+(?:-\d+)?-/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function readBundledHtmlSfxList() {
  const dir = path.join(ASSETS_DIR, 'html-default-media', 'sfx');
  const files = await fs.readdir(dir).catch(() => []);
  return files
    .filter((fileName) => !fileName.startsWith('.'))
    .sort((a, b) => a.localeCompare(b, 'vi'))
    .map((fileName) => {
      const type = mediaKindFromFileName(fileName);
      return {
        id: `bundled-sfx-${fileName}`,
        scope: 'global',
        role: 'sound-effect',
        type,
        originalName: fileName.replace(/^\d+(?:-\d+)?-/g, ''),
        fileName,
        description: describeBundledMedia(fileName),
        mimeType: '',
        path: path.join(dir, fileName),
        width: null,
        height: null,
        durationSec: null
      };
    });
}

async function withBundledHtmlMedia(settings) {
  const htmlDefaultSfx = await readBundledHtmlSfxList();
  const customSfx = (Array.isArray(settings?.htmlDefaultSfx) ? settings.htmlDefaultSfx : [])
    .filter((item) => !String(item?.id || '').startsWith('bundled-sfx-'));
  return {
    ...settings,
    htmlDefaultSfx: [...htmlDefaultSfx, ...customSfx]
  };
}

async function getSettings(workspaceId = '') {
  await ensureAppDirectories();
  const workspaceFile = getSettingsFile(workspaceId);
  const saved = await readJson(workspaceFile, null);
  if (!saved && workspaceFile !== SETTINGS_FILE) {
    const globalSettings = await readJson(SETTINGS_FILE, DEFAULT_APP_SETTINGS);
    return sanitizeSettings(await withBundledHtmlMedia(globalSettings || {}));
  }
  return sanitizeSettings(await withBundledHtmlMedia(saved || {}));
}

async function saveSettings(partialSettings, workspaceId = '') {
  const current = await getSettings(workspaceId);
  const next = sanitizeSettings(await withBundledHtmlMedia({ ...current, ...(partialSettings || {}) }));
  await writeJson(getSettingsFile(workspaceId), next);
  return next;
}

function sanitizeSettings(input) {
  const merged = { ...DEFAULT_APP_SETTINGS, ...(input || {}) };
  const allowed = Object.keys(DEFAULT_APP_SETTINGS);
  const next = Object.fromEntries(allowed.map((key) => [key, merged[key]]));
  const forceBundledTools = process.env.VIBE_TOOL_FORCE_BUNDLED_TOOLS === '1';
  if (process.env.VIBE_TOOL_FFMPEG_PATH && (forceBundledTools || !input?.ffmpegPath || input.ffmpegPath === 'ffmpeg')) {
    next.ffmpegPath = process.env.VIBE_TOOL_FFMPEG_PATH;
  }
  if (process.env.VIBE_TOOL_FFPROBE_PATH && (forceBundledTools || !input?.ffprobePath || input.ffprobePath === 'ffprobe')) {
    next.ffprobePath = process.env.VIBE_TOOL_FFPROBE_PATH;
  }
  const aiProviderValues = new Set(AI_PROVIDER_OPTIONS.map((provider) => provider.value));
  next.apiProvider = aiProviderValues.has(next.apiProvider) ? next.apiProvider : DEFAULT_APP_SETTINGS.apiProvider;
  const imageSourceValues = new Set([
    ...IMAGE_SOURCE_OPTIONS.map((provider) => provider.value),
    ...HTML_GENERATION_PROVIDER_OPTIONS.map((provider) => `html:${provider.value}`)
  ]);
  next.imageSource = imageSourceValues.has(next.imageSource) ? next.imageSource : DEFAULT_APP_SETTINGS.imageSource;
  const imageGenerationProviderValues = new Set(IMAGE_GENERATION_PROVIDER_OPTIONS.map((provider) => provider.value));
  next.imageGenerationProvider = imageGenerationProviderValues.has(next.imageGenerationProvider)
    ? next.imageGenerationProvider
    : DEFAULT_APP_SETTINGS.imageGenerationProvider;
  next.thumbnailImageProvider = imageGenerationProviderValues.has(next.thumbnailImageProvider)
    ? next.thumbnailImageProvider
    : DEFAULT_APP_SETTINGS.thumbnailImageProvider;
  const ttsProviderValues = new Set(TTS_PROVIDER_OPTIONS.map((provider) => provider.value));
  next.ttsProvider = ttsProviderValues.has(next.ttsProvider) ? next.ttsProvider : DEFAULT_APP_SETTINGS.ttsProvider;
  next.aiModel = String(next.aiModel || '').trim().slice(0, 120);
  next.imageModel = String(next.imageModel || '').trim().slice(0, 120);
  next.flowApiBaseUrl = sanitizeHttpBaseUrl(next.flowApiBaseUrl) || DEFAULT_APP_SETTINGS.flowApiBaseUrl;
  const flowImageModelValues = new Set(FLOW_IMAGE_MODEL_OPTIONS.map((option) => option.value));
  next.flowImageModel = flowImageModelValues.has(next.flowImageModel)
    ? next.flowImageModel
    : DEFAULT_APP_SETTINGS.flowImageModel;
  const flowVideoModelValues = new Set(FLOW_VIDEO_MODEL_OPTIONS.map((option) => option.value));
  next.flowVideoModel = flowVideoModelValues.has(next.flowVideoModel)
    ? next.flowVideoModel
    : DEFAULT_APP_SETTINGS.flowVideoModel;
  const flowVideoDurations = new Set(FLOW_VIDEO_DURATION_OPTIONS.map((option) => Number(option.value)));
  const flowDuration = Number(next.flowVideoDurationSec);
  next.flowVideoDurationSec = flowVideoDurations.has(flowDuration)
    ? flowDuration
    : DEFAULT_APP_SETTINGS.flowVideoDurationSec;
  next.flowRequestTimeoutMs = normalizeInteger(next.flowRequestTimeoutMs, DEFAULT_APP_SETTINGS.flowRequestTimeoutMs, 5000, 1800000);
  next.flowGenerationTimeoutMs = normalizeInteger(next.flowGenerationTimeoutMs, DEFAULT_APP_SETTINGS.flowGenerationTimeoutMs, 30000, 3600000);
  next.flowPollIntervalMs = normalizeInteger(next.flowPollIntervalMs, DEFAULT_APP_SETTINGS.flowPollIntervalMs, 1000, 30000);
  next.flowAuthRetryIntervalMs = normalizeInteger(next.flowAuthRetryIntervalMs, DEFAULT_APP_SETTINGS.flowAuthRetryIntervalMs, 5000, 300000);
  next.flowAuthMaxWaitMs = normalizeInteger(next.flowAuthMaxWaitMs, DEFAULT_APP_SETTINGS.flowAuthMaxWaitMs, 60000, 60000);
  next.flowUnusualActivityMaxWaitMs = normalizeInteger(next.flowUnusualActivityMaxWaitMs, DEFAULT_APP_SETTINGS.flowUnusualActivityMaxWaitMs, 0, 60000);
  next.customApiStandard = ['openai', 'openai-responses', 'claude', 'gemini'].includes(next.customApiStandard)
    ? next.customApiStandard
    : DEFAULT_APP_SETTINGS.customApiStandard;
  next.customApiBaseUrl = sanitizeHttpBaseUrl(next.customApiBaseUrl);
  next.nineRouterBaseUrl = sanitizeHttpBaseUrl(next.nineRouterBaseUrl) || DEFAULT_APP_SETTINGS.nineRouterBaseUrl;
  next.claudeMaxTokens = normalizeInteger(
    next.claudeMaxTokens,
    DEFAULT_APP_SETTINGS.claudeMaxTokens,
    1024,
    128000
  );
  next.htmlConcurrency = normalizeInteger(next.htmlConcurrency, DEFAULT_APP_SETTINGS.htmlConcurrency, 1, 5);
  next.renderConcurrency = normalizeInteger(next.renderConcurrency, DEFAULT_APP_SETTINGS.renderConcurrency, 1, 8);
  next.projectConcurrency = normalizeInteger(next.projectConcurrency, DEFAULT_APP_SETTINGS.projectConcurrency || 1, 1, 4);
  const presetValues = new Set(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium']);
  next.renderPreset = presetValues.has(next.renderPreset) ? next.renderPreset : DEFAULT_APP_SETTINGS.renderPreset;
  const languageValues = new Set(VIDEO_LANGUAGE_OPTIONS.map((language) => language.value));
  next.videoLanguage = languageValues.has(next.videoLanguage) ? next.videoLanguage : DEFAULT_APP_SETTINGS.videoLanguage;
  next.aspectRatio = normalizeAspectRatio(next.aspectRatio);
  const densityValues = new Set(IMAGE_TEXT_DENSITY_OPTIONS.map((density) => density.value));
  next.imageTextDensity = densityValues.has(next.imageTextDensity) ? next.imageTextDensity : DEFAULT_APP_SETTINGS.imageTextDensity;
  next.larvoiceVoiceId = String(next.larvoiceVoiceId || '1');
  next.larvoiceKeysText = String(next.larvoiceKeysText || next.larvoiceApiKey || '').trim();
  next.larvoiceApiKey = String(next.larvoiceApiKey || '').trim();
  next.ttsVoiceId = String(next.ttsVoiceId || '').trim().slice(0, 160);
  next.vbeeAppId = String(next.vbeeAppId || '').trim().slice(0, 220);
  next.omnivoiceApiBaseUrl = sanitizeHttpBaseUrl(next.omnivoiceApiBaseUrl) || DEFAULT_APP_SETTINGS.omnivoiceApiBaseUrl;
  next.omnivoiceVoices = sanitizeOmniVoiceVoices(next.omnivoiceVoices);
  next.omnivoiceVoiceId = sanitizeOmniVoiceVoiceId(next.omnivoiceVoiceId, next.omnivoiceVoices);
  next.omnivoiceInstruct = String(next.omnivoiceInstruct || '').trim().slice(0, 300);
  next.omnivoiceNumStep = normalizeInteger(next.omnivoiceNumStep, DEFAULT_APP_SETTINGS.omnivoiceNumStep, 8, 64);
  next.omnivoiceChunkDurationSec = normalizeNullableNumber(
    next.omnivoiceChunkDurationSec,
    DEFAULT_APP_SETTINGS.omnivoiceChunkDurationSec,
    2,
    15
  );
  next.omnivoiceChunkThresholdSec = normalizeNullableNumber(
    next.omnivoiceChunkThresholdSec,
    DEFAULT_APP_SETTINGS.omnivoiceChunkThresholdSec,
    0,
    30
  );
  next.elevenlabsModelId = String(next.elevenlabsModelId || DEFAULT_APP_SETTINGS.elevenlabsModelId).trim().slice(0, 120);
  next.elevenlabsLanguageCode = String(next.elevenlabsLanguageCode || '').trim().slice(0, 40);
  next.elevenlabsOutputFormat = String(next.elevenlabsOutputFormat || DEFAULT_APP_SETTINGS.elevenlabsOutputFormat).trim().slice(0, 80);
  next.elevenlabsStability = normalizeNullableNumber(next.elevenlabsStability, DEFAULT_APP_SETTINGS.elevenlabsStability, 0, 1);
  next.elevenlabsSimilarityBoost = normalizeNullableNumber(next.elevenlabsSimilarityBoost, DEFAULT_APP_SETTINGS.elevenlabsSimilarityBoost, 0, 1);
  next.elevenlabsStyle = normalizeNullableNumber(next.elevenlabsStyle, DEFAULT_APP_SETTINGS.elevenlabsStyle, 0, 1);
  next.elevenlabsUseSpeakerBoost = Boolean(next.elevenlabsUseSpeakerBoost);
  next.vbeeCallbackUrl = String(next.vbeeCallbackUrl || DEFAULT_APP_SETTINGS.vbeeCallbackUrl).trim().slice(0, 300);
  next.vbeeAudioType = String(next.vbeeAudioType || 'mp3').toLowerCase() === 'wav' ? 'wav' : 'mp3';
  next.vbeeBitrate = normalizeInteger(next.vbeeBitrate, DEFAULT_APP_SETTINGS.vbeeBitrate, 32, 320);
  next.vbeeSampleRate = next.vbeeSampleRate === '' ? '' : normalizeInteger(next.vbeeSampleRate, '', 8000, 96000);
  next.vbeeEmphasisIntensity = next.vbeeEmphasisIntensity === '' ? '' : normalizeNullableNumber(next.vbeeEmphasisIntensity, '', 0, 2);
  const voiceSpeed = Number(next.voiceSpeed || 1.0);
  next.voiceSpeed = [0.9, 1.0, 1.1].includes(voiceSpeed) ? voiceSpeed : 1.0;
  next.musicVolume = normalizeNullableNumber(next.musicVolume, DEFAULT_APP_SETTINGS.musicVolume, 0, 1);
  next.htmlSfxVolume = normalizeNullableNumber(next.htmlSfxVolume, DEFAULT_APP_SETTINGS.htmlSfxVolume, 0, 1);
  const motionValues = new Set(MOTION_OPTIONS.map((option) => option.value));
  next.motionPreset = motionValues.has(next.motionPreset)
    ? next.motionPreset
    : DEFAULT_APP_SETTINGS.motionPreset;
  const transitionValues = new Set(TRANSITION_OPTIONS.map((option) => option.value));
  next.transitionPreset = transitionValues.has(next.transitionPreset)
    ? next.transitionPreset
    : DEFAULT_APP_SETTINGS.transitionPreset;
  next.generateThumbnailEnabled = Boolean(next.generateThumbnailEnabled);
  next.generateSeoEnabled = Boolean(next.generateSeoEnabled);
  next.subtitleEnabled = Boolean(next.subtitleEnabled);
  const fontValues = new Set(SUBTITLE_FONT_OPTIONS.map((font) => font.value));
  next.subtitleFontFamily = fontValues.has(next.subtitleFontFamily) ? next.subtitleFontFamily : DEFAULT_APP_SETTINGS.subtitleFontFamily;
  next.subtitleFontFamily = getSafeSubtitleFont(next.videoLanguage, next.subtitleFontFamily);
  const effectValues = new Set(SUBTITLE_EFFECT_OPTIONS.map((effect) => effect.value));
  next.subtitleEffect = effectValues.has(next.subtitleEffect) ? next.subtitleEffect : DEFAULT_APP_SETTINGS.subtitleEffect;
  const textCaseValues = new Set(SUBTITLE_TEXT_CASE_OPTIONS.map((option) => option.value));
  next.subtitleTextCase = textCaseValues.has(next.subtitleTextCase) ? next.subtitleTextCase : DEFAULT_APP_SETTINGS.subtitleTextCase;
  next.subtitleColor = /^#[0-9a-fA-F]{6}$/.test(String(next.subtitleColor || ''))
    ? String(next.subtitleColor).toLowerCase()
    : DEFAULT_APP_SETTINGS.subtitleColor;
  next.subtitleHighlightColor = /^#[0-9a-fA-F]{6}$/.test(String(next.subtitleHighlightColor || ''))
    ? String(next.subtitleHighlightColor).toLowerCase()
    : DEFAULT_APP_SETTINGS.subtitleHighlightColor;
  next.subtitleMaxWordsPerLine = normalizeInteger(
    next.subtitleMaxWordsPerLine,
    DEFAULT_APP_SETTINGS.subtitleMaxWordsPerLine,
    1,
    10
  );
  const legacyPositionY = { top: 14, middle: 50, bottom: 86 }[next.subtitlePosition];
  const positionY = Number(next.subtitlePositionY ?? legacyPositionY ?? DEFAULT_APP_SETTINGS.subtitlePositionY);
  next.subtitlePositionY = Math.min(94, Math.max(6, Number.isFinite(positionY) ? positionY : DEFAULT_APP_SETTINGS.subtitlePositionY));
  delete next.subtitlePosition;
  const fontScale = Number(next.subtitleFontScale ?? 1);
  next.subtitleFontScale = Math.min(2.4, Math.max(0.7, Number.isFinite(fontScale) ? fontScale : 1));
  next.subtitleOpacity = normalizeNullableNumber(next.subtitleOpacity, DEFAULT_APP_SETTINGS.subtitleOpacity, 0.1, 1);
  next.logoSize = normalizeInteger(next.logoSize, DEFAULT_APP_SETTINGS.logoSize, 40, 360);
  next.logoPosition = ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(next.logoPosition)
    ? next.logoPosition
    : DEFAULT_APP_SETTINGS.logoPosition;
  next.logoOpacity = normalizeNullableNumber(next.logoOpacity, DEFAULT_APP_SETTINGS.logoOpacity, 0.1, 1);
  next.pexelsExcludedVideoUrlsText = sanitizePexelsVideoUrls(next.pexelsExcludedVideoUrlsText);
  next.htmlDefaultSfx = sanitizeHtmlMediaSettingsList(next.htmlDefaultSfx, 'sound-effect');
  next.htmlBrandAssets = sanitizeHtmlMediaSettingsList(next.htmlBrandAssets, 'brand-asset');
  next.htmlMaxGenerationAttempts = normalizeInteger(
    next.htmlMaxGenerationAttempts,
    DEFAULT_APP_SETTINGS.htmlMaxGenerationAttempts,
    0,
    100
  );
  return next;
}

function sanitizeHttpBaseUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    const loopbackIpv4Host = ['127', '0', '0', '1'].join('.');
    if (url.hostname === 'localhost') {
      url.hostname = loopbackIpv4Host;
    }
    const pathname = url.pathname === '/' ? '' : url.pathname;
    return `${url.protocol}//${url.host}${pathname}${url.search}${url.hash}`.slice(0, 500);
  } catch {
    return '';
  }
}

function isPathInside(parentDir, childPath) {
  const parent = path.resolve(parentDir);
  const child = path.resolve(String(childPath || ''));
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function sanitizeOmniVoiceVoices(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => {
      const id = String(item?.id || '').trim();
      const name = String(item?.name || '').trim().slice(0, 80);
      const refAudioPath = String(item?.refAudioPath || '').trim();
      if (!/^[a-f0-9]{16,32}$/i.test(id) || !name || !refAudioPath || !isPathInside(OMNIVOICE_VOICES_DIR, refAudioPath)) {
        return null;
      }
      return {
        id,
        name,
        refAudioPath,
        refText: String(item?.refText || '').trim().slice(0, 2000),
        originalName: String(item?.originalName || '').trim().slice(0, 160),
        createdAt: String(item?.createdAt || new Date().toISOString())
      };
    })
    .filter(Boolean)
    .slice(0, 100);
}

function sanitizeOmniVoiceVoiceId(value, voices) {
  const id = String(value || '').trim();
  if (isOmniVoiceDefaultVoiceId(id)) return id;
  return voices.some((voice) => voice.id === id) ? id : '';
}

function sanitizePexelsVideoUrls(value) {
  return [...new Set(
    String(value || '')
      .split(/\r?\n/)
      .map((url) => url.trim())
      .filter((url) => {
        try {
          const parsed = new URL(url);
          const hostname = parsed.hostname.toLowerCase();
          const path = parsed.pathname.replace(/\/+$/, '');
          const hasVideoId = /\/video-files\/\d+(?:\/|$)/i.test(parsed.pathname)
            || (parsed.pathname.toLowerCase().includes('/video/') && /(?:-|\/)\d+$/.test(path));
          return ['http:', 'https:'].includes(parsed.protocol)
            && (hostname === 'pexels.com' || hostname.endsWith('.pexels.com'))
            && hasVideoId;
        } catch {
          return false;
        }
      })
  )].slice(0, 1000).join('\n');
}

function sanitizeHtmlMediaSettingsList(list, role) {
  return (Array.isArray(list) ? list : [])
    .filter((item) => item?.path)
    .slice(0, 200)
    .map((item) => ({
      id: String(item.id || ''),
      scope: 'global',
      role,
      type: String(item.type || 'file').slice(0, 30),
      originalName: String(item.originalName || item.fileName || '').slice(0, 220),
      fileName: String(item.fileName || '').slice(0, 220),
      description: String(item.description || item.originalName || item.fileName || '').slice(0, 220),
      mimeType: String(item.mimeType || '').slice(0, 120),
      path: String(item.path || ''),
      width: item.width ? Number(item.width) || null : null,
      height: item.height ? Number(item.height) || null : null,
      durationSec: item.durationSec ? Number(item.durationSec) || null : null
    }));
}

function normalizeNullableNumber(value, fallback, min, max) {
  if (value === '') return '';
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function normalizeInteger(value, fallback, min, max) {
  if (value === '') return '';
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function normalizeStyleName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

function normalizeStylePrompt(prompt) {
  return String(prompt || '').trim().replace(/\s+/g, ' ').slice(0, 2500);
}

function slugifyStyleName(name) {
  const ascii = String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return ascii || `style-${Date.now()}`;
}

async function readStyleStore() {
  await ensureAppDirectories();
  const payload = await readJson(CUSTOM_STYLES_FILE, { styles: [], deletedValues: [] });
  return {
    styles: Array.isArray(payload.styles) ? payload.styles : [],
    deletedValues: Array.isArray(payload.deletedValues) ? payload.deletedValues.map(String) : []
  };
}

function getBuiltInStylePrompt(value) {
  return STYLE_PROMPT_DETAIL[value] || value;
}

function toStoredStyle(style, fallback = {}) {
  return {
    value: String(style.value),
    label: String(style.label || fallback.label || style.value),
    prompt: String(style.prompt || fallback.prompt || ''),
    custom: !STYLE_OPTIONS.some((item) => item.value === style.value),
    builtIn: STYLE_OPTIONS.some((item) => item.value === style.value),
    createdAt: style.createdAt || fallback.createdAt || null,
    updatedAt: style.updatedAt || style.createdAt || fallback.updatedAt || null
  };
}

async function listCustomStyles() {
  const { styles, deletedValues } = await readStyleStore();
  const deleted = new Set(deletedValues);
  return styles
    .filter((style) => style?.value && style?.label && style?.prompt)
    .filter((style) => !deleted.has(String(style.value)))
    .map((style) => toStoredStyle(style));
}

async function listImageStyles() {
  const { styles, deletedValues } = await readStyleStore();
  const deleted = new Set(deletedValues);
  const storedByValue = new Map(
    styles
      .filter((style) => style?.value && style?.label && style?.prompt)
      .map((style) => [String(style.value), style])
  );

  const builtInStyles = STYLE_OPTIONS
    .filter((style) => !deleted.has(style.value))
    .map((style) => {
      const stored = storedByValue.get(style.value);
      return {
        value: style.value,
        label: stored?.label || style.label,
        prompt: stored?.prompt || getBuiltInStylePrompt(style.value),
        custom: false,
        builtIn: true,
        modified: Boolean(stored),
        createdAt: stored?.createdAt || null,
        updatedAt: stored?.updatedAt || stored?.createdAt || null
      };
    });

  const customStyles = styles
    .filter((style) => style?.value && style?.label && style?.prompt)
    .filter((style) => !STYLE_OPTIONS.some((item) => item.value === style.value))
    .filter((style) => !deleted.has(String(style.value)))
    .map((style) => toStoredStyle(style));

  return [...builtInStyles, ...customStyles];
}

async function saveCustomStyle(input = {}) {
  await ensureAppDirectories();
  const label = normalizeStyleName(input.label || input.name);
  const prompt = normalizeStylePrompt(input.prompt);
  if (!label) {
    throw new Error('Tên phong cách không được để trống');
  }
  if (!prompt) {
    throw new Error('Mô tả phong cách không được để trống');
  }

  const { styles, deletedValues } = await readStyleStore();
  const availableValues = new Set((await listImageStyles()).map((style) => style.value));
  const rawValue = String(input.value || '');
  const value = rawValue && rawValue !== '__new__' && availableValues.has(rawValue)
    ? rawValue
    : `custom:${slugifyStyleName(label)}`;
  const now = new Date().toISOString();
  const index = styles.findIndex((style) => style.value === value);
  const nextStyle = {
    value,
    label,
    prompt,
    custom: !STYLE_OPTIONS.some((style) => style.value === value),
    builtIn: STYLE_OPTIONS.some((style) => style.value === value),
    createdAt: index >= 0 ? styles[index].createdAt || now : now,
    updatedAt: now
  };
  if (index >= 0) {
    styles[index] = nextStyle;
  } else {
    let suffix = 2;
    while (styles.some((style) => style.value === nextStyle.value)) {
      nextStyle.value = `${value}-${suffix}`;
      suffix += 1;
    }
    styles.push(nextStyle);
  }
  await writeJson(CUSTOM_STYLES_FILE, {
    styles,
    deletedValues: deletedValues.filter((item) => item !== nextStyle.value)
  });
  return nextStyle;
}

async function deleteCustomStyle(value) {
  await ensureAppDirectories();
  const normalizedValue = String(value || '');
  const { styles, deletedValues } = await readStyleStore();
  const builtInValues = new Set(STYLE_OPTIONS.map((style) => style.value));
  if (builtInValues.has(normalizedValue)) {
    await writeJson(CUSTOM_STYLES_FILE, {
      styles: styles.filter((style) => style.value !== normalizedValue),
      deletedValues: Array.from(new Set([...deletedValues, normalizedValue]))
    });
  } else {
    const nextStyles = styles.filter((style) => style.value !== normalizedValue);
    if (nextStyles.length === styles.length) {
      throw new Error('Không tìm thấy phong cách ảnh');
    }
    await writeJson(CUSTOM_STYLES_FILE, { styles: nextStyles, deletedValues });
  }

  const settings = await getSettings();
  if (settings.imageStyle === normalizedValue) {
    const remainingStyles = await listImageStyles();
    await saveSettings({ imageStyle: remainingStyles[0]?.value || DEFAULT_APP_SETTINGS.imageStyle });
  }
}

async function resolveImageStyle(value) {
  const normalizedValue = String(value || DEFAULT_APP_SETTINGS.imageStyle);
  const styles = await listImageStyles();
  return styles.find((style) => style.value === normalizedValue)
    || styles.find((style) => style.value === DEFAULT_APP_SETTINGS.imageStyle)
    || {
      ...STYLE_OPTIONS.find((style) => style.value === DEFAULT_APP_SETTINGS.imageStyle),
      prompt: getBuiltInStylePrompt(DEFAULT_APP_SETTINGS.imageStyle),
      custom: false,
      builtIn: true
    };
}

async function readProjectLogs(projectDir) {
  try {
    const raw = await fs.readFile(`${projectDir}/logs.ndjson`, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

module.exports = {
  ensureAppDirectories,
  getSettings,
  saveSettings,
  listImageStyles,
  listCustomStyles,
  saveCustomStyle,
  deleteCustomStyle,
  resolveImageStyle,
  readProjectLogs
};
