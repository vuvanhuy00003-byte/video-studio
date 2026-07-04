const {
  isImageSearchSource,
  isVideoSearchSource,
  isDirectMediaMode,
  isHtmlSource,
  isFlowSource,
  isFlowImageOnlySource,
  isFlowAudioSource,
  isFlowFilmSource,
  normalizeScenesForImageSource,
  normalizeScriptEntities
} = require('./projectService');
const { STYLE_PROMPT_DETAIL, STYLE_BG_MODIFIERS, getAspectRatioConfig } = require('../config/constants');
const { getVideoLanguageConfig } = require('../config/languages');
const htmlPatternLibrary = require('../config/htmlPatternLibrary.json');

const MAX_HTML_SCRIPT_ATTEMPTS = 3;
const SOURCE_REFERENCE_PATTERNS = [
  /\b(?:bài viết|nội dung nguồn|nguồn đầu vào|tài liệu nguồn|văn bản nguồn)\s+(?:này\s+)?(?:cho biết|gợi ý|nhấn mạnh|đề cập|mô tả|khẳng định|nói rằng)/iu,
  /\btheo\s+(?:bài viết|nội dung nguồn|nguồn đầu vào|tài liệu nguồn|văn bản nguồn)\b/iu,
  /\b(?:this|the)\s+(?:article|source|input|source material)\s+(?:says|suggests|emphasizes|mentions|describes|claims)\b/iu,
  /\baccording to\s+(?:this|the)\s+(?:article|source|input|source material)\b/iu
];

function deriveTitle(title, scenes = []) {
  const normalizedTitle = String(title || '').trim();
  if (normalizedTitle) {
    return normalizedTitle;
  }

  const fallback = scenes
    .map((scene) => String(scene.voiceText || scene.imagePrompt || scene.imageKeyword || scene.videoKeyword || '').trim())
    .find(Boolean);
  return fallback ? fallback.slice(0, 80) : '';
}

// Calibration: 40-45 Vietnamese words (no punctuation) ≈ 10 s at voiceSpeed 0.9
// → base rate at 1.0× = 42.5 / (10 × 0.9) ≈ 4.72 words/sec
const WORDS_PER_SEC_AT_1X = 42.5 / (10 * 0.9);

function getAutoSceneRange(videoDurationSec) {
  const duration = Number(videoDurationSec) || 60;
  if (duration <= 30) return { min: 3, max: 6 };
  if (duration <= 60) return { min: 5, max: 9 };
  if (duration <= 120) return { min: 8, max: 14 };
  return { min: 10, max: 18 };
}

function flowDurationOptionsForModel(model) {
  return String(model || '').trim() === 'abra' ? [4, 6, 8, 10] : [4, 6, 8];
}

function nearestFlowDuration(value, options) {
  const target = Number(value) || 8;
  return options.reduce((best, item) => (
    Math.abs(item - target) < Math.abs(best - target) ? item : best
  ), options[0] || 8);
}

