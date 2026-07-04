const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { appendProjectLog } = require('../lib/logger');
const { exists, writeJson, isReadableVideoFile } = require('../lib/fs');
const { AiProviderClient } = require('./aiProviderClient');

const CHAT01_CLIENT_SESSION = Symbol('chat01ClientSession');
const SCENE_RENDER_SETTING_KEYS = new Set([
  'motionPreset',
  'subtitleEnabled',
  'subtitleFontFamily',
  'subtitleEffect',
  'subtitleTextCase',
  'subtitleColor',
  'subtitleHighlightColor',
  'subtitleMaxWordsPerLine',
  'subtitlePositionY',
  'subtitleFontScale',
  'subtitleOpacity'
]);
const SUBTITLE_RENDER_SETTING_KEYS = new Set([
  'subtitleEnabled',
  'subtitleFontFamily',
  'subtitleEffect',
  'subtitleTextCase',
  'subtitleColor',
  'subtitleHighlightColor',
  'subtitleMaxWordsPerLine',
  'subtitlePositionY',
  'subtitleFontScale',
  'subtitleOpacity'
]);
const FINAL_RENDER_SETTING_KEYS = new Set(['transitionPreset', 'musicVolume', 'logoSize', 'logoPosition', 'logoOpacity']);
const ESCBASE_TRANSITION_SEQUENCE = ['dramatic', 'sweep', 'bass', 'rise', 'chord', 'minimal'];
const ESCBASE_TRANSITION_XFADE = {
  dramatic: 'fadeblack',
  sweep: 'slideleft',
  bass: 'dissolve',
  rise: 'smoothup',
  chord: 'circleopen',
  minimal: 'fade'
};
const VISUAL_TRANSITION_POOL = Object.values(ESCBASE_TRANSITION_XFADE);

function createAiClient(settings) {
  if (!settings[CHAT01_CLIENT_SESSION]) {
    Object.defineProperty(settings, CHAT01_CLIENT_SESSION, {
      value: new AiProviderClient(settings),
      writable: true,
      enumerable: false
    });
  }
  return settings[CHAT01_CLIENT_SESSION];
}

function getProjectAppSettings(project, appSettings = {}) {
  return {
    ...appSettings,
    ...(project?.settings || {})
  };
}

function applyProjectReferenceToScenes(project) {
  if (!project.settings?.referenceImageUrl) return false;
  let changed = false;
  for (const scene of project.scenes || []) {
    if (!scene.sceneReferenceImageUrl && typeof scene.useReferenceImage !== 'string' && scene.useReferenceImage !== true) {
      scene.useReferenceImage = true;
      changed = true;
    }
  }
  return changed;
}
const { generateScriptFromText, parseScriptInput } = require('./scriptGenerator');
const {
  createProject,
  getProject,
  saveProject,
  saveScript,
  getProjectPaths,
  ensureSceneDir,
  isImageSearchSource,
  isVideoSearchSource,
  isDirectMediaMode,
  isHtmlSource,
  isFlowSource,
  isFlowImageOnlySource,
  isFlowVideoSource,
  isFlowAudioSource,
  isFlowFilmSource,
  getHtmlSourceProvider,
  getDefaultVerticalPrompt
} = require('./projectService');
const { generateSceneImage, generateThumbnailImage, generateThumbnailFallbackImage } = require('./imageService');
const { findAndDownloadVideo } = require('./imageSearchService');
const { isDirectMediaSource, saveDirectMediaSource } = require('./mediaSourceService');
const { generateFlowMedia, getConfiguredFlowAccount, clearFlowSetupPromises } = require('./flowClient');
const { createSceneVoice, getAudioDuration, addAudioTailPadding } = require('./voiceService');
const { createCorrectedSubtitle, saveManualSubtitle } = require('./subtitleService');
const { renderSceneVideo, renderSceneVideoFromSourceVideo, renderSceneVideoWithOriginalAudio, renderSceneVideoFromHtml, concatSceneVideos, addBackgroundMusicAndLogo, prependIntroVideo, appendOutroVideo, normalizeStillImageToAspect, extractLastVideoFrame } = require('./renderService');

const { generateHtmlForScene } = require('./htmlSceneService');
const { generateSeo } = require('./seoService');
const { getSettings } = require('./settingsService');

function checkPause(projectId) {
  const { isPauseRequested } = require('./jobManager');
  if (isPauseRequested(projectId)) {
    const error = new Error('Tạm dừng bởi người dùng');
    error.name = 'PipelinePausedError';
    throw error;
  }
}

async function markStep(project, status, lastCompletedStep, error = null) {
  project.status = status;
  project.lastCompletedStep = lastCompletedStep;
  project.error = error;
  await saveProject(project);
}

async function ensureScript(project, appSettings) {
  const paths = getProjectPaths(project.id);
  if (project.scenes.length) {
    if (applyProjectReferenceToScenes(project)) {
      await saveProject(project);
    }
    return project;
  }

  const parsed = parseScriptInput(project.inputText, { imageSource: project.settings?.imageSource });
  if (parsed.inputMode === 'json') {
    project.title = parsed.script.title;
    project.thumbnailPrompt = parsed.script.thumbnailPrompt;
    project.thumbnailPromptVertical = getDefaultVerticalPrompt(parsed.script.thumbnailPrompt, project.title);
    project.thumbnailKeyword = parsed.script.thumbnailKeyword;
    project.entities = parsed.script.entities || [];
    project.scenes = parsed.script.scenes;
    applyProjectReferenceToScenes(project);
    await saveScript(project.id, parsed.script);
    await saveProject(project, { overwrite: true });
    return project;
  }

  const scriptSettings = isHtmlSource(project.settings?.imageSource)
    ? { ...appSettings, apiProvider: getHtmlSourceProvider(project.settings?.imageSource) }
    : appSettings;
  const chat01Client = createAiClient(scriptSettings);
  const script = await generateScriptFromText(chat01Client, {
    inputText: parsed.text,
    settings: project.settings
  });
  project.inputMode = 'prompt';
  project.title = script.title;
  project.thumbnailPrompt = script.thumbnailPrompt;
  project.thumbnailPromptVertical = getDefaultVerticalPrompt(script.thumbnailPrompt, project.title);
  project.thumbnailKeyword = script.thumbnailKeyword;
  project.entities = script.entities || [];
  project.scenes = script.scenes;
  applyProjectReferenceToScenes(project);
  await saveScript(project.id, script);
  await saveProject(project, { overwrite: true });
  await appendProjectLog(paths.projectDir, 'info', 'Generated script JSON', { sceneCount: project.scenes.length });
  return project;
}

function getSceneOrThrow(project, sceneNumber) {
  const scene = project.scenes.find((item) => Number(item.sceneNumber) === Number(sceneNumber));
  if (!scene) {
    throw new Error(`Scene not found: ${sceneNumber}`);
  }
  return scene;
}

function getProjectRuntimeSettings(project, appSettings) {
  return {
    ...appSettings,
    _projectId: project.id,
    aspectRatio: project.settings?.aspectRatio || appSettings.aspectRatio,
    imageGenerationProvider: project.settings?.imageGenerationProvider || appSettings.imageGenerationProvider,
    thumbnailImageProvider: appSettings.thumbnailImageProvider || 'chat01',
    imageModel: project.settings?.imageModel || appSettings.imageModel,
    imageStyle: project.settings?.imageStyle || appSettings.imageStyle,
    imageStylePrompt: project.settings?.imageStylePrompt || appSettings.imageStylePrompt,
    imageTextDensity: project.settings?.imageTextDensity || appSettings.imageTextDensity,
    videoLanguage: project.settings?.videoLanguage || appSettings.videoLanguage,
    referenceImageUrl: project.settings?.referenceImageUrl || appSettings.referenceImageUrl,
    flowImageModel: project.settings?.flowImageModel || appSettings.flowImageModel,
    flowVideoModel: project.settings?.flowVideoModel || appSettings.flowVideoModel,
    htmlConcurrency: appSettings.htmlConcurrency,
    subtitleFontFamily: project.settings?.subtitleFontFamily || appSettings.subtitleFontFamily,
    subtitleEffect: project.settings?.subtitleEffect || appSettings.subtitleEffect,
    subtitleTextCase: project.settings?.subtitleTextCase || appSettings.subtitleTextCase,
    subtitleColor: project.settings?.subtitleColor || appSettings.subtitleColor,
    subtitleHighlightColor: project.settings?.subtitleHighlightColor || appSettings.subtitleHighlightColor,
    subtitleMaxWordsPerLine: project.settings?.subtitleMaxWordsPerLine || appSettings.subtitleMaxWordsPerLine,
    subtitlePositionY: project.settings?.subtitlePositionY || appSettings.subtitlePositionY,
    subtitleFontScale: project.settings?.subtitleFontScale || appSettings.subtitleFontScale,
    subtitleOpacity: project.settings?.subtitleOpacity ?? appSettings.subtitleOpacity,
    logoSize: project.settings?.logoSize ?? appSettings.logoSize,
    logoPosition: project.settings?.logoPosition || appSettings.logoPosition,
    logoOpacity: project.settings?.logoOpacity ?? appSettings.logoOpacity,
    musicVolume: project.settings?.musicVolume ?? appSettings.musicVolume,
    htmlSfxVolume: project.settings?.htmlSfxVolume ?? appSettings.htmlSfxVolume
  };
}

function getSceneImageRequestLog(project, scene) {
  if (isFlowSource(project.settings?.imageSource)) {
    return { prompt: String(scene.videoPrompt || scene.imagePrompt || scene.voiceText || project.title || '').slice(0, 80) };
  }
  if (sceneUsesVideoSource(project, scene)) {
    return { keyword: String(scene.videoKeyword || scene.searchKeyword || scene.voiceText || project.title || '').slice(0, 80) };
  }
  if (isImageSearchSource(project.settings?.imageSource)) {
    return { keyword: String(scene.imageKeyword || scene.imageSearchKeyword || scene.searchKeyword || scene.voiceText || project.title || '').slice(0, 80) };
  }
  return { prompt: String(scene.imagePrompt || '').slice(0, 80) };
}

function sceneUsesVideoSource(project, scene) {
  return isVideoSearchSource(project.settings?.imageSource)
    || isFlowVideoSource(project.settings?.imageSource)
    || (isDirectMediaMode(project.settings?.imageSource) && scene.mediaType === 'video');
}

function projectUsesGeneratedVoice(project) {
  return !isFlowAudioSource(project.settings?.imageSource);
}

