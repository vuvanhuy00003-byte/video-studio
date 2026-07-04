const VIDEO_LANGUAGE_CONFIGS = {
  vi: {
    value: 'vi',
    label: 'Tiếng Việt',
    englishName: 'Vietnamese',
    vietnameseName: 'tiếng Việt',
    voiceLanguage: 'vi',
    whisperLanguage: 'vi',
    subtitleFontFamily: 'Be Vietnam Pro',
    defaultVoiceId: '1',
    videoLabel: 'VIDEO',
    imageTextExample: 'sign reading "ĐỪNG BỎ CUỘC" or headline text "CƠ HỘI CUỐI"',
    searchKeywordExample: 'cầu nguyện buổi sáng bình minh',
    previewText: 'Xin chào, đây là đoạn nghe thử ngắn để kiểm tra giọng đọc và khoá API.',
    serperLocale: { gl: 'vn', hl: 'vi', location: 'Vietnam' },
    pexelsLocale: 'vi-VN'
  },
  en: {
    value: 'en',
    label: 'Tiếng Anh',
    englishName: 'English',
    vietnameseName: 'tiếng Anh',
    voiceLanguage: 'en',
    whisperLanguage: 'en',
    subtitleFontFamily: 'Be Vietnam Pro',
    defaultVoiceId: '184',
    videoLabel: 'VIDEO',
    imageTextExample: 'sign reading "NEVER GIVE UP" or headline text "LAST CHANCE"',
    searchKeywordExample: 'morning prayer sunrise',
    previewText: 'Hello, this is a short voice preview for checking this voice and API key.',
    serperLocale: { gl: 'us', hl: 'en', location: 'United States' },
    pexelsLocale: 'en-US'
  },
  th: {
    value: 'th',
    label: 'Tiếng Thái',
    englishName: 'Thai',
    vietnameseName: 'tiếng Thái',
    voiceLanguage: 'th',
    whisperLanguage: 'th',
    subtitleFontFamily: 'Noto Sans Thai',
    defaultVoiceId: '',
    videoLabel: 'วิดีโอ',
    imageTextExample: 'sign reading "อย่ายอมแพ้" or headline text "โอกาสสุดท้าย"',
    searchKeywordExample: 'สวดมนต์ตอนเช้า พระอาทิตย์ขึ้น',
    previewText: 'สวัสดี นี่คือตัวอย่างเสียงสั้น ๆ สำหรับตรวจสอบเสียงและคีย์ API',
    serperLocale: { gl: 'th', hl: 'th', location: 'Thailand' },
    pexelsLocale: 'th-TH'
  },
  ko: {
    value: 'ko',
    label: 'Tiếng Hàn',
    englishName: 'Korean',
    vietnameseName: 'tiếng Hàn',
    voiceLanguage: 'ko',
    whisperLanguage: 'ko',
    subtitleFontFamily: 'Noto Sans CJK KR',
    defaultVoiceId: '',
    videoLabel: '비디오',
    imageTextExample: 'sign reading "포기하지 마세요" or headline text "마지막 기회"',
    searchKeywordExample: '아침 기도 일출',
    previewText: '안녕하세요. 음성과 API 키를 확인하기 위한 짧은 음성 미리듣기입니다.',
    serperLocale: { gl: 'kr', hl: 'ko', location: 'South Korea' },
    pexelsLocale: 'ko-KR'
  },
  ja: {
    value: 'ja',
    label: 'Tiếng Nhật',
    englishName: 'Japanese',
    vietnameseName: 'tiếng Nhật',
    voiceLanguage: 'ja',
    whisperLanguage: 'ja',
    subtitleFontFamily: 'Noto Sans CJK JP',
    defaultVoiceId: '',
    videoLabel: '動画',
    imageTextExample: 'sign reading "あきらめないで" or headline text "最後のチャンス"',
    searchKeywordExample: '朝の祈り 日の出',
    previewText: 'こんにちは。音声とAPIキーを確認するための短い音声プレビューです。',
    serperLocale: { gl: 'jp', hl: 'ja', location: 'Japan' },
    pexelsLocale: 'ja-JP'
  },
  de: {
    value: 'de',
    label: 'Tiếng Đức',
    englishName: 'German',
    vietnameseName: 'tiếng Đức',
    voiceLanguage: 'de',
    whisperLanguage: 'de',
    subtitleFontFamily: 'Be Vietnam Pro',
    defaultVoiceId: '',
    videoLabel: 'VIDEO',
    imageTextExample: 'sign reading "GIB NICHT AUF" or headline text "LETZTE CHANCE"',
    searchKeywordExample: 'Morgengebet Sonnenaufgang',
    previewText: 'Hallo, dies ist eine kurze Stimmvorschau zum Prüfen der Stimme und des API-Schlüssels.',
    serperLocale: { gl: 'de', hl: 'de', location: 'Germany' },
    pexelsLocale: 'de-DE'
  },
  fr: {
    value: 'fr',
    label: 'Tiếng Pháp',
    englishName: 'French',
    vietnameseName: 'tiếng Pháp',
    voiceLanguage: 'fr',
    whisperLanguage: 'fr',
    subtitleFontFamily: 'Be Vietnam Pro',
    defaultVoiceId: '',
    videoLabel: 'VIDÉO',
    imageTextExample: 'sign reading "N’ABANDONNEZ PAS" or headline text "DERNIÈRE CHANCE"',
    searchKeywordExample: 'prière du matin lever du soleil',
    previewText: 'Bonjour, ceci est un court aperçu vocal pour vérifier la voix et la clé API.',
    serperLocale: { gl: 'fr', hl: 'fr', location: 'France' },
    pexelsLocale: 'fr-FR'
  },
  es: {
    value: 'es',
    label: 'Tiếng Tây Ban Nha',
    englishName: 'Spanish',
    vietnameseName: 'tiếng Tây Ban Nha',
    voiceLanguage: 'es',
    whisperLanguage: 'es',
    subtitleFontFamily: 'Be Vietnam Pro',
    defaultVoiceId: '',
    videoLabel: 'VIDEO',
    imageTextExample: 'sign reading "NO TE RINDAS" or headline text "ÚLTIMA OPORTUNIDAD"',
    searchKeywordExample: 'oración de la mañana amanecer',
    previewText: 'Hola, esta es una breve muestra de voz para comprobar la voz y la clave API.',
    serperLocale: { gl: 'mx', hl: 'es', location: 'Mexico' },
    pexelsLocale: 'es-ES'
  },
  'pt-br': {
    value: 'pt-BR',
    label: 'Tiếng Bồ Đào Nha (Brazil)',
    englishName: 'Brazilian Portuguese',
    vietnameseName: 'tiếng Bồ Đào Nha Brazil',
    voiceLanguage: 'pt',
    whisperLanguage: 'pt',
    subtitleFontFamily: 'Be Vietnam Pro',
    defaultVoiceId: '',
    videoLabel: 'VÍDEO',
    imageTextExample: 'sign reading "NÃO DESISTA" or headline text "ÚLTIMA CHANCE"',
    searchKeywordExample: 'oração da manhã nascer do sol',
    previewText: 'Olá, esta é uma breve prévia de voz para verificar a voz e a chave da API.',
    serperLocale: { gl: 'br', hl: 'pt-br', location: 'Brazil' },
    pexelsLocale: 'pt-BR'
  },
  id: {
    value: 'id',
    label: 'Tiếng Indonesia',
    englishName: 'Indonesian',
    vietnameseName: 'tiếng Indonesia',
    voiceLanguage: 'id',
    whisperLanguage: 'id',
    subtitleFontFamily: 'Be Vietnam Pro',
    defaultVoiceId: '',
    videoLabel: 'VIDEO',
    imageTextExample: 'sign reading "JANGAN MENYERAH" or headline text "KESEMPATAN TERAKHIR"',
    searchKeywordExample: 'doa pagi matahari terbit',
    previewText: 'Halo, ini adalah pratinjau suara singkat untuk memeriksa suara dan kunci API.',
    serperLocale: { gl: 'id', hl: 'id', location: 'Indonesia' },
    pexelsLocale: 'id-ID'
  },
  hi: {
    value: 'hi',
    label: 'Tiếng Hindi',
    englishName: 'Hindi',
    vietnameseName: 'tiếng Hindi',
    voiceLanguage: 'hi',
    whisperLanguage: 'hi',
    subtitleFontFamily: 'Noto Sans Devanagari',
    defaultVoiceId: '',
    videoLabel: 'वीडियो',
    imageTextExample: 'sign reading "हार मत मानो" or headline text "आखिरी मौका"',
    searchKeywordExample: 'सुबह की प्रार्थना सूर्योदय',
    previewText: 'नमस्ते, यह आवाज़ और API कुंजी की जाँच के लिए एक छोटा वॉइस प्रीव्यू है।',
    serperLocale: { gl: 'in', hl: 'hi', location: 'India' },
    pexelsLocale: 'en-IN'
  },
  ar: {
    value: 'ar',
    label: 'Tiếng Ả Rập',
    englishName: 'Arabic',
    vietnameseName: 'tiếng Ả Rập',
    voiceLanguage: 'ar',
    whisperLanguage: 'ar',
    subtitleFontFamily: 'Noto Sans Arabic',
    defaultVoiceId: '',
    videoLabel: 'فيديو',
    imageTextExample: 'sign reading "لا تستسلم" or headline text "الفرصة الأخيرة"',
    searchKeywordExample: 'صلاة الصباح شروق الشمس',
    previewText: 'مرحبًا، هذه معاينة صوتية قصيرة للتحقق من الصوت ومفتاح API.',
    serperLocale: { gl: 'sa', hl: 'ar', location: 'Saudi Arabia' },
    pexelsLocale: 'en-US'
  }
};