function countWords(text = '') {
  return String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

function estimateFlowAudioDurationSec(scene, options) {
  const spokenWords = countWords(scene.voiceText);
  const promptWords = countWords(scene.videoPrompt || scene.imagePrompt);
  const wordCount = spokenWords || Math.round(promptWords * 0.35);
  if (wordCount <= 16) return nearestFlowDuration(4, options);
  if (wordCount <= 30) return nearestFlowDuration(6, options);
  if (wordCount <= 48) return nearestFlowDuration(8, options);
  return nearestFlowDuration(options.includes(10) ? 10 : 8, options);
}

function applyFlowAudioDurationHints(scenes, settings = {}) {
  if (
    !isFlowAudioSource(settings.imageSource)
    || !Array.isArray(scenes)
    || scenes.length === 0
  ) return scenes;
  const options = flowDurationOptionsForModel(settings.flowVideoModel);
  const existingDurations = scenes.map((scene) => Number(scene.flowDurationSec)).filter((item) => options.includes(item));
  const shouldAutoTune = existingDurations.length !== scenes.length || new Set(existingDurations).size <= 1;
  if (!shouldAutoTune) return scenes;
  return scenes.map((scene) => ({
    ...scene,
    flowDurationSec: estimateFlowAudioDurationSec(scene, options)
  }));
}

function getLanguagePromptConfig(videoLanguage = 'vi') {
  const config = getVideoLanguageConfig(videoLanguage);
  return {
    name: config.label,
    voiceLanguage: config.vietnameseName,
    titleLanguage: config.vietnameseName,
    imageTextLanguage: config.englishName,
    wordUnit: `từ ${config.vietnameseName}`,
    imageTextExample: config.imageTextExample,
    imageTextRule: `all readable text must be natural ${config.englishName} with correct spelling and writing conventions`,
    imageTextAvoid: 'no text in any other language',
    searchKeywordLanguage: config.vietnameseName,
    searchKeywordExample: config.searchKeywordExample,
    thumbnailRule: `thumbnailPrompt: English, safe video thumbnail layout, MUST include a large short ${config.englishName} headline; no watermark / logo / tiny text.`
  };
}

function getImageTextDensityPrompt(value = 'medium') {
  switch (value) {
    case 'none':
      return {
        label: 'Không có',
        promptLabel: 'no readable',
        count: 'no readable words, phrases, letters, signs, captions, labels, headlines, UI text, or decorative typography',
        instruction: 'Do not add any readable text in the image; communicate the idea only through characters, objects, setting, lighting, action, and composition.',
        ruleOverride: 'no readable text of any language',
        avoidOverride: 'no readable text in any language, no letters, no words, no signs'
      };
    case 'low':
      return {
        label: 'Ít chữ',
        promptLabel: 'minimal readable',
        count: '0 to 1 very short phrase, about 0 to 4 words total',
        instruction: 'Prefer visual storytelling; only add readable text when it is truly necessary.'
      };
    case 'high':
      return {
        label: 'Nhiều vừa phải',
        promptLabel: 'moderate readable',
        count: '2 to 3 short phrases, about 6 to 14 words total',
        instruction: 'Use more readable text when it improves clarity, but never create paragraphs or dense labels.'
      };
    default:
      return {
        label: 'Vừa',
        promptLabel: 'balanced readable',
        count: '1 to 2 short phrases, about 3 to 10 words total',
        instruction: 'Use readable text moderately when it helps the scene stand out.'
      };
  }
}

function summarizeHtmlPatternLibrary() {
  return JSON.stringify({
    globalRules: htmlPatternLibrary.globalRules,
    qualityGates: {
      script: htmlPatternLibrary.qualityGates?.script || [],
      visualPlan: htmlPatternLibrary.qualityGates?.visualPlan || []
    },
    runtimeDesign: {
      themeMoods: htmlPatternLibrary.runtimeDesign?.themeMoods?.map((mood) => ({
        id: mood.id,
        useWhen: mood.useWhen,
        notes: mood.notes
      })) || [],
      backgroundFx: htmlPatternLibrary.runtimeDesign?.backgroundFx || [],
      revealModes: htmlPatternLibrary.runtimeDesign?.revealModes || [],
      sfxCues: htmlPatternLibrary.runtimeDesign?.sfxCues || []
    },
    patterns: htmlPatternLibrary.patterns.map((pattern) => ({
      id: pattern.id,
      category: pattern.category,
      useWhen: pattern.useWhen,
      avoidWhen: pattern.avoidWhen,
      requiredSlots: pattern.requiredSlots,
      optionalSlots: pattern.optionalSlots
    })),
    selectionGuide: htmlPatternLibrary.selectionGuide
  }, null, 2);
}

function splitSentences(text = '') {
  return String(text || '').trim().split(/(?<=[.!?。！？])\s+/).map(part => part.trim()).filter(Boolean);
}

function validateHtmlScriptScenes(scenes = []) {
  const patternMap = new Map(htmlPatternLibrary.patterns.map(pattern => [pattern.id, pattern]));
  const cueIds = new Set((htmlPatternLibrary.runtimeDesign?.sfxCues || []).map(cue => cue.id));
  const errors = [];
  scenes.forEach((scene, index) => {
    const sceneNumber = scene.sceneNumber || index + 1;
    const spec = scene.htmlSpec;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      errors.push(`Scene ${sceneNumber}: missing htmlSpec object`);
      return;
    }
    const pattern = patternMap.get(String(spec.selectedPattern || '').trim());
    if (!pattern) {
      errors.push(`Scene ${sceneNumber}: htmlSpec.selectedPattern must be a valid pattern id`);
      return;
    }
    if (!String(spec.visualPlan || '').trim()) {
      errors.push(`Scene ${sceneNumber}: htmlSpec.visualPlan is required`);
    }
    if (!String(spec.visualTwist || '').trim()) {
      errors.push(`Scene ${sceneNumber}: htmlSpec.visualTwist is required`);
    }
    const slots = spec.contentSlots && typeof spec.contentSlots === 'object' ? spec.contentSlots : {};
    for (const slot of pattern.requiredSlots || []) {
      const value = slots[slot];
      const empty = value === undefined
        || value === null
        || (typeof value === 'string' && !value.trim())
        || (Array.isArray(value) && value.length === 0);
      if (empty) errors.push(`Scene ${sceneNumber}: contentSlots.${slot} is required for pattern ${pattern.id}`);
    }
    const revealBeats = Array.isArray(spec.timeline?.revealBeats) ? spec.timeline.revealBeats : [];
    if (!revealBeats.length) {
      errors.push(`Scene ${sceneNumber}: htmlSpec.timeline.revealBeats is required`);
    }
    revealBeats.forEach((beat, beatIndex) => {
      if (!String(beat?.phrase || '').trim()) {
        errors.push(`Scene ${sceneNumber}: revealBeats[${beatIndex}].phrase is required`);
      }
      if (!String(beat?.component || '').trim()) {
        errors.push(`Scene ${sceneNumber}: revealBeats[${beatIndex}].component is required`);
      }
      if (!String(beat?.visualChange || '').trim()) {
        errors.push(`Scene ${sceneNumber}: revealBeats[${beatIndex}].visualChange is required`);
      }
    });
    (Array.isArray(scene.sfxPlan) ? scene.sfxPlan : []).forEach((cue, cueIndex) => {
      const cueType = String(cue?.cueType || '').trim();
      if (cueType && cueIds.size && !cueIds.has(cueType)) {
        errors.push(`Scene ${sceneNumber}: sfxPlan[${cueIndex}].cueType must be one of runtimeDesign.sfxCues`);
      }
      if (cueType && !String(cue?.timingPhrase || '').trim()) {
        errors.push(`Scene ${sceneNumber}: sfxPlan[${cueIndex}].timingPhrase is required when cueType is set`);
      }
    });
    const sentenceCount = splitSentences(scene.voiceText).length || 1;
    if (revealBeats.length && Math.abs(revealBeats.length - sentenceCount) > 1) {
      errors.push(`Scene ${sceneNumber}: ${revealBeats.length} revealBeats does not match ${sentenceCount} voice sentence(s)`);
    }
  });
  if (errors.length) {
    throw new Error(`HTML script quality validation failed: ${errors.slice(0, 8).join('; ')}`);
  }
}

function validateStandaloneNarration(scenes = [], settings = {}) {
  const errors = [];
  // Calculate minimum words per scene from configured duration
  const voiceSpeed = settings.voiceSpeed ?? 1.0;
  const minWordsPerScene = (settings.sceneDurationMode === 'fixed' && settings.sceneDurationSec > 0)
    ? Math.round(settings.sceneDurationSec * WORDS_PER_SEC_AT_1X * voiceSpeed * 0.75) // 75% threshold to allow natural variation
    : 0;

  scenes.forEach((scene, index) => {
    const sceneNumber = scene?.sceneNumber || index + 1;
    const voiceText = String(scene?.voiceText || '');

    // Check for source references
    const matched = SOURCE_REFERENCE_PATTERNS.find((pattern) => pattern.test(voiceText));
    if (matched) {
      errors.push(`Scene ${sceneNumber}: voiceText refers to the input/source instead of speaking directly to the viewer`);
    }

    // Check minimum word count for fixed-pace mode
    if (minWordsPerScene > 0) {
      const wordCount = countWords(voiceText);
      if (wordCount < minWordsPerScene) {
        errors.push(`Scene ${sceneNumber}: voiceText has only ${wordCount} words but needs at least ${minWordsPerScene} words for ${settings.sceneDurationSec}s scene duration. Please write more detailed narration.`);
      }
    }
  });
  if (errors.length) {
    throw new Error(`Standalone narration validation failed: ${errors.slice(0, 8).join('; ')}`);
  }
}