function getSceneDuration(project, scene) {
  if (isFlowAudioSource(project.settings?.imageSource)) {
    return Number(scene.durations?.sourceVideoSec) || 0;
  }
  const voiceSec = Number(scene.durations?.voiceSec) || 0;
  // In fixed-pace mode, enforce minimum duration = configured pace.
  // This prevents short voice clips from making scenes shorter than intended.
  if (project.settings?.sceneDurationMode === 'fixed' && project.settings?.sceneDurationSec > 0) {
    return Math.max(voiceSec, Number(project.settings.sceneDurationSec));
  }
  return voiceSec;
}

function flowVideoShouldExposeImage(imageSource) {
  return ['flow-image-video', 'flow-image-video-az'].includes(String(imageSource || '').trim());
}

function sceneRenderOutputPath(project, sceneDir) {
  return path.join(sceneDir, !projectUsesGeneratedVoice(project)
    ? 'scene.flow-audio.mp4'
    : project.settings.subtitleEnabled ? 'scene.subtitled.mp4' : 'scene.voice.mp4');
}

function projectSceneAssetPath(project, scene, fileName) {
  return `/projects/${project.id}/scenes/scene-${String(scene.sceneNumber).padStart(2, '0')}/${fileName}`;
}

async function applyFlowFilmReference(project, scene, sceneDir, referenceImagePath) {
  if (!referenceImagePath) return false;
  const currentReference = String(scene.sceneReferenceImageUrl || '').trim();
  const currentChainReference = String(scene.metadata?.flow?.chainedReferenceImageUrl || '').trim();
  if (currentReference === referenceImagePath && currentChainReference === referenceImagePath) return false;

  scene.sceneReferenceImageUrl = referenceImagePath;
  scene.useReferenceImage = referenceImagePath;
  scene.files = scene.files || {};
  scene.files.image = null;
  scene.files.sourceVideo = null;
  scene.files.video = null;
  scene.durations = scene.durations || {};
  delete scene.durations.sourceVideoSec;
  scene.metadata = scene.metadata || {};
  scene.metadata.flow = {
    ...(scene.metadata.flow || {}),
    chainedReferenceImageUrl: referenceImagePath,
    referenceImageUrl: '',
    referenceMediaId: null,
    referenceEntityId: null,
    referenceEntityName: '',
    imageRequestId: null,
    imageMediaId: null,
    imageUrl: null,
    videoRequestId: null,
    videoMediaId: null,
    videoUrl: null
  };
  await Promise.all([
    fs.rm(path.join(sceneDir, 'source-video.mp4'), { force: true }),
    fs.rm(path.join(sceneDir, 'scene.flow-audio.mp4'), { force: true }),
    fs.rm(path.join(sceneDir, 'flow-start-image.png'), { force: true }),
    fs.rm(path.join(sceneDir, 'image.png'), { force: true })
  ]);
  return true;
}

async function clearFlowFilmReference(project, scene, sceneDir) {
  const chainedReference = String(scene.metadata?.flow?.chainedReferenceImageUrl || '').trim();
  if (!chainedReference) return false;
  if (String(scene.sceneReferenceImageUrl || '').trim() === chainedReference) {
    scene.sceneReferenceImageUrl = '';
  }
  if (scene.useReferenceImage === chainedReference) {
    scene.useReferenceImage = false;
  }
  scene.files = scene.files || {};
  scene.files.image = null;
  scene.files.sourceVideo = null;
  scene.files.video = null;
  scene.durations = scene.durations || {};
  delete scene.durations.sourceVideoSec;
  scene.metadata = scene.metadata || {};
  scene.metadata.flow = {
    ...(scene.metadata.flow || {}),
    chainedReferenceImageUrl: '',
    referenceImageUrl: '',
    referenceMediaId: null,
    referenceEntityId: null,
    referenceEntityName: '',
    imageRequestId: null,
    imageMediaId: null,
    imageUrl: null,
    videoRequestId: null,
    videoMediaId: null,
    videoUrl: null
  };
  await Promise.all([
    fs.rm(path.join(sceneDir, 'source-video.mp4'), { force: true }),
    fs.rm(path.join(sceneDir, 'scene.flow-audio.mp4'), { force: true }),
    fs.rm(path.join(sceneDir, 'flow-start-image.png'), { force: true }),
    fs.rm(path.join(sceneDir, 'image.png'), { force: true })
  ]);
  return true;
}

function getFlowFilmReferenceForScene(scene, previousLastFrame, lastFrameBySceneNumber) {
  if (!previousLastFrame) return '';
  const chainType = String(scene.chainType || '').trim().toUpperCase();
  if (chainType === 'ROOT') return '';
  if (chainType === 'CONTINUATION' || chainType === 'INSERT') {
    const parentSceneNumber = Number(scene.parentSceneNumber || 0);
    return parentSceneNumber ? lastFrameBySceneNumber.get(parentSceneNumber) || previousLastFrame : previousLastFrame;
  }
  return previousLastFrame;
}

function getTransitionSoundMap(settings = {}) {
  const out = new Map();
  for (const item of Array.isArray(settings.htmlDefaultSfx) ? settings.htmlDefaultSfx : []) {
    const fileName = String(item.fileName || item.originalName || item.path || '').toLowerCase();
    const match = fileName.match(/^(?:escbase-)?transition-([a-z0-9-]+)\.wav$/);
    if (match && item.path) out.set(match[1], item.path);
  }
  return out;
}

function hashString(input) {
  return Array.from(String(input || '')).reduce((acc, char) => (
    ((acc * 31) + char.charCodeAt(0)) >>> 0
  ), 7);
}

function pickVisualTransition(project, boundaryIndex, sound = '') {
  const seed = `${project.id || project.title || 'project'}:${boundaryIndex}:${sound}`;
  return VISUAL_TRANSITION_POOL[hashString(seed) % VISUAL_TRANSITION_POOL.length] || 'fade';
}

function getSceneTransitionPlan(project, appSettings) {
  const htmlMode = isHtmlSource(project.settings?.imageSource);
  const soundMap = htmlMode ? getTransitionSoundMap(appSettings) : new Map();
  const transitionPreset = String(project.settings?.transitionPreset || appSettings.transitionPreset || 'fade').trim().toLowerCase();
  const boundaryCount = Math.max(0, project.scenes.length - 1);
  if (transitionPreset === 'none') {
    return { transitions: Array(boundaryCount).fill('none'), transitionSoundPaths: [] };
  }
  const transitions = [];
  const transitionSoundPaths = [];
  for (let index = 1; index < project.scenes.length; index += 1) {
    const incoming = project.scenes[index] || {};
    const explicit = String(
      incoming.htmlSpec?.transitionSound
      || incoming.htmlSpec?.transitionCue
      || incoming.transitionSound
      || ''
    ).trim().toLowerCase();
    const sound = explicit || ESCBASE_TRANSITION_SEQUENCE[hashString(`${project.id || project.title}:${index}:sound`) % ESCBASE_TRANSITION_SEQUENCE.length];
    transitions.push(transitionPreset === 'random' ? pickVisualTransition(project, index, sound) : transitionPreset);
    if (soundMap.has(sound)) transitionSoundPaths.push(soundMap.get(sound));
  }
  return { transitions, transitionSoundPaths };
}

function getSceneVideoKeyword(project, scene) {
  return scene.videoKeyword || scene.searchKeyword || scene.voiceText || project.title;
}