const VIDEO_LANGUAGE_OPTIONS = Object.values(VIDEO_LANGUAGE_CONFIGS).map((language) => ({
  value: language.value,
  label: language.label,
  voiceLanguage: language.voiceLanguage,
  defaultVoiceId: language.defaultVoiceId,
  subtitleFontFamily: language.subtitleFontFamily,
  previewText: language.previewText,
  direction: language.value === 'ar' ? 'rtl' : 'ltr'
}));

const OMNIVOICE_ACCENT_BY_LANGUAGE = {
  en: 'american accent',
  ko: 'korean accent',
  ja: 'japanese accent',
  'pt-br': 'portuguese accent',
  hi: 'indian accent'
};

const OMNIVOICE_DEFAULT_VOICE_PROFILES = {
  vi: {
    male: { name: 'Minh Quân', description: 'nam trầm, ấm', age: 'middle-aged', pitch: 'low pitch' },
    female: { name: 'Thu Hà', description: 'nữ trầm, dịu', age: 'middle-aged', pitch: 'low pitch' }
  },
  en: {
    male: { name: 'Ethan', description: 'nam ấm, rõ' },
    female: { name: 'Emma', description: 'nữ sáng, tự nhiên' }
  },
  th: {
    male: { name: 'Niran', description: 'nam ấm, điềm' },
    female: { name: 'Mali', description: 'nữ mềm, rõ' }
  },
  ko: {
    male: { name: 'Minjun', description: 'nam ấm, chắc' },
    female: { name: 'Seo-yun', description: 'nữ dịu, sáng' }
  },
  ja: {
    male: { name: 'Haruto', description: 'nam êm, rõ' },
    female: { name: 'Aoi', description: 'nữ trong, dịu' }
  },
  de: {
    male: { name: 'Lukas', description: 'nam rõ, chắc' },
    female: { name: 'Clara', description: 'nữ ấm, sáng' }
  },
  fr: {
    male: { name: 'Hugo', description: 'nam ấm, thanh lịch' },
    female: { name: 'Camille', description: 'nữ dịu, tự nhiên' }
  },
  es: {
    male: { name: 'Mateo', description: 'nam ấm, truyền cảm' },
    female: { name: 'Sofia', description: 'nữ sáng, mềm' }
  },
  'pt-br': {
    male: { name: 'Lucas', description: 'nam ấm, tự nhiên' },
    female: { name: 'Mariana', description: 'nữ dịu, rõ' }
  },
  id: {
    male: { name: 'Bima', description: 'nam ấm, rõ' },
    female: { name: 'Sari', description: 'nữ mềm, tự nhiên' }
  },
  hi: {
    male: { name: 'Aarav', description: 'nam ấm, rõ' },
    female: { name: 'Anaya', description: 'nữ dịu, sáng' }
  },
  ar: {
    male: { name: 'Omar', description: 'nam ấm, rõ' },
    female: { name: 'Layla', description: 'nữ ấm, mềm' }
  }
};

