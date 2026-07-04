const path = require('path');
const fs = require('fs');
const { VIDEO_LANGUAGE_OPTIONS, OMNIVOICE_DEFAULT_VOICE_OPTIONS } = require('./languages');

const ROOT_DIR = path.resolve(__dirname, '../..');
const DATA_ROOT_DIR = process.env.VIBE_TOOL_DATA_DIR
  ? path.resolve(process.env.VIBE_TOOL_DATA_DIR)
  : ROOT_DIR;
const STORAGE_DIR = path.join(DATA_ROOT_DIR, 'storage');
const PROJECTS_DIR = path.join(DATA_ROOT_DIR, 'projects');
const TMP_DIR = path.join(DATA_ROOT_DIR, 'tmp');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const ASSETS_DIR = path.join(ROOT_DIR, 'assets');
const SETTINGS_FILE = path.join(STORAGE_DIR, 'settings.json');
const HISTORY_FILE = path.join(STORAGE_DIR, 'history.json');
const CUSTOM_STYLES_FILE = path.join(STORAGE_DIR, 'custom-styles.json');
const OMNIVOICE_VOICES_DIR = path.join(STORAGE_DIR, 'omnivoice-voices');

// Redirect OS temp environment variables to D drive tmp folder
try {
  fs.mkdirSync(TMP_DIR, { recursive: true });
} catch {}
process.env.TEMP = TMP_DIR;
process.env.TMP = TMP_DIR;

const STYLE_OPTIONS = [
  { value: 'finance-cartoon', label: 'Hoạt hình bảng trắng tài chính' },
  { value: 'chalk-dark', label: 'Phác thảo phấn tối màu kể chuyện đạo lý' },
  { value: 'ai-fashion-product', label: 'Trưng bày sản phẩm thời trang AI' },
  { value: 'stickman-morality', label: 'Câu chuyện đạo lý người que' },
  { value: '2d-explainer', label: 'Hoạt hình giải thích phong cách phẳng' },
  { value: 'renaissance', label: 'Sơn dầu kịch tính kiểu Caravaggio Phục Hưng' },
  { value: 'cinematic', label: 'Điện ảnh chân thực' },
  { value: 'dark-fantasy', label: 'Giả tưởng đen phong cách Gothic' },
  { value: 'watercolor', label: 'Minh họa màu nước mềm mại' },
  { value: 'flat-minimal', label: 'Vector phẳng tối giản' },
  { value: 'anime', label: 'Minh họa Anime/Manga' },
  { value: 'oil-classical', label: 'Tranh sơn dầu cổ điển' },
  { value: 'cyberpunk', label: 'Khoa học viễn tưởng neon Cyberpunk' },
  { value: 'comic-popart', label: 'Truyện tranh Pop Art' },
  { value: 'vintage-graphic-novel', label: 'Phóng sự tiểu thuyết đồ họa cổ điển' }
];

const MOTION_OPTIONS = [
  { value: 'none', label: 'Không hiệu ứng (ảnh tĩnh)' },
  { value: 'zoom-in', label: 'Phóng to' },
  { value: 'zoom-out', label: 'Thu nhỏ' },
  { value: 'pan-left', label: 'Trượt trái' },
  { value: 'pan-right', label: 'Trượt phải' },
  { value: 'pan-up', label: 'Trượt lên' },
  { value: 'pan-down', label: 'Trượt xuống' },
  { value: 'random', label: 'Random hiệu ứng từng cảnh' }
];