function collectUsedVideoRefs(project) {
  return (project.scenes || [])
    .flatMap((scene) => {
      const selected = scene.metadata?.videoSearch?.selected || {};
      return [
        scene.metadata?.videoUrl,
        selected.id ? `id:${selected.id}` : '',
        selected.pageUrl,
        selected.sourceUrl,
        selected.sourcePath,
        selected.selectedFile?.link,
        ...(selected.videoFiles || []).map((file) => file?.link)
      ];
    })
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function applyCurrentRenderSettings(project, appSettings, overrides = null) {
  if (!project?.settings || !appSettings) return false;
  const source = {
    ...appSettings,
    ...(overrides || {})
  };
  const keys = [
    'motionPreset',
    'transitionPreset',
    'subtitleEnabled',
    'subtitleFontFamily',
    'subtitleEffect',
    'subtitleTextCase',
    'subtitleColor',
    'subtitleHighlightColor',
    'subtitleMaxWordsPerLine',
    'subtitlePositionY',
    'subtitleFontScale',
    'subtitleOpacity',
    'logoSize',
    'logoPosition',
    'logoOpacity',
    'musicVolume',
    'htmlSfxVolume'
  ];
  let changed = false;
  for (const key of keys) {
    if (source[key] !== undefined && project.settings[key] !== source[key]) {
      project.settings[key] = source[key];
      changed = true;
    }
  }
  return changed;
}

async function runWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function createSemaphore(limit) {
  let count = 0;
  const queue = [];
  return {
    acquire() {
      return new Promise(resolve => {
        if (count < limit) { count++; resolve(); }
        else { queue.push(resolve); }
      });
    },
    release() {
      if (queue.length > 0) { queue.shift()(); }
      else { count--; }
    }
  };
}

function getEnvPositiveInt(name, fallback, max = Number.MAX_SAFE_INTEGER) {
  const value = Number.parseInt(String(process.env[name] || ''), 10);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(value, max);
}

async function getFlowPipelineConcurrency(project, runtimeSettings, flowMode, flowImageOnlyMode, paths) {
  if (!flowMode) return 0;
  if (flowImageOnlyMode) return getEnvPositiveInt('FLOW_IMAGE_PIPELINE_CONCURRENCY', 1, project.scenes.length);

  const requestedModel = String(runtimeSettings.flowVideoModel || '');
  const ultraModelRequested = requestedModel === 'veo_3_1_quality' || requestedModel.includes('ultra_relaxed');
  if (!ultraModelRequested) return 1;

  try {
    const account = await getConfiguredFlowAccount(runtimeSettings, project.settings?.aspectRatio);
    if (account?.accountClass === 'ultra') {
      return getEnvPositiveInt('FLOW_ULTRA_VIDEO_PIPELINE_CONCURRENCY', 1, project.scenes.length);
    }
  } catch (error) {
    await appendProjectLog(paths.projectDir, 'info', `Flow tier check failed, using safe video concurrency`, { error: error.message });
  }
  return 1;
}

async function processFlowFilmScenesSequential(project, appSettings) {
  const paths = getProjectPaths(project.id);
  let previousLastFrame = '';
  const lastFrameBySceneNumber = new Map();
  await appendProjectLog(paths.projectDir, 'info', `Processing Flow film scenes sequentially`, {
    total: project.scenes.length,
    mode: 'flow-film'
  });

  for (const scene of project.scenes) {
    checkPause(project.id);
    const sceneDir = await ensureSceneDir(project.id, scene.sceneNumber);
    const referenceFrame = getFlowFilmReferenceForScene(scene, previousLastFrame, lastFrameBySceneNumber);
    if (referenceFrame) {
      const referenceChanged = await applyFlowFilmReference(project, scene, sceneDir, referenceFrame);
      if (referenceChanged) {
        await appendProjectLog(paths.projectDir, 'info', `Flow film reference updated: scene ${scene.sceneNumber}`, {
          referenceImage: referenceFrame,
          chainType: scene.chainType || 'LEGACY_CONTINUATION'
        });
        await saveProject(project);
      }
    } else if (await clearFlowFilmReference(project, scene, sceneDir)) {
      await appendProjectLog(paths.projectDir, 'info', `Flow film chain reset: scene ${scene.sceneNumber}`, {
        chainType: scene.chainType || 'ROOT'
      });
      await saveProject(project);
    }

    try {
      await appendProjectLog(paths.projectDir, 'info', `Flow film: generating scene ${scene.sceneNumber}`);
      await generateVideoForScene(project, appSettings, scene.sceneNumber, false);
      const videoPath = sceneRenderOutputPath(project, sceneDir);
      if (await exists(videoPath) && isReadableVideoFile(videoPath, appSettings.ffprobePath, getSceneDuration(project, scene))) {
        scene.files.video = videoPath;
        await appendProjectLog(paths.projectDir, 'info', `Scene video already exists, skipping scene ${scene.sceneNumber}`);
      } else {
        await appendProjectLog(paths.projectDir, 'info', `Rendering scene video ${scene.sceneNumber}`, {
          durationSec: getSceneDuration(project, scene),
          aspectRatio: project.settings.aspectRatio
        });
        scene.files.video = await renderSceneMedia({ project, appSettings, scene, outputPath: videoPath });
        await appendProjectLog(paths.projectDir, 'info', `Scene video done: scene ${scene.sceneNumber}`);
      }

      const lastFramePath = path.join(sceneDir, 'flow-last-frame.png');
      await extractLastVideoFrame({
        ffmpegPath: appSettings.ffmpegPath,
        inputPath: scene.files.video,
        outputPath: lastFramePath
      });
      scene.metadata = scene.metadata || {};
      scene.metadata.flow = {
        ...(scene.metadata.flow || {}),
        lastFrameImagePath: projectSceneAssetPath(project, scene, 'flow-last-frame.png')
      };
      previousLastFrame = scene.metadata.flow.lastFrameImagePath;
      lastFrameBySceneNumber.set(Number(scene.sceneNumber), previousLastFrame);
      await saveProject(project);
    } catch (err) {
      scene.status = 'error';
      scene.errors = [...(scene.errors || []), `flow-film: ${err.message}`];
      await appendProjectLog(paths.projectDir, 'error', `Flow film scene failed: scene ${scene.sceneNumber} — ${err.message}`);
      await saveProject(project);
      throw err;
    }
  }
}

async function processAllScenesPipelined(project, appSettings) {
  const paths = getProjectPaths(project.id);
  const runtimeSettings = getProjectRuntimeSettings(project, appSettings);
  const videoSearchMode = isVideoSearchSource(project.settings?.imageSource);
  const flowMode = isFlowSource(project.settings?.imageSource);
  const flowImageOnlyMode = isFlowImageOnlySource(project.settings?.imageSource);
  const generatedVoiceMode = projectUsesGeneratedVoice(project);
  const htmlMode = isHtmlSource(project.settings?.imageSource);
  if (isFlowFilmSource(project.settings?.imageSource)) {
    await processFlowFilmScenesSequential(project, appSettings);
    return;
  }
  const flowConcurrency = await getFlowPipelineConcurrency(project, runtimeSettings, flowMode, flowImageOnlyMode, paths);
  const imageConcurrency = videoSearchMode ? 1 : flowMode ? flowConcurrency : project.settings.imageConcurrency;
  const imageSem = createSemaphore(imageConcurrency);
  const voiceConcurrency = 3;
  const voiceSem = createSemaphore(voiceConcurrency);
  const htmlConcurrency = htmlMode ? getEnvPositiveInt('HTML_CONCURRENCY', runtimeSettings.htmlConcurrency || 2, project.scenes.length) : 0;
  const renderConcurrency = Math.min(runtimeSettings.renderConcurrency || 2, project.scenes.length);
  const htmlSem = createSemaphore(htmlConcurrency || 1);
  const renderSem = createSemaphore(renderConcurrency);
  const chat01Client = createAiClient(runtimeSettings);
  let fatalPipelineError = null;

  await appendProjectLog(paths.projectDir, 'info', `Processing scenes (pipelined)`, {
    total: project.scenes.length,
    imageConcurrency,
    htmlConcurrency,
    renderConcurrency
  });

  checkPause(project.id);

  await Promise.all(project.scenes.map(async (scene) => {
    checkPause(project.id);
    const sceneDir = await ensureSceneDir(project.id, scene.sceneNumber);
    const sceneVideoMode = sceneUsesVideoSource(project, scene);

    // Reset error status at start of each scene so resume can retry failed scenes.
    // Completed scenes are identified by existing files, not by status.
    if (scene.status === 'error') {
      scene.status = null;
    }

    // Image
    const imagePath = path.join(sceneDir, 'image.png');
    if (htmlMode) {
      await appendProjectLog(paths.projectDir, 'info', `HTML mode: skipping image source for scene ${scene.sceneNumber}`);
    } else if (!sceneVideoMode && (await exists(imagePath))) {
      scene.files.image = imagePath;
      await appendProjectLog(paths.projectDir, 'info', `Image already exists, skipping scene ${scene.sceneNumber}`);
    } else if (!sceneVideoMode) {
      await imageSem.acquire();
      try {
        await appendProjectLog(paths.projectDir, 'info', `Generating image for scene ${scene.sceneNumber}`, getSceneImageRequestLog(project, scene));
        let imageAttempt = 0;
        const maxImageAttempts = 2;
        while (imageAttempt < maxImageAttempts) {
          try {
            imageAttempt += 1;
            if (flowImageOnlyMode) {
              await generateFlowImageForScene(project, appSettings, scene.sceneNumber, false);
            } else {
              const result = await generateSceneImage({ chat01Client, project, scene, settings: runtimeSettings, sceneDir });
              scene.files.image = result.outputPath;
              scene.metadata.imageUrl = result.imageUrl;
              if (result.imageSearch) scene.metadata.imageSearch = result.imageSearch;
            }
            await appendProjectLog(paths.projectDir, 'info', `Image done: scene ${scene.sceneNumber}`);
            await saveProject(project);
            break; // success
          } catch (imgErr) {
            if (imgErr.name === 'PipelinePausedError') throw imgErr;
            if (imageAttempt < maxImageAttempts) {
              await appendProjectLog(paths.projectDir, 'warn', `Image attempt ${imageAttempt} failed for scene ${scene.sceneNumber}, retrying in 5s — ${imgErr.message}`);
              await new Promise(res => setTimeout(res, 5000));
              checkPause(project.id);
            } else {
              throw imgErr;
            }
          }
        }
      } catch (err) {
        if (err.name === 'PipelinePausedError') throw err;
        scene.status = 'error';
        scene.errors = [...(scene.errors || []), `image: ${err.message}`];
        await appendProjectLog(paths.projectDir, 'error', `Image failed: scene ${scene.sceneNumber} — ${err.message}`);
        return;
      } finally {
        imageSem.release();
      }
    }

    // Voice
    checkPause(project.id);
    const paddedPath = path.join(sceneDir, 'voice.padded.wav');
    if (!generatedVoiceMode) {
      await appendProjectLog(paths.projectDir, 'info', `Generated-audio mode: skipping voice for scene ${scene.sceneNumber}`);
    } else if (await exists(paddedPath)) {
      scene.files.voice = paddedPath;
      scene.durations.voiceSec = await getAudioDuration(paddedPath, appSettings.ffprobePath);
      await appendProjectLog(paths.projectDir, 'info', `Voice already exists, skipping scene ${scene.sceneNumber}`, { durationSec: scene.durations.voiceSec });
    } else {
      await voiceSem.acquire();
      try {
        await appendProjectLog(paths.projectDir, 'info', `Generating voice for scene ${scene.sceneNumber}`);
        const result = await createSceneVoice({ scene, settings: appSettings, sceneDir });
        const finalPath = await addAudioTailPadding(result.voicePath, paddedPath, project.settings.voicePaddingMs, appSettings.ffmpegPath);
        scene.files.voice = finalPath;
        scene.files.autoSrt = result.rawSrtPath;
        scene.metadata.projectExportId = result.projectExportId;
        scene.durations.voiceSec = await getAudioDuration(finalPath, appSettings.ffprobePath);
        await appendProjectLog(paths.projectDir, 'info', `Voice done: scene ${scene.sceneNumber}`, { durationSec: scene.durations.voiceSec });
        await saveProject(project);
      } finally {
        voiceSem.release();
      }
    }

    // Source video search runs after voice so duration matching can use the real voice length.
    if (sceneVideoMode) {
      checkPause(project.id);
      const sourceVideoPath = path.join(sceneDir, 'source-video.mp4');
      const existingSourceVideo = scene.files?.sourceVideo && await exists(scene.files.sourceVideo)
        ? scene.files.sourceVideo
        : await exists(sourceVideoPath) ? sourceVideoPath : '';
      if (existingSourceVideo) {
        scene.files.sourceVideo = existingSourceVideo;
        scene.durations.sourceVideoSec = scene.durations.sourceVideoSec || await getAudioDuration(existingSourceVideo, appSettings.ffprobePath);
        await appendProjectLog(paths.projectDir, 'info', `Source video already exists, skipping scene ${scene.sceneNumber}`);
      } else {
        await imageSem.acquire();
        try {
          await appendProjectLog(paths.projectDir, 'info', `Searching video for scene ${scene.sceneNumber}`, getSceneImageRequestLog(project, scene));
          await generateVideoForScene(project, appSettings, scene.sceneNumber, true);
          await appendProjectLog(paths.projectDir, 'info', `Source video done: scene ${scene.sceneNumber}`);
        } catch (err) {
          scene.status = 'error';
          scene.errors = [...(scene.errors || []), `video: ${err.message}`];
          await appendProjectLog(paths.projectDir, 'error', `Video search failed: scene ${scene.sceneNumber} — ${err.message}`);
          await saveProject(project);
          return;
        } finally {
          imageSem.release();
        }
      }
    }

    // Subtitle
    if (project.settings.subtitleEnabled && generatedVoiceMode) {
      checkPause(project.id);
      const subtitlePath = path.join(sceneDir, 'voice.corrected.srt');
      if (await exists(subtitlePath)) {
        scene.files.subtitle = subtitlePath;
        await appendProjectLog(paths.projectDir, 'info', `Subtitle already exists, skipping scene ${scene.sceneNumber}`);
      } else {
        await appendProjectLog(paths.projectDir, 'info', `Generating subtitle for scene ${scene.sceneNumber}`);
        const subtitleFiles = await createCorrectedSubtitle({
          scene,
          sceneDir,
          settings: getProjectRuntimeSettings(project, appSettings),
          force: false
        });
        scene.files.subtitle = subtitleFiles.srtPath;
        scene.files.karaokeAss = subtitleFiles.assPath;
        if (subtitleFiles.fallback) {
          await appendProjectLog(paths.projectDir, 'warn', `Subtitle fallback timing used: scene ${scene.sceneNumber}`, { reason: subtitleFiles.reason });
        }
        await appendProjectLog(paths.projectDir, 'info', `Subtitle done: scene ${scene.sceneNumber}`);
        await saveProject(project);
      }
    }

    if (htmlMode) {
      checkPause(project.id);
      const htmlPath = path.join(sceneDir, 'scene.ai-html.html');
      if (await exists(htmlPath)) {
        scene.files.html = htmlPath;
        await appendProjectLog(paths.projectDir, 'info', `HTML already exists, skipping scene ${scene.sceneNumber}`);
      } else {
        await htmlSem.acquire();
        try {
          if (fatalPipelineError) return;
          await appendProjectLog(paths.projectDir, 'info', `Generating HTML for scene ${scene.sceneNumber}`);
          await generateHtmlForScene({
            project,
            scene,
            sceneDir,
            settings: runtimeSettings,
            onLog: (message, data) => appendProjectLog(paths.projectDir, 'info', message, data)
          });
          await appendProjectLog(paths.projectDir, 'info', `HTML done: scene ${scene.sceneNumber}`);
          await saveProject(project);
        } catch (err) {
          fatalPipelineError = err;
          throw err;
        } finally {
          htmlSem.release();
        }
      }
    }

    // Render
    checkPause(project.id);
    // Skip render for scenes that failed media generation (no image or source video available)
    const sceneHasMedia = sceneVideoMode ? Boolean(scene.files?.sourceVideo) : Boolean(scene.files?.image);
    if (!sceneHasMedia) {
      await appendProjectLog(paths.projectDir, 'warn', `Skipping render for scene ${scene.sceneNumber}: no media available`);
      return;
    }

    const videoPath = path.join(sceneDir, !generatedVoiceMode ? 'scene.flow-audio.mp4' : project.settings.subtitleEnabled ? 'scene.subtitled.mp4' : 'scene.voice.mp4');
    if (await exists(videoPath) && isReadableVideoFile(videoPath, appSettings.ffprobePath, getSceneDuration(project, scene))) {
      scene.files.video = videoPath;
      await appendProjectLog(paths.projectDir, 'info', `Scene video already exists, skipping scene ${scene.sceneNumber}`);
      return;
    }
    await renderSem.acquire();
    try {
      await appendProjectLog(paths.projectDir, 'info', `Rendering scene video ${scene.sceneNumber}`, { durationSec: getSceneDuration(project, scene), aspectRatio: project.settings.aspectRatio });
      scene.files.video = await renderSceneMedia({ project, appSettings, scene, outputPath: videoPath });
      await appendProjectLog(paths.projectDir, 'info', `Scene video done: scene ${scene.sceneNumber}`);
      await saveProject(project);
    } finally {
      renderSem.release();
    }
  }));

  if (fatalPipelineError) {
    throw fatalPipelineError;
  }
  const failed = project.scenes.filter((s) => s.status === 'error' && (sceneUsesVideoSource(project, s) ? !s.files.sourceVideo : !s.files.image));
  if (failed.length) {
    if (failed.length === project.scenes.length) {
      // ALL scenes failed — something is fundamentally wrong, stop the pipeline
      throw new Error(`All ${failed.length}/${project.scenes.length} media generations failed. Check API keys and quota.`);
    }
    // PARTIAL failure — log warning but continue so successfully-generated scenes can proceed to render.
    // User can Resume afterward to retry the failed scenes individually.
    await appendProjectLog(paths.projectDir, 'warn',
      `${failed.length}/${project.scenes.length} media generations failed. Pipeline will continue with successful scenes. Use Resume to retry failed scenes.`,
      { failedScenes: failed.map(s => s.sceneNumber) }
    );
  }
}

async function generateImages(project, appSettings) {
  const paths = getProjectPaths(project.id);
  const runtimeSettings = getProjectRuntimeSettings(project, appSettings);
  const chat01Client = createAiClient(runtimeSettings);
  const isFlow = isFlowSource(project.settings?.imageSource);
  const imageOnlyConcurrency = isFlow ? 1 : project.settings.imageConcurrency;
  await appendProjectLog(paths.projectDir, 'info', `Generating images`, { total: project.scenes.length, concurrency: imageOnlyConcurrency });
  await runWithConcurrency(project.scenes, imageOnlyConcurrency, async (scene) => {
    const sceneDir = await ensureSceneDir(project.id, scene.sceneNumber);
    const imagePath = path.join(sceneDir, 'image.png');
    if (await exists(imagePath)) {
      scene.files.image = imagePath;
      await appendProjectLog(paths.projectDir, 'info', `Image already exists, skipping scene ${scene.sceneNumber}`);
      return;
    }
    await appendProjectLog(paths.projectDir, 'info', `Generating image for scene ${scene.sceneNumber}`, getSceneImageRequestLog(project, scene));
    try {
      if (isFlowImageOnlySource(project.settings?.imageSource)) {
        await generateFlowImageForScene(project, appSettings, scene.sceneNumber, false);
      } else {
        const result = await generateSceneImage({ chat01Client, project, scene, settings: runtimeSettings, sceneDir });
        scene.files.image = result.outputPath;
        scene.metadata.imageUrl = result.imageUrl;
        if (result.imageSearch) scene.metadata.imageSearch = result.imageSearch;
        await appendProjectLog(paths.projectDir, 'info', `Image done: scene ${scene.sceneNumber}`, { path: result.outputPath });
      }
    } catch (err) {
      scene.status = 'error';
      scene.errors = [...(scene.errors || []), `image: ${err.message}`];
      await appendProjectLog(paths.projectDir, 'error', `Image failed: scene ${scene.sceneNumber} — ${err.message}`);
    }
    await saveProject(project);
  });
  await saveProject(project);

  const failed = project.scenes.filter((s) => s.status === 'error' && !s.files.image);
  if (failed.length === project.scenes.length) {
    throw new Error(`All ${failed.length} image generations failed. Check API keys and quota.`);
  }
}

async function generateImageForScene(project, appSettings, sceneNumber, force = false) {
  if (isFlowImageOnlySource(project.settings?.imageSource)) {
    return generateFlowImageForScene(project, appSettings, sceneNumber, force);
  }
  const scene = getSceneOrThrow(project, sceneNumber);
  const paths = getProjectPaths(project.id);
  const runtimeSettings = getProjectRuntimeSettings(project, appSettings);
  const chat01Client = createAiClient(runtimeSettings);
  const sceneDir = await ensureSceneDir(project.id, scene.sceneNumber);
  const imagePath = path.join(sceneDir, 'image.png');
  if (!force && (await exists(imagePath))) {
    scene.files.image = imagePath;
    return scene;
  }
  await appendProjectLog(paths.projectDir, 'info', `Generating image for scene ${scene.sceneNumber}`);
  const result = await generateSceneImage({ chat01Client, project, scene, settings: runtimeSettings, sceneDir });
  scene.files.image = result.outputPath;
  scene.files.video = null;
  scene.files.sourceVideo = null;
  scene.metadata.imageUrl = result.imageUrl;
  if (result.imageSearch) scene.metadata.imageSearch = result.imageSearch;
  else delete scene.metadata.imageSearch;
  await saveProject(project);
  return scene;
}

async function generateFlowImageForScene(project, appSettings, sceneNumber, force = false) {
  const scene = getSceneOrThrow(project, sceneNumber);
  const paths = getProjectPaths(project.id);
  const runtimeSettings = getProjectRuntimeSettings(project, appSettings);
  const sceneDir = await ensureSceneDir(project.id, scene.sceneNumber);
  const imagePath = path.join(sceneDir, 'image.png');
  scene.metadata = scene.metadata || {};
  scene.metadata.flow = scene.metadata.flow || {};
  if (!force && (await exists(imagePath))) {
    // Only skip if Flow actually generated this image (imageMediaId or imageUrl from Flow is present).
    // If there's no imageMediaId/imageUrl it means the file may be a stale reference image
    // that was saved by a previous bug. In that case, delete it and regenerate.
    const hasFlowImage = Boolean(scene.metadata.flow.imageMediaId || scene.metadata.flow.imageUrl);
    if (hasFlowImage) {
      scene.files.image = imagePath;
      return scene;
    }
    await appendProjectLog(paths.projectDir, 'info', `Scene ${scene.sceneNumber}: image.png found but no Flow imageMediaId — regenerating to replace possible stale reference image`);
    await fs.unlink(imagePath).catch(() => {});
  }
  // Clean up any leftover temp reference upload files from previous runs
  await fs.unlink(`${imagePath}.ref-upload.tmp`).catch(() => {});
  if (force) {
    scene.metadata.flow.imageMediaId = null;
    scene.metadata.flow.imageUrl = null;
    scene.metadata.flow.forceRegenerate = true;
  }
  await appendProjectLog(paths.projectDir, 'info', `Generating Flow image for scene ${scene.sceneNumber}`);
  const maxAttempts = 3;
  let result;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      result = await generateFlowMedia({
        project,
        scene,
        settings: runtimeSettings,
        sceneDir,
        generateVideo: false,
        exposeImage: true,
        onProgress: () => saveProject(project)
      });
      break;
    } catch (err) {
      const errStr = String(err.message || err).toUpperCase();
      const isCaptcha = errStr.includes('CAPTCHA') || errStr.includes('TIMEOUT');
      if (attempt < maxAttempts && isCaptcha) {
        await appendProjectLog(paths.projectDir, 'warn', `Flow image generation failed due to Captcha/Timeout (attempt ${attempt}/${maxAttempts}). Retrying in 5 seconds...`, { error: err.message });
        await new Promise((resolve) => setTimeout(resolve, 5000));
        // Reset Flow request properties to force a fresh recaptcha check and request submission
        if (scene.metadata?.flow) {
          scene.metadata.flow.imageRequestId = null;
          scene.metadata.flow.imageMediaId = null;
          scene.metadata.flow.imageUrl = null;
        }
        await saveProject(project);
      } else {
        throw err;
      }
    }
  }
  scene.files.image = result.imagePath;
  scene.files.video = null;
  scene.metadata.imageUrl = scene.metadata.flow?.imageUrl || '';
  await saveProject(project);
  return scene;
}

