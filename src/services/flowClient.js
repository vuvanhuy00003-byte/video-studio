const fs = require('fs/promises');
const path = require('path');
const { isHttpUrl, isDirectMediaSource, resolveWebsitePath, saveDirectMediaSource } = require('./mediaSourceService');
const { buildEnrichedImagePrompt } = require('./imageService');
const { STYLE_PROMPT_DETAIL } = require('../config/constants');

const FLOW_FREE_VIDEO_MODEL = 'veo_3_1_lite';
const FLOW_LOW_PRIORITY_VIDEO_MODEL = 'veo_3_1_lite_low_priority';
const FLOW_VIDEO_DURATION_VALUES = new Set([4, 6, 8, 10]);
const FLOW_AUDIO_SOURCES = new Set(['flow-video-az', 'flow-image-video-az', 'flow-film']);
const FLOW_ENTITY_TYPES = new Set(['character', 'location', 'creature', 'visual_asset', 'generic_troop', 'faction']);
const FLOW_PROJECT_SETUP_PROMISES = new Map();
const FLOW_VIDEO_SETUP_PROMISES = new Map();
const FLOW_ENTITY_SETUP_PROMISES = new Map();
const FLOW_MATERIAL_BY_IMAGE_STYLE = {
  cinematic: 'realistic',
  'ai-fashion-product': 'realistic',
  anime: 'anime',
  watercolor: 'watercolor',
  cyberpunk: 'cyberpunk',
  renaissance: 'oil_painting',
  'oil-classical': 'oil_painting',
  'dark-fantasy': 'oil_painting',
  'finance-cartoon': 'comic_book',
  'chalk-dark': 'comic_book',
  'stickman-morality': 'comic_book',
  '2d-explainer': 'comic_book',
  'flat-minimal': 'comic_book',
  'comic-popart': 'comic_book',
  'vintage-graphic-novel': 'comic_book'
};

function normalizeBaseUrl(value) {
  return String(value || 'http://127.0.0.1:8100').trim().replace(/\/+$/, '');
}

function orientationFromAspectRatio(aspectRatio) {
  return String(aspectRatio || '16:9') === '9:16' ? 'VERTICAL' : 'HORIZONTAL';
}

function isFlowAuthError(status, message) {
  const value = String(message || '').toLowerCase();
  return status === 401
    || value.includes('invalid authentication credentials')
    || value.includes('unauthenticated')
    || value.includes('no_flow_key')
    || value.includes('extension not connected');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientFetchError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('fetch failed')
    || message.includes('socket')
    || message.includes('econnreset')
    || message.includes('econnrefused')
    || message.includes('etimedout')
    || message.includes('timeout');
}

async function requestFlow(settings, pathname, options = {}) {
  const baseUrl = normalizeBaseUrl(settings.flowApiBaseUrl);
  const {
    authRetry = true,
    ...fetchOptions
  } = options;
  const authRetryIntervalMs = Math.min(30000, Number(settings.flowAuthRetryIntervalMs) || 5000);
  const authDeadline = Date.now() + Math.min(60000, Number(settings.flowAuthMaxWaitMs) || 60000);
  let authAttempt = 0;
  let networkAttempt = 0;
  const networkRetries = Math.max(1, Number(settings.flowNetworkRetries) || 3);

  while (true) {
    let response;
    const method = String(fetchOptions.method || 'GET').toUpperCase();
    try {
      response = await fetch(`${baseUrl}${pathname}`, {
        ...fetchOptions,
        headers: {
          Accept: 'application/json',
          ...(fetchOptions.body ? { 'Content-Type': 'application/json' } : {}),
          ...(fetchOptions.headers || {})
        },
        signal: AbortSignal.timeout(Number(settings.flowRequestTimeoutMs) || 600000)
      });
    } catch (error) {
      networkAttempt += 1;
      if (networkAttempt < networkRetries && isTransientFetchError(error)) {
        await sleep(1000 * networkAttempt);
        continue;
      }
      throw new Error(`FlowKit API ${method} ${pathname} failed: ${error.message || error}`);
    }
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text };
    }
    if (response.ok) return data;

    const detail = data?.detail || data?.error;
    const message = typeof detail === 'string'
      ? detail
      : detail?.message || detail?.error?.message || JSON.stringify(detail || data).slice(0, 500);
    if (authRetry && isFlowAuthError(response.status, message) && Date.now() < authDeadline) {
      authAttempt += 1;
      console.warn(
        `Flow authentication unavailable for ${pathname}; waiting ${Math.round(authRetryIntervalMs / 1000)}s`
        + ` before retry ${authAttempt}`
      );
      await sleep(authRetryIntervalMs);
      continue;
    }
    throw new Error(message || `Flowkit HTTP ${response.status}`);
  }
}