const TRANSITION_OPTIONS = [
  { value: 'none', label: 'Không có hiệu ứng' },
  { value: 'fade', label: 'Fade' },
  { value: 'fadeblack', label: 'Fade qua đen' },
  { value: 'dissolve', label: 'Dissolve mềm' },
  { value: 'slideleft', label: 'Trượt trái' },
  { value: 'slideright', label: 'Trượt phải' },
  { value: 'slideup', label: 'Trượt lên' },
  { value: 'slidedown', label: 'Trượt xuống' },
  { value: 'smoothleft', label: 'Smooth trái' },
  { value: 'smoothright', label: 'Smooth phải' },
  { value: 'smoothup', label: 'Smooth lên' },
  { value: 'smoothdown', label: 'Smooth xuống' },
  { value: 'circleopen', label: 'Mở vòng tròn' },
  { value: 'random', label: 'Random hiệu ứng' }
];

const IMAGE_TEXT_DENSITY_OPTIONS = [
  { value: 'none', label: 'Không có' },
  { value: 'low', label: 'Ít chữ' },
  { value: 'medium', label: 'Vừa' },
  { value: 'high', label: 'Nhiều vừa phải' }
];

const AI_PROVIDER_OPTIONS = [
  { value: 'chat01', label: 'Chat01 / AI' },
  { value: 'openai', label: 'OpenAI / AI' },
  { value: 'claude', label: 'Claude / AI' },
  { value: 'gemini', label: 'Gemini / AI' },
  { value: 'deepseek', label: 'DeepSeek / AI' },
  { value: 'nineRouter', label: '9Router / LLM Gateway' },
  { value: 'custom', label: 'Custom API' }
];

const IMAGE_SOURCE_OPTIONS = [
  { value: 'ai', label: 'Chế độ tạo ảnh bằng AI' },
  { value: 'flow-videos', label: 'Flow - Văn bản thành video' },
  { value: 'flow-images', label: 'Flow - Ảnh tĩnh cho từng cảnh' },
  { value: 'flow-image-video', label: 'Flow - Ảnh thành video' },
  { value: 'flow-video-az', label: 'Flow - Video có giọng nói' },
  { value: 'flow-image-video-az', label: 'Flow - Ảnh thành video có giọng nói' },
  { value: 'flow-film', label: 'Flow - Nối cảnh phim' },
  { value: 'serper', label: 'Serper - Tìm ảnh web' },
  { value: 'pexels', label: 'Pexels - Tìm ảnh stock' },
  { value: 'pexels-video', label: 'Pexels - Tìm video stock' },
  { value: 'direct-media', label: 'URL ảnh/video trực tiếp' }
];

const FLOW_IMAGE_MODEL_OPTIONS = [
  {
    value: 'nano_banana_pro',
    label: '🍌 Nano Banana Pro (Free)',
    group: 'Flow image',
    quality: 'Cao / mới',
    speed: 'Bình thường',
    credits: 'Free',
    freeUsage: 'Dùng được',
    paidUsage: 'Model ảnh mới khuyến nghị',
    tierRequirement: 'Mọi tài khoản',
    note: 'Flow family id: nano_banana_pro, usage key thật: GEM_PIX_2.'
  },
  {
    value: 'narwhal_display',
    label: '🍌 Nano Banana 2 (Free)',
    group: 'Flow image',
    quality: 'Thay thế',
    speed: 'Bình thường',
    credits: 'Free',
    freeUsage: 'Dùng được',
    paidUsage: 'Dùng khi muốn thử model thay thế',
    tierRequirement: 'Mọi tài khoản',
    note: 'Flow family id: narwhal_display, usage key thật: NARWHAL.'
  },
  {
    value: 'imagen_4',
    label: 'Imagen 4 (Free, leaving 6/16)',
    group: 'Flow image',
    quality: 'Cao',
    speed: 'Bình thường',
    credits: 'Free',
    freeUsage: 'Dùng được',
    paidUsage: 'Dùng khi muốn chất ảnh Imagen',
    tierRequirement: 'Mọi tài khoản',
    note: 'Flow family id: imagen_4, usage key thật: R2I hoặc IMAGEN_3_5.'
  }
];