async function generateVideoForScene(project, appSettings, sceneNumber, force = false) {
  const scene = getSceneOrThrow(project, sceneNumber);
  const paths = getProjectPaths(project.id);
  const runtimeSettings = getProjectRuntimeSettings(project, appSettings);
  const sceneDir = await ensureSceneDir(project.id, scene.sceneNumber);
  const sourceVideoPath = path.join(sceneDir, 'source-video.mp4');
  if (!force && (await exists(sourceVideoPath))) {
    scene.files.sourceVideo = sourceVideoPath;
    scene.durations = scene.durations || {};
    scene.durations.sourceVideoSec = scene.durations.sourceVideoSec || await getAudioDuration(sourceVideoPath, appSettings.ffprobePath);
    return scene;
  }
  const targetDurationSec = Number(scene.durations?.voiceSec) || Number(scene.targetDurationSec) || 8;
  if (!targetDurationSec && !isFlowSource(project.settings?.imageSource)) {
    throw new Error(`Scene ${scene.sceneNumber} cần voice trước khi tìm video`);
  }
  if (isFlowSource(project.settings?.imageSource)) {
    const exposeImage = flowVideoShouldExposeImage(project.settings?.imageSource);
    await appendProjectLog(paths.projectDir, 'info', `Generating Flow video for scene ${scene.sceneNumber}`, {
      aspectRatio: project.settings.aspectRatio,
      imageModel: runtimeSettings.flowImageModel,
      videoModel: runtimeSettings.flowVideoModel || 'Flowkit default',
      flowDurationSec: scene.flowDurationSec || runtimeSettings.flowVideoDurationSec || 8
    });
    const maxAttempts = 3;
    let result;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        result = await generateFlowMedia({
          project,
          scene,
          settings: runtimeSettings,
          sceneDir,
          generateVideo: true,
          exposeImage,
          onProgress: () => saveProject(project)
        });
        break;
      } catch (err) {
        const errStr = String(err.message || err).toUpperCase();
        const isCaptcha = errStr.includes('CAPTCHA') || errStr.includes('TIMEOUT');
        if (attempt < maxAttempts && isCaptcha) {
          await appendProjectLog(paths.projectDir, 'warn', `Flow video generation failed due to Captcha/Timeout (attempt ${attempt}/${maxAttempts}). Retrying in 5 seconds...`, { error: err.message });
          await new Promise((resolve) => setTimeout(resolve, 5000));
          // Reset Flow request properties to force a fresh recaptcha check and request submission
          if (scene.metadata?.flow) {
            scene.metadata.flow.imageRequestId = null;
            scene.metadata.flow.imageMediaId = null;
            scene.metadata.flow.imageUrl = null;
            scene.metadata.flow.videoRequestId = null;
            scene.metadata.flow.videoMediaId = null;
            scene.metadata.flow.videoUrl = null;
          }
          await saveProject(project);
        } else {
          throw err;
        }
      }
    }
    scene.files.image = exposeImage ? result.imagePath : null;
    scene.files.sourceVideo = result.videoPath;
    scene.files.video = null;
    scene.durations = scene.durations || {};
    scene.durations.sourceVideoSec = await getAudioDuration(result.videoPath, appSettings.ffprobePath);
    scene.metadata.imageUrl = scene.metadata.flow?.imageUrl || '';
    scene.metadata.videoUrl = scene.metadata.flow?.videoUrl || '';
    scene.metadata.videoSearch = {
      provider: project.settings?.imageSource || 'flow-image-video',
      query: scene.videoPrompt || scene.imagePrompt || '',
      selected: scene.metadata.flow || {}
    };
    await saveProject(project);
    return scene;
  }
  const query = getSceneVideoKeyword(project, scene);
  await appendProjectLog(paths.projectDir, 'info', `${isDirectMediaSource(query) ? 'Loading direct' : 'Searching Pexels'} video for scene ${scene.sceneNumber}`, {
    keyword: String(query || '').slice(0, 80),
    targetDurationSec,
    aspectRatio: project.settings.aspectRatio
  });
  const result = isDirectMediaSource(query)
    ? await saveDirectMediaSource(query, sourceVideoPath, {
        accept: 'video/mp4,video/*,*/*;q=0.8',
        expectedType: 'video'
      })
    : await findAndDownloadVideo({
        query,
        settings: {
          ...runtimeSettings,
          imageSource: 'pexels-video',
          videoLanguage: project.settings.videoLanguage || runtimeSettings.videoLanguage
        },
        outputPath: sourceVideoPath,
        aspectRatio: project.settings.aspectRatio,
        targetDurationSec,
        usedVideoRefs: collectUsedVideoRefs(project)
      });
  scene.files.sourceVideo = result.outputPath;
  scene.files.video = null;
  scene.files.image = null;
  scene.durations = scene.durations || {};
  scene.durations.sourceVideoSec = await getAudioDuration(result.outputPath, appSettings.ffprobePath);
  scene.metadata.videoUrl = result.videoUrl || result.sourceUrl || '';
  scene.metadata.videoSearch = {
    provider: isDirectMediaSource(query) ? 'direct-url' : 'pexels-video',
    query,
    selected: result.candidate || result,
    failedCandidates: result.failedCandidates || []
  };
  delete scene.metadata.imageSearch;
  delete scene.metadata.imageUrl;
  await saveProject(project);
  return scene;
}

