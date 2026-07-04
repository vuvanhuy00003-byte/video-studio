const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const {
  MOTION_OPTIONS,
  TRANSITION_OPTIONS,
  ASPECT_RATIO_OPTIONS,
  VIDEO_LANGUAGE_OPTIONS,
  IMAGE_TEXT_DENSITY_OPTIONS,
  AI_PROVIDER_OPTIONS,
  IMAGE_SOURCE_OPTIONS,
  IMAGE_GENERATION_PROVIDER_OPTIONS,
  HTML_GENERATION_PROVIDER_OPTIONS,
  TTS_PROVIDER_OPTIONS,
  SUBTITLE_FONT_OPTIONS,
  SUBTITLE_EFFECT_OPTIONS,
  SUBTITLE_TEXT_CASE_OPTIONS,
  FLOW_IMAGE_MODEL_OPTIONS,
  FLOW_VIDEO_MODEL_OPTIONS,
  FLOW_VIDEO_DURATION_OPTIONS,
  OMNIVOICE_DEFAULT_VOICE_OPTIONS,
  DEFAULT_PROJECT_SETTINGS,
  TMP_DIR,
  PUBLIC_DIR,
  OMNIVOICE_VOICES_DIR,
  STORAGE_DIR,
  normalizeAspectRatio
} = require('../config/constants');
const { getMachineId, verifyLicenseData, checkLicenseStatus } = require('../services/licenseService');
const {
  getSettings,
  saveSettings,
  listImageStyles,
  saveCustomStyle,
  deleteCustomStyle,
  resolveImageStyle,
  readProjectLogs
} = require('../services/settingsService');
const { listHistory, deleteProject, deleteAllProjects, listGroups, createGroup, deleteGroup } = require('../services/historyService');
const { getDefaultVerticalPrompt, getProjectDetails, getProject, saveProject, getProjectPaths, ensureSceneDir, isImageSearchSource, isVideoSearchSource, isHtmlSource, isFlowSource, isFlowVideoSource, isFlowAudioSource } = require('../services/projectService');
const {
  createProjectAndStart,
  runProjectPipeline,
  generateImageForScene,
  generateVideoForScene,
  generateHtmlForSceneInProject,
  generateVoiceForScene,
  generateSubtitleForScene,
  renderSingleScene,
  renderProjectOutputs,
  rebuildAllScenesAndFinalize,
  applyCurrentRenderSettings,
  saveSceneSubtitle,
  generateThumbnailForProject,
  generateThumbnailVerticalForProject,
  generateSeoForProject
} = require('../services/projectPipeline');
const { startJob, isJobRunning, getActiveJobsForProject } = require('../services/jobManager');
const { readSubtitleText } = require('../services/subtitleService');
const { parseScriptInput } = require('../services/scriptGenerator');
const { normalizeHttpUrl, crawlUrlContent } = require('../services/crawlService');
const { synthesizeWithProvider } = require('../services/multiTtsClient');
const { getAudioDuration } = require('../services/voiceService');
const { normalizeStillImageWithBlurredBackground } = require('../services/renderService');
const { getFlowStatus } = require('../services/flowClient');
const { getOmniVoiceStatus, prepareOmniVoiceVoice } = require('../services/omnivoiceClient');
const { getVideoLanguageConfig } = require('../config/languages');
const {
  storeProjectHtmlMediaFiles,
  storeGlobalHtmlMediaFiles
} = require('../services/htmlMediaService');

const upload = multer({ dest: TMP_DIR });

function getWorkspaceId(req) {
  return String(req.get('x-workspace-id') || req.query?.workspaceId || '').trim();
}

async function getRequestSettings(req) {
  return getSettings(getWorkspaceId(req));
}

async function saveRequestSettings(req, partialSettings) {
  return saveSettings(partialSettings, getWorkspaceId(req));
}

function getProjectAppSettings(project, appSettings = {}) {
  return {
    ...appSettings,
    ...(project?.settings || {})
  };
}

function omniVoiceAudioExt(fileName = '') {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return ['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac'].includes(ext) ? ext : '';
}

async function removeUploadedFile(file) {
  if (!file?.path) return;
  await fs.unlink(file.path).catch(() => {});
}

function flowImageModelFromBody(value) {
  const normalized = String(value || '').trim();
  return FLOW_IMAGE_MODEL_OPTIONS.some((option) => option.value === normalized)
    ? normalized
    : DEFAULT_PROJECT_SETTINGS.flowImageModel;
}

function flowVideoModelFromBody(value) {
  const normalized = String(value || '').trim();
  return FLOW_VIDEO_MODEL_OPTIONS.some((option) => option.value === normalized)
    ? normalized
    : DEFAULT_PROJECT_SETTINGS.flowVideoModel;
}

function flowVideoDurationFromBody(value, fallback = DEFAULT_PROJECT_SETTINGS.flowVideoDurationSec) {
  const duration = Number(value);
  return FLOW_VIDEO_DURATION_OPTIONS.some((option) => Number(option.value) === duration)
    ? duration
    : fallback;
}

async function readLarVoiceSamples() {
  const samplesDir = path.join(PUBLIC_DIR, 'voice-samples');
  const manifestFile = path.join(samplesDir, '_manifest.json');
  try {
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    const ready = Array.isArray(manifest.ready) ? manifest.ready : [];
    return ready
      .filter((voice) => voice?.id && voice?.file)
      .map((voice) => ({
        id: Number(voice.id),
        name: String(voice.name || `Voice ${voice.id}`),
        language: String(voice.language || ''),
        duration: Number(voice.duration || 0) || null,
        sampleUrl: `/voice-samples/${voice.file}`
      }))
      .sort((a, b) => a.language.localeCompare(b.language) || a.name.localeCompare(b.name, 'vi'));
  } catch {
    const files = await fs.readdir(samplesDir).catch(() => []);
    return files
      .map((file) => file.match(/^larvoice-(\d+)-1p00\.mp3$/)?.[1])
      .filter(Boolean)
      .map((id) => ({
        id: Number(id),
        name: `Voice ${id}`,
        language: '',
        duration: null,
        sampleUrl: `/voice-samples/larvoice-${id}-1p00.mp3`
      }));
  }
}

function hasBodyField(body, key) {
  return Object.prototype.hasOwnProperty.call(body || {}, key);
}

function boolFromBody(value) {
  return value === true || value === 'true' || value === 'on' || value === '1';
}

function motionFromBody(value) {
  const normalized = String(value || '').trim();
  return MOTION_OPTIONS.some((option) => option.value === normalized) ? normalized : 'zoom-in';
}

const PROJECT_QUEUE_DELIMITER = '#######';

function splitQueuedProjectInputs(rawInput) {
  return String(rawInput || '')
    .split(PROJECT_QUEUE_DELIMITER)
    .map((item) => item.trim())
    .filter(Boolean);
}

function classifyQueuedProjectInput(rawInput, imageSource) {
  const inputText = String(rawInput || '').trim();
  const parsedInput = parseScriptInput(inputText, { imageSource });
  if (parsedInput.inputMode === 'json') {
    return { kind: 'json', inputText, parsedInput };
  }
  if (/^https?:\/\/\S+$/iu.test(inputText)) {
    return {
      kind: 'url',
      inputText,
      normalizedUrl: normalizeHttpUrl(inputText),
      parsedInput
    };
  }
  return { kind: 'text', inputText, parsedInput };
}