const FLOW_VIDEO_MODEL_OPTIONS = [
  {
    value: 'abra',
    label: '[QUYỀN RIÊNG] Omni Flash',
    group: 'Quyền riêng / tuỳ tài khoản',
    quality: 'Cao',
    speed: 'Nhanh',
    credits: '~7 credits / video',
    durations: [4, 6, 8, 10],
    freeUsage: 'Chỉ dùng nếu Flow UI của tài khoản có hiện Omni Flash',
    paidUsage: 'Dùng khi tài khoản có quyền Omni Flash và cần 10s',
    tierRequirement: 'Quyền model riêng, không mặc định cho Free/Paid thường',
    note: 'Flow family id thật: abra. FlowKit sẽ tự chọn abra_t2v/i2v/r2v theo mode và duration.'
  },
  {
    value: 'veo_3_1_lite_low_priority',
    label: '[TRÁNH DÙNG] Veo 3.1 - Lite Low Priority',
    group: 'Không dùng cho Flow free hiện tại',
    quality: 'Thấp hơn',
    speed: 'Chậm',
    credits: '0 credit',
    durations: [4, 6, 8],
    freeUsage: 'Không dùng: tài khoản free hiện bị 403 với model này',
    paidUsage: 'Chỉ thử thủ công nếu Flow UI của tài khoản cho phép',
    tierRequirement: 'Không ổn định theo tier, dễ MODEL_ACCESS_DENIED',
    note: 'Flow family id thật: veo_3_1_lite_low_priority. App free sẽ tự ép về veo_3_1_lite.'
  },
  {
    value: 'veo_3_1_lite',
    label: '[FREE 50 credits/ngày] Veo 3.1 - Lite',
    group: 'Free / Entry - nên dùng',
    quality: 'Thấp hơn',
    speed: 'Nhanh',
    credits: '10 credits / video 1x',
    durations: [4, 6, 8],
    freeUsage: 'Khuyến nghị cho free 50 credits/ngày',
    paidUsage: 'Dùng khi cần nhanh, chi phí thấp',
    tierRequirement: 'Mọi tài khoản',
    note: 'Flow family id thật: veo_3_1_lite.'
  },
  {
    value: 'veo_3_1_fast',
    label: '[THƯỜNG/PAID] Veo 3.1 - Fast',
    group: 'Tài khoản thường / Paid',
    quality: 'Chuẩn',
    speed: 'Nhanh',
    credits: '20 credits / video 1x',
    durations: [4, 6, 8],
    freeUsage: 'Flow UI có thể hiện nhưng không khuyến nghị cho app free',
    paidUsage: 'Dùng cho tài khoản thường/paid khi cần nhanh',
    tierRequirement: 'Paid thường hoặc tài khoản được Flow UI cho phép',
    note: 'Flow family id thật: veo_3_1_fast.'
  },
  {
    value: 'veo_3_1_quality',
    label: '[ULTRA] Veo 3.1 - Quality',
    group: 'Ultra only / chất lượng cao',
    quality: 'Cao',
    speed: 'Nhanh',
    credits: '~100 credits / video 8s',
    durations: [4, 6, 8],
    freeUsage: 'Không dùng cho Free',
    paidUsage: 'Chỉ dùng khi tài khoản là Ultra và chấp nhận tốn credits',
    tierRequirement: 'Ultra / SERVICE_TIER_ULTRA',
    note: 'Flow family id thật: veo_3_1_quality.'
  }
];

const FLOW_VIDEO_DURATION_OPTIONS = [
  { value: 4, label: '4s' },
  { value: 6, label: '6s' },
  { value: 8, label: '8s' },
  { value: 10, label: '10s' }
];

const IMAGE_GENERATION_PROVIDER_OPTIONS = [
  { value: 'chat01', label: 'Chat01 - Tạo ảnh AI', defaultModel: 'gpt-5-5' },
  { value: 'openai', label: 'OpenAI - Model tạo ảnh', defaultModel: 'gpt-image-2' },
  { value: 'gemini', label: 'Gemini - Model tạo ảnh', defaultModel: 'gemini-2.5-flash-image' }
];

