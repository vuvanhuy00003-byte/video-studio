const fs = require('fs/promises');
const path = require('path');
const { getAspectRatioConfig } = require('../config/constants');
const { getVideoLanguageConfig } = require('../config/languages');
const { sanitizeApiKeyError, withApiKeyFallback } = require('./providerUtils');

const SERPER_IMAGES_URL = 'https://google.serper.dev/images';
const PEXELS_SEARCH_URL = 'https://api.pexels.com/v1/search';
const PEXELS_VIDEO_SEARCH_URL = 'https://api.pexels.com/v1/videos/search';

function normalizePexelsQuery(query) {
  const raw = String(query || '').trim();
  return raw
    .replace(/\bsite:\S+/gi, ' ')
    .replace(/\bfiletype:\S+/gi, ' ')
    .replace(/\bOR\b/gi, ' ')
    .replace(/(^|\s)-[^\s]+/g, ' ')
    .replace(/["'()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || raw.slice(0, 120);
}

function providerKeys(settings, provider) {
  if (provider === 'pexels') return settings.pexelsKeysText;
  return settings.serperKeysText;
}

async function searchSerperImages(query, settings, { num = 10 } = {}) {
  const localeParams = getVideoLanguageConfig(settings.videoLanguage).serperLocale;
  return withApiKeyFallback(providerKeys(settings, 'serper'), async (apiKey, keyMeta) => {
    const res = await fetch(SERPER_IMAGES_URL, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: String(query || '').trim(),
        num: Math.max(1, Math.min(10, Number(num) || 10)),
        ...localeParams
      }),
      signal: AbortSignal.timeout(45000)
    });
    const raw = await res.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { error: raw }; }
    if (!res.ok) {
      const error = new Error(`Serper Images HTTP ${res.status} (key=${keyMeta.maskedKey}): ${sanitizeApiKeyError(data?.message || data?.error || raw, [apiKey]).slice(0, 500)}`);
      error.status = res.status;
      throw error;
    }
    return (Array.isArray(data.images) ? data.images : [])
      .map((item) => ({
        title: String(item?.title || '').trim().slice(0, 180),
        imageUrl: String(item?.imageUrl || '').trim(),
        imageWidth: Number(item?.imageWidth) || 0,
        imageHeight: Number(item?.imageHeight) || 0,
        source: 'serper'
      }))
      .filter((item) => /^https?:\/\//i.test(item.imageUrl))
      .slice(0, 10);
  }, { label: 'Serper Images' });
}

async function searchPexelsImages(query, settings, { num = 10, aspectRatio = '16:9' } = {}) {
  const ratio = getAspectRatioConfig(aspectRatio);
  const orientation = ratio.height > ratio.width ? 'portrait' : ratio.width > ratio.height ? 'landscape' : 'square';
  return withApiKeyFallback(providerKeys(settings, 'pexels'), async (apiKey, keyMeta) => {
    const url = new URL(PEXELS_SEARCH_URL);
    url.searchParams.set('query', normalizePexelsQuery(query));
    url.searchParams.set('per_page', String(Math.max(1, Math.min(80, Number(num) || 10))));
    url.searchParams.set('orientation', orientation);
    url.searchParams.set('locale', getVideoLanguageConfig(settings.videoLanguage).pexelsLocale);
    const res = await fetch(url, {
      headers: { Authorization: apiKey },
      signal: AbortSignal.timeout(45000)
    });
    const raw = await res.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { error: raw }; }
    if (!res.ok) {
      const error = new Error(`Pexels Images HTTP ${res.status} (key=${keyMeta.maskedKey}): ${sanitizeApiKeyError(data?.error || data?.message || raw, [apiKey]).slice(0, 500)}`);
      error.status = res.status;
      throw error;
    }
    return (Array.isArray(data.photos) ? data.photos : [])
      .map((item) => ({
        title: String(item?.alt || item?.photographer || 'Pexels photo').trim().slice(0, 180),
        imageUrl: String(item?.src?.large2x || item?.src?.large || item?.src?.original || item?.src?.portrait || '').trim(),
        imageWidth: Number(item?.width) || 0,
        imageHeight: Number(item?.height) || 0,
        source: 'pexels',
        pageUrl: String(item?.url || '').trim(),
        photographer: String(item?.photographer || '').trim()
      }))
      .filter((item) => /^https?:\/\//i.test(item.imageUrl))
      .slice(0, 10);
  }, { label: 'Pexels Images' });
}

