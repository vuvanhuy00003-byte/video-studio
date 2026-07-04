const path = require('path');
const { PROJECTS_DIR, DEFAULT_PROJECT_SETTINGS, normalizeAspectRatio } = require('../config/constants');
const { ensureDir, readJson, writeJson, exists } = require('../lib/fs');
const { upsertHistory } = require('./historyService');

let lastProjectIdTime = 0;
let projectIdCounter = 0;
const FLOW_SOURCES = new Set([
  'flow-videos',
  'flow-images',
  'flow-image-video',
  'flow-video-az',
  'flow-image-video-az',
  'flow-film'
]);
const FLOW_VIDEO_SOURCES = new Set([
  'flow-videos',
  'flow-image-video',
  'flow-video-az',
  'flow-image-video-az',
  'flow-film'
]);
const FLOW_AUDIO_SOURCES = new Set([
  'flow-video-az',
  'flow-image-video-az',
  'flow-film'
]);
const FLOW_ENTITY_TYPES = new Set([
  'character',
  'location',
  'creature',
  'visual_asset',
  'generic_troop',
  'faction'
]);

function normalizeFlowDurationSec(value) {
  const duration = Number(value);
  return [4, 6, 8, 10].includes(duration) ? duration : null;
}

function normalizeFlowEntityType(value) {
  const normalized = String(value || '').trim().toLowerCase().replaceAll('-', '_');
  if (normalized === 'place' || normalized === 'setting' || normalized === 'background') return 'location';
  if (normalized === 'prop' || normalized === 'object' || normalized === 'asset') return 'visual_asset';
  if (normalized === 'troop' || normalized === 'generic_troops') return 'generic_troop';
  return FLOW_ENTITY_TYPES.has(normalized) ? normalized : 'character';
}

function normalizeEntityNames(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
    ? value.split(',')
    : [];
  return [...new Set(raw
    .map((item) => String(item || '').trim())
    .filter(Boolean))];
}

function normalizeChainType(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return ['ROOT', 'CONTINUATION', 'INSERT'].includes(normalized) ? normalized : '';
}

function normalizeScriptEntities(entities = []) {
  return (Array.isArray(entities) ? entities : [])
    .map((entity) => {
      const name = String(entity?.name || entity?.entityName || entity?.label || '').trim();
      if (!name) return null;
      return {
        name,
        entityType: normalizeFlowEntityType(entity.entityType || entity.entity_type || entity.type),
        description: String(entity.description || entity.visualDescription || entity.appearance || '').trim(),
        imagePrompt: String(entity.imagePrompt || entity.image_prompt || '').trim(),
        voiceDescription: String(entity.voiceDescription || entity.voice_description || '').trim(),
        referenceImageUrl: String(entity.referenceImageUrl || entity.reference_image_url || entity.imageUrl || entity.url || '').trim(),
        mediaId: String(entity.mediaId || entity.media_id || '').trim()
      };
    })
    .filter(Boolean);
}

function getDefaultVerticalPrompt(horizontalPrompt, title) {
  if (horizontalPrompt) {
    return horizontalPrompt
      .replace(/\b16:9\b/gi, '9:16')
      .replace(/\blandscape\b/gi, 'portrait')
      .replace(/\bhorizontal\b/gi, 'vertical');
  }
  return `9:16 portrait video thumbnail, tall vertical framing, for: ${title || ''}`;
}

function createProjectId() {
  const now = Date.now();
  projectIdCounter = now === lastProjectIdTime ? projectIdCounter + 1 : 0;
  lastProjectIdTime = now;
  return projectIdCounter ? `project_${now}_${projectIdCounter}` : `project_${now}`;
}

function getProjectPaths(projectId) {
  const projectDir = path.join(PROJECTS_DIR, projectId);
  return {
    projectDir,
    projectFile: path.join(projectDir, 'project.json'),
    scriptFile: path.join(projectDir, 'script.json'),
    seoFile: path.join(projectDir, 'seo.json'),
    outputDir: path.join(projectDir, 'output'),
    scenesDir: path.join(projectDir, 'scenes')
  };
}

function isImageSearchSource(imageSource = 'ai') {
  const source = String(imageSource || 'ai').trim();
  return Boolean(source) && source !== 'ai' && !source.startsWith('ai:') && !source.startsWith('video-api:') && !isVideoSearchSource(source) && !isDirectMediaMode(source) && !isHtmlSource(source) && !isFlowSource(source);
}

function isVideoSearchSource(imageSource = 'ai') {
  return String(imageSource || 'ai').trim() === 'pexels-video';
}