async function generateHtmlForSceneInProject(project, appSettings, sceneNumber, force = false) {
  const scene = getSceneOrThrow(project, sceneNumber);
  const sceneDir = await ensureSceneDir(project.id, scene.sceneNumber);
  const htmlPath = path.join(sceneDir, 'scene.ai-html.html');
  if (!force && (await exists(htmlPath))) {
    scene.files.html = htmlPath;
    return scene;
  }
  await generateHtmlForScene({
    project,
    scene,
    sceneDir,
    settings: getProjectRuntimeSettings(project, appSettings),
    onLog: (message, data) => appendProjectLog(getProjectPaths(project.id).projectDir, 'info', message, data)
  });
  scene.files.video = null;
  await saveProject(project);
  return scene;
}

async function generateVoices(project, appSettings) {
  if (!projectUsesGeneratedVoice(project)) return;
  const paths = getProjectPaths(project.id);
  await appendProjectLog(paths.projectDir, 'info', `Generating voices`, { total: project.scenes.length });
  for (const scene of project.scenes) {
    const sceneDir = await ensureSceneDir(project.id, scene.sceneNumber);
    const paddedPath = path.join(sceneDir, 'voice.padded.wav');
    if (await exists(paddedPath)) {
      scene.files.voice = paddedPath;
      scene.durations.voiceSec = await getAudioDuration(paddedPath, appSettings.ffprobePath);
      await appendProjectLog(paths.projectDir, 'info', `Voice already exists, skipping scene ${scene.sceneNumber}`, { durationSec: scene.durations.voiceSec });
      continue;
    }
    await appendProjectLog(paths.projectDir, 'info', `Generating voice for scene ${scene.sceneNumber}`);
    const result = await createSceneVoice({ scene, settings: appSettings, sceneDir });
    const finalPath = await addAudioTailPadding(
      result.voicePath,
      paddedPath,
      project.settings.voicePaddingMs,
      appSettings.ffmpegPath
    );
    scene.files.voice = finalPath;
    scene.files.autoSrt = result.rawSrtPath;
    scene.metadata.projectExportId = result.projectExportId;
    scene.durations.voiceSec = await getAudioDuration(finalPath, appSettings.ffprobePath);
    await appendProjectLog(paths.projectDir, 'info', `Voice done: scene ${scene.sceneNumber}`, { durationSec: scene.durations.voiceSec });
    await saveProject(project);
  }
}

async function generateVoiceForScene(project, appSettings, sceneNumber, force = false) {
  if (!projectUsesGeneratedVoice(project)) return getSceneOrThrow(project, sceneNumber);
  const scene = getSceneOrThrow(project, sceneNumber);
  const paths = getProjectPaths(project.id);
  const sceneDir = await ensureSceneDir(project.id, scene.sceneNumber);
  const paddedPath = path.join(sceneDir, 'voice.padded.wav');
  if (!force && (await exists(paddedPath))) {
    scene.files.voice = paddedPath;
    scene.durations.voiceSec = await getAudioDuration(paddedPath, appSettings.ffprobePath);
    return scene;
  }
  await appendProjectLog(paths.projectDir, 'info', `Generating voice for scene ${scene.sceneNumber}`);
  const result = await createSceneVoice({ scene, settings: appSettings, sceneDir });
  const finalPath = await addAudioTailPadding(
    result.voicePath,
    paddedPath,
    project.settings.voicePaddingMs,
    appSettings.ffmpegPath
  );
  scene.files.voice = finalPath;
  scene.files.autoSrt = result.rawSrtPath;
  scene.metadata.projectExportId = result.projectExportId;
  scene.durations.voiceSec = await getAudioDuration(finalPath, appSettings.ffprobePath);
  await saveProject(project);
  return scene;
}

async function generateSubtitles(project, appSettings) {
  if (!project.settings.subtitleEnabled || !projectUsesGeneratedVoice(project)) {
    return;
  }
  const paths = getProjectPaths(project.id);
  await appendProjectLog(paths.projectDir, 'info', `Generating subtitles`, { total: project.scenes.length });
  for (const scene of project.scenes) {
    const sceneDir = await ensureSceneDir(project.id, scene.sceneNumber);
    const subtitlePath = path.join(sceneDir, 'voice.corrected.srt');
    if (await exists(subtitlePath)) {
      scene.files.subtitle = subtitlePath;
      await appendProjectLog(paths.projectDir, 'info', `Subtitle already exists, skipping scene ${scene.sceneNumber}`);
      continue;
    }
    await appendProjectLog(paths.projectDir, 'info', `Generating subtitle for scene ${scene.sceneNumber}`);
    const subtitleFiles = await createCorrectedSubtitle({
      scene,
      sceneDir,
      settings: getProjectRuntimeSettings(project, appSettings),
      force: false
    });
    scene.files.subtitle = subtitleFiles.srtPath;
    scene.files.karaokeAss = subtitleFiles.assPath;
    if (subtitleFiles.fallback) {
      await appendProjectLog(paths.projectDir, 'warn', `Subtitle fallback timing used: scene ${scene.sceneNumber}`, { reason: subtitleFiles.reason });
    }
    await appendProjectLog(paths.projectDir, 'info', `Subtitle done: scene ${scene.sceneNumber}`);
    await saveProject(project);
  }
}