function validateOmniVoiceNarration(scenes = [], maxWordsPerSentence = 18) {
  const errors = [];
  scenes.forEach((scene, index) => {
    const sceneNumber = scene?.sceneNumber || index + 1;
    const sentences = splitSentences(scene?.voiceText || '');
    sentences.forEach((sentence, sentenceIndex) => {
      const wordCount = countWords(sentence);
      if (wordCount > maxWordsPerSentence) {
        errors.push(`Scene ${sceneNumber}, sentence ${sentenceIndex + 1}: ${wordCount} words; OmniVoice needs <= ${maxWordsPerSentence}`);
      }
    });
  });
  if (errors.length) {
    throw new Error(`OmniVoice narration validation failed: ${errors.slice(0, 8).join('; ')}`);
  }
}

function buildScriptPrompt({ inputText, settings }) {
  const isAutoDuration = settings.sceneDurationMode === 'auto';
  const isFreeDuration = settings.sceneDurationMode === 'free';
  const sceneCount = isAutoDuration
    ? null
    : isFreeDuration
      ? null
    : Math.max(1, Math.round(settings.videoDurationSec / settings.sceneDurationSec));
  const voiceSpeed = settings.voiceSpeed ?? 1.0;
  const voiceWordCount = Math.max(20, Math.round((settings.sceneDurationSec || 10) * WORDS_PER_SEC_AT_1X * voiceSpeed));
  const totalVoiceWordCount = Math.max(40, Math.round((Number(settings.videoDurationSec) || 60) * WORDS_PER_SEC_AT_1X * voiceSpeed));
  const styleDetail = settings.imageStylePrompt || STYLE_PROMPT_DETAIL[settings.imageStyle] || settings.imageStyle;
  const bgModifier  = STYLE_BG_MODIFIERS[settings.imageStyle] || null;
  const ratioConfig = getAspectRatioConfig(settings.aspectRatio);
  const autoSceneRange = getAutoSceneRange(settings.videoDurationSec);
  const language = getLanguagePromptConfig(settings.videoLanguage);

  // Custom thumbnail rules for character-focused styles
  let resolvedThumbnailRule = language.thumbnailRule;
  const imageStyle = settings.imageStyle || '';
  if (imageStyle === 'custom:richard-wyckoff') {
    resolvedThumbnailRule = `thumbnailPrompt: English, professional high-contrast YouTube video thumbnail layout, MUST feature Richard Wyckoff (matching reference image) as the main character (large portrait or medium close-up, NOT tiny, positioned on the right side, left side, or center), with EITHER a dark moody 1930s Wall Street stock exchange floor background OR a vintage cream paper market chart background, and MUST include a large bold ${language.imageTextLanguage} headline in gold/yellow and white colors; no watermark / logo / tiny text.`;
  } else if (imageStyle === 'custom:huyen-thoai-au-tu-jesse-livermore') {
    resolvedThumbnailRule = `thumbnailPrompt: English, professional safe video thumbnail layout, MUST feature Jesse Livermore (matching reference image) as the main character focused in the center of the frame (large portrait or medium close-up, NOT tiny, NOT small), with a vintage trading chart or stock board background, and MUST include a large short ${language.imageTextLanguage} headline; no watermark / logo / tiny text.`;
  } else if (imageStyle === 'custom:5-phut-suy-ngam') {
    resolvedThumbnailRule = `thumbnailPrompt: English, professional safe video thumbnail layout, MUST feature the 'Người Lặng' character (round white head, black suit, matching reference image) focused large in the center, and MUST include a large short ${language.imageTextLanguage} headline; no watermark / logo / tiny text.`;
  } else if (imageStyle === 'custom:tram-oc-5-phut') {
    resolvedThumbnailRule = `thumbnailPrompt: English, professional safe video thumbnail layout, MUST feature the 'Bạn Đọc' character (round head, round glasses, matching reference image) focused large in the center, and MUST include a large short ${language.imageTextLanguage} headline; no watermark / logo / tiny text.`;
  } else if (imageStyle === 'custom:tram-dung-chan-5-phut') {
    resolvedThumbnailRule = `thumbnailPrompt: English, professional safe video thumbnail layout, MUST feature the 'Bạn Mây' character (round white head, peach scarf, matching reference image) focused large in the center, and MUST include a large short ${language.imageTextLanguage} headline; no watermark / logo / tiny text.`;
  }

  const subtitleAndVoiceRules = [
    '════ QUY TẮC VIẾT THOẠI & PHỤ ĐỀ CHUYÊN NGHIỆP (BẮT BUỘC) ════',
    '',
    '① NGẮT NHỊP TỰ NHIÊN: Sử dụng dấu phẩy (,) hoặc dấu ba chấm (...) ở các điểm ngắt nghỉ tự nhiên khi nói (khoảng 4-8 từ nên có một điểm ngắt nghỉ). Điều này giúp công cụ TTS đọc có nhịp điệu và phụ đề hiển thị không bị dồn cục.',
    '② DẤU BA CHẤM CHỜ (...) CHO SỰ KỊCH TÍNH: Sử dụng dấu ba chấm (...) để biểu thị sự tạm dừng nhấn mạnh, chuyển ý hoặc tạo sự tò mò (Ví dụ: "Nhưng thực tế là... họ đã sai.", "Volume tăng vọt... nhưng giá lại đi ngang.").',
    '③ CÂU NGẮN, SÚC TÍCH: Tuyệt đối không viết câu dài lê thê. Mỗi câu thoại chỉ nên chứa từ 8 đến 15 từ. Mỗi cảnh chỉ nên có từ 2 đến 4 câu thoại ngắn.',
    '④ TRÁNH TRỘN NGÔN NGỮ: Giữ ngôn ngữ đồng nhất, không chèn các ký tự đặc biệt hoặc viết tắt vô nghĩa, đảm bảo phụ đề hiển thị chuẩn xác nhất.',
  ];

  const imageTextDensity = getImageTextDensityPrompt(settings.imageTextDensity);
  const imageTextRule = imageTextDensity.ruleOverride || language.imageTextRule;
  const imageTextAvoid = imageTextDensity.avoidOverride || language.imageTextAvoid;
  const readableTextRuleLine = settings.imageTextDensity === 'none'
    ? `   - Không tạo bất kỳ chữ đọc được nào trong ảnh; ${imageTextAvoid}, không pseudo-text, không ký tự random.`
    : `   - Chữ trong ảnh BẮT BUỘC là ${language.imageTextLanguage}; ${imageTextAvoid}, không pseudo-text, không ký tự random.`;
  const imageSearchMode = isImageSearchSource(settings.imageSource);
  const videoSearchMode = isVideoSearchSource(settings.imageSource);
  const htmlMode = isHtmlSource(settings.imageSource);
  const providerName = 'Flow';
  const providerKey = 'FLOW';
  const flowMode = isFlowSource(settings.imageSource);
  const flowImageOnlyMode = isFlowImageOnlySource(settings.imageSource);
  const flowAudioMode = isFlowAudioSource(settings.imageSource);
  const flowFilmMode = isFlowFilmSource(settings.imageSource);
  const flowDurationOptions = flowDurationOptionsForModel(settings.flowVideoModel);
  const flowDurationList = flowDurationOptions.map((item) => `${item}s`).join(', ');
  const flowDurationRule = `⑦ BẮT BUỘC chọn flowDurationSec riêng cho từng cảnh trong các giá trị ${flowDurationList}. Cảnh hook/ít thoại chọn 4s; cảnh vừa chọn 6s; cảnh nhiều thoại/cảm xúc/hành động chọn 8s; cảnh rất dài chọn 10s nếu model hỗ trợ. Không dùng cùng một flowDurationSec cho toàn bộ video trừ khi mọi cảnh thật sự cùng nhịp.`;
  const omniVoiceNarrationRules = settings.ttsProvider === 'omnivoice'
    ? [
        '════ QUY TẮC VOICE OMNIVOICE (BẮT BUỘC) ════',
        '',
        `Vì đang chọn OmniVoice, mọi voiceText phải dùng câu ngắn tự nhiên: mỗi câu tối đa 18 ${language.wordUnit}.`,
        'Ưu tiên tách ý bằng dấu chấm. Nếu cần nghỉ nhẹ, dùng dấu phẩy ở ranh giới tự nhiên của cụm nghĩa.',
        'Không viết câu dài phải đọc liền, không để một cụm từ quan trọng bị tách đôi bởi dấu câu.',
      ]
    : [];
  const flowEntityRules = flowMode
    ? [
        `════ ${providerKey} VISUAL CONSISTENCY / ENTITY REFERENCES (BẮT BUỘC) ════`,
        '',
        '① Trả về top-level entities cho mọi nhân vật, bối cảnh và đạo cụ quan trọng cần giữ đồng nhất xuyên suốt video.',
        '② Mỗi entity gồm: name, entityType ("character", "location", "visual_asset", "creature"), description, imagePrompt, voiceDescription nếu là nhân vật có thoại.',
        '③ description/imagePrompt của entity CHỈ mô tả ngoại hình cố định: mặt, dáng, trang phục gốc, bối cảnh/đạo cụ trông như thế nào. Không mô tả hành động từng cảnh.',
        '④ Mỗi scene phải có entityNames liệt kê đúng các entity xuất hiện trong cảnh đó. Tên phải khớp name trong entities.',
        '⑤ imagePrompt/videoPrompt của scene chỉ mô tả hành động, camera, cảm xúc, âm thanh, ánh sáng và bố cục cảnh; không lặp lại chi tiết ngoại hình đã nằm trong entity.',
        '⑥ Nếu cần đổi tuổi/trang phục lớn theo thời gian, tạo entity riêng, ví dụ "Người em trẻ", "Người em già", không ép một reference dùng cho mọi độ tuổi.',
        `⑦ STYLE LOCK: Mọi entity imagePrompt, scene imagePrompt, videoPrompt và transitionPrompt phải giữ đúng phong cách này: "${styleDetail}". Không trộn photorealistic footage với anime/cartoon/painting/stylized khi style đã chọn không phải realistic.`,
        flowFilmMode
          ? `⑧ Với ${providerName.toLowerCase()}-film, thêm chainType cho mỗi cảnh: "ROOT" khi đổi bối cảnh/nhân vật chính/nhảy thời gian; "CONTINUATION" khi nối trực tiếp từ cảnh trước. Nếu CONTINUATION, thêm parentSceneNumber là cảnh cha gần nhất.`
          : `⑧ Với mode không phải ${providerName.toLowerCase()}-film, có thể thêm chainType nếu hữu ích, nhưng entityNames mới là cơ chế chính để giữ đồng nhất.`,
      ]
    : [];
  const searchKeywordLanguage = settings.imageSource === 'serper' ? language.searchKeywordLanguage : 'tiếng Anh';
  const searchKeywordExample = settings.imageSource === 'serper' ? language.searchKeywordExample : 'morning prayer sunrise';
  const mediaRules = flowImageOnlyMode
    ? [
        `════ QUY TẮC ${providerKey} IMAGES (BẮT BUỘC) ════`,
        '',
        `① Mỗi cảnh phải có imagePrompt bằng tiếng Anh để ${providerName} tạo ảnh.`,
        '② Không trả về videoPrompt; tool sẽ dựng video từ ảnh bằng hiệu ứng chuyển động hiện tại.',
        `③ useReferenceImage có thể là true/false hoặc URL ảnh riêng của cảnh; URL sẽ được tool tải về rồi gửi vào ${providerName}.`,
        '④ Không yêu cầu watermark, logo hoặc chữ ngẫu nhiên trong ảnh.',
        '⑤ Mỗi imagePrompt chỉ mô tả hành động/khoảnh khắc của cảnh và gọi entity bằng tên, không lặp mô tả ngoại hình.',
      ]
    : flowFilmMode
    ? [
        `════ QUY TẮC LÀM PHIM / ${providerKey} FILM (BẮT BUỘC) ════`,
        '',
        '① Mỗi cảnh phải có videoPrompt bằng tiếng Anh mô tả tiếp nối trực tiếp từ cảnh trước: hành động, camera, chuyển động và âm thanh/lời thoại trong clip.',
        '② Cảnh 1 tự thiết lập bối cảnh; từ cảnh 2 trở đi tool sẽ tự lấy frame cuối cảnh trước làm ảnh đầu vào, nên videoPrompt phải tiếp tục cùng không gian/nhân vật, tránh nhảy cảnh đột ngột.',
        '③ Có thể viết imagePrompt bằng tiếng Anh để mô tả mục tiêu hình ảnh của cảnh, nhưng không được phá continuity với frame đầu vào.',
        `④ Nếu có nhân vật nói, lời thoại và giọng nói phải bằng ${language.voiceLanguage}; yêu cầu audio tự nhiên rõ ràng trong videoPrompt.`,
        '⑤ Không yêu cầu narration/voiceover bên ngoài, subtitle, caption, logo hoặc chữ trên màn hình.',
        `⑥ Tool sẽ giữ nguyên audio do ${providerName} tạo, không tạo TTS/phụ đề, và dựng tuần tự từng cảnh.`,
        '⑦ Chỉ dùng CONTINUATION khi cảnh thật sự nối trực tiếp; nếu đổi địa điểm, nhảy thời gian hoặc đổi tuyến nhân vật thì dùng ROOT để tránh morph sai nhân vật/bối cảnh.',
        flowDurationRule,
      ]
    : flowAudioMode
    ? [
        `════ QUY TẮC ${providerKey} VIDEO CÓ VOICE (BẮT BUỘC) ════`,
        '',
        '① Mỗi cảnh phải có imagePrompt bằng tiếng Anh để mô tả hình ảnh/frame mở đầu.',
        '② Mỗi cảnh phải có videoPrompt bằng tiếng Anh mô tả hành động, camera, lời thoại hoặc âm thanh cần nghe trực tiếp trong video.',
        `③ VideoPrompt phải yêu cầu audio tự nhiên rõ ràng. Nếu có nhân vật nói, lời thoại và giọng nói phải bằng ${language.voiceLanguage}.`,
        '④ Không yêu cầu narration/voiceover bên ngoài, subtitle, caption, logo hoặc chữ trên màn hình.',
        `⑤ useReferenceImage có thể là true/false hoặc URL ảnh riêng của cảnh; URL sẽ được tool tải về rồi gửi vào ${providerName}.`,
        `⑥ Tool sẽ giữ nguyên audio do ${providerName} tạo và không tạo TTS/phụ đề.`,
        '⑦ videoPrompt nên viết như briefing đạo diễn: 100-150 từ, camera riêng một câu, Audio/SFX/Negative rõ ràng, thoại ngắn vừa với flowDurationSec.',
        flowDurationRule,
      ]
    : flowMode
    ? [
        `════ QUY TẮC ${providerKey} IMAGE / VIDEO (BẮT BUỘC) ════`,
        '',
        `① Mỗi cảnh phải có imagePrompt bằng tiếng Anh để ${providerName} tạo frame mở đầu.`,
        '② Mỗi cảnh phải có videoPrompt bằng tiếng Anh, mô tả chuyển động chủ thể, chuyển động camera và diễn biến trong clip.',
        '③ videoPrompt không được chỉ lặp lại imagePrompt; phải tập trung vào hành động và chuyển động có thể nhìn thấy.',
        '④ Không yêu cầu narration, voiceover, subtitle, caption, logo hoặc chữ trên màn hình trong videoPrompt.',
        `⑤ useReferenceImage có thể là true/false hoặc URL ảnh riêng của cảnh; URL sẽ được tool tải về rồi gửi vào ${providerName}.`,
        `⑥ Tool sẽ tắt âm thanh ${providerName} và lồng voiceText sau khi tạo video.`,
        `⑦ Mỗi scene phải có entityNames để ${providerName} dùng ảnh tham chiếu entity khi tạo ảnh/frame mở đầu.`,
      ]
    : videoSearchMode
    ? [
        '════ QUY TẮC videoKeyword (BẮT BUỘC VÌ ĐANG DÙNG KHO VIDEO) ════',
        '',
        '① Không viết prompt tạo ảnh dài. Thay vào đó mỗi cảnh phải có videoKeyword bằng tiếng Anh để tìm video stock phù hợp.',
        `② videoKeyword phải khớp nội dung cảnh và tỉ lệ ${ratioConfig.value}; ưu tiên 4-10 từ mô tả chủ thể, bối cảnh, hành động, cảm xúc.`,
        '③ Ưu tiên keyword mô tả footage có chuyển động thật: hành động, nơi chốn, người/vật chính. Tránh yêu cầu chữ trong video, watermark, logo, UI screenshot.',
        '④ Không trả về imagePrompt/imageKeyword/useReferenceImage cho cảnh vì chế độ này tìm video và render từ video nguồn.',
        '⑤ thumbnailKeyword vẫn là từ khoá tiếng Anh ngắn để tìm ảnh thumbnail; không dùng thumbnailPrompt.',
      ]
    : imageSearchMode
    ? [
        '════ QUY TẮC imageKeyword (BẮT BUỘC VÌ ĐANG DÙNG KHO ẢNH) ════',
        '',
        `① Không viết prompt tạo ảnh dài. Thay vào đó mỗi cảnh phải có imageKeyword bằng ${searchKeywordLanguage} để tìm ảnh thật/stock phù hợp.`,
        `② imageKeyword phải khớp nội dung cảnh và tỉ lệ ${ratioConfig.value}; ưu tiên 4-10 từ mô tả chủ thể, bối cảnh, cảm xúc, hành động.`,
        `   Ví dụ imageKeyword: "${searchKeywordExample}".`,
        '③ Tránh yêu cầu chữ trong ảnh, poster, biểu đồ dày đặc, UI screenshot, watermark, logo. Nếu cần khái niệm trừu tượng, dùng từ khoá stock-photo rõ ràng.',
        '④ Không trả về imagePrompt/useReferenceImage cho cảnh vì chế độ này không gọi AI tạo ảnh.',
        `⑤ thumbnailKeyword phải là từ khoá ${searchKeywordLanguage} ngắn để tìm ảnh thumbnail; không dùng thumbnailPrompt.`,
      ]
    : htmlMode
    ? [
        '════ QUY TẮC htmlSpec (BẮT BUỘC VÌ ĐANG DÙNG AI HTML VIDEO) ════',
        '',
        '① Không viết prompt tạo ảnh. Mỗi cảnh phải có htmlSpec chi tiết để AI khác dựng thành HTML chuyển động.',
        `② htmlSpec phải dựng được trong khung ${ratioConfig.value}; bố cục fixed pixel, không dựa vào viewport font, không để nội dung quan trọng ở vùng phụ đề thấp.`,
        '③ Script phải chốt nhịp trước visual: scene 1 là một câu hook vừa, rõ chủ đề ngay; các cảnh giải thích thường có 2-4 câu vừa, mỗi câu chỉ gánh một ý.',
        '④ Mỗi cảnh chỉ giữ một ý trung tâm. Nếu một cảnh cần giải thích nhiều hướng, tách thành cảnh khác thay vì nhồi visual/card.',
        '⑤ Vì pipeline sẽ burn phụ đề sau, htmlSpec phải visual-first: không yêu cầu chép lại toàn bộ voiceText lên màn hình; chỉ dùng keyword, số liệu, icon, diagram, card ngắn, logo/mark hoặc media minh hoạ.',
        '⑥ htmlSpec.timeline nên có revealBeats khớp semantic với từng câu/cụm SRT trong voiceText. Không gộp 2-3 ý thoại vào một visual reveal nếu người xem cần thấy từng bước.',
        '⑦ Bắt buộc chọn pattern từ HTML_PATTERN_LIBRARY bên dưới. Ghi vào htmlSpec.selectedPattern và chỉ dùng id hợp lệ.',
        '⑧ htmlSpec.visualPlan phải ghi vì sao pattern đó khớp câu thoại, twist visual riêng, và component nào được dùng. Không lặp một stack card qua nhiều cảnh.',
        '⑨ htmlSpec.visualTwist phải là một biến thể cụ thể cho câu chuyện này, không chỉ ghi chung chung “modern/clean”.',
        '⑩ Chọn htmlSpec.designMood từ runtimeDesign.themeMoods và htmlSpec.backgroundFx từ runtimeDesign.backgroundFx để các cảnh có mood rõ, không lặp nền đơn điệu.',
        '⑪ Chọn htmlSpec.revealMode từ runtimeDesign.revealModes. Nếu dùng risk đỏ/vàng/xanh thì ưu tiên traffic-light; nếu có module/card được active dần thì dùng highlight.',
        `⑫ htmlSpec.contentSlots phải điền dữ liệu ngắn cho requiredSlots/optionalSlots của pattern đã chọn; text trên canvas phải là ${language.voiceLanguage} ngắn, không phải paragraph.`,
        '⑬ htmlSpec.timeline.revealBeats phải nói rõ mỗi reveal dùng component nào và phrase nào trong voiceText kích hoạt.',
        '⑭ Ưu tiên HTML/CSS/SVG/canvas và media local do người dùng upload. Không yêu cầu remote image/video/iframe trong htmlSpec.',
        '⑮ Nếu cần media, mô tả asset bằng tên tự nhiên trong htmlSpec.assets hoặc mediaHints; AI render HTML sẽ chọn từ catalog media upload theo tên file. Nếu nhắc thương hiệu/sản phẩm, ưu tiên logo/mark hoặc brand asset thay vì chỉ viết tên.',
        '⑯ Có thể thêm sfxPlan nếu sound effect giúp nhịp cảnh. Cue nên có cueType từ runtimeDesign.sfxCues, timingPhrase khớp một cụm ngắn trong voiceText, và volume thấp.',
        '⑰ thumbnailKeyword là từ khoá tiếng Anh ngắn để tìm ảnh thumbnail; không dùng thumbnailPrompt.',
      ]
    : [
        '════ QUY TẮC imagePrompt (BẮT BUỘC) ════',
        '',
        '① NGÔN NGỮ: imagePrompt phải viết bằng tiếng Anh.',
        '',
        `② TỈ LỆ & FRAMING ${ratioConfig.value} — Nhúng cụm sau vào đầu mỗi imagePrompt: "${ratioConfig.framingCue}, faces kept well below top edge, background fills lower area"`,
        '',
        '③ PHONG CÁCH — Nhúng NGUYÊN VĂN chuỗi sau vào CUỐI mỗi imagePrompt:',
        `   "${styleDetail}"`,
        '',
        '④ NHÂN VẬT & ĐỘ TUỔI (quan trọng khi có ảnh tham chiếu):',
        '   - Nếu cảnh có nhân vật cụ thể, BẮT BUỘC ghi rõ độ tuổi phù hợp với bối cảnh lịch sử của cảnh đó.',
        '     Ví dụ: "as a young child aged 6-8", "as a young priest in his early 30s", "as an elderly man in his late 70s".',
        '   - Mô tả độ tuổi phải xuất hiện TRƯỚC khi mô tả trang phục / hành động.',
        '   - KHÔNG bỏ trống tuổi — AI tạo ảnh sẽ dựa vào ảnh tham chiếu mà sinh nhân vật sai độ tuổi.',
        '',
        '⑤ useReferenceImage:',
        '   - true  → chỉ khi nhân vật xuất hiện ở độ tuổi TRƯỞNG THÀNH (phù hợp với ảnh tham chiếu).',
        '   - false → khi nhân vật còn nhỏ tuổi / già hơn ảnh tham chiếu, hoặc cảnh thuần phong cảnh / ký hiệu.',
        '',
        '⑥ SHOT TYPE: Ưu tiên medium shot hoặc wide-medium shot. Tránh extreme close-up, watermark, border, collage, split layout.',
        '',
        `⑦ VĂN BẢN TRONG ẢNH — MẬT ĐỘ: ${imageTextDensity.label}, ${language.imageTextLanguage}.`,
        '   - Mặc định ưu tiên minh hoạ bằng nhân vật, vật thể, bối cảnh, ánh sáng, hành động, biểu cảm và bố cục.',
        `   - ${imageTextDensity.instruction}`,
        `   - Mỗi imagePrompt nên có ${imageTextDensity.count}.`,
        readableTextRuleLine,
        `   - Khi thêm chữ, ghi cụm chữ cụ thể trong imagePrompt, ví dụ: ${language.imageTextExample}.`,
        `   - BẮT BUỘC thêm nguyên cụm sau vào MỌI imagePrompt: "balanced visual illustration with ${imageTextDensity.promptLabel} ${language.imageTextLanguage} text density, ${imageTextRule}, include ${imageTextDensity.count}, ${imageTextAvoid}, no pseudo-text, no paragraphs, no captions, no subtitles, no narration boxes, no speech bubbles, no UI text, no dense small labels, no repeated words, no random letters, no watermarks, no logos".`,
        '   - Không dùng trang báo/sách/poster/màn hình chứa quá nhiều chữ, không tạo chữ trang trí không liên quan.',
        ...(bgModifier ? [
          '',
          `⑧ NỀN ĐẶC BIỆT (bắt buộc cho phong cách này): Thêm NGUYÊN VĂN cụm sau vào mỗi imagePrompt: "${bgModifier}"`,
        ] : []),
      ];

  return [
    'Bạn là biên kịch video ngắn chuyên nghiệp. Trả về JSON hợp lệ, không có markdown hay giải thích.',
    `NGÔN NGỮ VIDEO: ${language.name}.`,
    `BẮT BUỘC title và mọi voiceText phải viết bằng ${language.voiceLanguage}. Không trộn ngôn ngữ khác, trừ tên riêng hoặc thuật ngữ bắt buộc.`,
    videoSearchMode || imageSearchMode || htmlMode
      ? 'Ảnh được lấy từ kết quả tìm kiếm: không yêu cầu ảnh có chữ cụ thể hoặc áp đặt style sinh ảnh.'
      : `Các chữ xuất hiện trong ảnh/thumbnail phải là ${language.imageTextLanguage}.`,
    ...(isFreeDuration ? [
      'Không có tổng thời lượng mục tiêu. Hãy tự quyết định độ dài video, số cảnh và nhịp kể dựa trên độ phức tạp của nội dung đầu vào.',
      'Nếu nội dung ngắn: làm video ngắn, gọn, không kéo dài. Nếu nội dung dài hoặc nhiều luận điểm: chia đủ cảnh để kể trọn ý, không lược bỏ ý quan trọng.',
      flowMode
        ? flowAudioMode
          ? `Mỗi cảnh có thể dài/ngắn khác nhau; với mode dùng audio ${providerName}, độ dài cảnh cuối cùng đi theo video/audio ${providerName} trả về. Bắt buộc chọn flowDurationSec từng cảnh trong ${flowDurationList} theo độ dài thoại/nhịp cảnh.`
          : `Mỗi cảnh có thể dài/ngắn khác nhau; với ${providerName} dùng voice ngoài, độ dài cảnh cuối cùng đi theo voiceText, không cần targetDurationSec trong JSON. Nếu là ${providerName} video, có thể thêm flowDurationSec để chọn clip ${providerName} ${flowDurationList}.`
        : 'Mỗi cảnh có thể dài/ngắn khác nhau; cảnh mở hook nên gọn, cảnh giải thích có thể dài hơn. Có thể thêm targetDurationSec cho từng cảnh nếu hữu ích.'
    ] : isAutoDuration ? [
      `Tổng thời lượng mục tiêu: khoảng ${settings.videoDurationSec} giây.`,
      `Tự quyết định số cảnh và nhịp dài/ngắn theo nội dung; nên nằm trong khoảng ${autoSceneRange.min}-${autoSceneRange.max} cảnh nếu hợp lý.`,
      `Tổng voiceText toàn video khoảng ${totalVoiceWordCount} ${language.wordUnit}, có thể lệch 15% nếu nhịp kể cần tự nhiên hơn.`,
      'Mỗi cảnh có độ dài khác nhau: cảnh mở hook có thể rất ngắn, cảnh cảm xúc/giải thích có thể dài hơn; tránh chia đều máy móc.',
      flowMode
        ? flowAudioMode
          ? `Với mode dùng audio ${providerName}, độ dài cảnh cuối cùng đi theo video/audio ${providerName} trả về; không cần targetDurationSec trong JSON. Bắt buộc chọn flowDurationSec từng cảnh trong ${flowDurationList} theo độ dài thoại/nhịp cảnh.`
          : `Với ${providerName} dùng voice ngoài, độ dài cảnh cuối cùng đi theo voiceText; không cần targetDurationSec trong JSON. Nếu là ${providerName} video, có thể thêm flowDurationSec ${flowDurationList}.`
        : 'Có thể thêm targetDurationSec cho từng cảnh để thể hiện nhịp dự kiến, nhưng độ dài thật sẽ đi theo voiceText.'
    ] : [
      `Số cảnh mục tiêu: ${sceneCount}.`,
      `Mỗi cảnh khoảng ${settings.sceneDurationSec} giây — voiceText phải dài ít nhất ${voiceWordCount} ${language.wordUnit} (tối thiểu tuyệt đối, BẮT BUỘC tuân thủ), kể chuyện tự nhiên, liền mạch, hấp dẫn.`,
      `Tổng voiceText toàn video ít nhất ${totalVoiceWordCount} ${language.wordUnit} — bắt buộc viết đủ nội dung cho ${settings.videoDurationSec} giây video. Nếu chủ đề ngắn, hãy mở rộng với ví dụ, giải thích sâu, ứng dụng thực tế và tóm kết. CẤM viết voiceText ngắn hơn ${Math.round(voiceWordCount * 0.85)} ${language.wordUnit}/cảnh.`
    ]),
    'Nếu đầu vào là chủ đề ngắn: tự mở rộng thành câu chuyện mạch lạc có mở bài – thân bài – kết.',
    'Nếu đầu vào là nội dung dài: chia đều thành các cảnh cân đối, không cắt giữa chừng ý.',
    'Nội dung đầu vào chỉ là nguyên liệu và ý tưởng để viết một video nguyên bản. Kịch bản phải đứng độc lập, như thể người kể tự trình bày chủ đề trực tiếp với người xem.',
    'Phân biệt rõ nguồn đầu vào với dẫn chứng trong nội dung: không nhắc đến việc đang tham khảo bài viết, video gốc, transcript, tài liệu đầu vào hoặc quá trình tạo kịch bản. Cấm các câu meta như "bài viết nhấn mạnh", "nội dung nguồn gợi ý", "nguồn đầu vào cho biết", "theo bài viết này" hoặc cách diễn đạt tương tự.',
    'BẮT BUỘC giữ lại các dẫn chứng có giá trị nếu chúng hữu ích cho câu chuyện: con số, ngày tháng, thống kê, kết quả nghiên cứu, tên báo cáo, tên tổ chức/chuyên gia và trích dẫn cụ thể có trong đầu vào. Có thể nói tự nhiên như "Theo nghiên cứu của Đại học X...", "Báo cáo Y năm 2025 cho thấy..." hoặc "WHO ước tính...". Không được xóa dẫn chứng chỉ vì chúng có nguồn được nêu tên.',
    'Không bịa thêm nghiên cứu, tổ chức, con số hoặc mức độ chắc chắn. Nếu đầu vào không nêu rõ nguồn của một số liệu, diễn đạt thận trọng như "ước tính hiện tại cho thấy" hoặc "theo số liệu được công bố", thay vì gọi chung chung là bài viết hay nội dung nguồn.',
    '',
    ...subtitleAndVoiceRules,
    '',
    ...omniVoiceNarrationRules,
    ...(omniVoiceNarrationRules.length ? [''] : []),
    ...flowEntityRules,
    ...(flowEntityRules.length ? [''] : []),
    ...mediaRules,
    ...(htmlMode ? [
      '',
      '════ HTML_PATTERN_LIBRARY ════',
      summarizeHtmlPatternLibrary()
    ] : []),
    '',
    '════ JSON TRẢ VỀ ════',
    flowImageOnlyMode
      ? '{"title":"","thumbnailPrompt":"","entities":[{"name":"","entityType":"character","description":"","imagePrompt":"","voiceDescription":""},{"name":"","entityType":"location","description":"","imagePrompt":""}],"scenes":[{"sceneNumber":1,"voiceText":"","entityNames":[""],"imagePrompt":"","useReferenceImage":false}]}'
      : flowMode
      ? '{"title":"","thumbnailPrompt":"","entities":[{"name":"","entityType":"character","description":"","imagePrompt":"","voiceDescription":""},{"name":"","entityType":"location","description":"","imagePrompt":""}],"scenes":[{"sceneNumber":1,"chainType":"ROOT","voiceText":"","entityNames":[""],"imagePrompt":"","videoPrompt":"","flowDurationSec":4,"useReferenceImage":false},{"sceneNumber":2,"chainType":"CONTINUATION","parentSceneNumber":1,"voiceText":"","entityNames":[""],"imagePrompt":"","videoPrompt":"","flowDurationSec":8,"useReferenceImage":false}]}'
      : videoSearchMode
      ? '{"title":"","thumbnailKeyword":"","scenes":[{"sceneNumber":1,"targetDurationSec":8,"voiceText":"","videoKeyword":""}]}'
      : htmlMode
      ? '{"title":"","thumbnailKeyword":"","scenes":[{"sceneNumber":1,"targetDurationSec":10,"voiceText":"","visual":"","htmlSpec":{"concept":"","selectedPattern":"hero-orbit","designMood":"market-neon","backgroundFx":"particles","revealMode":"normal","visualPlan":"","visualTwist":"","contentSlots":{},"components":[],"layout":{"safeZone":"keep key content above subtitle area"},"timeline":{"revealBeats":[{"phrase":"","component":"","visualChange":""}]}},"sfxPlan":[{"timingPhrase":"","cueType":"pop","reason":"","volume":0.35}]}]}'
      : imageSearchMode
      ? '{"title":"","thumbnailKeyword":"","scenes":[{"sceneNumber":1,"targetDurationSec":8,"voiceText":"","imageKeyword":""}]}'
      : '{"title":"","thumbnailPrompt":"","scenes":[{"sceneNumber":1,"targetDurationSec":8,"voiceText":"","imagePrompt":"","useReferenceImage":false}]}',
    videoSearchMode
      ? `thumbnailKeyword: từ khoá tiếng Anh ngắn, phù hợp ảnh stock và bố cục ${ratioConfig.value}; videoKeyword dùng để tìm footage từng cảnh.`
      : imageSearchMode
      ? `thumbnailKeyword: từ khoá ${searchKeywordLanguage} ngắn, phù hợp ảnh stock và bố cục ${ratioConfig.value}; không yêu cầu chữ nằm sẵn trong ảnh.`
      : `${resolvedThumbnailRule} Bố cục ${ratioConfig.value}.`,
    '',
    '════ NỘI DUNG ĐẦU VÀO ════',
    inputText
  ].join('\n');
}