function guessImageMime(filePath = '') {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

function sceneReferenceImageUrl(scene, settings) {
  if (scene.sceneReferenceImageUrl) return String(scene.sceneReferenceImageUrl).trim();
  if (typeof scene.useReferenceImage === 'string') return String(scene.useReferenceImage).trim();
  if (scene.useReferenceImage === true) return String(settings.referenceImageUrl || '').trim();
  return '';
}

function flowMaterialFromSettings(settings) {
  return FLOW_MATERIAL_BY_IMAGE_STYLE[String(settings.imageStyle || '').trim()] || 'realistic';
}

function flowProjectAllowsVoice(project) {
  return FLOW_AUDIO_SOURCES.has(String(project.settings?.imageSource || '').trim());
}

function normalizeFlowVideoDurationSec(value, fallback = 8) {
  const duration = Number(value);
  return FLOW_VIDEO_DURATION_VALUES.has(duration) ? duration : fallback;
}

function flowVideoDurationValuesForModel(model) {
  return String(model || '').trim() === 'abra' ? [4, 6, 8, 10] : [4, 6, 8];
}

function flowModelSupportsReferenceVideo(model) {
  return !String(model || '').trim().includes('lite');
}

function flowVideoDurationSec(scene, settings) {
  const duration = normalizeFlowVideoDurationSec(
    scene.flowDurationSec ?? scene.flowVideoDurationSec ?? settings.flowVideoDurationSec,
    normalizeFlowVideoDurationSec(settings.flowVideoDurationSec, 8)
  );
  return flowVideoDurationValuesForModel(settings.flowVideoModel).includes(duration) ? duration : 8;
}

function flowStyleDetail(project, settings) {
  const styleKey = project?.settings?.imageStyle || settings.imageStyle || '';
  return String(
    project?.settings?.imageStylePrompt
    || settings.imageStylePrompt
    || STYLE_PROMPT_DETAIL[styleKey]
    || styleKey
    || ''
  ).trim();
}

function flowStyleCue(project, settings) {
  const style = flowStyleDetail(project, settings);
  if (!style) return '';
  return [
    `Visual style must remain consistent across every generated image and video frame: ${style}`,
    'Apply this exact style to characters, locations, props, lighting, texture, color palette, and motion',
    'Do not mix photorealistic footage with illustrated, anime, cartoon, painting, or stylized references'
  ].join('. ');
}

function appendFlowStyleCue(basePrompt, project, settings) {
  const prompt = String(basePrompt || '').trim();
  const cue = flowStyleCue(project, settings);
  return [prompt, cue].filter(Boolean).join('. ');
}

function flowImagePrompt(project, scene, settings) {
  return buildEnrichedImagePrompt(
    scene.imagePrompt || scene.voiceText || project.title || '',
    project.settings?.imageStyle || settings.imageStyle,
    project.settings?.aspectRatio || settings.aspectRatio,
    project.settings?.imageStylePrompt || settings.imageStylePrompt,
    {
      videoLanguage: project.settings?.videoLanguage || settings.videoLanguage,
      imageTextDensity: project.settings?.imageTextDensity || settings.imageTextDensity
    }
  );
}

function flowVideoPrompt(project, scene, settings) {
  const base = scene.videoPrompt || scene.imagePrompt || scene.voiceText || '';
  return appendFlowStyleCue(base, project, settings);
}

function normalizeFlowEntityType(value) {
  const normalized = String(value || '').trim().toLowerCase().replaceAll('-', '_');
  if (normalized === 'place' || normalized === 'setting' || normalized === 'background') return 'location';
  if (normalized === 'prop' || normalized === 'object' || normalized === 'asset') return 'visual_asset';
  if (normalized === 'troop' || normalized === 'generic_troops') return 'generic_troop';
  return FLOW_ENTITY_TYPES.has(normalized) ? normalized : 'character';
}

function uniqueList(items = []) {
  return [...new Set(items.map((item) => String(item || '').trim()).filter(Boolean))];
}

function flowProjectEntities(project) {
  return (Array.isArray(project.entities) ? project.entities : [])
    .map((entity) => {
      const name = String(entity?.name || entity?.entityName || '').trim();
      if (!name) return null;
      return {
        name,
        entityType: normalizeFlowEntityType(entity.entityType || entity.entity_type || entity.type),
        description: String(entity.description || entity.visualDescription || entity.appearance || name).trim(),
        imagePrompt: String(entity.imagePrompt || entity.image_prompt || '').trim(),
        voiceDescription: String(entity.voiceDescription || entity.voice_description || '').trim(),
        referenceImageUrl: String(entity.referenceImageUrl || entity.reference_image_url || entity.imageUrl || entity.url || '').trim(),
        mediaId: String(entity.mediaId || entity.media_id || '').trim()
      };
    })
    .filter(Boolean);
}

function sceneEntityNames(scene) {
  const raw = Array.isArray(scene.entityNames)
    ? scene.entityNames
    : Array.isArray(scene.characterNames)
    ? scene.characterNames
    : Array.isArray(scene.character_names)
    ? scene.character_names
    : typeof scene.entityNames === 'string'
    ? scene.entityNames.split(',')
    : typeof scene.characterNames === 'string'
    ? scene.characterNames.split(',')
    : typeof scene.character_names === 'string'
    ? scene.character_names.split(',')
    : [];
  return uniqueList(raw);
}

function sceneVideoReferenceEntityNames(project, scene) {
  const names = new Set(sceneEntityNames(scene));
  if (!names.size) return [];
  return flowProjectEntities(project)
    .filter((entity) => names.has(entity.name) && ['character', 'visual_asset'].includes(entity.entityType))
    .map((entity) => entity.name);
}

function flowStyleSignature(settings) {
  return JSON.stringify({
    imageStyle: settings.imageStyle || '',
    imageStylePrompt: settings.imageStylePrompt || '',
    aspectRatio: settings.aspectRatio || '',
    imageTextDensity: settings.imageTextDensity || '',
    videoLanguage: settings.videoLanguage || ''
  });
}

function flowEntitySignature(entity, settings) {
  return JSON.stringify({
    name: entity.name,
    entityType: entity.entityType,
    description: entity.description,
    imagePrompt: entity.imagePrompt,
    voiceDescription: entity.voiceDescription,
    referenceImageUrl: entity.referenceImageUrl,
    mediaId: entity.mediaId,
    style: flowStyleSignature(settings)
  });
}

function flowEntityImagePrompt(entity, settings) {
  const material = flowMaterialFromSettings(settings).replaceAll('_', ' ');
  const description = entity.description || entity.name;
  let basePrompt = entity.imagePrompt;
  if (basePrompt) {
    basePrompt = `Single reference image for ${entity.name}: ${basePrompt}`;
  }
  if (entity.entityType === 'location') {
    basePrompt = basePrompt || `Single landscape reference image of ${description}. Establishing shot, level horizon, atmospheric lighting, ${material} style, no text, no watermark.`;
  } else if (entity.entityType === 'visual_asset') {
    basePrompt = basePrompt || `Single reference image of ${description}. Detailed object view, clear texture and scale, centered composition, ${material} style, no text, no watermark.`;
  } else {
    basePrompt = basePrompt || `Single full-body reference image of ${description}. Front-facing or three-quarter view, centered, clear face and outfit, neutral background, ${material} style, one single image only, no text, no watermark.`;
  }
  return buildEnrichedImagePrompt(
    basePrompt,
    settings.imageStyle,
    settings.aspectRatio,
    settings.imageStylePrompt,
    {
      videoLanguage: settings.videoLanguage,
      imageTextDensity: settings.imageTextDensity
    }
  );
}

async function uploadReferenceImageToFlow({ settings, projectId, referenceUrl, localImagePath }) {
  let body;
  if (localImagePath) {
    const sourcePath = localImagePath || resolveWebsitePath(referenceUrl);
    const imageBase64 = (await fs.readFile(sourcePath)).toString('base64');
    body = {
      project_id: projectId,
      image_base64: imageBase64,
      mime_type: guessImageMime(sourcePath),
      file_name: path.basename(sourcePath)
    };
  } else if (isHttpUrl(referenceUrl)) {
    body = {
      project_id: projectId,
      url: referenceUrl,
      file_name: path.basename(new URL(referenceUrl).pathname) || 'reference-image.png'
    };
  } else {
    const sourcePath = resolveWebsitePath(referenceUrl);
    const imageBase64 = (await fs.readFile(sourcePath)).toString('base64');
    body = {
      project_id: projectId,
      image_base64: imageBase64,
      mime_type: guessImageMime(sourcePath),
      file_name: path.basename(sourcePath)
    };
  }
  return requestFlow(settings, '/api/media/upload-image', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

async function ensureFlowEntityReferences({ project, settings, flowProjectId }) {
  const entities = flowProjectEntities(project);
  if (!entities.length) return [];
  project.metadata = project.metadata || {};
  project.metadata.flow = project.metadata.flow || {};
  project.metadata.flow.entities = project.metadata.flow.entities || {};
  const state = project.metadata.flow.entities;
  const readyNames = [];

  for (const entity of entities) {
    const signature = flowEntitySignature(entity, settings);
    const current = state[entity.name]?.signature === signature ? state[entity.name] : {};
    let entityId = current.entityId || '';
    let mediaId = entity.mediaId || current.mediaId || '';
    let referenceImageUrl = entity.referenceImageUrl || current.referenceImageUrl || '';
    const body = {
      name: entity.name,
      entity_type: entity.entityType,
      description: entity.description,
      image_prompt: flowEntityImagePrompt(entity, settings),
      ...(entity.voiceDescription ? { voice_description: entity.voiceDescription } : {}),
      ...(referenceImageUrl ? { reference_image_url: referenceImageUrl } : {}),
      ...(mediaId ? { media_id: mediaId } : {})
    };

    if (referenceImageUrl && !mediaId) {
      const upload = await uploadReferenceImageToFlow({
        settings,
        projectId: flowProjectId,
        referenceUrl: referenceImageUrl
      });
      mediaId = upload.mediaId || upload.media_id || '';
      body.media_id = mediaId;
    }

    if (entityId) {
      try {
        await requestFlow(settings, `/api/characters/${encodeURIComponent(entityId)}`, {
          method: 'PATCH',
          body: JSON.stringify(body)
        });
      } catch {
        entityId = '';
      }
    }

    if (!entityId) {
      const flowEntity = await requestFlow(settings, '/api/characters', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      entityId = flowEntity.id;
    }

    await requestFlow(settings, `/api/projects/${encodeURIComponent(flowProjectId)}/characters/${encodeURIComponent(entityId)}`, {
      method: 'POST'
    });

    if (!mediaId) {
      const refRequest = await submitRequest({
        settings,
        type: 'GENERATE_CHARACTER_IMAGE',
        projectId: flowProjectId,
        characterId: entityId
      });
      mediaId = refRequest.media_id || '';
      referenceImageUrl = refRequest.output_url || referenceImageUrl;
    }

    if (!mediaId) {
      const fresh = await requestFlow(settings, `/api/characters/${encodeURIComponent(entityId)}`);
      mediaId = fresh.media_id || '';
      referenceImageUrl = fresh.reference_image_url || referenceImageUrl;
    }

    state[entity.name] = {
      signature,
      entityId,
      mediaId,
      referenceImageUrl,
      entityType: entity.entityType
    };
    readyNames.push(entity.name);
  }

  return readyNames;
}

async function ensureFlowEntityReferencesOnce({ project, settings, flowProjectId, onProgress }) {
  const entities = flowProjectEntities(project);
  if (!entities.length) return [];
  const signature = entities.map((entity) => flowEntitySignature(entity, settings)).join('|');
  const state = project.metadata?.flow?.entities || {};
  if (
    project.metadata?.flow?.entitiesReadySignature === signature
    && project.metadata?.flow?.entitiesProjectId === flowProjectId
    && entities.every((entity) => state[entity.name]?.mediaId)
  ) {
    return entities.map((entity) => entity.name);
  }
  const key = `${project.id}:${flowProjectId}:${signature}`;
  if (!FLOW_ENTITY_SETUP_PROMISES.has(key)) {
    FLOW_ENTITY_SETUP_PROMISES.set(key, (async () => {
      try {
        const names = await ensureFlowEntityReferences({ project, settings, flowProjectId });
        project.metadata.flow.entitiesReadySignature = signature;
        project.metadata.flow.entitiesProjectId = flowProjectId;
        await onProgress();
        return names;
      } finally {
        FLOW_ENTITY_SETUP_PROMISES.delete(key);
      }
    })());
  }
  return FLOW_ENTITY_SETUP_PROMISES.get(key);
}

async function ensureFlowReferenceEntity({ settings, scene, flowProjectId, flowSceneId, referenceUrl, mediaId, characterNames = [] }) {
  const referenceName = `Scene Reference ${scene.sceneNumber}`;
  if (!scene.metadata.flow.referenceEntityId) {
    const entity = await requestFlow(settings, '/api/characters', {
      method: 'POST',
      body: JSON.stringify({
        name: referenceName,
        entity_type: 'character',
        description: 'Uploaded visual reference for subject and style consistency',
        reference_image_url: referenceUrl,
        media_id: mediaId
      })
    });
    await requestFlow(settings, `/api/projects/${encodeURIComponent(flowProjectId)}/characters/${encodeURIComponent(entity.id)}`, {
      method: 'POST'
    });
    scene.metadata.flow.referenceEntityId = entity.id;
  }
  await requestFlow(settings, `/api/scenes/${encodeURIComponent(flowSceneId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ character_names: uniqueList([...characterNames, referenceName]) })
  });
  scene.metadata.flow.referenceEntityName = referenceName;
  scene.metadata.flow.referenceMediaId = mediaId;
}

async function getFlowStatus(settings) {
  const [health, flow, credits, models] = await Promise.all([
    requestFlow(settings, '/health', { authRetry: false }).catch((error) => ({ status: 'unavailable', error: error.message })),
    requestFlow(settings, '/api/flow/status', { authRetry: false }).catch((error) => ({ connected: false, error: error.message })),
    requestFlow(settings, '/api/flow/credits', { authRetry: false }).catch((error) => ({ error: error.message })),
    requestFlow(settings, '/api/models', { authRetry: false }).catch((error) => ({ error: error.message }))
  ]);
  return { health, flow, credits, models };
}

async function configureFlowModels(settings, orientation) {
  const imageModel = String(settings.flowImageModel || '').trim();
  const videoModel = String(settings.flowVideoModel || '').trim();
  const aspect = orientation === 'VERTICAL'
    ? 'VIDEO_ASPECT_RATIO_PORTRAIT'
    : 'VIDEO_ASPECT_RATIO_LANDSCAPE';
  const body = {};
  if (imageModel) {
    body.image_models = { NANO_BANANA_PRO: imageModel };
  }
  const credits = await requestFlow(settings, '/api/flow/credits');
  const accountTier = String(credits.userPaygateTier || '').trim();
  const serviceTier = String(credits.serviceTier || '').trim();
  const freeAccount = accountTier === 'PAYGATE_TIER_NOT_PAID' || serviceTier === 'SERVICE_TIER_ENTRY';
  const ultraAccount = serviceTier === 'SERVICE_TIER_ULTRA';
  const requestedModel = videoModel || FLOW_FREE_VIDEO_MODEL;
  const requestedNeedsUltra = requestedModel.includes('ultra_relaxed') || requestedModel === 'veo_3_1_quality';
  let configuredModel = requestedModel;
  if (freeAccount) {
    configuredModel = FLOW_FREE_VIDEO_MODEL;
  } else if (requestedModel === 'veo_3_1_quality' && !ultraAccount) {
    configuredModel = 'veo_3_1_fast';
  } else if (requestedModel.includes('ultra_relaxed') && !ultraAccount) {
    configuredModel = FLOW_LOW_PRIORITY_VIDEO_MODEL;
  }
  const videoAspects = freeAccount
    ? ['VIDEO_ASPECT_RATIO_PORTRAIT', 'VIDEO_ASPECT_RATIO_LANDSCAPE']
    : [aspect];
  if (configuredModel && accountTier) {
    const configuredVideoModels = {
      frame_2_video: Object.fromEntries(videoAspects.map((item) => [item, configuredModel])),
      start_end_frame_2_video: Object.fromEntries(videoAspects.map((item) => [item, configuredModel])),
      reference_frame_2_video: Object.fromEntries(videoAspects.map((item) => [item, configuredModel]))
    };
    body.video_models = {
      [accountTier]: configuredVideoModels
    };
    if (videoModel && !freeAccount && !(requestedNeedsUltra && !ultraAccount)) {
      body.video_models.PAYGATE_TIER_ONE = configuredVideoModels;
      body.video_models.PAYGATE_TIER_TWO = configuredVideoModels;
    }
  }
  if (Object.keys(body).length) {
    await requestFlow(settings, '/api/models', {
      method: 'PATCH',
      body: JSON.stringify(body)
    });
  }
  return {
    accountTier,
    serviceTier,
    accountClass: freeAccount ? 'free' : serviceTier === 'SERVICE_TIER_ULTRA' ? 'ultra' : 'paid',
    credits: Number(credits.credits),
    imageModel: imageModel || '',
    requestedVideoModel: requestedModel,
    modelOverridden: configuredModel !== requestedModel,
    videoModel: configuredModel
  };
}

async function getConfiguredFlowAccount(settings, aspectRatio) {
  return configureFlowModels(settings, orientationFromAspectRatio(aspectRatio));
}

function flowProjectOwner(project, scene, isolateVideoProject) {
  project.metadata = project.metadata || {};
  project.metadata.flow = project.metadata.flow || {};
  if (!isolateVideoProject) return project.metadata.flow;
  scene.metadata = scene.metadata || {};
  scene.metadata.flow = scene.metadata.flow || {};
  return scene.metadata.flow;
}

function resetSceneFlowMedia(scene) {
  scene.metadata = scene.metadata || {};
  scene.metadata.flow = scene.metadata.flow || {};
  scene.metadata.flow.sceneId = null;
  scene.metadata.flow.imageRequestId = null;
  scene.metadata.flow.imageMediaId = null;
  scene.metadata.flow.imageUrl = null;
  scene.metadata.flow.videoRequestId = null;
  scene.metadata.flow.videoMediaId = null;
  scene.metadata.flow.videoUrl = null;
  scene.metadata.flow.referenceMediaId = null;
  scene.metadata.flow.referenceEntityId = null;
  scene.metadata.flow.referenceEntityName = '';
}

function resetSceneFlowGeneratedMedia(scene) {
  scene.metadata = scene.metadata || {};
  scene.metadata.flow = scene.metadata.flow || {};
  scene.metadata.flow.imageRequestId = null;
  scene.metadata.flow.imageMediaId = null;
  scene.metadata.flow.imageUrl = null;
  scene.metadata.flow.videoRequestId = null;
  scene.metadata.flow.videoMediaId = null;
  scene.metadata.flow.videoUrl = null;
}

function flowSceneSignature({ project, scene, settings, imagePrompt, videoPrompt, referenceUrl, durationSeconds, generateVideo, exposeImage }) {
  return JSON.stringify({
    imageSource: project.settings?.imageSource || settings.imageSource || '',
    imageStyle: project.settings?.imageStyle || settings.imageStyle || '',
    imageStylePrompt: flowStyleDetail(project, settings),
    aspectRatio: project.settings?.aspectRatio || settings.aspectRatio || '',
    imagePrompt,
    videoPrompt,
    transitionPrompt: scene.transitionPrompt || '',
    referenceUrl,
    durationSeconds,
    generateVideo: Boolean(generateVideo),
    exposeImage: Boolean(exposeImage)
  });
}

async function ensureFlowProject({ project, scene, settings, isolateVideoProject }) {
  const owner = flowProjectOwner(project, scene, isolateVideoProject);
  if (owner.projectId) {
    await requestFlow(settings, `/api/projects/${encodeURIComponent(owner.projectId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        material: flowMaterialFromSettings(settings),
        allow_music: false,
        allow_voice: flowProjectAllowsVoice(project)
      })
    });
    return owner.projectId;
  }

  const key = isolateVideoProject
    ? `${project.id}:scene:${scene.sceneNumber}:project`
    : `${project.id}:project`;
  if (!FLOW_PROJECT_SETUP_PROMISES.has(key)) {
    FLOW_PROJECT_SETUP_PROMISES.set(key, (async () => {
      try {
        const latestOwner = flowProjectOwner(project, scene, isolateVideoProject);
        if (latestOwner.projectId) return latestOwner.projectId;
        const flowProject = await requestFlow(settings, '/api/projects', {
          method: 'POST',
          body: JSON.stringify({
            name: isolateVideoProject
              ? `${project.title || project.id} - Scene ${scene.sceneNumber}`
              : project.title || project.id,
            story: isolateVideoProject
              ? scene.videoPrompt || scene.imagePrompt || scene.voiceText || project.title || ''
              : project.inputText || project.title || '',
            language: project.settings?.videoLanguage || 'vi',
            material: flowMaterialFromSettings(settings),
            allow_music: false,
            allow_voice: flowProjectAllowsVoice(project)
          })
        });
        latestOwner.projectId = flowProject.id;
        if (isolateVideoProject) latestOwner.projectScope = 'scene-video';
        return flowProject.id;
      } finally {
        FLOW_PROJECT_SETUP_PROMISES.delete(key);
      }
    })());
  }
  return FLOW_PROJECT_SETUP_PROMISES.get(key);
}

async function ensureFlowVideo({ project, scene, settings, flowProjectId, isolateVideoProject }) {
  const owner = flowProjectOwner(project, scene, isolateVideoProject);
  if (owner.videoId) return owner.videoId;
  const key = isolateVideoProject
    ? `${project.id}:scene:${scene.sceneNumber}:video:${flowProjectId}`
    : `${project.id}:video:${flowProjectId}`;
  if (!FLOW_VIDEO_SETUP_PROMISES.has(key)) {
    FLOW_VIDEO_SETUP_PROMISES.set(key, (async () => {
      try {
        const latestOwner = flowProjectOwner(project, scene, isolateVideoProject);
        if (latestOwner.videoId) return latestOwner.videoId;
        const flowVideo = await requestFlow(settings, '/api/videos', {
          method: 'POST',
          body: JSON.stringify({
            project_id: flowProjectId,
            title: isolateVideoProject
              ? `${project.title || project.id} - Scene ${scene.sceneNumber}`
              : project.title || project.id,
            orientation: orientationFromAspectRatio(project.settings?.aspectRatio)
          })
        });
        latestOwner.videoId = flowVideo.id;
        return flowVideo.id;
      } finally {
        FLOW_VIDEO_SETUP_PROMISES.delete(key);
      }
    })());
  }
  return FLOW_VIDEO_SETUP_PROMISES.get(key);
}

function parentFlowSceneId(project, scene) {
  const parentSceneNumber = Number(scene.parentSceneNumber || 0);
  if (!parentSceneNumber) return null;
  const parent = (project.scenes || []).find((item) => Number(item.sceneNumber) === parentSceneNumber);
  return parent?.metadata?.flow?.sceneId || null;
}

function flowScenePatchBody(project, scene, settings, imagePrompt, videoPrompt, characterNames) {
  const chainType = String(scene.chainType || '').trim().toUpperCase();
  const body = {
    prompt: imagePrompt,
    image_prompt: imagePrompt,
    video_prompt: videoPrompt,
    character_names: characterNames
  };
  if (scene.transitionPrompt) body.transition_prompt = appendFlowStyleCue(scene.transitionPrompt, project, settings);
  if (chainType) body.chain_type = chainType;
  const parentId = parentFlowSceneId(project, scene);
  if (parentId) body.parent_scene_id = parentId;
  return body;
}

async function ensureFlowScene({ project, scene, settings, flowVideoId, isolateVideoProject, imagePrompt, videoPrompt, characterNames = [] }) {
  scene.metadata = scene.metadata || {};
  scene.metadata.flow = scene.metadata.flow || {};
  if (scene.metadata.flow.sceneId) {
    await requestFlow(settings, `/api/scenes/${encodeURIComponent(scene.metadata.flow.sceneId)}`, {
      method: 'PATCH',
      body: JSON.stringify(flowScenePatchBody(project, scene, settings, imagePrompt, videoPrompt, characterNames))
    });
    return scene.metadata.flow.sceneId;
  }
  const flowScene = await requestFlow(settings, '/api/scenes', {
    method: 'POST',
    body: JSON.stringify({
      ...flowScenePatchBody(project, scene, settings, imagePrompt, videoPrompt, characterNames),
      video_id: flowVideoId,
      display_order: isolateVideoProject ? 0 : Math.max(0, Number(scene.sceneNumber || 1) - 1)
    })
  });
  scene.metadata.flow.sceneId = flowScene.id;
  return flowScene.id;
}

async function waitForRequest(settings, requestId) {
  const timeoutMs = Number(settings.flowGenerationTimeoutMs) || 900000;
  const pollMs = Number(settings.flowPollIntervalMs) || 5000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const request = await requestFlow(settings, `/api/requests/${encodeURIComponent(requestId)}`);
    if (request.status === 'COMPLETED') return request;
    if (request.status === 'FAILED') {
      throw new Error(request.error_message || `Flow request ${requestId} failed`);
    }
    const errorMessage = String(request.error_message || '');
    if (errorMessage.includes('PUBLIC_ERROR_UNUSUAL_ACTIVITY')) {
      throw new Error(`${errorMessage}. Google Flow đang chặn reCAPTCHA do unusual activity; dừng queue, chờ 30-60 phút rồi chạy lại từng scene.`);
    }
    if (
      errorMessage.includes('PUBLIC_ERROR_USER_QUOTA_REACHED')
      || errorMessage.startsWith('No model for tier=')
    ) {
      throw new Error(errorMessage);
    }
    await sleep(pollMs);
  }
  throw new Error(`Flow request ${requestId} timed out after ${Math.round(timeoutMs / 1000)}s`);
}

async function submitRequest({ settings, type, orientation, projectId, videoId, sceneId, characterId, durationSeconds }) {
  const request = await requestFlow(settings, '/api/requests', {
    method: 'POST',
    body: JSON.stringify({
      type,
      orientation,
      project_id: projectId,
      video_id: videoId,
      scene_id: sceneId,
      character_id: characterId,
      ...(durationSeconds ? { duration_seconds: durationSeconds } : {})
    })
  });
  return waitForRequest(settings, request.id);
}

async function saveFlowMedia(source, outputPath) {
  const value = String(source || '').trim();
  if (!value) throw new Error('Flowkit did not return a media URL');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  if (value.startsWith('file://')) {
    await fs.copyFile(require('url').fileURLToPath(value), outputPath);
    return outputPath;
  }
  if (!isHttpUrl(value) && isDirectMediaSource(value)) {
    await saveDirectMediaSource(value, outputPath);
    return outputPath;
  }
  let response;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetch(value, { signal: AbortSignal.timeout(180000) });
      break;
    } catch (error) {
      if (attempt >= 3 || !isTransientFetchError(error)) {
        const host = isHttpUrl(value) ? new URL(value).host : 'unknown source';
        throw new Error(`Flow media download failed from ${host}: ${error.message || error}`);
      }
      await sleep(1000 * attempt);
    }
  }
  if (!response.ok) throw new Error(`Cannot download Flow media: HTTP ${response.status}`);
  await fs.writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
  return outputPath;
}