const HTML_GENERATION_PROVIDER_OPTIONS = [
  { value: 'chat01', label: 'Chat01 - Render chuyển động HTML' },
  { value: 'openai', label: 'OpenAI - Render chuyển động HTML' },
  { value: 'gemini', label: 'Gemini - Render chuyển động HTML' },
  { value: 'claude', label: 'Claude - Render chuyển động HTML' },
  { value: 'deepseek', label: 'DeepSeek - Render chuyển động HTML' },
  { value: 'custom', label: 'Custom API - Render chuyển động HTML' }
];

const TTS_PROVIDER_OPTIONS = [
  { value: 'larvoice', label: 'LarVoice / TTS' },
  { value: 'omnivoice', label: 'OmniVoice Local / TTS' },
  { value: 'vivibe', label: 'Vivibe / TTS' },
  { value: 'elevenlabs', label: 'ElevenLabs / TTS' },
  { value: 'vbee', label: 'Vbee / TTS' }
];

const SUBTITLE_FONT_OPTIONS = [
  { value: 'Be Vietnam Pro', label: 'Be Vietnam Pro', file: 'BeVietnamPro-Regular.ttf' },
  { value: 'Patrick Hand', label: 'Patrick Hand', file: 'PatrickHand-Regular.ttf' },
  { value: 'Caveat', label: 'Caveat', file: 'Caveat-Regular.ttf' },
  { value: 'Playpen Sans', label: 'Playpen Sans', file: 'PlaypenSans-Regular.ttf' },
  { value: 'Shantell Sans', label: 'Shantell Sans', file: 'ShantellSans-Regular.ttf' },
  { value: 'Pacifico', label: 'Pacifico', file: 'Pacifico-Regular.ttf' },
  { value: 'Noto Sans', label: 'Noto Sans', file: 'NotoSans-Regular.ttf' },
  { value: 'Noto Sans Thai', label: 'Noto Sans Thai', file: 'NotoSansThai-Regular.ttf' },
  { value: 'Noto Sans Devanagari', label: 'Noto Sans Devanagari', file: 'NotoSansDevanagari-Regular.ttf' },
  { value: 'Noto Sans Arabic', label: 'Noto Sans Arabic', file: 'NotoSansArabic-Regular.ttf' },
  { value: 'Noto Sans CJK JP', label: 'Noto Sans CJK JP', file: 'NotoSansCJKjp-Regular.otf' },
  { value: 'Noto Sans CJK KR', label: 'Noto Sans CJK KR', file: 'NotoSansCJKkr-Regular.otf' },
  { value: 'Noto Serif', label: 'Noto Serif', file: 'NotoSerif-Regular.ttf' },
  { value: 'Arial', label: 'Arial', file: 'Arial.ttf' },
  { value: 'Tahoma', label: 'Tahoma', file: 'Tahoma.ttf' },
  { value: 'Verdana', label: 'Verdana', file: 'Verdana.ttf' },
  { value: 'Georgia', label: 'Georgia', file: 'Georgia.ttf' }
];

const SUBTITLE_EFFECT_OPTIONS = [
  { value: 'karaoke-fill', label: 'Chạy màu karaoke' },
  { value: 'active-fill', label: 'Tô màu chữ đang đọc' },
  { value: 'active-zoom-fill', label: 'Phóng to + tô màu chữ đang đọc' },
  { value: 'tiktok-pill', label: 'TikTok nền hồng chữ đang đọc' },
  { value: 'tiktok-pop-pill', label: 'TikTok pop nền hồng' },
  { value: 'neon-active', label: 'Neon chữ đang đọc' },
  { value: 'bounce-outline', label: 'Nảy chữ viền màu' },
  { value: 'active-outline', label: 'Viền nổi bật chữ đang đọc' },
  { value: 'sweep-glow', label: 'Quét sáng mềm' },
  { value: 'active-pop-fill', label: 'Pop chữ đang đọc' },
  { value: 'glow-pulse', label: 'Nhịp sáng chữ đang đọc' },
  { value: 'highlight-box', label: 'Nền nổi bật sau chữ' },
  { value: 'typewriter', label: 'Hiện chữ kiểu đánh máy' },
  { value: 'plain-text', label: 'Chỉ hiển thị chữ' }
];