async function generateScriptFromText(chat01Client, payload) {
  const prompt = buildScriptPrompt(payload);
  const imageSearchMode = isImageSearchSource(payload.settings?.imageSource);
  const videoSearchMode = isVideoSearchSource(payload.settings?.imageSource);
  const htmlMode = isHtmlSource(payload.settings?.imageSource);
  let script = null;
  let scenes = [];
  let lastError = null;
  const attempts = htmlMode ? MAX_HTML_SCRIPT_ATTEMPTS : 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const retryPrompt = attempt === 1
      ? prompt
      : `${prompt}

VALIDATION ERROR FROM PREVIOUS SCRIPT ATTEMPT:
${String(lastError?.message || lastError || '').slice(0, 900)}

Retry ${attempt}/${attempts}. Return corrected JSON only.`;
    try {
      script = await chat01Client.generateJson(retryPrompt);
      scenes = normalizeScenesForImageSource(script.scenes || [], payload.settings?.imageSource);
      scenes = applyFlowAudioDurationHints(scenes, payload.settings);
      validateStandaloneNarration(scenes, payload.settings || {});
      if (payload.settings?.ttsProvider === 'omnivoice') validateOmniVoiceNarration(scenes);
      if (htmlMode) validateHtmlScriptScenes(scenes);
      break;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
    }
  }
  return {
    title: deriveTitle(script.title, scenes),
    thumbnailPrompt: imageSearchMode || videoSearchMode || htmlMode ? '' : script.thumbnailPrompt || '',
    thumbnailKeyword: imageSearchMode || videoSearchMode || htmlMode ? script.thumbnailKeyword || '' : '',
    entities: normalizeScriptEntities(script.entities || script.characters || script.referenceEntities || []),
    scenes
  };
}