async function generateSubtitleForScene(project, appSettings, sceneNumber, force = false) {
  if (!project.settings.subtitleEnabled || !projectUsesGeneratedVoice(project)) {
    return null;
  }
  const scene = getSceneOrThrow(project, sceneNumber);
  const paths = getProjectPaths(project.id);
  const sceneDir = await ensureSceneDir(project.id, scene.sceneNumber);
  const subtitlePath = path.join(sceneDir, 'voice.corrected.srt');
  if (!force && (await exists(subtitlePath))) {
    scene.files.subtitle = subtitlePath;
    return scene;
  }
  await appendProjectLog(paths.projectDir, 'info', `Generating subtitle for scene ${scene.sceneNumber}`);
  const subtitleFiles = await createCorrectedSubtitle({
    scene,
    sceneDir,
    settings: getProjectRuntimeSettings(project, appSettings),
    force
  });
  scene.files.subtitle = subtitleFiles.srtPath;
  scene.files.karaokeAss = subtitleFiles.assPath;
  if (subtitleFiles.fallback) {
    await appendProjectLog(paths.projectDir, 'warn', `Subtitle fallback timing used: scene ${scene.sceneNumber}`, { reason: subtitleFiles.reason });
  }
  await saveProject(project);
  return scene;
}

async function renderSceneMedia({ project, appSettings, scene, outputPath }) {
  const generatedVoiceMode = projectUsesGeneratedVoice(project);
  const subtitlePath = project.settings.subtitleEnabled && generatedVoiceMode ? scene.files.karaokeAss || scene.files.subtitle : null;
  // Use getSceneDuration which enforces minimum from sceneDurationSec in fixed-pace mode.
  // This ensures voice shorter than configured pace still produces a full-length scene.
  const sceneDuration = getSceneDuration(project, scene);
  if (scene.files.html) {
    return renderSceneVideoFromHtml({
      ffmpegPath: appSettings.ffmpegPath,
      htmlPath: scene.files.html,
      audioPath: scene.files.voice,
      outputPath,
      duration: sceneDuration,
      subtitlePath,
      sfxVolume: project.settings?.htmlSfxVolume ?? appSettings.htmlSfxVolume
    });
  }
  if (scene.files.sourceVideo) {
    if (!generatedVoiceMode) {
      return renderSceneVideoWithOriginalAudio({
        ffmpegPath: appSettings.ffmpegPath,
        sourceVideoPath: scene.files.sourceVideo,
        outputPath,
        duration: scene.durations.sourceVideoSec,
        aspectRatio: project.settings.aspectRatio
      });
    }
    return renderSceneVideoFromSourceVideo({
      ffmpegPath: appSettings.ffmpegPath,
      sourceVideoPath: scene.files.sourceVideo,
      sourceDuration: scene.durations.sourceVideoSec,
      audioPath: scene.files.voice,
      outputPath,
      duration: sceneDuration,
      aspectRatio: project.settings.aspectRatio,
      subtitlePath
    });
  }
  return renderSceneVideo({
    ffmpegPath: appSettings.ffmpegPath,
    imagePath: scene.files.image,
    audioPath: scene.files.voice,
    outputPath,
    duration: sceneDuration,
    aspectRatio: project.settings.aspectRatio,
    subtitlePath,
    motionMode: project.settings.motionPreset,
    sceneNumber: scene.sceneNumber,
    projectId: project.id,
    imageStyle: project.settings.imageStyle
  });
}

async function renderScenes(project, appSettings) {
  const paths = getProjectPaths(project.id);
  const runtimeSettings = getProjectRuntimeSettings(project, appSettings);
  const renderConcurrency = Math.min(runtimeSettings.renderConcurrency || 2, project.scenes.length);
  await appendProjectLog(paths.projectDir, 'info', `Rendering scene videos`, {
    total: project.scenes.length,
    subtitleEnabled: project.settings.subtitleEnabled && projectUsesGeneratedVoice(project),
    concurrency: renderConcurrency
  });
  await runWithConcurrency(project.scenes, renderConcurrency, async (scene) => {
    const sceneDir = await ensureSceneDir(project.id, scene.sceneNumber);
    const videoPath = path.join(sceneDir, !projectUsesGeneratedVoice(project) ? 'scene.flow-audio.mp4' : project.settings.subtitleEnabled ? 'scene.subtitled.mp4' : 'scene.voice.mp4');
    if (await exists(videoPath) && isReadableVideoFile(videoPath, appSettings.ffprobePath, getSceneDuration(project, scene))) {
      scene.files.video = videoPath;
      await appendProjectLog(paths.projectDir, 'info', `Scene video already exists, skipping scene ${scene.sceneNumber}`);
      return;
    }
    await appendProjectLog(paths.projectDir, 'info', `Rendering scene video ${scene.sceneNumber}`, {
      durationSec: getSceneDuration(project, scene),
      aspectRatio: project.settings.aspectRatio
    });
    scene.files.video = await renderSceneMedia({ project, appSettings, scene, outputPath: videoPath });
    await appendProjectLog(paths.projectDir, 'info', `Scene video done: scene ${scene.sceneNumber}`, { path: videoPath });
    await saveProject(project);
  });
}

async function renderSingleScene(project, appSettings, sceneNumber, force = false) {
  const scene = getSceneOrThrow(project, sceneNumber);
  const paths = getProjectPaths(project.id);
  const sceneDir = await ensureSceneDir(project.id, scene.sceneNumber);
  const videoPath = path.join(sceneDir, !projectUsesGeneratedVoice(project) ? 'scene.flow-audio.mp4' : project.settings.subtitleEnabled ? 'scene.subtitled.mp4' : 'scene.voice.mp4');
  if (!force && (await exists(videoPath)) && isReadableVideoFile(videoPath, appSettings.ffprobePath, getSceneDuration(project, scene))) {
    scene.files.video = videoPath;
    return scene;
  }
  await appendProjectLog(paths.projectDir, 'info', `Rendering scene video ${scene.sceneNumber}`);
  scene.files.video = await renderSceneMedia({ project, appSettings, scene, outputPath: videoPath });
  await saveProject(project);
  return scene;
}

async function _generateThumbnailForProject(project, appSettings, force = false) {
  const paths = getProjectPaths(project.id);
  const runtimeSettings = getProjectRuntimeSettings(project, appSettings);
  const thumbnailPath = path.join(paths.outputDir, 'thumbnail.jpg');
  if (!force && (await exists(thumbnailPath))) {
    await appendProjectLog(paths.projectDir, 'info', `Thumbnail already exists, skipping`);
    await normalizeStillImageToAspect(runtimeSettings.ffmpegPath, thumbnailPath, thumbnailPath, runtimeSettings.aspectRatio);
    project.outputs.thumbnail = thumbnailPath;
    await saveProject(project);
    return thumbnailPath;
  }
  const thumbnailRequest = {
    prompt: String(project.thumbnailPrompt || project.thumbnailKeyword || project.title || '').slice(0, 80),
    provider: runtimeSettings.thumbnailImageProvider || 'chat01'
  };
  await appendProjectLog(paths.projectDir, 'info', `Generating thumbnail`, {
    ...thumbnailRequest,
    aspectRatio: runtimeSettings.aspectRatio
  });
  const thumbnailSettings = {
    ...runtimeSettings,
    imageGenerationProvider: runtimeSettings.thumbnailImageProvider || 'chat01'
  };
  const chat01Client = createAiClient(thumbnailSettings);
  try {
    await generateThumbnailImage({
      chat01Client,
      project,
      settings: thumbnailSettings,
      outputPath: thumbnailPath
    });
  } catch (error) {
    await appendProjectLog(paths.projectDir, 'warn', `Thumbnail AI generation failed, trying fallback: ${error.message}`);
    try {
      await generateThumbnailFallbackImage({
        project,
        settings: runtimeSettings,
        outputPath: thumbnailPath
      });
      await normalizeStillImageToAspect(runtimeSettings.ffmpegPath, thumbnailPath, thumbnailPath, runtimeSettings.aspectRatio);
      project.outputs.thumbnail = thumbnailPath;
      await saveProject(project);
      await appendProjectLog(paths.projectDir, 'info', `Thumbnail fallback done`, {
        path: thumbnailPath,
        aspectRatio: runtimeSettings.aspectRatio
      });
      return thumbnailPath;
    } catch (fallbackError) {
      await appendProjectLog(paths.projectDir, 'warn', `Thumbnail fallback failed: ${fallbackError.message}`);
    }
    if (await exists(thumbnailPath)) {
      await normalizeStillImageToAspect(runtimeSettings.ffmpegPath, thumbnailPath, thumbnailPath, runtimeSettings.aspectRatio);
      project.outputs.thumbnail = thumbnailPath;
      await saveProject(project);
      await appendProjectLog(paths.projectDir, 'warn', `Thumbnail generation failed, keeping existing thumbnail: ${error.message}`);
      return thumbnailPath;
    }

    const fallbackImage = project.scenes
      .map((scene) => scene.files?.image)
      .find(Boolean);
    if (!fallbackImage || !(await exists(fallbackImage))) {
      throw error;
    }

    await fs.mkdir(path.dirname(thumbnailPath), { recursive: true });
    await fs.copyFile(fallbackImage, thumbnailPath);
    await normalizeStillImageToAspect(runtimeSettings.ffmpegPath, thumbnailPath, thumbnailPath, runtimeSettings.aspectRatio);
    project.outputs.thumbnail = thumbnailPath;
    await saveProject(project);
    await appendProjectLog(paths.projectDir, 'warn', `Thumbnail generation failed, using first scene image as fallback: ${error.message}`, {
      fallbackImage
    });
    return thumbnailPath;
  }
  await normalizeStillImageToAspect(runtimeSettings.ffmpegPath, thumbnailPath, thumbnailPath, runtimeSettings.aspectRatio);
  project.outputs.thumbnail = thumbnailPath;
  await saveProject(project);
  await appendProjectLog(paths.projectDir, 'info', `Thumbnail done`, {
    path: thumbnailPath,
    aspectRatio: runtimeSettings.aspectRatio
  });
  return thumbnailPath;
}