function isDirectMediaMode(imageSource = 'ai') {
  return String(imageSource || 'ai').trim() === 'direct-media';
}

function isHtmlSource(imageSource = 'ai') {
  return String(imageSource || 'ai').trim().startsWith('html:');
}

function isFlowSource(imageSource = 'ai') {
  return FLOW_SOURCES.has(String(imageSource || '').trim());
}

function isFlowImageOnlySource(imageSource = 'ai') {
  return String(imageSource || '').trim() === 'flow-images';
}

function isFlowVideoSource(imageSource = 'ai') {
  return FLOW_VIDEO_SOURCES.has(String(imageSource || '').trim());
}

function isFlowAudioSource(imageSource = 'ai') {
  return FLOW_AUDIO_SOURCES.has(String(imageSource || '').trim());
}

function isFlowFilmSource(imageSource = 'ai') {
  return String(imageSource || '').trim() === 'flow-film';
}

function getHtmlSourceProvider(imageSource = 'ai') {
  const source = String(imageSource || '').trim();
  return source.startsWith('html:') ? source.slice(5) || 'chat01' : 'chat01';
}

function normalizeLegacyImageSource(imageSource = 'ai') {
  const source = String(imageSource || 'ai').trim();
  return source.startsWith('video-api:') ? 'ai' : source;
}

function createSceneBase(scene, index) {
  return {
    sceneNumber: scene.sceneNumber ?? index + 1,
    voiceText: scene.voiceText ?? '',
    targetDurationSec: Number(scene.targetDurationSec || 0) || null,
    flowDurationSec: normalizeFlowDurationSec(scene.flowDurationSec ?? scene.flowVideoDurationSec),
    entityNames: normalizeEntityNames(scene.entityNames ?? scene.characterNames ?? scene.character_names ?? scene.entities),
    chainType: normalizeChainType(scene.chainType ?? scene.chain_type),
    parentSceneNumber: Number(scene.parentSceneNumber ?? scene.parent_scene_number ?? scene.parentScene ?? 0) || null,
    transitionPrompt: scene.transitionPrompt ?? scene.transition_prompt ?? '',
    status: scene.status ?? 'pending',
    files: scene.files ?? {},
    errors: scene.errors ?? [],
    durations: scene.durations ?? {},
    metadata: scene.metadata ?? {}
  };
}

function normalizeAiScenes(scenes = []) {
  return scenes.map((scene, index) => {
    const referenceUrl = typeof scene.useReferenceImage === 'string'
      ? scene.useReferenceImage.trim()
      : String(scene.sceneReferenceImageUrl || scene.referenceImageUrl || scene.referenceUrl || '').trim();
    return {
      ...createSceneBase(scene, index),
      imagePrompt: scene.imagePrompt ?? '',
      videoPrompt: scene.videoPrompt ?? '',
      durationSec: scene.durationSec ?? scene.targetDurationSec ?? null,
      imageKeyword: '',
      sceneReferenceImageUrl: referenceUrl,
      useReferenceImage: referenceUrl || Boolean(scene.useReferenceImage),
    };
  });
}

function normalizeSearchScenes(scenes = []) {
  return scenes.map((scene, index) => ({
    ...createSceneBase(scene, index),
    imagePrompt: '',
    imageKeyword: scene.imageKeyword ?? scene.imageSearchKeyword ?? scene.searchKeyword ?? '',
    videoKeyword: '',
    sceneReferenceImageUrl: '',
    useReferenceImage: false
  }));
}

function normalizeVideoScenes(scenes = []) {
  return scenes.map((scene, index) => ({
    ...createSceneBase(scene, index),
    imagePrompt: '',
    imageKeyword: '',
    videoKeyword: scene.videoKeyword ?? scene.imageKeyword ?? scene.imageSearchKeyword ?? scene.searchKeyword ?? '',
    sceneReferenceImageUrl: '',
    useReferenceImage: false
  }));
}

function inferDirectMediaType(mediaUrl = '') {
  const pathname = String(mediaUrl || '').trim().split('#')[0].split('?')[0];
  if (/\.(mp4|mov|m4v|webm)$/i.test(pathname)) return 'video';
  if (/\.(png|jpe?g|webp|gif|avif)$/i.test(pathname)) return 'image';
  return '';
}