const SUBTITLE_TEXT_CASE_OPTIONS = [
  { value: 'original', label: 'Bình thường' },
  { value: 'lower', label: 'viết thường toàn bộ' },
  { value: 'upper', label: 'VIẾT HOA TOÀN BỘ' },
  { value: 'title', label: 'Viết Hoa Chữ Cái Đầu' }
];

const ASPECT_RATIO_OPTIONS = [
  {
    value: '16:9',
    label: '16:9 — YouTube ngang',
    width: 1920,
    height: 1080,
    framingCue: '16:9 landscape composition, cinematic wide framing, subject placed upper-center, generous headroom, safe margins on all four edges, no important details cropped at borders'
  },
  {
    value: '9:16',
    label: '9:16 — Shorts/TikTok/Reels',
    width: 1080,
    height: 1920,
    framingCue: '9:16 vertical composition for Shorts, TikTok, and Reels, tall portrait framing, subject centered in the middle vertical safe area, generous headroom, safe margins on all four edges, no important details cropped at borders'
  },
  {
    value: '1:1',
    label: '1:1 — Vuông',
    width: 1080,
    height: 1080,
    framingCue: '1:1 square composition for social feeds, balanced centered framing, subject placed near center, generous safe margins on all four edges, no important details cropped at borders'
  },
  {
    value: '4:3',
    label: '4:3 — Cổ điển',
    width: 1440,
    height: 1080,
    framingCue: '4:3 classic composition, balanced editorial framing, subject placed upper-center, generous safe margins on all four edges, no important details cropped at borders'
  },
  {
    value: '5:4',
    label: '5:4 — Dọc nhẹ / Social',
    width: 1350,
    height: 1080,
    framingCue: '5:4 near-square social composition, slightly wide editorial framing, subject centered with balanced margins, avoid tall empty vertical space and avoid edge-cropped panels'
  }
];

const ASPECT_RATIO_CONFIG = Object.fromEntries(
  ASPECT_RATIO_OPTIONS.map((option) => [option.value, option])
);

function normalizeAspectRatio(value) {
  return ASPECT_RATIO_CONFIG[value] ? value : '16:9';
}

function getAspectRatioConfig(value) {
  return ASPECT_RATIO_CONFIG[normalizeAspectRatio(value)];
}

const DEFAULT_PROJECT_SETTINGS = {
  videoLanguage: 'vi',
  aspectRatio: '16:9',
  imageStyle: 'cinematic',
  imageTextDensity: 'medium',
  imageGenerationProvider: 'chat01',
  imageModel: '',
  referenceImageUrl: '',
  flowImageModel: 'nano_banana_pro',
  flowVideoModel: 'veo_3_1_lite',
  flowVideoDurationSec: 8,
  motionPreset: 'zoom-in',
  transitionPreset: 'fade',
  generateThumbnailEnabled: false,
  generateSeoEnabled: false,
  subtitleEnabled: true,
  subtitleFontFamily: 'Be Vietnam Pro',
  subtitleEffect: 'karaoke-fill',
  subtitleTextCase: 'original',
  subtitleColor: '#ffffff',
  subtitleHighlightColor: '#ffd84d',
  subtitleMaxWordsPerLine: 5,
  subtitlePositionY: 86,
  subtitleFontScale: 1,
  subtitleOpacity: 1,
  logoSize: 120,
  logoPosition: 'top-right',
  logoOpacity: 1,
  musicVolume: 0.18,
  htmlSfxVolume: 0.45,
  videoDurationSec: 0,
  sceneDurationSec: 0,
  sceneDurationMode: 'free',
  voiceSpeed: 1,
  voicePaddingMs: 900,
  imageConcurrency: 6,
  xfadeDurationSec: 0.5,
  watermarkText: '',
  watermarkFontSize: 24,
  watermarkOpacity: 30,
  watermarkBehavior: 'interval',
  watermarkInterval: 5,
  watermarkSpeed: 'medium'
};

