const fs = require('fs/promises');
const path = require('path');
const { ASSETS_DIR, PROJECTS_DIR, PUBLIC_DIR } = require('../config/constants');

function stripUrlDecorations(value) {
  return String(value || '').trim().split('#')[0].split('?')[0].trim();
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isWebsitePath(value) {
  const raw = String(value || '').trim();
  if (!raw || /\s/.test(raw) || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return false;
  return raw.startsWith('/')
    || raw.startsWith('projects/')
    || raw.startsWith('assets/')
    || raw.includes('/')
    || /\.(png|jpe?g|webp|gif|avif|mp4|mov|m4v|webm)$/i.test(stripUrlDecorations(raw));
}

function isDirectMediaSource(value) {
  const raw = String(value || '').trim();
  return isHttpUrl(raw) || path.isAbsolute(raw) || isWebsitePath(raw);
}

function safeJoin(rootDir, relativePath) {
  const normalized = decodeURIComponent(relativePath || '').replace(/^\/+/, '');
  const resolved = path.resolve(rootDir, normalized);
  const root = path.resolve(rootDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Đường dẫn tài nguyên không hợp lệ');
  }
  return resolved;
}

function resolveWebsitePath(value) {
  const raw = stripUrlDecorations(value);
  const pathname = raw.startsWith('/') ? raw : `/${raw}`;
  if (pathname.startsWith('/projects/')) {
    return safeJoin(PROJECTS_DIR, pathname.slice('/projects/'.length));
  }
  if (pathname.startsWith('/assets/')) {
    return safeJoin(ASSETS_DIR, pathname.slice('/assets/'.length));
  }
  return safeJoin(PUBLIC_DIR, pathname.slice(1));
}

async function downloadHttpMedia(url, outputPath, accept, expectedType) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VibeToolVideo/1.0)', Accept: accept || '*/*' },
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) throw new Error(`Tải tài nguyên HTTP ${res.status}: ${url}`);
  const contentType = res.headers.get('content-type') || '';
  if (expectedType && contentType && !contentType.startsWith(`${expectedType}/`) && !contentType.includes('octet-stream')) {
    throw new Error(`URL không phải ${expectedType} (${contentType})`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 2048) throw new Error('Tài nguyên tải về quá nhỏ hoặc không hợp lệ');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, bytes);
}

async function copyWebsiteMedia(sitePath, outputPath) {
  const inputPath = resolveWebsitePath(sitePath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.copyFile(inputPath, outputPath);
  return inputPath;
}

async function saveDirectMediaSource(source, outputPath, { accept, expectedType } = {}) {
  const raw = String(source || '').trim();
  if (isHttpUrl(raw)) {
    await downloadHttpMedia(raw, outputPath, accept, expectedType);
    return { outputPath, sourceUrl: raw, sourceType: 'url' };
  }
  if (path.isAbsolute(raw)) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.copyFile(raw, outputPath);
    return { outputPath, sourcePath: raw, sourceType: 'file-path' };
  }
  if (isWebsitePath(raw)) {
    const sourcePath = await copyWebsiteMedia(raw, outputPath);
    return { outputPath, sourcePath, sourceType: 'website-path' };
  }
  throw new Error('Nguồn tài nguyên trực tiếp không hợp lệ');
}

module.exports = {
  isHttpUrl,
  isDirectMediaSource,
  resolveWebsitePath,
  saveDirectMediaSource
};