function normalizeDirectMediaScenes(scenes = []) {
  return scenes.map((scene, index) => {
    const mediaUrl = String(scene.mediaUrl ?? scene.url ?? scene.videoUrl ?? scene.imageUrl ?? '').trim();
    const declaredType = String(scene.mediaType ?? scene.type ?? '').trim().toLowerCase();
    const mediaType = ['video', 'image'].includes(declaredType) ? declaredType : inferDirectMediaType(mediaUrl);
    if (!mediaUrl) throw new Error(`Scene ${scene.sceneNumber ?? index + 1} thiếu mediaUrl`);
    if (!mediaType) throw new Error(`Scene ${scene.sceneNumber ?? index + 1} cần mediaType là "image" hoặc "video"`);
    return {
      ...createSceneBase(scene, index),
      imagePrompt: '',
      imageKeyword: mediaType === 'image' ? mediaUrl : '',
      videoKeyword: mediaType === 'video' ? mediaUrl : '',
      mediaUrl,
      mediaType,
      sceneReferenceImageUrl: '',
      useReferenceImage: false
    };
  });
}

function normalizeHtmlScenes(scenes = []) {
  return scenes.map((scene, index) => ({
    ...createSceneBase(scene, index),
    voiceText: scene.voiceText ?? scene.voice ?? scene.ttsVoice ?? '',
    ttsVoice: scene.ttsVoice ?? scene.voiceText ?? scene.voice ?? '',
    visual: scene.visual ?? scene.imagePrompt ?? scene.imageKeyword ?? scene.videoKeyword ?? '',
    imagePrompt: '',
    imageKeyword: '',
    videoKeyword: '',
    htmlSpec: scene.htmlSpec ?? scene.htmlJson ?? scene.htmlDescription ?? null,
    sfxPlan: Array.isArray(scene.sfxPlan) ? scene.sfxPlan : [],
    generationMode: 'ai-html',
    sceneReferenceImageUrl: '',
    useReferenceImage: false
  }));
}

function normalizeScenesForImageSource(scenes = [], imageSource = 'ai') {
  return isHtmlSource(imageSource)
    ? normalizeHtmlScenes(scenes)
    : isDirectMediaMode(imageSource)
    ? normalizeDirectMediaScenes(scenes)
    : isVideoSearchSource(imageSource)
    ? normalizeVideoScenes(scenes)
    : isImageSearchSource(imageSource)
    ? normalizeSearchScenes(scenes)
    : normalizeAiScenes(scenes);
}

function normalizeScenes(scenes = []) {
  return normalizeAiScenes(scenes);
}

async function createProject(input) {
  const projectId = createProjectId();
  const paths = getProjectPaths(projectId);
  await Promise.all([
    ensureDir(paths.projectDir),
    ensureDir(paths.outputDir),
    ensureDir(paths.scenesDir)
  ]);

  const now = new Date().toISOString();
  const project = {
    id: projectId,
    title: typeof input.title === 'string' ? input.title.trim() : '',
    groupId: input.groupId || null,
    createdAt: now,
    updatedAt: now,
    status: 'queued',
    lastCompletedStep: null,
    inputMode: input.inputMode,
    inputText: input.inputText || '',
    inputSource: input.inputSource || { type: input.inputMode === 'json' ? 'json' : 'text' },
    settings: {
      ...DEFAULT_PROJECT_SETTINGS,
      ...input.settings,
      imageSource: normalizeLegacyImageSource(input.settings?.imageSource || DEFAULT_PROJECT_SETTINGS.imageSource),
      aspectRatio: normalizeAspectRatio(input.settings?.aspectRatio)
    },
    thumbnailPrompt: '',
    thumbnailKeyword: '',
    entities: normalizeScriptEntities(input.entities || []),
    scenes: [],
    outputs: {},
    seo: null,
    error: null
  };

  await writeJson(paths.projectFile, project);
  await upsertHistory({
    id: project.id,
    title: project.title,
    groupId: project.groupId || null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    status: project.status
  });
  return project;
}

async function getProject(projectId) {
  const paths = getProjectPaths(projectId);
  const project = await readJson(paths.projectFile, null);
  if (project?.settings?.imageSource) {
    project.settings.imageSource = normalizeLegacyImageSource(project.settings.imageSource);
  }
  if (project) {
    project.entities = normalizeScriptEntities(project.entities || []);
    if (project.thumbnailPrompt && !project.thumbnailPromptVertical) {
      project.thumbnailPromptVertical = getDefaultVerticalPrompt(project.thumbnailPrompt, project.title);
    }
  }
  return project;
}

const projectSaveLocks = new Map();