function parseScriptInput(rawInput, options = {}) {
  const text = String(rawInput || '').trim();
  if (!text) {
    throw new Error('Missing script input');
  }
  const imageSource = options.imageSource || options.settings?.imageSource || 'ai';
  const imageSearchMode = isImageSearchSource(imageSource);
  const videoSearchMode = isVideoSearchSource(imageSource);
  const directMediaMode = isDirectMediaMode(imageSource);
  const htmlMode = isHtmlSource(imageSource);

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (directMediaMode) {
      throw new Error('Chế độ URL ảnh / Video yêu cầu JSON hợp lệ với mediaUrl cho từng scene');
    }
    return { inputMode: 'prompt', text };
  }

  if (parsed && Array.isArray(parsed.scenes)) {
    const scenes = normalizeScenesForImageSource(parsed.scenes, imageSource);
    if (htmlMode) validateHtmlScriptScenes(scenes);
    return {
      inputMode: 'json',
      script: {
        title: deriveTitle(parsed.title, scenes),
        thumbnailPrompt: imageSearchMode || videoSearchMode || htmlMode ? '' : parsed.thumbnailPrompt || '',
        thumbnailKeyword: imageSearchMode || videoSearchMode || htmlMode ? parsed.thumbnailKeyword || '' : '',
        entities: normalizeScriptEntities(parsed.entities || parsed.characters || parsed.referenceEntities || []),
        scenes
      }
    };
  }

  if (directMediaMode) {
    throw new Error('Chế độ URL ảnh / Video yêu cầu JSON có mảng scenes');
  }
  return { inputMode: 'prompt', text };
}

module.exports = {
  generateScriptFromText,
  parseScriptInput
};