async function generateFlowMedia({
  project,
  scene,
  settings,
  sceneDir,
  generateVideo = true,
  exposeImage = true,
  onProgress = async () => {}
}) {
  const orientation = orientationFromAspectRatio(project.settings?.aspectRatio);
  const isolateVideoProject = false;
  const durationSeconds = flowVideoDurationSec(scene, settings);
  const imagePrompt = flowImagePrompt(project, scene, settings);
  const videoPrompt = flowVideoPrompt(project, scene, settings);
  const flowAccount = await configureFlowModels(settings, orientation);
  project.metadata = project.metadata || {};
  project.metadata.flow = {
    ...(project.metadata.flow || {}),
    accountTier: flowAccount?.accountTier || '',
    serviceTier: flowAccount?.serviceTier || '',
    accountClass: flowAccount?.accountClass || '',
    creditsBeforeGeneration: flowAccount?.credits,
    imageModel: flowAccount?.imageModel || '',
    requestedVideoModel: flowAccount?.requestedVideoModel || '',
    modelOverridden: Boolean(flowAccount?.modelOverridden),
    videoModel: flowAccount?.videoModel || '',
    flowDurationSec: durationSeconds
  };
  const flowProjectId = await ensureFlowProject({ project, scene, settings, isolateVideoProject });
  const flowVideoId = await ensureFlowVideo({ project, scene, settings, flowProjectId, isolateVideoProject });
  const readyEntityNames = await ensureFlowEntityReferencesOnce({
    project,
    settings,
    flowProjectId,
    onProgress
  });
  const characterNames = uniqueList(sceneEntityNames(scene).filter((name) => readyEntityNames.includes(name)));
  if (
    scene.metadata?.flow?.projectScope === 'scene-video'
    || (scene.metadata?.flow?.projectId && scene.metadata.flow.projectId !== flowProjectId)
    || (scene.metadata?.flow?.videoId && scene.metadata.flow.videoId !== flowVideoId)
  ) {
    resetSceneFlowMedia(scene);
    scene.metadata.flow.projectScope = 'project';
  }
  const flowSceneId = await ensureFlowScene({
    project,
    scene,
    settings,
    flowVideoId,
    isolateVideoProject,
    imagePrompt,
    videoPrompt,
    characterNames
  });
  scene.metadata.flow = {
    ...(scene.metadata.flow || {}),
    projectId: flowProjectId,
    videoId: flowVideoId,
    sceneId: flowSceneId,
    orientation,
    accountTier: flowAccount?.accountTier || '',
    serviceTier: flowAccount?.serviceTier || '',
    accountClass: flowAccount?.accountClass || '',
    creditsBeforeGeneration: flowAccount?.credits,
    imageModel: flowAccount?.imageModel || '',
    requestedVideoModel: flowAccount?.requestedVideoModel || '',
    modelOverridden: Boolean(flowAccount?.modelOverridden),
    videoModel: flowAccount?.videoModel || '',
    flowDurationSec: durationSeconds
  };
  if (generateVideo && Number(scene.metadata.flow.videoDurationSec || 0) !== durationSeconds) {
    scene.metadata.flow.videoRequestId = null;
    scene.metadata.flow.videoMediaId = null;
    scene.metadata.flow.videoUrl = null;
    scene.metadata.flow.videoDurationSec = durationSeconds;
  }
  await onProgress();

  const imagePath = path.join(sceneDir, exposeImage ? 'image.png' : 'flow-start-image.png');
  const referenceUrl = sceneReferenceImageUrl(scene, settings);
  const promptSignature = flowSceneSignature({
    project,
    scene,
    settings,
    imagePrompt,
    videoPrompt,
    referenceUrl,
    durationSeconds,
    generateVideo,
    exposeImage
  });
  if (scene.metadata.flow.promptSignature && scene.metadata.flow.promptSignature !== promptSignature) {
    resetSceneFlowGeneratedMedia(scene);
  }
  scene.metadata.flow.promptSignature = promptSignature;
  const useTextToVideo = generateVideo && !exposeImage && !referenceUrl;
  if (referenceUrl !== String(scene.metadata.flow.referenceImageUrl || '').trim()) {
    scene.metadata.flow.referenceMediaId = null;
    scene.metadata.flow.referenceEntityId = null;
    scene.metadata.flow.referenceEntityName = '';
    resetSceneFlowGeneratedMedia(scene);
    scene.metadata.flow.referenceImageUrl = referenceUrl;
  }
  let referenceImageSaved = false;
  let referenceEntityReady = false;
  if (referenceUrl && !scene.metadata.flow.imageMediaId && !scene.metadata.flow.referenceMediaId) {
    // Use a temp path when exposeImage=true so we don't pollute imagePath with the reference image.
    // imagePath should only contain the AI-generated scene image, not the reference.
    const refDownloadPath = exposeImage ? `${imagePath}.ref-upload.tmp` : imagePath;
    let localReference;
    try {
      localReference = await saveDirectMediaSource(referenceUrl, refDownloadPath, {
        accept: 'image/png,image/jpeg,image/webp,image/*,*/*;q=0.8',
        expectedType: 'image'
      });
    } catch (err) {
      // If saving reference image to temp path fails, try with original ref URL directly
      localReference = { outputPath: null, sourceType: 'url' };
    }
    const upload = await uploadReferenceImageToFlow({
      settings,
      projectId: flowProjectId,
      referenceUrl,
      localImagePath: localReference?.outputPath || null
    });
    // Clean up the temp reference file - we don't want it as the scene image
    if (exposeImage && localReference?.outputPath) {
      await fs.unlink(localReference.outputPath).catch(() => {});
    }
    scene.metadata.flow.referenceImageUrl = referenceUrl;
    scene.metadata.flow.referenceImageSource = localReference?.sourceType || 'local';
    if (!exposeImage) {
      const prefix = orientation === 'VERTICAL' ? 'vertical' : 'horizontal';
      await requestFlow(settings, `/api/scenes/${encodeURIComponent(flowSceneId)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          [`${prefix}_image_media_id`]: upload.mediaId,
          [`${prefix}_image_url`]: referenceUrl,
          [`${prefix}_image_status`]: 'COMPLETED'
        })
      });
      scene.metadata.flow.imageRequestId = '';
      scene.metadata.flow.imageMediaId = upload.mediaId;
      scene.metadata.flow.imageUrl = referenceUrl;
      referenceImageSaved = true;
    } else {
      await ensureFlowReferenceEntity({
        settings,
        scene,
        flowProjectId,
        flowSceneId,
        referenceUrl,
        mediaId: upload.mediaId,
        characterNames
      });
      referenceEntityReady = true;
    }
    await onProgress();
  }

  if (referenceUrl && exposeImage && scene.metadata.flow.referenceMediaId && !referenceEntityReady) {
    await ensureFlowReferenceEntity({
      settings,
      scene,
      flowProjectId,
      flowSceneId,
      referenceUrl,
      mediaId: scene.metadata.flow.referenceMediaId,
      characterNames
    });
  }
  if (!scene.metadata.flow.imageMediaId && !useTextToVideo) {
    const imageRequest = await submitRequest({
      settings, type: scene.metadata.flow.forceRegenerate ? 'REGENERATE_IMAGE' : 'GENERATE_IMAGE', orientation,
      projectId: flowProjectId, videoId: flowVideoId, sceneId: flowSceneId
    });
    scene.metadata.flow.imageRequestId = imageRequest.id;
    scene.metadata.flow.imageMediaId = imageRequest.media_id;
    scene.metadata.flow.imageUrl = imageRequest.output_url;
    await onProgress();
  }
  if (!referenceImageSaved && scene.metadata.flow.imageUrl) {
    await saveFlowMedia(scene.metadata.flow.imageUrl, imagePath);
  }

  if (!generateVideo) {
    delete scene.metadata.flow.forceRegenerate;
    await onProgress();
    return { imagePath, videoPath: null };
  }

  const videoPath = path.join(sceneDir, 'source-video.mp4');
  if (!scene.metadata.flow.videoMediaId) {
    const requestType = useTextToVideo
      && flowModelSupportsReferenceVideo(flowAccount?.videoModel)
      && sceneVideoReferenceEntityNames(project, scene).some((name) => characterNames.includes(name))
      ? 'GENERATE_VIDEO_REFS'
      : scene.metadata.flow.forceRegenerate ? 'REGENERATE_VIDEO' : 'GENERATE_VIDEO';
    const videoRequest = await submitRequest({
      settings, type: requestType, orientation,
      projectId: flowProjectId, videoId: flowVideoId, sceneId: flowSceneId, durationSeconds
    });
    scene.metadata.flow.videoRequestId = videoRequest.id;
    scene.metadata.flow.videoMediaId = videoRequest.media_id;
    scene.metadata.flow.videoUrl = videoRequest.output_url;
    await onProgress();
  }
  await saveFlowMedia(scene.metadata.flow.videoUrl, videoPath);
  delete scene.metadata.flow.forceRegenerate;
  await onProgress();
  return { imagePath, videoPath };
}

function clearFlowSetupPromises() {
  FLOW_PROJECT_SETUP_PROMISES.clear();
  FLOW_VIDEO_SETUP_PROMISES.clear();
  FLOW_ENTITY_SETUP_PROMISES.clear();
}

module.exports = {
  getFlowStatus,
  getConfiguredFlowAccount,
  generateFlowMedia,
  orientationFromAspectRatio,
  clearFlowSetupPromises
};