async function generateThumbnailVerticalForProject(project, appSettings, force = false) {
  const paths = getProjectPaths(project.id);
  const runtimeSettings = getProjectRuntimeSettings(project, appSettings);
  const verticalThumbnailPath = path.join(paths.outputDir, 'thumbnail.vertical.jpg');

  if (!force && (await exists(verticalThumbnailPath))) {
    project.outputs.thumbnailVertical = verticalThumbnailPath;
    await saveProject(project);
    return verticalThumbnailPath;
  }

  const hasPrompt = !!project.thumbnailPromptVertical;
  if (hasPrompt) {
    await appendProjectLog(paths.projectDir, 'info', `Generating vertical 9:16 thumbnail using vertical prompt`);
    const thumbnailSettings = {
      ...runtimeSettings,
      imageGenerationProvider: runtimeSettings.thumbnailImageProvider || 'chat01'
    };
    const chat01Client = createAiClient(thumbnailSettings);

    try {
      const { generateThumbnailImage } = require('./imageService');
      await generateThumbnailImage({
        chat01Client,
        project,
        settings: thumbnailSettings,
        outputPath: verticalThumbnailPath,
        targetAspectRatio: '9:16',
        targetPrompt: project.thumbnailPromptVertical
      });
      project.outputs.thumbnailVertical = verticalThumbnailPath;
      await saveProject(project);
      await appendProjectLog(paths.projectDir, 'info', `Vertical thumbnail AI generation done`);
      return verticalThumbnailPath;
    } catch (err) {
      await appendProjectLog(paths.projectDir, 'warn', `Vertical AI generation failed: ${err.message}. Falling back to blurred landscape...`);
    }
  }

  let horizontalPath = project.outputs?.thumbnail;
  if (!horizontalPath || !(await exists(horizontalPath))) {
    horizontalPath = await _generateThumbnailForProject(project, appSettings, false);
  }

  try {
    await appendProjectLog(paths.projectDir, 'info', `Generating vertical 9:16 thumbnail from landscape thumbnail (blurred background fallback)`);
    const verticalSettings = project.verticalSettings || {};
    const { normalizeStillImageWithBlurredBackground } = require('./renderService');
    await normalizeStillImageWithBlurredBackground(
      runtimeSettings.ffmpegPath,
      horizontalPath,
      verticalThumbnailPath,
      '9:16',
      {
        blurPercent: verticalSettings.blurPercent ?? 50,
        topText: verticalSettings.topText || '',
        bottomText: verticalSettings.bottomText || '',
        fontFamily: verticalSettings.fontFamily || 'Arial',
        topFontSize: verticalSettings.topFontSize || 64,
        bottomFontSize: verticalSettings.bottomFontSize || 64,
        topPositionY: verticalSettings.topPositionY ?? 18,
        bottomPositionY: verticalSettings.bottomPositionY ?? 83,
        topColor: verticalSettings.topColor || 'white',
        bottomColor: verticalSettings.bottomColor || 'yellow',
        topLineHeight: verticalSettings.topLineHeight ?? 1.4,
        bottomLineHeight: verticalSettings.bottomLineHeight ?? 1.4
      }
    );
    project.outputs.thumbnailVertical = verticalThumbnailPath;
    await saveProject(project);
    await appendProjectLog(paths.projectDir, 'info', `Vertical thumbnail created from landscape thumbnail`);
  } catch (err) {
    await appendProjectLog(paths.projectDir, 'warn', `Failed to generate vertical thumbnail from landscape: ${err.message}`);
  }

  return verticalThumbnailPath;
}

async function generateThumbnailForProject(project, appSettings, force = false) {
  const thumbnailPath = await _generateThumbnailForProject(project, appSettings, force);
  const runtimeSettings = getProjectRuntimeSettings(project, appSettings);
  if (runtimeSettings.aspectRatio === '16:9') {
    await generateThumbnailVerticalForProject(project, appSettings, force);
  }
  return thumbnailPath;
}

async function generateSeoForProject(project, appSettings, force = false) {
  const paths = getProjectPaths(project.id);
  if (!force && (project.seo || (await exists(paths.seoFile)))) {
    await appendProjectLog(paths.projectDir, 'info', `SEO metadata already exists, skipping`);
    return project.seo;
  }
  await appendProjectLog(paths.projectDir, 'info', `Generating SEO metadata`);
  const chat01Client = createAiClient(appSettings);
  project.seo = await generateSeo(chat01Client, project);
  await writeJson(paths.seoFile, project.seo);
  await saveProject(project);
  await appendProjectLog(paths.projectDir, 'info', `SEO done`, { title: project.seo?.title });
  return project.seo;
}

async function assembleFinalVideo(project, appSettings, force = false, options = {}) {
  const paths = getProjectPaths(project.id);
  const sceneVideos = project.scenes
    .filter((scene) => scene.files.video)
    .map((scene) => ({ path: scene.files.video, duration: getSceneDuration(project, scene) }));
  const assembledPath = path.join(paths.outputDir, 'video.no-music.mp4');
  const finalPath = path.join(paths.outputDir, 'video.final.mp4');
  const hasIntro = Boolean(project.outputs.introVideo);
  const hasOutro = Boolean(project.outputs.outroVideo);
  const mainFinalPath = hasIntro || hasOutro
    ? path.join(paths.outputDir, 'video.without-extra-videos.mp4')
    : finalPath;
  const introFinalPath = hasIntro && hasOutro
    ? path.join(paths.outputDir, 'video.with-intro.mp4')
    : finalPath;
  const forceConcat = Boolean(force || options.forceConcat);
  const forceMain = Boolean(force || options.forceMain);
  const forceIntro = Boolean(force || options.forceIntro);
  const forceOutro = Boolean(force || options.forceOutro);
  const assembledMissing = !(await exists(assembledPath));
  const concatStale = !assembledMissing && (await anySceneVideoNewerThanOutput(sceneVideos, assembledPath));
  let concatChanged = false;

  if (forceConcat || assembledMissing || concatStale) {
    const transitionPlan = getSceneTransitionPlan(project, appSettings);
    await appendProjectLog(paths.projectDir, 'info', `Concatenating scene videos`, {
      sceneCount: sceneVideos.length,
      xfadeDurationSec: project.settings.xfadeDurationSec,
      transitions: transitionPlan.transitions,
      transitionSfxCount: transitionPlan.transitionSoundPaths.length
    });
    await concatSceneVideos({
      ffmpegPath: appSettings.ffmpegPath,
      scenes: sceneVideos,
      outputPath: assembledPath,
      xfadeDurationSec: project.settings.xfadeDurationSec,
      transitions: transitionPlan.transitions,
      transitionSoundPaths: transitionPlan.transitionSoundPaths,
      transitionSoundVolume: project.settings?.htmlSfxVolume ?? appSettings.htmlSfxVolume
    });
    concatChanged = true;
    await appendProjectLog(paths.projectDir, 'info', `Concat done`, { path: assembledPath });
  } else {
    await appendProjectLog(paths.projectDir, 'info', `Concat video already exists, skipping`);
  }

  const currentRenderSettings = {
    musicPaths: project.outputs.backgroundMusicFiles || (project.outputs.backgroundMusic ? [project.outputs.backgroundMusic] : []),
    musicVolume: project.settings?.musicVolume ?? appSettings.musicVolume ?? 0.18,
    logo: project.outputs.logo || '',
    logoSize: project.settings?.logoSize ?? appSettings.logoSize ?? 120,
    logoPosition: project.settings?.logoPosition || appSettings.logoPosition || 'top-right',
    logoOpacity: project.settings?.logoOpacity ?? appSettings.logoOpacity ?? 1,
    watermarkText: project.settings?.watermarkText || '',
    watermarkFontSize: project.settings?.watermarkFontSize ?? 24,
    watermarkOpacity: project.settings?.watermarkOpacity ?? 30,
    watermarkBehavior: project.settings?.watermarkBehavior || 'interval',
    watermarkInterval: project.settings?.watermarkInterval ?? 5,
    watermarkSpeed: project.settings?.watermarkSpeed || 'medium',
    renderPreset: project.settings?.renderPreset || appSettings.renderPreset || 'fast'
  };

  const settingsChanged = !project.outputs.lastRenderedSettings ||
    JSON.stringify(currentRenderSettings.musicPaths) !== JSON.stringify(project.outputs.lastRenderedSettings.musicPaths) ||
    currentRenderSettings.musicVolume !== project.outputs.lastRenderedSettings.musicVolume ||
    currentRenderSettings.logo !== project.outputs.lastRenderedSettings.logo ||
    currentRenderSettings.logoSize !== project.outputs.lastRenderedSettings.logoSize ||
    currentRenderSettings.logoPosition !== project.outputs.lastRenderedSettings.logoPosition ||
    currentRenderSettings.logoOpacity !== project.outputs.lastRenderedSettings.logoOpacity ||
    currentRenderSettings.watermarkText !== project.outputs.lastRenderedSettings.watermarkText ||
    currentRenderSettings.watermarkFontSize !== project.outputs.lastRenderedSettings.watermarkFontSize ||
    currentRenderSettings.watermarkOpacity !== project.outputs.lastRenderedSettings.watermarkOpacity ||
    currentRenderSettings.watermarkBehavior !== project.outputs.lastRenderedSettings.watermarkBehavior ||
    currentRenderSettings.watermarkInterval !== project.outputs.lastRenderedSettings.watermarkInterval ||
    currentRenderSettings.watermarkSpeed !== project.outputs.lastRenderedSettings.watermarkSpeed ||
    currentRenderSettings.renderPreset !== project.outputs.lastRenderedSettings.renderPreset;

  const mainMissing = !(await exists(mainFinalPath));
  const mainStale = !mainMissing && (concatChanged || settingsChanged || (await fileIsNewerThan(assembledPath, mainFinalPath)));
  let mainChanged = false;

  if (forceMain || mainMissing || mainStale) {
    const musicPaths = currentRenderSettings.musicPaths;
    const musicVolume = currentRenderSettings.musicVolume;
    await appendProjectLog(paths.projectDir, 'info', `Adding music/logo`, {
      musicCount: musicPaths.length,
      hasLogo: Boolean(currentRenderSettings.logo),
      musicVolume
    });
    await addBackgroundMusicAndLogo({
      ffmpegPath: appSettings.ffmpegPath,
      inputPath: assembledPath,
      musicPaths,
      logoPath: currentRenderSettings.logo,
      outputPath: mainFinalPath,
      musicVolume,
      logoSize: currentRenderSettings.logoSize,
      logoPosition: currentRenderSettings.logoPosition,
      logoOpacity: currentRenderSettings.logoOpacity,
      watermarkText: currentRenderSettings.watermarkText,
      watermarkFontSize: currentRenderSettings.watermarkFontSize,
      watermarkOpacity: currentRenderSettings.watermarkOpacity,
      watermarkBehavior: currentRenderSettings.watermarkBehavior,
      watermarkInterval: currentRenderSettings.watermarkInterval,
      watermarkSpeed: currentRenderSettings.watermarkSpeed,
      renderPreset: currentRenderSettings.renderPreset
    });
    mainChanged = true;
    project.outputs.lastRenderedSettings = currentRenderSettings;
    await saveProject(project);
    await appendProjectLog(paths.projectDir, 'info', `Main video ready`, { path: mainFinalPath });
  } else {
    await appendProjectLog(paths.projectDir, 'info', `Main video already exists, skipping`);
  }

  let edgeInputPath = mainFinalPath;
  if (project.outputs.introVideo) {
    const introMissing = !(await exists(introFinalPath));
    const introStale = !introMissing && (
      mainChanged
      || (await fileIsNewerThan(mainFinalPath, introFinalPath))
      || (await fileIsNewerThan(project.outputs.introVideo, introFinalPath))
    );
    let introChanged = false;

    if (forceIntro || forceMain || introMissing || introStale) {
      await appendProjectLog(paths.projectDir, 'info', `Prepending intro video`, { introVideo: project.outputs.introVideo });
      await prependIntroVideo({
        ffmpegPath: appSettings.ffmpegPath,
        inputPath: mainFinalPath,
        introPath: project.outputs.introVideo,
        outputPath: introFinalPath,
        aspectRatio: project.settings?.aspectRatio || appSettings.aspectRatio
      });
      introChanged = true;
      await appendProjectLog(paths.projectDir, 'info', `Video ready with intro`, { path: introFinalPath });
    } else {
      await appendProjectLog(paths.projectDir, 'info', `Video with intro already exists, skipping`);
    }
    edgeInputPath = introFinalPath;
    mainChanged = mainChanged || introChanged;
  }

  if (project.outputs.outroVideo) {
    const outroMissing = !(await exists(finalPath));
    const outroStale = !outroMissing && (
      mainChanged
      || (await fileIsNewerThan(edgeInputPath, finalPath))
      || (await fileIsNewerThan(project.outputs.outroVideo, finalPath))
    );

    if (forceOutro || forceMain || outroMissing || outroStale) {
      await appendProjectLog(paths.projectDir, 'info', `Appending outro video`, { outroVideo: project.outputs.outroVideo });
      await appendOutroVideo({
        ffmpegPath: appSettings.ffmpegPath,
        inputPath: edgeInputPath,
        outroPath: project.outputs.outroVideo,
        outputPath: finalPath,
        aspectRatio: project.settings?.aspectRatio || appSettings.aspectRatio
      });
      await appendProjectLog(paths.projectDir, 'info', `Final video ready with outro`, { path: finalPath });
    } else {
      await appendProjectLog(paths.projectDir, 'info', `Final video with outro already exists, skipping`);
    }
  }

  project.outputs.videoNoMusic = assembledPath;
  project.outputs.videoFinal = finalPath;
  await saveProject(project);
  return { assembledPath, finalPath };
}