function omniVoiceDefaultInstruct(language, gender, profile = {}) {
  return [
    gender,
    profile.age || 'young adult',
    profile.pitch || 'moderate pitch',
    profile.accent || OMNIVOICE_ACCENT_BY_LANGUAGE[String(language.value || '').toLowerCase()]
  ].filter(Boolean).join(', ');
}

const OMNIVOICE_DEFAULT_VOICE_OPTIONS = Object.values(VIDEO_LANGUAGE_CONFIGS).flatMap((language) => {
  const languageId = String(language.value || '').toLowerCase();
  const profiles = OMNIVOICE_DEFAULT_VOICE_PROFILES[languageId] || {};
  return [
    {
      id: `default-${languageId}-male`,
      name: `${profiles.male?.name || 'Nam'} - ${profiles.male?.description || 'nam ấm, rõ'}`,
      language: language.value,
      gender: 'male',
      description: profiles.male?.description || 'nam ấm, rõ',
      instruct: omniVoiceDefaultInstruct(language, 'male', profiles.male)
    },
    {
      id: `default-${languageId}-female`,
      name: `${profiles.female?.name || 'Nữ'} - ${profiles.female?.description || 'nữ dịu, rõ'}`,
      language: language.value,
      gender: 'female',
      description: profiles.female?.description || 'nữ dịu, rõ',
      instruct: omniVoiceDefaultInstruct(language, 'female', profiles.female)
    }
  ];
});