async function saveProject(project, options = {}) {
  const fs = require('fs').promises;
  const paths = getProjectPaths(project.id);
  
  if (!projectSaveLocks.has(project.id)) {
    projectSaveLocks.set(project.id, Promise.resolve());
  }
  
  const currentPromise = projectSaveLocks.get(project.id);
  const nextPromise = currentPromise.then(async () => {
    let latestProject;
    try {
      const data = await fs.readFile(paths.projectFile, 'utf8');
      latestProject = JSON.parse(data);
    } catch (err) {
      latestProject = project;
    }
    
    const overwrite = options.overwrite || !latestProject.scenes || latestProject.scenes.length === 0;
    const activeSceneNumber = project.activeSceneNumber || options.onlySceneNumber;
    
    // Merge scene-level changes
    if (!overwrite && latestProject && latestProject.scenes && project.scenes) {
      const targetScenes = activeSceneNumber
        ? project.scenes.filter(s => Number(s.sceneNumber) === Number(activeSceneNumber))
        : project.scenes;

      for (const scene of targetScenes) {
        const latestScene = latestProject.scenes.find(s => Number(s.sceneNumber) === Number(scene.sceneNumber));
        if (latestScene) {
          latestScene.files = { ...latestScene.files, ...scene.files };
          latestScene.metadata = { ...latestScene.metadata, ...scene.metadata };
          latestScene.status = scene.status;
          latestScene.errors = scene.errors;
          latestScene.durations = { ...latestScene.durations, ...scene.durations };
        }
      }
      
      // Nếu không phải là cập nhật đơn cảnh, hoặc cập nhật toàn dự án mới merge status chung
      if (!activeSceneNumber) {
        latestProject.outputs = { ...latestProject.outputs, ...project.outputs };
        latestProject.status = project.status;
        latestProject.lastCompletedStep = project.lastCompletedStep;
        latestProject.error = project.error;
        latestProject.seo = project.seo || latestProject.seo;
      }
      
      if (project.verticalSettings) {
        latestProject.verticalSettings = { ...latestProject.verticalSettings, ...project.verticalSettings };
      }
    } else {
      latestProject = project;
    }
    
    latestProject.updatedAt = new Date().toISOString();
    await writeJson(paths.projectFile, latestProject);
    
    await upsertHistory({
      id: latestProject.id,
      title: latestProject.title,
      groupId: latestProject.groupId || null,
      createdAt: latestProject.createdAt,
      updatedAt: latestProject.updatedAt,
      status: latestProject.status
    });
    
    project.updatedAt = latestProject.updatedAt;
  }).catch((err) => {
    console.error('Error in serialized saveProject:', err);
    throw err;
  });
  
  projectSaveLocks.set(project.id, nextPromise);
  return nextPromise;
}

async function updateProject(projectId, updater, options = {}) {
  const project = await getProject(projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }
  const next = await updater(project);
  return saveProject(next || project, options);
}

async function saveScript(projectId, scriptPayload) {
  const paths = getProjectPaths(projectId);
  await writeJson(paths.scriptFile, scriptPayload);
}

async function getProjectDetails(projectId) {
  const project = await getProject(projectId);
  if (!project) {
    return null;
  }
  const paths = getProjectPaths(projectId);
  const script = await readJson(paths.scriptFile, null);
  const seo = await readJson(paths.seoFile, null);
  return { project, script, seo, paths };
}

async function ensureSceneDir(projectId, sceneNumber) {
  const dir = path.join(getProjectPaths(projectId).scenesDir, `scene-${String(sceneNumber).padStart(2, '0')}`);
  await ensureDir(dir);
  return dir;
}

async function projectExists(projectId) {
  return exists(getProjectPaths(projectId).projectFile);
}

module.exports = {
  getDefaultVerticalPrompt,
  createProject,
  getProject,
  saveProject,
  updateProject,
  saveScript,
  getProjectDetails,
  getProjectPaths,
  ensureSceneDir,
  projectExists,
  normalizeScenes,
  normalizeScenesForImageSource,
  normalizeAiScenes,
  normalizeSearchScenes,
  normalizeVideoScenes,
  normalizeDirectMediaScenes,
  normalizeHtmlScenes,
  normalizeScriptEntities,
  normalizeEntityNames,
  isImageSearchSource,
  isVideoSearchSource,
  isDirectMediaMode,
  isHtmlSource,
  isFlowSource,
  isFlowImageOnlySource,
  isFlowVideoSource,
  isFlowAudioSource,
  isFlowFilmSource,
  getHtmlSourceProvider
};