async function resolveQueuedProjectInput(rawInput, imageSource, appSettings) {
  const classified = classifyQueuedProjectInput(rawInput, imageSource);
  if (classified.kind !== 'url') {
    return {
      inputText: classified.inputText,
      parsedInput: classified.parsedInput,
      inputSource: { type: classified.kind }
    };
  }

  const crawled = await crawlUrlContent(classified.normalizedUrl, appSettings);
  return {
    inputText: crawled.text,
    parsedInput: { inputMode: 'prompt', text: crawled.text },
    inputSource: {
      type: crawled.sourceType === 'video' ? 'video-url' : 'article-url',
      url: crawled.sourceUrl || classified.normalizedUrl,
      platform: crawled.platform || ''
    }
  };
}

function collectRenderSettings(body = {}) {
  const settings = {};
  if (hasBodyField(body, 'motionPreset')) settings.motionPreset = motionFromBody(body.motionPreset);
  if (hasBodyField(body, 'transitionPreset')) settings.transitionPreset = body.transitionPreset;
  if (hasBodyField(body, 'generateThumbnailEnabled')) settings.generateThumbnailEnabled = boolFromBody(body.generateThumbnailEnabled);
  if (hasBodyField(body, 'generateSeoEnabled')) settings.generateSeoEnabled = boolFromBody(body.generateSeoEnabled);
  if (hasBodyField(body, 'subtitleEnabled')) settings.subtitleEnabled = boolFromBody(body.subtitleEnabled);
  if (hasBodyField(body, 'subtitleFontFamily')) settings.subtitleFontFamily = body.subtitleFontFamily;
  if (hasBodyField(body, 'subtitleEffect')) settings.subtitleEffect = body.subtitleEffect;
  if (hasBodyField(body, 'subtitleColor')) settings.subtitleColor = body.subtitleColor;
  if (hasBodyField(body, 'subtitleHighlightColor')) settings.subtitleHighlightColor = body.subtitleHighlightColor;
  if (hasBodyField(body, 'subtitleMaxWordsPerLine')) settings.subtitleMaxWordsPerLine = Number(body.subtitleMaxWordsPerLine || 5);
  if (hasBodyField(body, 'subtitlePositionY')) settings.subtitlePositionY = Number(body.subtitlePositionY || 86);
  if (hasBodyField(body, 'subtitleFontScale')) settings.subtitleFontScale = Number(body.subtitleFontScale || 1);
  if (hasBodyField(body, 'subtitleOpacity')) settings.subtitleOpacity = Number(body.subtitleOpacity ?? 1);
  if (hasBodyField(body, 'logoSize')) settings.logoSize = Number(body.logoSize || 120);
  if (hasBodyField(body, 'logoPosition')) settings.logoPosition = body.logoPosition;
  if (hasBodyField(body, 'logoOpacity')) settings.logoOpacity = Number(body.logoOpacity ?? 1);
  if (hasBodyField(body, 'musicVolume')) settings.musicVolume = Number(body.musicVolume ?? 0.18);
  if (hasBodyField(body, 'htmlSfxVolume')) settings.htmlSfxVolume = Number(body.htmlSfxVolume ?? 0.45);
  if (hasBodyField(body, 'referenceImageUrl')) settings.referenceImageUrl = body.referenceImageUrl;
  if (hasBodyField(body, 'watermarkText')) settings.watermarkText = body.watermarkText;
  if (hasBodyField(body, 'watermarkFontSize')) settings.watermarkFontSize = Number(body.watermarkFontSize || 24);
  if (hasBodyField(body, 'watermarkOpacity')) settings.watermarkOpacity = Number(body.watermarkOpacity ?? 30);
  if (hasBodyField(body, 'watermarkBehavior')) settings.watermarkBehavior = body.watermarkBehavior;
  if (hasBodyField(body, 'watermarkInterval')) settings.watermarkInterval = Number(body.watermarkInterval || 5);
  if (hasBodyField(body, 'watermarkSpeed')) settings.watermarkSpeed = body.watermarkSpeed;
  return settings;
}

async function applyRenderPayloadToProject(project, body = {}, files = {}) {
  const renderSettings = collectRenderSettings(body);
  let changed = false;
  const changedSettings = [];
  const changedAssets = [];
  project.settings = project.settings || {};
  for (const [key, value] of Object.entries(renderSettings)) {
    if (value !== undefined && project.settings[key] !== value) {
      project.settings[key] = value;
      changedSettings.push(key);
      changed = true;
    }
  }

  const paths = getProjectPaths(project.id);
  project.outputs = project.outputs || {};

  if (body.clearLogo === 'true' || body.clearLogo === true) {
    if (project.outputs.logo) {
      project.outputs.logo = null;
      changedAssets.push('logo');
      changed = true;
    }
  } else if (files.logo?.[0]) {
    const logoPath = path.join(paths.outputDir, 'logo' + path.extname(files.logo[0].originalname || '.png'));
    await fs.rename(files.logo[0].path, logoPath);
    project.outputs.logo = logoPath;
    changedAssets.push('logo');
    changed = true;
  }

  if (body.clearBackgroundMusic === 'true' || body.clearBackgroundMusic === true) {
    if (project.outputs.backgroundMusicFiles || project.outputs.backgroundMusic) {
      project.outputs.backgroundMusicFiles = [];
      project.outputs.backgroundMusic = null;
      changedAssets.push('backgroundMusic');
      changed = true;
    }
  } else if (files.backgroundMusic?.length) {
    const musicPaths = await Promise.all(
      files.backgroundMusic.map(async (file, i) => {
        const ext = path.extname(file.originalname || '.mp3') || '.mp3';
        const dest = path.join(paths.outputDir, `background-music-${i + 1}${ext}`);
        await fs.rename(file.path, dest);
        return dest;
      })
    );
    project.outputs.backgroundMusicFiles = musicPaths;
    project.outputs.backgroundMusic = musicPaths[0];
    changedAssets.push('backgroundMusic');
    changed = true;
  }

  if (body.clearIntroVideo === 'true' || body.clearIntroVideo === true) {
    if (project.outputs.introVideo) {
      project.outputs.introVideo = null;
      changedAssets.push('introVideo');
      changed = true;
    }
  } else if (files.introVideo?.[0]) {
    const ext = path.extname(files.introVideo[0].originalname || '.mp4') || '.mp4';
    const introPath = path.join(paths.outputDir, `intro-video${ext}`);
    await fs.rename(files.introVideo[0].path, introPath);
    project.outputs.introVideo = introPath;
    changedAssets.push('introVideo');
    changed = true;
  }

  if (body.clearOutroVideo === 'true' || body.clearOutroVideo === true) {
    if (project.outputs.outroVideo) {
      project.outputs.outroVideo = null;
      changedAssets.push('outroVideo');
      changed = true;
    }
  } else if (files.outroVideo?.[0]) {
    const ext = path.extname(files.outroVideo[0].originalname || '.mp4') || '.mp4';
    const outroPath = path.join(paths.outputDir, `outro-video${ext}`);
    await fs.rename(files.outroVideo[0].path, outroPath);
    project.outputs.outroVideo = outroPath;
    changedAssets.push('outroVideo');
    changed = true;
  }

  if (body.clearReferenceImage === 'true' || body.clearReferenceImage === true) {
    if (project.settings?.referenceImageUrl) {
      project.settings.referenceImageUrl = '';
      changed = true;
    }
  } else if (files.referenceImage?.[0]) {
    const ext = path.extname(files.referenceImage[0].originalname || '.png') || '.png';
    const refImagePath = path.join(paths.outputDir, `reference-image${ext}`);
    await fs.rename(files.referenceImage[0].path, refImagePath);
    project.settings = project.settings || {};
    project.settings.referenceImageUrl = refImagePath;
    changedAssets.push('referenceImage');
    changed = true;
  }

  if (files.htmlMedia?.length) {
    const appSettings = await getSettings();
    const stored = await storeProjectHtmlMediaFiles(project, files.htmlMedia, {
      ffprobePath: appSettings.ffprobePath
    });
    if (stored.length) {
      changedAssets.push('htmlMedia');
      changed = true;
    }
  }

  if (changed) {
    await saveProject(project, { overwrite: true });
  }
  return { changed, changedSettings, changedAssets };
}