function getVideoLanguageConfig(value = 'vi') {
  return VIDEO_LANGUAGE_CONFIGS[String(value || '').trim().toLowerCase()] || VIDEO_LANGUAGE_CONFIGS.vi;
}

function getOmniVoiceDefaultVoice(value = '') {
  const id = String(value || '').trim();
  return OMNIVOICE_DEFAULT_VOICE_OPTIONS.find((voice) => voice.id === id) || null;
}

function isOmniVoiceDefaultVoiceId(value = '') {
  return Boolean(getOmniVoiceDefaultVoice(value));
}

function getRecommendedSubtitleFont(value = 'vi') {
  return getVideoLanguageConfig(value).subtitleFontFamily;
}

function getSafeSubtitleFont(value = 'vi', requestedFont = '') {
  const language = getVideoLanguageConfig(value);
  if (['th', 'ko', 'ja', 'hi', 'ar'].includes(language.value)) {
    return language.subtitleFontFamily;
  }
  return String(requestedFont || language.subtitleFontFamily);
}

module.exports = {
  VIDEO_LANGUAGE_CONFIGS,
  VIDEO_LANGUAGE_OPTIONS,
  OMNIVOICE_DEFAULT_VOICE_OPTIONS,
  getOmniVoiceDefaultVoice,
  isOmniVoiceDefaultVoiceId,
  getVideoLanguageConfig,
  getRecommendedSubtitleFont,
  getSafeSubtitleFont
};