const DEFAULT_APP_SETTINGS = {
  apiProvider: 'chat01',
  aiModel: '',
  imageGenerationProvider: 'chat01',
  thumbnailImageProvider: 'chat01',
  imageModel: '',
  customApiStandard: 'openai',
  customApiBaseUrl: '',
  nineRouterBaseUrl: 'http://127.0.0.1:20128/v1',
  claudeMaxTokens: 16384,
  htmlConcurrency: 2,
  // LLM API keys
  chato1KeysText: '',
  openaiKeysText: '',
  claudeKeysText: '',
  geminiKeysText: '',
  deepseekKeysText: '',
  nineRouterKeysText: '',
  customApiKeysText: '',
  // Image generation API keys
  imageChat01KeysText: '',
  imageOpenaiKeysText: '',
  imageGeminiKeysText: '',
  imageSource: 'ai',
  flowApiBaseUrl: 'http://127.0.0.1:8100',
  flowImageModel: 'nano_banana_pro',
  flowVideoModel: 'veo_3_1_lite',
  flowVideoDurationSec: 8,
  flowRequestTimeoutMs: 600000,
  flowGenerationTimeoutMs: 900000,
  flowPollIntervalMs: 5000,
  flowAuthRetryIntervalMs: 5000,
  flowAuthMaxWaitMs: 60000,
  flowUnusualActivityMaxWaitMs: 0,
  serperKeysText: '',
  pexelsKeysText: '',
  pexelsExcludedVideoUrlsText: 'https://www.pexels.com/vi-vn/video/s-ng-mu-co-s-ng-mu-indonesia-phong-c-nh-nui-non-11856435/',
  ttsProvider: 'larvoice',
  ttsVoiceId: '',
  vivibeKeysText: '',
  elevenlabsKeysText: '',
  vbeeKeysText: '',
  vbeeAppId: '',
  omnivoiceApiBaseUrl: 'http://127.0.0.1:8101',
  omnivoiceVoiceId: '',
  omnivoiceVoices: [],
  omnivoiceInstruct: '',
  omnivoiceNumStep: 32,
  omnivoiceChunkDurationSec: 5,
  omnivoiceChunkThresholdSec: 0,
  elevenlabsModelId: 'eleven_multilingual_v2',
  elevenlabsLanguageCode: '',
  elevenlabsOutputFormat: 'mp3_44100_128',
  elevenlabsStability: 0.5,
  elevenlabsSimilarityBoost: 0.75,
  elevenlabsStyle: '',
  elevenlabsUseSpeakerBoost: true,
  vbeeCallbackUrl: 'https://example.com/vbee-callback',
  vbeeAudioType: 'mp3',
  vbeeBitrate: 128,
  vbeeSampleRate: '',
  vbeeEmphasisIntensity: '',
  // LarVoice
  larvoiceKeysText: '',
  larvoiceApiKey: '',
  larvoiceVoiceId: '1',
  videoLanguage: 'vi',
  aspectRatio: '16:9',
  imageStyle: 'cinematic',
  imageTextDensity: 'medium',
  motionPreset: 'zoom-in',
  transitionPreset: 'fade',
  generateThumbnailEnabled: false,
  generateSeoEnabled: false,
  renderConcurrency: 2,
  renderPreset: 'fast',
  projectConcurrency: 1,
  subtitleEnabled: true,
  subtitleFontFamily: 'Be Vietnam Pro',
  subtitleEffect: 'karaoke-fill',
  subtitleTextCase: 'original',
  subtitleColor: '#ffffff',
  subtitleHighlightColor: '#ffd84d',
  subtitleMaxWordsPerLine: 5,
  subtitlePositionY: 86,
  subtitleFontScale: 1,
  subtitleOpacity: 1,
  logoSize: 120,
  logoPosition: 'top-right',
  logoOpacity: 1,
  voiceSpeed: 1.0,
  logoPath: '',
  referenceImageUrl: '',
  htmlDefaultSfx: [],
  htmlBrandAssets: [],
  htmlSfxVolume: 0.45,
  htmlMaxGenerationAttempts: 0,
  musicVolume: 0.18,
  ffmpegPath: process.env.VIBE_TOOL_FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.VIBE_TOOL_FFPROBE_PATH || 'ffprobe'
};

