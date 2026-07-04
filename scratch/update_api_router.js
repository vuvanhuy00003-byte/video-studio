const fs = require('fs');
const path = require('path');

let code = fs.readFileSync('src/routes/api.js', 'utf8');

// 1. Update imports from constants
code = code.replace(
  /const \{\s*MOTION_OPTIONS,[\s\S]*?normalizeAspectRatio\s*\} = require\('\.\.\/config\/constants'\);/,
  `const {
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
  normalizeAspectRatio
} = require('../config/constants');`
);

// 2. Update imports from projectService
code = code.replace(
  /const \{\s*getProjectDetails,[\s\S]*?isHtmlSource\s*\} = require\('\.\.\/services\/projectService'\);/,
  `const { getProjectDetails, getProject, saveProject, getProjectPaths, ensureSceneDir, isImageSearchSource, isVideoSearchSource, isHtmlSource, isFlowSource, isFlowVideoSource, isFlowAudioSource } = require('../services/projectService');`
);

// 3. Add services imports
const serviceImportAnchor = "const { normalizeStillImageWithBlurredBackground } = require('../services/renderService');";
code = code.replace(
  serviceImportAnchor,
  `${serviceImportAnchor}
const { getFlowStatus } = require('../services/flowClient');
const { getOmniVoiceStatus, prepareOmniVoiceVoice } = require('../services/omnivoiceClient');
const { getVideoLanguageConfig } = require('../config/languages');`
);

// 4. Add helper functions
const helpersAnchor = "const upload = multer({ dest: TMP_DIR });";
code = code.replace(
  helpersAnchor,
  `${helpersAnchor}

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
}`
);

// 5. Update createApiRouter signature
code = code.replace(
  "function createApiRouter() {",
  "function createApiRouter({ localServices } = {}) {"
);

// 6. Insert new routes after the deleteCustomStyle route
const deleteStyleAnchor = `  router.delete('/styles/:styleValue', async (req, res, next) => {
    try {
      await deleteCustomStyle(req.params.styleValue);
      res.json({ styles: await listImageStyles(), settings: await getSettings() });
    } catch (error) {
      next(error);
    }
  });`;

const newRoutesBlock = `  router.delete('/styles/:styleValue', async (req, res, next) => {
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
      const refAudioPath = path.join(OMNIVOICE_VOICES_DIR, `${id}${ext}`);
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
  });`;

code = code.replace(deleteStyleAnchor, newRoutesBlock);

