const { getVideoLanguageConfig } = require('../config/languages');

const MAX_CHARS_PER_SCENE = 150;
const MAX_TAG_WORDS = 4;

function computeTimestamps(scenes, xfadeDurationSec = 0.5) {
  const timestamps = [];
  let elapsed = 0;
  for (let i = 0; i < scenes.length; i++) {
    timestamps.push(Math.floor(elapsed));
    const dur = Number(scenes[i].durations?.voiceSec || 0);
    if (i < scenes.length - 1) {
      elapsed += Math.max(0, dur - xfadeDurationSec);
    }
  }
  return timestamps;
}

function formatTimestamp(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function normalizeWords(text = '') {
  return String(text || '')
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3);
}

function uniqueItems(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const key = String(item || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractFallbackTags(project) {
  const text = [
    project.title,
    project.thumbnailKeyword,
    project.thumbnailPrompt,
    ...(project.scenes || []).flatMap((scene) => [
      scene.voiceText,
      scene.imageKeyword,
      scene.videoKeyword
    ])
  ].filter(Boolean).join(' ');
  const stopwords = new Set([
    'của', 'cho', 'với', 'một', 'những', 'được', 'trong', 'không', 'này', 'đó',
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'you', 'your'
  ]);
  const counts = new Map();
  for (const word of normalizeWords(text)) {
    if (stopwords.has(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  const topWords = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'vi'))
    .map(([word]) => word)
    .slice(0, 15);
  const titleWords = normalizeWords(project.title).slice(0, MAX_TAG_WORDS).join(' ');
  return uniqueItems([titleWords, ...topWords, 'video', 'shorts']).slice(0, 15);
}

function sceneSummary(scene) {
  return String(scene.voiceText || scene.imagePrompt || scene.videoKeyword || scene.imageKeyword || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function fallbackSeo(project) {
  const language = getVideoLanguageConfig(project.settings?.videoLanguage);
  const xfade = project.settings?.transitionPreset === 'none' ? 0 : project.settings?.xfadeDurationSec ?? 0.5;
  const timestamps = computeTimestamps(project.scenes || [], xfade);
  const title = String(project.title || sceneSummary(project.scenes?.[0]) || 'Video mới').trim().slice(0, 90);
  const sceneItems = (project.scenes || []).slice(0, 8).map((scene, index) => {
    const summary = sceneSummary(scene).slice(0, 90) || `Cảnh ${scene.sceneNumber || index + 1}`;
    return `${formatTimestamp(timestamps[index] || 0)} — ${summary}`;
  });
  const intro = language.value === 'vi'
    ? `Video này tổng hợp những điểm chính của "${title}" theo mạch kể ngắn gọn, dễ theo dõi.`
    : `This video summarizes the key ideas of "${title}" in a concise, easy-to-follow flow.`;
  const body = language.value === 'vi'
    ? 'Xem đến cuối để nắm trọn nội dung và chọn góc nhìn phù hợp nhất với bạn.'
    : 'Watch until the end to catch the full story and the most useful takeaways.';
  const sectionTitle = language.value === 'vi' ? '▬▬▬▬▬ NỘI DUNG VIDEO ▬▬▬▬▬' : '▬▬▬▬▬ VIDEO CONTENT ▬▬▬▬▬';
  const tags = extractFallbackTags(project);
  const hashtags = tags.slice(0, 5).map((tag) => `#${tag.replace(/\s+/g, '')}`).join(' ');
  return {
    title,
    description: [
      intro,
      '',
      body,
      '',
      sectionTitle,
      ...(sceneItems.length ? sceneItems : ['00:00 — Nội dung chính']),
      '',
      hashtags
    ].join('\n'),
    tags,
    socialCaptions: language.value === 'vi'
      ? [
          `Có một chi tiết trong video này rất đáng suy nghĩ. ${title}\n\n${hashtags}`,
          `Nếu bạn từng gặp tình huống giống trong câu chuyện này, video này sẽ cho bạn một góc nhìn khác.\n\n${hashtags}`,
          `Bạn đồng ý hay không đồng ý với cách nhìn trong video? Xem hết rồi để lại ý kiến của bạn.\n\n${hashtags}`
        ]
      : [
          `There is one detail in this video worth thinking about. ${title}\n\n${hashtags}`,
          `If this situation feels familiar, this video gives you another way to look at it.\n\n${hashtags}`,
          `Do you agree with the perspective in this video? Watch it and share your take.\n\n${hashtags}`
        ]
  };
}

async function generateSeo(chat01Client, project) {
  const language = getVideoLanguageConfig(project.settings?.videoLanguage);
  const xfade = project.settings?.transitionPreset === 'none' ? 0 : project.settings?.xfadeDurationSec ?? 0.5;
  const timestamps = computeTimestamps(project.scenes, xfade);

  const sceneLines = project.scenes.map((scene, i) => {
    const ts = formatTimestamp(timestamps[i]);
    const text = (scene.voiceText || '').slice(0, MAX_CHARS_PER_SCENE);
    return `[${ts}] Cảnh ${scene.sceneNumber}: ${text}`;
  }).join('\n');

  const prompt = [
    `Bạn là chuyên gia nội dung video đa nền tảng bằng ${language.vietnameseName}.`,
    `BẮT BUỘC viết title, description, tags và mọi socialCaptions bằng ${language.vietnameseName}. Không trộn ngôn ngữ khác, trừ tên riêng hoặc thuật ngữ bắt buộc.`,
    `Chủ đề video: ${project.title}`,
    '',
    'Danh sách cảnh với timestamp và nội dung (đã rút gọn):',
    sceneLines,
    '',
    'Trả về JSON hợp lệ với đúng 4 field: title, description, tags, socialCaptions.',
    '',
    'Yêu cầu cho description (plain text, xuống dòng bằng \\n):',
    '  1. 2-3 đoạn văn mô tả hấp dẫn nội dung video, viết tự nhiên như copywriter YouTube.',
    '  2. Dòng trống, rồi khối:',
    '       ▬▬▬▬▬ NỘI DUNG VIDEO ▬▬▬▬▬',
    '       MM:SS — Tên mục nội dung',
    '     Gộp các cảnh liên quan thành 5-8 mục lớn, KHÔNG liệt kê từng cảnh riêng lẻ.',
    '     Dùng đúng timestamp đã cho ở đầu mỗi mục.',
    '  3. Dòng trống, rồi các hashtag liên quan.',
    '',
    'Yêu cầu cho tags: mảng 10-15 chuỗi từ khoá, không có dấu #.',
    '',
    'Yêu cầu cho socialCaptions:',
    '  1. Mảng đúng 3 caption ngắn để người dùng lựa chọn đăng Facebook, TikTok, Reels và các mạng xã hội khác.',
    '  2. Mỗi caption dài khoảng 2-5 câu ngắn, mở đầu bằng một hook mạnh ngay câu đầu và có 2-5 hashtag phù hợp ở cuối.',
    '  3. Ba phiên bản phải khác rõ rệt về góc tiếp cận: một bản gây tò mò, một bản chạm cảm xúc hoặc vấn đề người xem, một bản trực diện tạo tranh luận hoặc thúc đẩy hành động.',
    '  4. Viết tự nhiên, hấp dẫn, không giật tít sai nội dung, không dùng tiêu đề "Phiên bản 1/2/3", không chèn timestamp.',
  ].join('\n');

  let seo;
  try {
    seo = await chat01Client.generateJson(prompt);
  } catch (error) {
    return fallbackSeo(project);
  }
  return {
    title: String(seo?.title || project.title || '').trim(),
    description: String(seo?.description || '').trim(),
    tags: (Array.isArray(seo?.tags) ? seo.tags : [])
      .map((tag) => String(tag || '').replace(/^#+/, '').trim())
      .filter(Boolean)
      .slice(0, 15),
    socialCaptions: (Array.isArray(seo?.socialCaptions) ? seo.socialCaptions : [])
      .map((caption) => String(caption || '').trim())
      .filter(Boolean)
      .slice(0, 3)
  };
}

module.exports = {
  generateSeo
};