// Chi tiết phong cách nhúng trực tiếp vào imagePrompt khi tạo ảnh
const STYLE_PROMPT_DETAIL = {
  'finance-cartoon': 'professional YouTube finance explainer cartoon illustration, pure white background (#FFFFFF), bold clean black outlines, semi-realistic character proportions, flat colors with subtle cel shading, expressive business characters in suits, symbolic educational composition using people and objects primarily, charts may use 1 to 2 short Vietnamese labels when useful, no English chart text, no dense chart text, no background scenery, no gradients on background, white space dominant, clean editorial cartoon quality similar to financial education YouTube channels',
  'chalk-dark':      'chalk sketch illustration on dark chalkboard background, deep dark green background (#1a3320), white chalk-like hand-drawn line art with 1 to 2 short Vietnamese chalk phrases when useful, no English writing, no dense writing or formulas, characters have simple rounded oval heads with large dot eyes and minimalist expressive faces, stick-figure-inspired proportions with clothing and detail lines, background elements rendered as thin white outline sketches, monochromatic white-on-dark aesthetic, no flat color fills, sketch marks visible, fable and parable storytelling illustration style, Asian moral tale animation quality',
  'ai-fashion-product': 'premium AI fashion product video first-frame aesthetic, photorealistic editorial fashion photography, clean studio or tasteful lifestyle set, clothing is the hero product with accurate fabric texture, stitching, silhouette, fit, drape, color, buttons, seams, labels, and accessories, professional model pose or mannequin/product flat lay when useful, luxury e-commerce campaign lighting, softbox highlights, crisp detail, shallow depth of field, elegant composition with safe margins, brand-friendly commercial styling, no distorted garments, no extra limbs, no messy background, no fake logos, no watermark, suitable for image-to-video fashion showcase and clothing product introduction',
  'stickman-morality': 'simple stickman moral story illustration, clean white or very light neutral background, black hand-drawn stick figures with round heads, expressive dot eyes and simple mouth, minimal props and symbolic scene elements, clear cause-and-effect storytelling composition, gentle educational tone for life lessons and moral videos, 2D doodle animation style, high readability, uncluttered frame, use 1 to 2 short Vietnamese handwritten phrases only when useful, no English writing, no dense text, no realistic faces, no complex shading, no busy scenery, no watermark',
  'cinematic':       'photorealistic cinematic photography, dramatic movie-grade lighting, 35mm lens look, shallow depth of field, film grain, color graded, high detail movie still quality',
  '2d-explainer':    '2D vector flat illustration, clean crisp lines, bright professional colors, modern explainer video art style, no gradients, simple readable shapes',
  'renaissance':     'Renaissance oil painting, Caravaggio chiaroscuro lighting, dramatic dark background with warm candlelight, classical Italian Old Masters style, rich earthy tones',
  'dark-fantasy':    'dark fantasy digital painting, gothic atmosphere, dramatic moody shadows, ominous lighting, highly detailed fantasy illustration, deep contrast',
  'watercolor':      'watercolor illustration, soft washes of color, visible paper texture, gentle painterly edges, pastel tones, book illustration quality',
  'flat-minimal':    'flat design minimalist illustration, geometric shapes, limited clean color palette, generous negative space, Scandinavian modern style, no textures or gradients',
  'anime':           'anime digital illustration, studio-quality art, vibrant colors, clean expressive line art, manga-influenced, detailed backgrounds, professional anime production',
  'oil-classical':   'classical oil painting, Old Masters style, rich impasto texture, warm golden light, museum-quality fine art realism',
  'cyberpunk':       'cyberpunk digital art, neon lights, rain-slicked streets, high contrast, glowing blues and magentas, futuristic dystopian city, Blade Runner aesthetic',
  'comic-popart':    'comic book pop art style, bold black outlines, Ben-Day dots, bright flat colors, dynamic diagonal composition, retro American comics, no speech bubbles, no caption boxes, no text overlays',
  'vintage-graphic-novel': 'vintage journalistic graphic novel illustration, aged sepia-toned paper texture, bold expressive black ink line art with crosshatching and stippling, reportage documentary style, dramatic chiaroscuro ink shadows, warm amber-sepia wash over black ink, 1940s–1960s editorial illustration aesthetic, no speech bubbles, no caption boxes, no panel borders, no text overlays, no watermarks, single full-frame illustration, museum-quality graphic reportage'
};