// 7. Update getSettings/saveSettings calls to getRequestSettings/saveRequestSettings
// Replace router.get('/bootstrap') Settings call
code = code.replace(
  /router\.get\('\/bootstrap', async \(req, res, next\) => \{([\s\S]*?)getSettings\(\)/,
  `router.get('/bootstrap', async (req, res, next) => {$1getRequestSettings(req)`
);

// Replace router.post('/settings') Settings call
code = code.replace(
  /router\.post\('\/settings', async \(req, res, next\) => \{([\s\S]*?)saveSettings\(/,
  `router.post('/settings', async (req, res, next) => {$1saveRequestSettings(req, `
);

// Replace html-default-media settings calls
code = code.replace(
  /const current = await getSettings\(\);(\s*const files = req.files)/,
  'const current = await getRequestSettings(req);$1'
);

code = code.replace(
  /const settings = await saveSettings\(\{([\s\S]*?)\}\);(\s*res\.json)/,
  'const settings = await saveRequestSettings(req, { ...sfxUpdate, ...brandUpdate });$2'
);

// Replace html-default-media-json settings calls
code = code.replace(
  /const settings = await saveSettings\(\{/,
  'const settings = await saveRequestSettings(req, {'
);

// Replace crawl-url settings calls
code = code.replace(
  /await getSettings\(\)\)/,
  'await getRequestSettings(req))'
);

// Replace tts preview settings calls
code = code.replace(
  /const current = await getSettings\(\);/,
  'const current = await getRequestSettings(req);'
);
code = code.replace(
  /const previewText = current\.videoLanguage === 'en'[\s\S]*?API khoá API\.";/,
  'const previewText = getVideoLanguageConfig(req.body?.videoLanguage || current.videoLanguage).previewText;'
);

// 8. Update POST /projects settings block and appSettings load
code = code.replace(
  /referenceImageUrl: body\.referenceImageUrl \|\| '',([\s\S]*?motionPreset:)/,
  `referenceImageUrl: body.referenceImageUrl || '',
          flowImageModel: flowImageModelFromBody(body.flowImageModel),
          flowVideoModel: flowVideoModelFromBody(body.flowVideoModel),
          flowVideoDurationSec: flowVideoDurationFromBody(body.flowVideoDurationSec),
          $1`
);
code = code.replace(
  /const appSettings = await getSettings\(\);(\s*const projects = \[\];)/,
  'const appSettings = await getRequestSettings(req);$1'
);

// 9. Update scene edit PATCH /projects/:projectId/scenes/:sceneNumber
code = code.replace(
  /scene\.useReferenceImage = req\.body\.useReferenceImage \?\? scene\.useReferenceImage;([\s\S]*?scene\.sceneReferenceImageUrl = req\.body\.sceneReferenceImageUrl \?\? scene\.sceneReferenceImageUrl;[\s\S]*?\})([\s\S]*?await saveProject\(project\);)/,
  `scene.useReferenceImage = req.body.useReferenceImage === true || req.body.useReferenceImage === 'true' || req.body.useReferenceImage === 'on' || req.body.useReferenceImage === '1';
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
      $2`
);

// 10. Update actions:
// - scenes action handler
code = code.replace(
  /const appSettings = await getSettings\(\);(\s*const taskMap =)/,
  'const appSettings = getProjectAppSettings(project, await getRequestSettings(req));$1'
);

// - convert-vertical route settings load
code = code.replace(
  /const appSettings = await getSettings\(\);(\s*const ffmpegPath)/,
  'const appSettings = await getRequestSettings(req);$1'
);

// - project action handler settings load and applyRenderPayloadToProject call
code = code.replace(
  /const changeSummary = \(action === 'render-all' \|\| action === 'finalize'\)\s*\? await applyRenderPayloadToProject\(project, req\.body \|\| \{\}, req\.files \|\| \{\}\)/,
  "const changeSummary = (action === 'render-all' || action === 'finalize') ? await applyRenderPayloadToProject(project, req.body || {}, req.files || {}, appSettings)"
);
code = code.replace(
  /const appSettings = await getSettings\(\);(\s*const renderSettings =)/,
  'const appSettings = getProjectAppSettings(project, await getRequestSettings(req));$1'
);

// In project action taskMap, replace thumbnail/seo actions with getRequestSettings and add thumbnail-vertical
code = code.replace(
  /thumbnail: async \(\) => \{([\s\S]*?const appSettings = )await getSettings\(\);([\s\S]*?)\},(\s*seo: async)/,
  `thumbnail: async () => {
          const current = await getProject(projectId);
          const appSettings = getProjectAppSettings(current, await getRequestSettings(req));
          await generateThumbnailForProject(current, appSettings, true);
        },
        'thumbnail-vertical': async () => {
          const current = await getProject(projectId);
          const appSettings = getProjectAppSettings(current, await getRequestSettings(req));
          await generateThumbnailVerticalForProject(current, appSettings, true);
        },
        $3`
);

code = code.replace(
  /seo: async \(\) => \{([\s\S]*?const appSettings = )await getSettings\(\);([\s\S]*?generateSeoForProject\([\s\S]*?\);)/,
  `seo: async () => {
          const current = await getProject(projectId);
          const appSettings = getProjectAppSettings(current, await getRequestSettings(req));
          await generateSeoForProject(current, appSettings, true);`
);

fs.writeFileSync('src/routes/api.js', code, 'utf8');
console.log('Update completed');