async function copyFileIfPresent(sourcePath, targetPath) {
  if (!sourcePath) return '';
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
  return targetPath;
}

async function copyProjectAssets(sourceProject, targetProject) {
  const sourceOutputs = sourceProject.outputs || {};
  const targetPaths = getProjectPaths(targetProject.id);
  targetProject.outputs = targetProject.outputs || {};

  if (sourceOutputs.logo) {
    targetProject.outputs.logo = await copyFileIfPresent(
      sourceOutputs.logo,
      path.join(targetPaths.outputDir, path.basename(sourceOutputs.logo))
    );
  }
  if (sourceOutputs.introVideo) {
    targetProject.outputs.introVideo = await copyFileIfPresent(
      sourceOutputs.introVideo,
      path.join(targetPaths.outputDir, path.basename(sourceOutputs.introVideo))
    );
  }
  if (sourceOutputs.outroVideo) {
    targetProject.outputs.outroVideo = await copyFileIfPresent(
      sourceOutputs.outroVideo,
      path.join(targetPaths.outputDir, path.basename(sourceOutputs.outroVideo))
    );
  }
  if (Array.isArray(sourceOutputs.backgroundMusicFiles) && sourceOutputs.backgroundMusicFiles.length) {
    targetProject.outputs.backgroundMusicFiles = [];
    for (const filePath of sourceOutputs.backgroundMusicFiles) {
      targetProject.outputs.backgroundMusicFiles.push(await copyFileIfPresent(
        filePath,
        path.join(targetPaths.outputDir, path.basename(filePath))
      ));
    }
    targetProject.outputs.backgroundMusic = targetProject.outputs.backgroundMusicFiles[0];
  }
  if (Array.isArray(sourceOutputs.htmlMedia) && sourceOutputs.htmlMedia.length) {
    const mediaDir = path.join(targetPaths.projectDir, 'html-media');
    await fs.mkdir(mediaDir, { recursive: true });
    targetProject.outputs.htmlMedia = [];
    for (const item of sourceOutputs.htmlMedia) {
      const fileName = item.fileName || path.basename(item.path || '');
      const copiedPath = await copyFileIfPresent(item.path, path.join(mediaDir, fileName));
      targetProject.outputs.htmlMedia.push({
        ...item,
        id: crypto.randomBytes(8).toString('hex'),
        path: copiedPath,
        publicPath: `/projects/${targetProject.id}/html-media/${fileName}`
      });
    }
  }

  if (sourceProject.settings?.referenceImageUrl) {
    const srcUrl = sourceProject.settings.referenceImageUrl;
    if (!srcUrl.startsWith('http://') && !srcUrl.startsWith('https://') && !srcUrl.startsWith('data:')) {
      const dest = path.join(targetPaths.outputDir, path.basename(srcUrl));
      targetProject.settings = targetProject.settings || {};
      targetProject.settings.referenceImageUrl = await copyFileIfPresent(srcUrl, dest);
    } else {
      targetProject.settings = targetProject.settings || {};
      targetProject.settings.referenceImageUrl = srcUrl;
    }
  }
}

async function runProjectQueue(projectIds) {
  for (const projectId of projectIds) {
    try {
      await startJob(projectId, () => runProjectPipeline(projectId));
    } catch {
      // runProjectPipeline marks the project as failed; continue the batch.
    }
  }
}