async function searchPexelsVideos(query, settings, { num = 15, aspectRatio = '16:9' } = {}) {
  const ratio = getAspectRatioConfig(aspectRatio);
  const orientation = ratio.height > ratio.width ? 'portrait' : ratio.width > ratio.height ? 'landscape' : 'square';
  return withApiKeyFallback(providerKeys(settings, 'pexels'), async (apiKey, keyMeta) => {
    const url = new URL(PEXELS_VIDEO_SEARCH_URL);
    url.searchParams.set('query', normalizePexelsQuery(query));
    url.searchParams.set('per_page', String(Math.max(1, Math.min(80, Number(num) || 15))));
    url.searchParams.set('orientation', orientation);
    url.searchParams.set('locale', getVideoLanguageConfig(settings.videoLanguage).pexelsLocale);
    const res = await fetch(url, {
      headers: { Authorization: apiKey },
      signal: AbortSignal.timeout(45000)
    });
    const raw = await res.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { error: raw }; }
    if (!res.ok) {
      const error = new Error(`Pexels Videos HTTP ${res.status} (key=${keyMeta.maskedKey}): ${sanitizeApiKeyError(data?.error || data?.message || raw, [apiKey]).slice(0, 500)}`);
      error.status = res.status;
      throw error;
    }
    return (Array.isArray(data.videos) ? data.videos : [])
      .map((item) => ({
        id: String(item?.id || '').trim(),
        title: String(item?.user?.name || 'Pexels video').trim().slice(0, 180),
        duration: Number(item?.duration) || 0,
        width: Number(item?.width) || 0,
        height: Number(item?.height) || 0,
        source: 'pexels-video',
        pageUrl: String(item?.url || '').trim(),
        user: item?.user || null,
        videoFiles: Array.isArray(item?.video_files) ? item.video_files : []
      }))
      .filter((item) => item.videoFiles.length)
      .slice(0, 15);
  }, { label: 'Pexels Videos' });
}

async function searchImages(query, settings, options = {}) {
  const provider = String(settings.imageSource || 'serper');
  if (provider === 'pexels') return searchPexelsImages(query, settings, options);
  return searchSerperImages(query, settings, options);
}

function rankCandidates(candidates, aspectRatio) {
  const ratio = getAspectRatioConfig(aspectRatio);
  const target = ratio.width / ratio.height;
  return [...candidates].sort((a, b) => {
    const aRatio = a.imageWidth && a.imageHeight ? a.imageWidth / a.imageHeight : target;
    const bRatio = b.imageWidth && b.imageHeight ? b.imageWidth / b.imageHeight : target;
    const aArea = (a.imageWidth || 0) * (a.imageHeight || 0);
    const bArea = (b.imageWidth || 0) * (b.imageHeight || 0);
    return Math.abs(aRatio - target) - Math.abs(bRatio - target) || bArea - aArea;
  });
}

function getTargetAspect(aspectRatio) {
  const ratio = getAspectRatioConfig(aspectRatio);
  return ratio.width / ratio.height;
}

function getVideoFileScore(file, targetAspect) {
  const width = Number(file?.width) || 0;
  const height = Number(file?.height) || 0;
  const fileAspect = width && height ? width / height : targetAspect;
  const area = width * height;
  const isMp4 = /mp4/i.test(String(file?.file_type || file?.link || ''));
  return {
    aspectDelta: Math.abs(fileAspect - targetAspect),
    area,
    isMp4
  };
}