async function finalizeProject(project, appSettings, force = false, options = {}) {
  checkPause(project.id);
  await assembleFinalVideo(project, appSettings, force, options);
  await markStep(project, 'running', 'video-assembled');

  if (project.settings?.generateThumbnailEnabled) {
    checkPause(project.id);
    await generateThumbnailForProject(project, appSettings, options.forceThumbnail ?? force);
    await markStep(project, 'running', 'thumbnail-ready');
  }

  // SEO là bước cuối — lỗi SEO không nên làm fail cả project
  if (project.settings?.generateSeoEnabled) {
    checkPause(project.id);
    try {
      await generateSeoForProject(project, appSettings, options.forceSeo ?? force);
    } catch (seoErr) {
      await appendProjectLog(getProjectPaths(project.id).projectDir, 'warn', `SEO generation failed (non-fatal): ${seoErr.message}`, { stack: seoErr.stack });
    }
  }
}

async function runProjectPipeline(projectId) {
  const project = await getProject(projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }
  const appSettings = getProjectAppSettings(project, await getSettings());
  const paths = getProjectPaths(project.id);
  clearFlowSetupPromises();
  try {
    await markStep(project, 'running', 'started');
    await appendProjectLog(paths.projectDir, 'info', 'Pipeline started');

    await ensureScript(project, appSettings);
    await markStep(project, 'running', 'script-ready');

    await processAllScenesPipelined(project, appSettings);
    await markStep(project, 'running', 'scenes-rendered');

    await finalizeProject(project, appSettings);
    await markStep(project, 'completed', 'done');
    await appendProjectLog(paths.projectDir, 'info', 'Pipeline completed');
  } catch (error) {
    if (error.name === 'PipelinePausedError') {
      await appendProjectLog(paths.projectDir, 'info', `Pipeline paused at step [${project.lastCompletedStep}]`);
      await markStep(project, 'paused', project.lastCompletedStep, 'Tạm dừng bởi người dùng');
      return;
    }
    await appendProjectLog(paths.projectDir, 'error', `Pipeline failed at step [${project.lastCompletedStep}]: ${error.message}`, { stack: error.stack });
    await markStep(project, 'failed', project.lastCompletedStep, error.message);
    throw error;
  }
}

async function createProjectAndStart(payload) {
  const project = await createProject(payload);
  return project;
}

async function renderProjectOutputs(projectId, force = true, options = {}) {
  const project = await getProject(projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }
  const appSettings = getProjectAppSettings(project, await getSettings());
  const paths = getProjectPaths(project.id);
  try {
    if (!project.scenes || project.scenes.length === 0) {
      throw new Error('Không có phân cảnh nào để render. Vui lòng bấm Resume để tạo kịch bản trước.');
    }
    await markStep(project, 'running', 'render-started');
    await finalizeProject(project, appSettings, force, options);
    await markStep(project, 'completed', 'done');
    await appendProjectLog(paths.projectDir, 'info', 'Render completed');
    return project;
  } catch (error) {
    if (error.name === 'PipelinePausedError') {
      await appendProjectLog(paths.projectDir, 'info', `Render paused at step [${project.lastCompletedStep}]`);
      await markStep(project, 'paused', project.lastCompletedStep, 'Tạm dừng bởi người dùng');
      return project;
    }
    await markStep(project, 'failed', project.lastCompletedStep, error.message);
    throw error;
  }
}

async function sceneVideoAvailable(scene) {
  return Boolean(scene.files?.video && (await exists(scene.files.video)));
}

async function fileMtimeMs(filePath) {
  if (!filePath) return 0;
  try {
    const stat = await fs.stat(filePath);
    return stat.mtimeMs || 0;
  } catch {
    return 0;
  }
}

async function fileIsNewerThan(inputPath, outputPath) {
  const [inputMtime, outputMtime] = await Promise.all([
    fileMtimeMs(inputPath),
    fileMtimeMs(outputPath)
  ]);
  return inputMtime > outputMtime;
}

async function anySceneVideoNewerThanOutput(sceneVideos, outputPath) {
  const outputMtime = await fileMtimeMs(outputPath);
  if (!outputMtime) return true;
  for (const scene of sceneVideos) {
    if ((await fileMtimeMs(scene.path)) > outputMtime) return true;
  }
  return false;
}

async function rebuildAllScenesAndFinalize(projectId, renderSettings = null, changeSummary = {}) {
  const project = await getProject(projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }
  const appSettings = getProjectAppSettings(project, await getSettings());
  const paths = getProjectPaths(project.id);
  await markStep(project, 'running', 'render-started');
  const appSettingsChanged = applyCurrentRenderSettings(project, appSettings, renderSettings);
  if (appSettingsChanged) {
    await saveProject(project);
  }
  const changedSettings = changeSummary.changedSettings || [];
  const changedAssets = changeSummary.changedAssets || [];
  const htmlMode = isHtmlSource(project.settings?.imageSource);
  const htmlSourceChanged = htmlMode && changedAssets.includes('htmlMedia');
  const sceneSettingsChanged = appSettingsChanged
    || changedSettings.some((key) => SCENE_RENDER_SETTING_KEYS.has(key))
    || htmlSourceChanged;
  const subtitleSettingsChanged = appSettingsChanged || changedSettings.some((key) => SUBTITLE_RENDER_SETTING_KEYS.has(key));
  const videoSearchMode = isVideoSearchSource(project.settings?.imageSource);

  try {
    if (!project.scenes || project.scenes.length === 0) {
      throw new Error('Không có phân cảnh nào để render. Vui lòng bấm Resume để tạo kịch bản trước.');
    }
    for (const scene of project.scenes) {
      checkPause(project.id);
      const shouldRenderScene = sceneSettingsChanged || !(await sceneVideoAvailable(scene));
      if (!shouldRenderScene) {
        await appendProjectLog(paths.projectDir, 'info', `Scene video unchanged, reusing scene ${scene.sceneNumber}`);
        continue;
      }
      if (htmlMode) {
        // HTML scenes do not need generated/search images.
      } else if (!sceneUsesVideoSource(project, scene) && !scene.files?.sourceVideo && !scene.files?.image) {
        checkPause(project.id);
        await generateImageForScene(project, appSettings, scene.sceneNumber, false);
      }
      checkPause(project.id);
      await generateVoiceForScene(project, appSettings, scene.sceneNumber, false);
      if (sceneUsesVideoSource(project, scene) && !scene.files?.sourceVideo) {
        checkPause(project.id);
        await generateVideoForScene(project, appSettings, scene.sceneNumber, false);
      }
      if (project.settings.subtitleEnabled) {
        checkPause(project.id);
        await generateSubtitleForScene(project, appSettings, scene.sceneNumber, subtitleSettingsChanged);
      }
      if (htmlMode && (!scene.files?.html || htmlSourceChanged)) {
        const sceneDir = await ensureSceneDir(project.id, scene.sceneNumber);
        checkPause(project.id);
        await generateHtmlForScene({
          project,
          scene,
          sceneDir,
          settings: getProjectRuntimeSettings(project, appSettings),
          onLog: (message, data) => appendProjectLog(paths.projectDir, 'info', message, data)
        });
      }
      checkPause(project.id);
      await renderSingleScene(project, appSettings, scene.sceneNumber, sceneSettingsChanged);
    }
    checkPause(project.id);
    await finalizeProject(project, appSettings, false, {
      forceConcat: true,
      forceMain: true,
      forceIntro: true,
      forceOutro: true,
      forceThumbnail: false,
      forceSeo: false
    });
    await markStep(project, 'completed', 'done');
    await appendProjectLog(paths.projectDir, 'info', 'Render completed');
    return project;
  } catch (error) {
    if (error.name === 'PipelinePausedError') {
      await appendProjectLog(paths.projectDir, 'info', `Render paused at step [${project.lastCompletedStep}]`);
      await markStep(project, 'paused', project.lastCompletedStep, 'Tạm dừng bởi người dùng');
      return project;
    }
    await markStep(project, 'failed', project.lastCompletedStep, error.message);
    throw error;
  }
}

async function saveSceneSubtitle(projectId, sceneNumber, subtitleText) {
  const project = await getProject(projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }
  const scene = getSceneOrThrow(project, sceneNumber);
  const sceneDir = await ensureSceneDir(projectId, scene.sceneNumber);
  const subtitleFiles = await saveManualSubtitle({
    sceneDir,
    subtitleText,
    settings: getProjectRuntimeSettings(project, getProjectAppSettings(project, await getSettings()))
  });
  scene.files.subtitle = subtitleFiles.srtPath;
  scene.files.karaokeAss = subtitleFiles.assPath;
  await saveProject(project);
  return scene;
}

module.exports = {
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
};