// Modifier đặc biệt cho các style có yêu cầu nền cụ thể — nhúng bổ sung vào prompt
const STYLE_BG_MODIFIERS = {
  'finance-cartoon': 'pure white background, isolated characters on white, no background scenery',
  'chalk-dark':      'dark green chalkboard background, white chalk line art only, 1 to 2 short Vietnamese chalk phrases if useful, no English writing, no dense writing, no repeated letters, no formulas, no color fills on characters',
  'stickman-morality': 'clean white or very light neutral background, simple black stickman line art, minimal props, no busy scenery'
};

const STYLE_FRAMING_CUE = getAspectRatioConfig('16:9').framingCue;

module.exports = {
  ROOT_DIR,
  DATA_ROOT_DIR,
  STORAGE_DIR,
  PROJECTS_DIR,
  TMP_DIR,
  PUBLIC_DIR,
  ASSETS_DIR,
  SETTINGS_FILE,
  HISTORY_FILE,
  CUSTOM_STYLES_FILE,
  OMNIVOICE_VOICES_DIR,
  STYLE_OPTIONS,
  ASPECT_RATIO_OPTIONS,
  ASPECT_RATIO_CONFIG,
  STYLE_PROMPT_DETAIL,
  STYLE_BG_MODIFIERS,
  STYLE_FRAMING_CUE,
  normalizeAspectRatio,
  getAspectRatioConfig,
  MOTION_OPTIONS,
  TRANSITION_OPTIONS,
  VIDEO_LANGUAGE_OPTIONS,
  IMAGE_TEXT_DENSITY_OPTIONS,
  AI_PROVIDER_OPTIONS,
  IMAGE_SOURCE_OPTIONS,
  FLOW_IMAGE_MODEL_OPTIONS,
  FLOW_VIDEO_MODEL_OPTIONS,
  FLOW_VIDEO_DURATION_OPTIONS,
  OMNIVOICE_DEFAULT_VOICE_OPTIONS,
  IMAGE_GENERATION_PROVIDER_OPTIONS,
  HTML_GENERATION_PROVIDER_OPTIONS,
  TTS_PROVIDER_OPTIONS,
  SUBTITLE_FONT_OPTIONS,
  SUBTITLE_EFFECT_OPTIONS,
  SUBTITLE_TEXT_CASE_OPTIONS,
  DEFAULT_PROJECT_SETTINGS,
  DEFAULT_APP_SETTINGS
};