function selectBestVideoFile(candidate, aspectRatio) {
  const targetAspect = getTargetAspect(aspectRatio);
  return [...(candidate.videoFiles || [])]
    .filter((file) => /^https?:\/\//i.test(String(file?.link || '')))
    .filter((file) => !/mpegurl|m3u8/i.test(String(file?.file_type || file?.link || '')))
    .sort((a, b) => {
      const aScore = getVideoFileScore(a, targetAspect);
      const bScore = getVideoFileScore(b, targetAspect);
      return Number(bScore.isMp4) - Number(aScore.isMp4)
        || aScore.aspectDelta - bScore.aspectDelta
        || bScore.area - aScore.area;
    })[0] || null;
}

function normalizeVideoRef(value) {
  return String(value || '').trim().toLowerCase();
}

function getPexelsVideoIdFromUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'pexels.com' && !hostname.endsWith('.pexels.com')) return '';
    const videoFileMatch = url.pathname.match(/\/video-files\/(\d+)(?:\/|$)/i);
    if (videoFileMatch) return videoFileMatch[1];
    if (!url.pathname.toLowerCase().includes('/video/')) return '';
    const pageMatch = url.pathname.replace(/\/+$/, '').match(/(?:-|\/)(\d+)$/);
    return pageMatch?.[1] || '';
  } catch {
    return '';
  }
}

function getPexelsExcludedVideoRefs(urlsText) {
  const refs = new Set();
  String(urlsText || '')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .forEach((value) => {
      refs.add(normalizeVideoRef(value));
      const videoId = getPexelsVideoIdFromUrl(value);
      if (videoId) refs.add(`id:${videoId}`);
    });
  return [...refs];
}

function getVideoCandidateRefs(candidate) {
  return [
    candidate.id ? `id:${candidate.id}` : '',
    candidate.pageUrl,
    candidate.selectedFile?.link,
    ...(candidate.videoFiles || []).map((file) => file?.link)
  ]
    .map(normalizeVideoRef)
    .filter(Boolean);
}

function videoCandidateWasUsed(candidate, usedVideoRefs = []) {
  const used = new Set((usedVideoRefs || []).map(normalizeVideoRef).filter(Boolean));
  if (!used.size) return false;
  return getVideoCandidateRefs(candidate).some((ref) => used.has(ref));
}

function rankVideoCandidates(candidates, aspectRatio, targetDurationSec = 0, usedVideoRefs = []) {
  const targetAspect = getTargetAspect(aspectRatio);
  const targetDuration = Number(targetDurationSec) || 0;
  return [...candidates]
    .map((candidate) => ({
      ...candidate,
      selectedFile: selectBestVideoFile(candidate, aspectRatio)
    }))
    .filter((candidate) => candidate.selectedFile)
    .filter((candidate) => !videoCandidateWasUsed(candidate, usedVideoRefs))
    .sort((a, b) => {
      const aRatio = a.width && a.height ? a.width / a.height : targetAspect;
      const bRatio = b.width && b.height ? b.width / b.height : targetAspect;
      const aDurationDelta = targetDuration ? Math.abs((a.duration || 0) - targetDuration) : 0;
      const bDurationDelta = targetDuration ? Math.abs((b.duration || 0) - targetDuration) : 0;
      const aFileScore = getVideoFileScore(a.selectedFile, targetAspect);
      const bFileScore = getVideoFileScore(b.selectedFile, targetAspect);
      return aDurationDelta - bDurationDelta
        || Math.abs(aRatio - targetAspect) - Math.abs(bRatio - targetAspect)
        || aFileScore.aspectDelta - bFileScore.aspectDelta
        || bFileScore.area - aFileScore.area;
    });
}

async function downloadSearchImage(candidate, outputPath) {
  const res = await fetch(candidate.imageUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VibeToolVideo/1.0)', Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8' },
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) throw new Error(`Download image HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') || '';
  if (contentType && !contentType.startsWith('image/')) throw new Error(`URL không phải ảnh (${contentType})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 2048) throw new Error('Ảnh tải về quá nhỏ hoặc không hợp lệ');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, bytes);
}

