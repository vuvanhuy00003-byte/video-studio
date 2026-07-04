const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { pathToFileURL } = require('url');
const { STORAGE_DIR } = require('../config/constants');
const { getProjectPaths } = require('./projectService');

const execFileAsync = promisify(execFile);

function mediaKindFromUpload(file) {
  const value = `${file?.mimetype || ''} ${file?.originalname || ''}`.toLowerCase();
  if (/video\/|\.mp4|\.mov|\.m4v|\.webm/.test(value)) return 'video';
  if (/audio\/|\.mp3|\.wav|\.m4a|\.aac|\.ogg/.test(value)) return 'audio';
  if (/image\/|\.png|\.jpe?g|\.webp|\.gif|\.avif/.test(value)) return 'image';
  return 'file';
}

function mediaKindFromMime(mime = '', fileName = '') {
  return mediaKindFromUpload({ mimetype: mime, originalname: fileName });
}

function describeMediaName(fileName = '') {
  return path.basename(fileName, path.extname(fileName))
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeFileBase(originalName = '', fallback = 'media') {
  const ext = path.extname(originalName || '');
  return (path.basename(originalName || fallback, ext)
    .replace(/[^\p{L}\p{N}._ -]+/gu, '-')
    .replace(/\s+/g, '-')
    .slice(0, 80) || fallback);
}

function numberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

async function probeMediaMetadata(filePath, type, ffprobePath = 'ffprobe') {
  if (!filePath || type === 'file') return {};
  try {
    const { stdout } = await execFileAsync(ffprobePath || 'ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      filePath
    ], { maxBuffer: 1024 * 1024 });
    const data = JSON.parse(stdout || '{}');
    const streams = Array.isArray(data.streams) ? data.streams : [];
    const visualStream = streams.find((stream) => Number(stream.width) && Number(stream.height));
    const duration = numberOrNull(data.format?.duration)
      || numberOrNull(streams.find((stream) => numberOrNull(stream.duration))?.duration);
    return {
      width: visualStream ? numberOrNull(visualStream.width) : null,
      height: visualStream ? numberOrNull(visualStream.height) : null,
      durationSec: duration
    };
  } catch {
    return {};
  }
}

function toPromptMediaItem(item = {}, fallback = {}) {
  const fileName = item.originalName || item.fileName || path.basename(item.path || '');
  const type = item.type || mediaKindFromMime(item.mimeType, fileName);
  const out = {
    id: item.id || '',
    scope: item.scope || fallback.scope || 'project',
    role: item.role || fallback.role || 'scene-media',
    type,
    fileName,
    description: item.description || describeMediaName(fileName || item.path || ''),
    path: item.path || '',
    src: item.path ? pathToFileURL(item.path).href : '',
    publicPath: item.publicPath || '',
    mimeType: item.mimeType || ''
  };
  if ((type === 'image' || type === 'video') && item.width) out.width = item.width;
  if ((type === 'image' || type === 'video') && item.height) out.height = item.height;
  if ((type === 'audio' || type === 'video') && item.durationSec) out.durationSec = item.durationSec;
  return out.src ? out : null;
}

async function storeProjectHtmlMediaFiles(project, files = [], options = {}) {
  if (!files.length) return [];
  const paths = getProjectPaths(project.id);
  const mediaDir = path.join(paths.projectDir, 'html-media');
  await fs.mkdir(mediaDir, { recursive: true });
  const stored = [];
  for (const [index, file] of files.entries()) {
    const ext = path.extname(file.originalname || '') || path.extname(file.path || '') || '';
    const safeBase = safeFileBase(file.originalname || `media-${index + 1}${ext}`, `media-${index + 1}`);
    const fileName = `${Date.now()}-${index + 1}-${safeBase}${ext}`;
    const dest = path.join(mediaDir, fileName);
    await fs.rename(file.path, dest);
    const type = mediaKindFromUpload(file);
    const metadata = await probeMediaMetadata(dest, type, options.ffprobePath);
    stored.push({
      id: crypto.randomBytes(8).toString('hex'),
      scope: 'project',
      role: 'scene-media',
      type,
      originalName: file.originalname || fileName,
      fileName,
      description: describeMediaName(file.originalname || fileName),
      mimeType: file.mimetype || '',
      path: dest,
      publicPath: `/projects/${project.id}/html-media/${fileName}`,
      width: metadata.width || null,
      height: metadata.height || null,
      durationSec: metadata.durationSec || null
    });
  }
  project.outputs = project.outputs || {};
  project.outputs.htmlMedia = [...(project.outputs.htmlMedia || []), ...stored];
  return stored;
}

async function storeGlobalHtmlMediaFiles(settings, files = [], kind, options = {}) {
  if (!files.length) return [];
  const isSfx = kind === 'sfx';
  const field = isSfx ? 'htmlDefaultSfx' : 'htmlBrandAssets';
  const role = isSfx ? 'sound-effect' : 'brand-asset';
  const mediaDir = path.join(STORAGE_DIR, 'html-default-media', isSfx ? 'sfx' : 'brand');
  await fs.mkdir(mediaDir, { recursive: true });
  const stored = [];
  for (const [index, file] of files.entries()) {
    const ext = path.extname(file.originalname || '') || path.extname(file.path || '') || '';
    const safeBase = safeFileBase(file.originalname || `${role}-${index + 1}${ext}`, `${role}-${index + 1}`);
    const fileName = `${Date.now()}-${index + 1}-${safeBase}${ext}`;
    const dest = path.join(mediaDir, fileName);
    await fs.rename(file.path, dest);
    const type = mediaKindFromUpload(file);
    const metadata = await probeMediaMetadata(dest, type, options.ffprobePath);
    stored.push({
      id: crypto.randomBytes(8).toString('hex'),
      scope: 'global',
      role,
      type,
      originalName: file.originalname || fileName,
      fileName,
      description: describeMediaName(file.originalname || fileName),
      mimeType: file.mimetype || '',
      path: dest,
      width: metadata.width || null,
      height: metadata.height || null,
      durationSec: metadata.durationSec || null
    });
  }
  return {
    [field]: [...(Array.isArray(settings?.[field]) ? settings[field] : []), ...stored]
  };
}

function sanitizeStoredHtmlMediaList(list = [], fallback = {}) {
  return (Array.isArray(list) ? list : [])
    .map((item) => toPromptMediaItem(item, fallback))
    .filter(Boolean);
}

function buildHtmlMediaCatalog({ project = {}, settings = {} } = {}) {
  return [
    ...sanitizeStoredHtmlMediaList(settings.htmlDefaultSfx, { scope: 'global', role: 'sound-effect' }),
    ...sanitizeStoredHtmlMediaList(settings.htmlBrandAssets, { scope: 'global', role: 'brand-asset' }),
    ...sanitizeStoredHtmlMediaList(project.outputs?.htmlMedia, { scope: 'project', role: 'scene-media' })
  ];
}

module.exports = {
  mediaKindFromUpload,
  mediaKindFromMime,
  describeMediaName,
  storeProjectHtmlMediaFiles,
  storeGlobalHtmlMediaFiles,
  buildHtmlMediaCatalog
};