function createApiRouter({ localServices } = {}) {
  const router = express.Router();

  router.get('/license/status', async (req, res, next) => {
    try {
      if (process.env.VIBE_TOOL_COMMERCIAL !== 'true') {
        return res.json({
          machineId: 'DEVELOPER_MACHINE',
          valid: true,
          expiresAt: '2099-12-31',
          reason: null
        });
      }
      const machineId = await getMachineId();
      const status = await checkLicenseStatus(STORAGE_DIR);
      res.json({
        machineId,
        valid: status.valid,
        expiresAt: status.expiresAt || null,
        reason: status.reason || null
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/license/activate', async (req, res, next) => {
    try {
      if (process.env.VIBE_TOOL_COMMERCIAL !== 'true') {
        return res.json({ ok: true, expiresAt: '2099-12-31' });
      }
      const { licenseContent } = req.body;
      if (!licenseContent) {
        return res.status(400).json({ ok: false, error: 'Thiếu nội dung tệp bản quyền.' });
      }

      let licenseObj;
      try {
        licenseObj = typeof licenseContent === 'string' ? JSON.parse(licenseContent) : licenseContent;
      } catch (e) {
        return res.status(400).json({ ok: false, error: 'Định dạng tệp .lic không hợp lệ (không phải JSON).' });
      }

      const machineId = await getMachineId();
      const status = verifyLicenseData(licenseObj, machineId);
      if (!status.valid) {
        return res.status(400).json({ ok: false, error: status.reason });
      }

      const licPath = path.join(STORAGE_DIR, 'license.lic');
      await fs.writeFile(licPath, JSON.stringify(licenseObj, null, 2), 'utf8');

      res.json({ ok: true, expiresAt: status.expiresAt });
    } catch (err) {
      next(err);
    }
  });

  router.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  router.get('/bootstrap', async (req, res, next) => {
    try {
      const [settings, history, voiceSamples, styles, groups] = await Promise.all([
        getRequestSettings(req),
        listHistory(),
        readLarVoiceSamples(),
        listImageStyles(),
        listGroups()
      ]);
      res.json({
        settings,
        history,
        groups,
        styles,
        motionOptions: MOTION_OPTIONS,
        transitionOptions: TRANSITION_OPTIONS,
        aspectRatioOptions: ASPECT_RATIO_OPTIONS,
        videoLanguageOptions: VIDEO_LANGUAGE_OPTIONS,
        imageTextDensityOptions: IMAGE_TEXT_DENSITY_OPTIONS,
        aiProviderOptions: AI_PROVIDER_OPTIONS,
        imageSourceOptions: IMAGE_SOURCE_OPTIONS,
        flowImageModelOptions: FLOW_IMAGE_MODEL_OPTIONS,
        flowVideoModelOptions: FLOW_VIDEO_MODEL_OPTIONS,
        flowVideoDurationOptions: FLOW_VIDEO_DURATION_OPTIONS,
        omnivoiceDefaultVoiceOptions: OMNIVOICE_DEFAULT_VOICE_OPTIONS,
        imageGenerationProviderOptions: IMAGE_GENERATION_PROVIDER_OPTIONS,
        htmlGenerationProviderOptions: HTML_GENERATION_PROVIDER_OPTIONS,
        ttsProviderOptions: TTS_PROVIDER_OPTIONS,
        subtitleFontOptions: SUBTITLE_FONT_OPTIONS,
        subtitleEffectOptions: SUBTITLE_EFFECT_OPTIONS,
        voiceSamples
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/settings', async (req, res, next) => {
    try {
      const settings = await saveRequestSettings(req, req.body || {});
      res.json({ settings });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/settings/html-default-media',
    upload.fields([
      { name: 'defaultSfx', maxCount: 100 },
      { name: 'brandAssets', maxCount: 100 }
    ]),
    async (req, res, next) => {
      try {
        const current = await getRequestSettings(req);
        const files = req.files || {};
        const sfxUpdate = await storeGlobalHtmlMediaFiles(current, files.defaultSfx || [], 'sfx', {
          ffprobePath: current.ffprobePath
        });
        const withSfx = { ...current, ...sfxUpdate };
        const brandUpdate = await storeGlobalHtmlMediaFiles(withSfx, files.brandAssets || [], 'brand', {
          ffprobePath: current.ffprobePath
        });
        const settings = await saveRequestSettings(req, { ...sfxUpdate, ...brandUpdate });
        res.json({ settings });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post('/settings/html-default-media-json', async (req, res, next) => {
    try {
      const body = req.body || {};
      const toStored = (items, role, fallbackType) => (Array.isArray(items) ? items : [])
        .filter((item) => item?.path)
        .slice(0, 200)
        .map((item) => ({
          id: String(item.id || ''),
          scope: 'global',
          role,
          type: String(item.type || fallbackType),
          originalName: String(item.fileName || item.originalName || ''),
          fileName: String(item.fileName || item.originalName || ''),
          description: String(item.description || item.fileName || item.originalName || ''),
          mimeType: String(item.mimeType || ''),
          path: String(item.path || ''),
          width: role === 'brand-asset' && item.width ? Number(item.width) || null : null,
          height: role === 'brand-asset' && item.height ? Number(item.height) || null : null,
          durationSec: item.durationSec ? Number(item.durationSec) || null : null
        }));
      const settings = await saveRequestSettings(req, {
        htmlDefaultSfx: toStored(body.soundEffects, 'sound-effect', 'audio'),
        htmlBrandAssets: toStored(body.brandAssets, 'brand-asset', 'image')
      });
      res.json({ settings });
    } catch (error) {
      next(error);
    }
  });

  router.post('/crawl-url', async (req, res, next) => {
    try {
      const url = normalizeHttpUrl(req.body?.url);
      const result = await crawlUrlContent(url, await getRequestSettings(req));
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/tts/preview', async (req, res, next) => {
    try {
      const current = await getRequestSettings(req);
      const provider = String(req.body?.ttsProvider || current.ttsProvider || 'larvoice');
      if (provider === 'larvoice') {
        return res.status(400).json({ error: 'LarVoice dùng file sample có sẵn ở giao diện.' });
      }
      const ext = provider === 'vbee' && String(req.body?.vbeeAudioType || current.vbeeAudioType || '').toLowerCase() === 'wav'
        ? '.wav'
        : '.mp3';
      const file = `tts-preview-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
      const outputPath = path.join(TMP_DIR, file);
      const previewText = current.videoLanguage === 'en'
        ? 'Hello, this is a short voice preview for checking this voice and API key.'
        : 'Xin chào, đây là đoạn nghe thử ngắn để kiểm tra giọng đọc và khoá API.';
      await synthesizeWithProvider({
        text: previewText,
        outputPath,
        settings: {
          ...current,
          ...(req.body || {}),
          ttsProvider: provider
        }
      });
      res.json({ audioUrl: `/api/tts/preview/${file}` });
    } catch (error) {
      next(error);
    }
  });

  router.get('/tts/preview/:file', async (req, res, next) => {
    try {
      const file = String(req.params.file || '');
      if (!/^tts-preview-\d+-[a-f0-9]{8}\.(mp3|wav)$/i.test(file)) {
        return res.status(404).end();
      }
      res.sendFile(path.join(TMP_DIR, file));
    } catch (error) {
      next(error);
    }
  });

  router.post('/styles', async (req, res, next) => {
    try {
      const style = await saveCustomStyle(req.body || {});
      res.json({ style, styles: await listImageStyles() });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/styles/:styleValue', async (req, res, next) => {
    try {
      await deleteCustomStyle(req.params.styleValue);
      res.json({ styles: await listImageStyles(), settings: await getRequestSettings(req) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/settings/omnivoice-voices', upload.single('refAudio'), async (req, res, next) => {
    let storedRefAudioPath = '';
    try {
      const file = req.file;
      const ext = omniVoiceAudioExt(file?.originalname);
      const name = String(req.body?.name || '').trim().slice(0, 80);
      if (!name) {
        await removeUploadedFile(file);
        return res.status(400).json({ error: 'Vui lòng nhập tên giọng OmniVoice.' });
      }
      if (!file || !ext) {
        await removeUploadedFile(file);
        return res.status(400).json({ error: 'Vui lòng tải file audio mẫu .wav, .mp3, .m4a, .aac, .ogg hoặc .flac.' });
      }

      const current = await getRequestSettings(req);
      const id = crypto.randomBytes(12).toString('hex');
      await fs.mkdir(OMNIVOICE_VOICES_DIR, { recursive: true });
      const refAudioPath = path.join(OMNIVOICE_VOICES_DIR, id + ext);
      await fs.rename(file.path, refAudioPath);
      storedRefAudioPath = refAudioPath;

      const voice = {
        id,
        name,
        refAudioPath,
        refText: String(req.body?.refText || '').trim().slice(0, 2000),
        originalName: String(file.originalname || '').slice(0, 160),
        createdAt: new Date().toISOString()
      };
      const nextVoices = [...(current.omnivoiceVoices || []), voice];
      const preparation = await prepareOmniVoiceVoice({
        voice,
        settings: {
          ...current,
          omnivoiceVoices: nextVoices,
          omnivoiceVoiceId: id
        }
      });
      const settings = await saveRequestSettings(req, {
        omnivoiceVoices: nextVoices,
        omnivoiceVoiceId: current.omnivoiceVoiceId || id
      });
      res.json({ settings, voice, preparation });
    } catch (error) {
      await removeUploadedFile(req.file);
      if (storedRefAudioPath) await fs.unlink(storedRefAudioPath).catch(() => {});
      next(error);
    }
  });

  router.delete('/settings/omnivoice-voices/:voiceId', async (req, res, next) => {
    try {
      const id = String(req.params.voiceId || '').trim();
      const current = await getRequestSettings(req);
      const voice = (current.omnivoiceVoices || []).find((item) => item.id === id);
      if (!voice) return res.status(404).json({ error: 'Không tìm thấy giọng OmniVoice.' });

      await fs.unlink(voice.refAudioPath).catch(() => {});
      const voices = (current.omnivoiceVoices || []).filter((item) => item.id !== id);
      const settings = await saveRequestSettings(req, {
        omnivoiceVoices: voices,
        omnivoiceVoiceId: current.omnivoiceVoiceId === id ? '' : current.omnivoiceVoiceId
      });
      res.json({ settings });
    } catch (error) {
      next(error);
    }
  });

  router.get('/flow/status', async (req, res, next) => {
    try {
      res.json(await getFlowStatus(await getRequestSettings(req)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/local-services/:name/start', async (req, res, next) => {
    try {
      if (!localServices?.start) {
        return res.status(503).json({ error: 'Local service manager is not available.' });
      }
      const name = String(req.params.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Service name is required.' });
      const service = await localServices.start(name);
      res.json({ ok: true, service });
    } catch (error) {
      next(error);
    }
  });

  router.get('/omnivoice/status', async (req, res, next) => {
    try {
      res.json(await getOmniVoiceStatus(await getRequestSettings(req)));
    } catch (error) {
      next(error);
    }
  });

  router.get('/projects', async (req, res, next) => {
    try {
      res.json({ projects: await listHistory() });
    } catch (error) {
      next(error);
    }
  });

  router.get('/groups', async (req, res, next) => {
    try {
      res.json({ groups: await listGroups() });
    } catch (error) {
      next(error);
    }
  });

  router.post('/groups', async (req, res, next) => {
    try {
      const { name } = req.body;
      if (!name) {
        res.status(400).json({ error: 'Group name is required' });
        return;
      }
      const group = await createGroup(name);
      res.status(201).json({ group });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/groups/:groupId', async (req, res, next) => {
    try {
      await deleteGroup(req.params.groupId);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.get('/projects/:projectId', async (req, res, next) => {
    try {
      const details = await getProjectDetails(req.params.projectId);
      if (!details) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const logs = await readProjectLogs(details.paths.projectDir);
      res.json({
        ...details,
        logs,
        running: isJobRunning(req.params.projectId),
        activeJobs: getActiveJobsForProject(req.params.projectId)
      });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/projects',
    upload.fields([
      { name: 'logo', maxCount: 1 },
      { name: 'backgroundMusic', maxCount: 10 },
      { name: 'introVideo', maxCount: 1 },
      { name: 'outroVideo', maxCount: 1 },
      { name: 'htmlMedia', maxCount: 50 },
      { name: 'referenceImage', maxCount: 1 }
    ]),
    async (req, res, next) => {
      try {
        const files = req.files || {};
        const body = req.body || {};
        const queuedInputs = splitQueuedProjectInputs(body.inputText);
        if (!queuedInputs.length) {
          throw new Error('Missing script input');
        }
        const sceneDurationMode = body.videoDurationSec === 'free'
          ? 'free'
          : body.sceneDurationSec === 'auto'
            ? 'auto'
            : 'fixed';
        const videoDurationSec = sceneDurationMode === 'free' ? 0 : Number(body.videoDurationSec || 60);
        const imageStyle = await resolveImageStyle(body.imageStyle);
        const projectSettings = {
          videoLanguage: body.videoLanguage,
          aspectRatio: normalizeAspectRatio(body.aspectRatio),
          imageStyle: imageStyle.value,
          imageStyleLabel: imageStyle.label,
          imageStylePrompt: imageStyle.prompt || '',
          imageTextDensity: body.imageTextDensity,
          imageSource: body.imageSource,
          imageGenerationProvider: body.imageGenerationProvider,
          imageModel: body.imageModel,
          referenceImageUrl: body.referenceImageUrl || '',
          flowImageModel: flowImageModelFromBody(body.flowImageModel),
          flowVideoModel: flowVideoModelFromBody(body.flowVideoModel),
          flowVideoDurationSec: flowVideoDurationFromBody(body.flowVideoDurationSec),
          
          motionPreset: motionFromBody(body.motionPreset),
          transitionPreset: body.transitionPreset,
          generateThumbnailEnabled: body.generateThumbnailEnabled === 'true' || body.generateThumbnailEnabled === true,
          generateSeoEnabled: body.generateSeoEnabled === 'true' || body.generateSeoEnabled === true,
          subtitleEnabled: body.subtitleEnabled === 'true' || body.subtitleEnabled === true,
          subtitleFontFamily: body.subtitleFontFamily,
          subtitleEffect: body.subtitleEffect,
          subtitleColor: body.subtitleColor,
          subtitleHighlightColor: body.subtitleHighlightColor,
          subtitleMaxWordsPerLine: Number(body.subtitleMaxWordsPerLine || 5),
          subtitlePositionY: Number(body.subtitlePositionY || 86),
          subtitleFontScale: Number(body.subtitleFontScale || 1),
          subtitleOpacity: Number(body.subtitleOpacity ?? 1),
          logoSize: Number(body.logoSize || 120),
          logoPosition: body.logoPosition || 'top-right',
          logoOpacity: Number(body.logoOpacity ?? 1),
          musicVolume: Number(body.musicVolume ?? 0.18),
          htmlSfxVolume: Number(body.htmlSfxVolume ?? 0.45),
          watermarkText: body.watermarkText || '',
          watermarkFontSize: Number(body.watermarkFontSize || 24),
          watermarkOpacity: Number(body.watermarkOpacity ?? 30),
          watermarkBehavior: body.watermarkBehavior || 'interval',
          watermarkInterval: Number(body.watermarkInterval || 5),
          watermarkSpeed: body.watermarkSpeed || 'medium',
          videoDurationSec,
          sceneDurationSec: sceneDurationMode === 'auto' || sceneDurationMode === 'free' ? 0 : Number(body.sceneDurationSec || 10),
          sceneDurationMode,
          voiceSpeed: Number(body.voiceSpeed || 1),
          voicePaddingMs: Math.round(800 / (Number(body.voiceSpeed) || 1)),
          imageConcurrency: Number(body.imageConcurrency || 6),
          xfadeDurationSec: Number(body.xfadeDurationSec || 0.5)
        };
        const appSettings = await getRequestSettings(req);
        const projects = [];
        for (const [index, queuedInput] of queuedInputs.entries()) {
          let resolvedInput;
          try {
            resolvedInput = await resolveQueuedProjectInput(queuedInput, body.imageSource, appSettings);
          } catch (error) {
            throw new Error(`Không thể xử lý mục multi ${index + 1}: ${error.message}`);
          }
          const { inputText, parsedInput, inputSource } = resolvedInput;
          projects.push(await createProjectAndStart({
            title: parsedInput.inputMode === 'json' ? parsedInput.script.title : '',
            inputMode: parsedInput.inputMode,
            inputText,
            inputSource,
            settings: projectSettings,
            groupId: body.groupId || null
          }));
        }
        const project = projects[0];

        const paths = getProjectPaths(project.id);
        if (files.logo?.[0]) {
          const logoPath = path.join(paths.outputDir, 'logo' + path.extname(files.logo[0].originalname || '.png'));
          await fs.rename(files.logo[0].path, logoPath);
          project.outputs.logo = logoPath;
        }
        if (files.backgroundMusic?.length) {
          const musicPaths = await Promise.all(
             files.backgroundMusic.map(async (file, i) => {
               const ext = path.extname(file.originalname || '.mp3');
               const dest = path.join(paths.outputDir, `background-music-${i + 1}${ext}`);
               await fs.rename(file.path, dest);
               return dest;
             })
          );
          project.outputs.backgroundMusicFiles = musicPaths;
          project.outputs.backgroundMusic = musicPaths[0]; // backward compat
        }
        if (files.introVideo?.[0]) {
          const ext = path.extname(files.introVideo[0].originalname || '.mp4') || '.mp4';
          const introPath = path.join(paths.outputDir, `intro-video${ext}`);
          await fs.rename(files.introVideo[0].path, introPath);
          project.outputs.introVideo = introPath;
        }
        if (files.outroVideo?.[0]) {
          const ext = path.extname(files.outroVideo[0].originalname || '.mp4') || '.mp4';
          const outroPath = path.join(paths.outputDir, `outro-video${ext}`);
          await fs.rename(files.outroVideo[0].path, outroPath);
          project.outputs.outroVideo = outroPath;
        }
        if (files.referenceImage?.[0]) {
          const ext = path.extname(files.referenceImage[0].originalname || '.png') || '.png';
          const refImagePath = path.join(paths.outputDir, `reference-image${ext}`);
          await fs.rename(files.referenceImage[0].path, refImagePath);
          project.settings.referenceImageUrl = refImagePath;
        }
        await storeProjectHtmlMediaFiles(project, files.htmlMedia || [], {
          ffprobePath: appSettings.ffprobePath
        });
        await saveProject(project, { overwrite: true });
        for (const queuedProject of projects.slice(1)) {
          await copyProjectAssets(project, queuedProject);
          await saveProject(queuedProject, { overwrite: true });
        }

        runProjectQueue(projects.map((item) => item.id)).catch(() => {});
        res.status(201).json({ project, projects });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post('/projects/:projectId/resume', async (req, res, next) => {
    try {
      const project = await getProject(req.params.projectId);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      startJob(project.id, () => runProjectPipeline(project.id)).catch(() => {});
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/projects/:projectId/pause', async (req, res, next) => {
    try {
      const { requestPause } = require('../services/jobManager');
      requestPause(req.params.projectId);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/projects/:projectId', async (req, res, next) => {
    try {
      const project = await getProject(req.params.projectId);
        if (!project) {
          res.status(404).json({ error: 'Project not found' });
          return;
      }
      project.thumbnailPrompt = req.body.thumbnailPrompt ?? project.thumbnailPrompt;
      if (req.body.thumbnailPrompt !== undefined && req.body.thumbnailPromptVertical === undefined) {
        project.thumbnailPromptVertical = getDefaultVerticalPrompt(req.body.thumbnailPrompt, project.title);
      } else {
        project.thumbnailPromptVertical = req.body.thumbnailPromptVertical ?? project.thumbnailPromptVertical;
      }
      project.thumbnailKeyword = req.body.thumbnailKeyword ?? project.thumbnailKeyword;
      if (req.body.groupId !== undefined) {
        project.groupId = req.body.groupId || null;
      }
      await saveProject(project, { overwrite: true });
      res.json({ ok: true, project });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/projects/:projectId/scenes/:sceneNumber', async (req, res, next) => {
    try {
      const project = await getProject(req.params.projectId);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const scene = project.scenes.find((item) => Number(item.sceneNumber) === Number(req.params.sceneNumber));
      if (!scene) {
        res.status(404).json({ error: 'Scene not found' });
        return;
      }
      scene.voiceText = req.body.voiceText ?? scene.voiceText;
      const isImageSearchMode = isImageSearchSource(project.settings?.imageSource);
      const isVideoSearchMode = isVideoSearchSource(project.settings?.imageSource);
      const isHtmlMode = isHtmlSource(project.settings?.imageSource);
      if (isHtmlMode) {
        if (Object.prototype.hasOwnProperty.call(req.body || {}, 'visual')) {
          scene.visual = String(req.body.visual || '').trim();
        }
        if (Object.prototype.hasOwnProperty.call(req.body || {}, 'htmlSpec')) {
          const rawSpec = req.body.htmlSpec;
          if (typeof rawSpec === 'string') {
            try {
              scene.htmlSpec = rawSpec.trim() ? JSON.parse(rawSpec) : null;
            } catch {
              scene.htmlSpec = rawSpec;
            }
          } else {
            scene.htmlSpec = rawSpec || null;
          }
        }
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'imagePrompt')) {
        if (isVideoSearchMode) {
          const searchKeyword = String(req.body.imagePrompt || '').trim();
          scene.imagePrompt = '';
          if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'videoKeyword')) {
            scene.videoKeyword = searchKeyword;
          }
        } else if (isImageSearchMode) {
          const searchKeyword = String(req.body.imagePrompt || '').trim();
          scene.imagePrompt = '';
          if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'imageKeyword')) {
            scene.imageKeyword = searchKeyword;
          }
        } else {
          scene.imagePrompt = req.body.imagePrompt ?? scene.imagePrompt;
        }
      }
      if (isImageSearchMode && Object.prototype.hasOwnProperty.call(req.body || {}, 'imageKeyword')) {
        scene.imageKeyword = String(req.body.imageKeyword || '').trim();
      }
      if (isVideoSearchMode && Object.prototype.hasOwnProperty.call(req.body || {}, 'videoKeyword')) {
        scene.videoKeyword = String(req.body.videoKeyword || '').trim();
      }
      if (isHtmlMode) {
        scene.imagePrompt = '';
        scene.imageKeyword = '';
        scene.videoKeyword = '';
        scene.useReferenceImage = false;
        scene.sceneReferenceImageUrl = '';
      } else if (isVideoSearchMode) {
        scene.imagePrompt = '';
        scene.imageKeyword = '';
        scene.useReferenceImage = false;
        scene.sceneReferenceImageUrl = '';
      } else if (isImageSearchMode) {
        scene.imagePrompt = '';
        scene.videoKeyword = '';
        scene.useReferenceImage = false;
        scene.sceneReferenceImageUrl = '';
      } else {
        scene.imageKeyword = '';
        scene.videoKeyword = '';
        scene.useReferenceImage = req.body.useReferenceImage === true || req.body.useReferenceImage === 'true' || req.body.useReferenceImage === 'on' || req.body.useReferenceImage === '1';
        scene.sceneReferenceImageUrl = req.body.sceneReferenceImageUrl ?? scene.sceneReferenceImageUrl;
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'flowDurationSec')) {
        const fallbackDuration = scene.flowDurationSec || project.settings?.flowVideoDurationSec || DEFAULT_PROJECT_SETTINGS.flowVideoDurationSec;
        const nextFlowDuration = flowVideoDurationFromBody(
          req.body.flowDurationSec,
          fallbackDuration
        );
        if (Number(fallbackDuration) !== nextFlowDuration) {
          scene.metadata = scene.metadata || {};
          scene.metadata.flow = scene.metadata.flow || {};
          scene.metadata.flow.videoRequestId = null;
          scene.metadata.flow.videoMediaId = null;
          scene.metadata.flow.videoUrl = null;
          scene.files = scene.files || {};
          scene.files.video = null;
          scene.files.sourceVideo = null;
        }
        scene.flowDurationSec = nextFlowDuration;
      }
      
      await saveProject(project);
      res.json({ ok: true, project });
    } catch (error) {
      next(error);
    }
  });

  router.get('/projects/:projectId/scenes/:sceneNumber/subtitle', async (req, res, next) => {
    try {
      const project = await getProject(req.params.projectId);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const scene = project.scenes.find((item) => Number(item.sceneNumber) === Number(req.params.sceneNumber));
      if (!scene) {
        res.status(404).json({ error: 'Scene not found' });
        return;
      }
      const sceneDir = await ensureSceneDir(project.id, scene.sceneNumber);
      const text = await readSubtitleText(sceneDir);
      res.json({ text });
    } catch (error) {
      next(error);
    }
  });

  router.put('/projects/:projectId/scenes/:sceneNumber/subtitle', async (req, res, next) => {
    try {
      await saveSceneSubtitle(req.params.projectId, req.params.sceneNumber, req.body.text || '');
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/projects/:projectId/scenes/:sceneNumber/upload-image',
    upload.single('image'),
    async (req, res, next) => {
      try {
        if (!req.file) {
          res.status(400).json({ error: 'No image file provided' });
          return;
        }
        const { projectId, sceneNumber } = req.params;
        const project = await getProject(projectId);
        if (!project) {
          if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
          res.status(404).json({ error: 'Project not found' });
          return;
        }
        const scene = project.scenes.find((s) => Number(s.sceneNumber) === Number(sceneNumber));
        if (!scene) {
          if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
          res.status(404).json({ error: 'Scene not found' });
          return;
        }
        const sceneDir = await ensureSceneDir(projectId, sceneNumber);
        const imagePath = path.join(sceneDir, 'image.png');
        const settings = await getSettings();
        await normalizeStillImageWithBlurredBackground(
          settings.ffmpegPath,
          req.file.path,
          imagePath,
          project.settings?.aspectRatio || settings.aspectRatio
        );
        await fs.unlink(req.file.path).catch(() => {});
        scene.files.image = imagePath;
        scene.files.video = null;
        scene.files.sourceVideo = null;
        scene.durations = scene.durations || {};
        delete scene.durations.sourceVideoSec;
        await saveProject(project);
        res.json({ ok: true });
      } catch (error) {
        if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
        next(error);
      }
    }
  );

  router.post(
    '/projects/:projectId/scenes/:sceneNumber/upload-video',
    upload.single('video'),
    async (req, res, next) => {
      try {
        if (!req.file) {
          res.status(400).json({ error: 'No video file provided' });
          return;
        }
        const { projectId, sceneNumber } = req.params;
        const project = await getProject(projectId);
        if (!project) {
          if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
          res.status(404).json({ error: 'Project not found' });
          return;
        }
        const scene = project.scenes.find((s) => Number(s.sceneNumber) === Number(sceneNumber));
        if (!scene) {
          if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
          res.status(404).json({ error: 'Scene not found' });
          return;
        }
        const sceneDir = await ensureSceneDir(projectId, sceneNumber);
        const ext = path.extname(req.file.originalname || '.mp4') || '.mp4';
        const sourceVideoPath = path.join(sceneDir, `source-video${ext}`);
        await fs.rename(req.file.path, sourceVideoPath);
        const settings = await getSettings();
        scene.files.sourceVideo = sourceVideoPath;
        scene.files.video = null;
        scene.durations = scene.durations || {};
        scene.durations.sourceVideoSec = await getAudioDuration(sourceVideoPath, settings.ffprobePath);
        scene.metadata = scene.metadata || {};
        delete scene.metadata.videoSearch;
        delete scene.metadata.videoUrl;
        await saveProject(project);
        res.json({ ok: true });
      } catch (error) {
        if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
        next(error);
      }
    }
  );

  router.post('/projects/:projectId/scenes/:sceneNumber/actions/:action', async (req, res, next) => {
    try {
      const { projectId, sceneNumber, action } = req.params;
      if (isJobRunning(projectId, true)) {
        res.status(409).json({ error: 'Project is already running' });
        return;
      }
      const jobId = `${projectId}:scene:${sceneNumber}:${action}`;
      if (isJobRunning(jobId)) {
        res.status(409).json({ error: 'This action is already running for this scene' });
        return;
      }
      const project = await getProject(projectId);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      project.activeSceneNumber = Number(sceneNumber);
      const appSettings = await getSettings();
      const videoSearchMode = isVideoSearchSource(project.settings?.imageSource);
      const htmlMode = isHtmlSource(project.settings?.imageSource);
      const taskMap = {
        image: async () => {
          if (htmlMode) {
            await generateVoiceForScene(project, appSettings, sceneNumber, false);
            if (project.settings.subtitleEnabled) {
              await generateSubtitleForScene(project, appSettings, sceneNumber, false);
            }
            return generateHtmlForSceneInProject(project, appSettings, sceneNumber, true);
          }
          if (videoSearchMode) {
            await generateVoiceForScene(project, appSettings, sceneNumber, false);
            return generateVideoForScene(project, appSettings, sceneNumber, true);
          }
          return generateImageForScene(project, appSettings, sceneNumber, true);
        },
        voice: async () => generateVoiceForScene(project, appSettings, sceneNumber, true),
        subtitle: async () => {
          if (applyCurrentRenderSettings(project, appSettings)) {
            await saveProject(project, { overwrite: true });
          }
          await generateSubtitleForScene(project, appSettings, sceneNumber, true);
        },
        render: async () => {
          if (applyCurrentRenderSettings(project, appSettings)) {
            await saveProject(project, { overwrite: true });
          }
          const scene = project.scenes.find((s) => Number(s.sceneNumber) === Number(sceneNumber));
          await generateVoiceForScene(project, appSettings, sceneNumber, false);
          if (videoSearchMode && !scene?.files?.sourceVideo) {
            await generateVideoForScene(project, appSettings, sceneNumber, false);
          } else if (htmlMode && !scene?.files?.html) {
            await generateHtmlForSceneInProject(project, appSettings, sceneNumber, false);
          } else if (!videoSearchMode && !htmlMode && !scene?.files?.sourceVideo) {
            await generateImageForScene(project, appSettings, sceneNumber, false);
          }
          if (project.settings.subtitleEnabled) {
            await generateSubtitleForScene(project, appSettings, sceneNumber, true);
          }
          if (htmlMode && !scene?.files?.html) {
            await generateHtmlForSceneInProject(project, appSettings, sceneNumber, false);
          }
          await renderSingleScene(project, appSettings, sceneNumber, true);
        }
      };
      const task = taskMap[action];
      if (!task) {
        res.status(400).json({ error: 'Unsupported action' });
        return;
      }
      startJob(jobId, task).catch(async (err) => {
        try {
          const { appendProjectLog } = require('../lib/logger');
          await appendProjectLog(getProjectPaths(projectId).projectDir, 'error', `[scene ${sceneNumber}/${action}] ${err.message}`);
          // Update scene status so client knows the action failed
          const failed = await getProject(projectId);
          if (failed) {
            const scene = failed.scenes.find((s) => Number(s.sceneNumber) === Number(sceneNumber));
            if (scene) {
              scene.status = 'error';
              scene.errors = [...(scene.errors || []), `${action}: ${err.message}`];
            }
            await saveProject(failed);  // updates updatedAt so cache-busting triggers
          }
        } catch {}
      });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/projects/:projectId/actions/convert-vertical', async (req, res, next) => {
    try {
      const { projectId } = req.params;
      if (isJobRunning(projectId)) {
        res.status(409).json({ error: 'Project is already running' });
        return;
      }
      const project = await getProject(projectId);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      if (!project.outputs?.videoFinal) {
        res.status(400).json({ error: 'Landscape video not generated yet' });
        return;
      }

      const {
        topText = '',
        bottomText = '',
        fontFamily = 'Arial',
        topFontSize,
        bottomFontSize,
        topPositionY,
        bottomPositionY,
        blurPercent,
        topColor = 'white',
        bottomColor = 'yellow',
        topLineHeight,
        bottomLineHeight
      } = req.body;

      const resolvedTopFontSize = Number(topFontSize || req.body.fontSize || 64);
      const resolvedBottomFontSize = Number(bottomFontSize || req.body.fontSize || 64);
      const resolvedTopPositionY = Number(topPositionY ?? 18);
      const resolvedBottomPositionY = Number(bottomPositionY ?? 83);
      const resolvedBlurPercent = Number(blurPercent ?? 50);
      const resolvedTopLineHeight = Number(topLineHeight ?? 1.4);
      const resolvedBottomLineHeight = Number(bottomLineHeight ?? 1.4);

      const appSettings = await getRequestSettings(req);
      const ffmpegPath = appSettings.ffmpegPath || 'ffmpeg';

      // Find the font path
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

      const paths = getProjectPaths(projectId);
      const outputVerticalPath = path.join(paths.outputDir, 'video.vertical.mp4');

      startJob(`${projectId}:vertical`, async () => {
        try {
          const { appendProjectLog } = require('../lib/logger');
          await appendProjectLog(paths.projectDir, 'info', 'Bắt đầu chuyển đổi video dọc 9:16...');

          const { convertToVerticalVideo } = require('../services/renderService');
          await convertToVerticalVideo({
            ffmpegPath,
            inputPath: project.outputs.videoFinal,
            outputPath: outputVerticalPath,
            topText,
            bottomText,
            fontFilePath,
            topFontSize: resolvedTopFontSize,
            bottomFontSize: resolvedBottomFontSize,
            topPositionY: resolvedTopPositionY,
            bottomPositionY: resolvedBottomPositionY,
            blurPercent: resolvedBlurPercent,
            topColor,
            bottomColor,
            topLineHeight: resolvedTopLineHeight,
            bottomLineHeight: resolvedBottomLineHeight
          });

          // Save to project outputs
          project.outputs.videoVertical = outputVerticalPath;
          project.verticalSettings = {
            topText,
            bottomText,
            fontFamily,
            topFontSize: resolvedTopFontSize,
            bottomFontSize: resolvedBottomFontSize,
            topPositionY: resolvedTopPositionY,
            bottomPositionY: resolvedBottomPositionY,
            blurPercent: resolvedBlurPercent,
            topColor,
            bottomColor,
            topLineHeight: resolvedTopLineHeight,
            bottomLineHeight: resolvedBottomLineHeight
          };
          await saveProject(project);

          if (project.outputs?.thumbnail) {
            await appendProjectLog(paths.projectDir, 'info', 'Cập nhật lại ảnh thumbnail dọc 9:16 đồng bộ với cấu hình dọc mới...');
            const { generateThumbnailForProject } = require('../services/projectPipeline');
            await generateThumbnailForProject(project, appSettings, false);
          }

          await appendProjectLog(paths.projectDir, 'info', 'Đã chuyển đổi video dọc 9:16 thành công!');
        } catch (err) {
          const { appendProjectLog } = require('../lib/logger');
          await appendProjectLog(paths.projectDir, 'error', `Chuyển đổi video dọc thất bại: ${err.message}`, {
            stack: err.stack
          });
          throw err;
        }
      }).catch(() => {});

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/projects/:projectId/actions/:action',
    upload.fields([
      { name: 'logo', maxCount: 1 },
      { name: 'backgroundMusic', maxCount: 10 },
      { name: 'introVideo', maxCount: 1 },
      { name: 'outroVideo', maxCount: 1 },
      { name: 'htmlMedia', maxCount: 50 },
      { name: 'referenceImage', maxCount: 1 }
    ]),
    async (req, res, next) => {
    try {
      const { projectId, action } = req.params;
      if (isJobRunning(projectId)) {
        res.status(409).json({ error: 'Project is already running' });
        return;
      }
      const project = await getProject(projectId);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const appSettings = getProjectAppSettings(project, await getRequestSettings(req));
      const changeSummary = (action === 'render-all' || action === 'finalize') ? await applyRenderPayloadToProject(project, req.body || {}, req.files || {}, appSettings)
        : { changed: false, changedSettings: [], changedAssets: [] };
      const renderSettings = collectRenderSettings(req.body || {});
      const taskMap = {
        'render-all': async () => rebuildAllScenesAndFinalize(projectId, renderSettings, changeSummary),
        finalize: async () => renderProjectOutputs(projectId, false, {
          forceMain: changeSummary.changed,
          forceIntro: changeSummary.changed,
          forceOutro: changeSummary.changed,
          forceThumbnail: false,
          forceSeo: false
        }),
        thumbnail: async () => {
          const current = await getProject(projectId);
          const appSettings = getProjectAppSettings(current, await getRequestSettings(req));
          await generateThumbnailForProject(current, appSettings, true);
        },
        'thumbnail-vertical': async () => {
          const current = await getProject(projectId);
          const appSettings = getProjectAppSettings(current, await getRequestSettings(req));
          await generateThumbnailVerticalForProject(current, appSettings, true);
        },
        
        seo: async () => {
          const current = await getProject(projectId);
          const appSettings = getProjectAppSettings(current, await getRequestSettings(req));
          await generateSeoForProject(current, appSettings, true);
        }
      };
      const task = taskMap[action];
      if (!task) {
        res.status(400).json({ error: 'Unsupported project action' });
        return;
      }
      startJob(projectId, async () => {
        try {
          await task();
        } catch (err) {
          const { appendProjectLog } = require('../lib/logger');
          await appendProjectLog(getProjectPaths(projectId).projectDir, 'error', `Hành động [${action}] thất bại: ${err.message}`, {
            stack: err.stack
          });
          throw err;
        }
      }).catch(() => {});
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/projects/:projectId', async (req, res, next) => {
    try {
      await deleteProject(req.params.projectId);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/projects', async (req, res, next) => {
    try {
      await deleteAllProjects();
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.use((error, req, res, next) => {
    res.status(500).json({ error: error.message || 'Internal server error' });
  });

  return router;
}

module.exports = {
  createApiRouter,
  splitQueuedProjectInputs,
  classifyQueuedProjectInput,
  resolveQueuedProjectInput
};