async function downloadSearchVideo(candidate, outputPath) {
  const videoUrl = candidate.selectedFile?.link;
  if (!/^https?:\/\//i.test(String(videoUrl || ''))) {
    throw new Error('Video URL không hợp lệ');
  }
  const res = await fetch(videoUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VibeToolVideo/1.0)', Accept: 'video/mp4,video/*,*/*;q=0.8' },
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) throw new Error(`Download video HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') || '';
  if (contentType && !contentType.startsWith('video/') && !contentType.includes('octet-stream')) {
    throw new Error(`URL không phải video (${contentType})`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 32768) throw new Error('Video tải về quá nhỏ hoặc không hợp lệ');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, bytes);
}

async function findAndDownloadImage({ query, settings, outputPath, aspectRatio, validateDownloadedImage }) {
  const candidates = await searchImages(query, settings, { num: 10, aspectRatio });
  if (!candidates.length) throw new Error(`Không tìm thấy ảnh cho từ khoá: ${query}`);
  const rankedCandidates = rankCandidates(candidates, aspectRatio);
  const failedCandidates = [];

  for (let index = 0; index < rankedCandidates.length; index += 1) {
    const candidate = rankedCandidates[index];
    const candidatePath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.candidate-${index + 1}.png`);
    try {
      await downloadSearchImage(candidate, candidatePath);
      if (typeof validateDownloadedImage === 'function') {
        await validateDownloadedImage(candidatePath, candidate);
      }
      await fs.rename(candidatePath, outputPath);
      return {
        outputPath,
        imageUrl: candidate.imageUrl,
        candidate,
        candidates: rankedCandidates,
        failedCandidates
      };
    } catch (error) {
      await fs.unlink(candidatePath).catch(() => {});
      failedCandidates.push({
        candidate,
        error: String(error?.message || error)
      });
    }
  }

  const lastError = failedCandidates.at(-1)?.error || 'không rõ lỗi';
  throw new Error(`Không tải hoặc xử lý được ảnh nào trong ${rankedCandidates.length} kết quả cho từ khoá "${query}". Lỗi cuối: ${lastError}`);
}

async function findAndDownloadVideo({ query, settings, outputPath, aspectRatio, targetDurationSec, usedVideoRefs = [] }) {
  const candidates = await searchPexelsVideos(query, settings, { num: 15, aspectRatio });
  if (!candidates.length) throw new Error(`Không tìm thấy video cho từ khoá: ${query}`);
  const excludedVideoRefs = getPexelsExcludedVideoRefs(settings?.pexelsExcludedVideoUrlsText);
  const rankedCandidates = rankVideoCandidates(candidates, aspectRatio, targetDurationSec, [
    ...usedVideoRefs,
    ...excludedVideoRefs
  ]);
  if (!rankedCandidates.length) {
    throw new Error(`Không còn video Pexels phù hợp chưa dùng hoặc không bị loại trừ cho từ khoá "${query}". Hãy đổi videoKeyword hoặc tăng độ rộng keyword.`);
  }
  const failedCandidates = [];

  for (let index = 0; index < rankedCandidates.length; index += 1) {
    const candidate = rankedCandidates[index];
    const candidatePath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.candidate-${index + 1}.mp4`);
    try {
      await downloadSearchVideo(candidate, candidatePath);
      await fs.rename(candidatePath, outputPath);
      return {
        outputPath,
        videoUrl: candidate.selectedFile?.link,
        candidate,
        candidates: rankedCandidates,
        failedCandidates
      };
    } catch (error) {
      await fs.unlink(candidatePath).catch(() => {});
      failedCandidates.push({
        candidate,
        error: String(error?.message || error)
      });
    }
  }

  const lastError = failedCandidates.at(-1)?.error || 'không rõ lỗi';
  throw new Error(`Không tải được video nào trong ${rankedCandidates.length} kết quả cho từ khoá "${query}". Lỗi cuối: ${lastError}`);
}

module.exports = {
  searchImages,
  searchPexelsVideos,
  findAndDownloadImage,
  findAndDownloadVideo
};
