const WORKSPACE_ID_STORAGE_KEY = 'vibeToolWorkspaceId';
const CURRENT_PROJECT_STORAGE_KEY = 'vibeToolCurrentProjectId';

// IndexedDB Helper để lưu giữ các file nhạc nền và ảnh tham chiếu
const PersistedFilesDB = {
  dbName: 'VibeToolPersistedFilesDB',
  storeName: 'cached_files',
  version: 1,

  open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = (e) => reject(e.target.error);
    });
  },

  async get(key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },

  async set(key, value) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  },

  async delete(key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
};

function removeVietnameseTones(str) {
  str = str.replace(/à|á|ạ|ả|ã|â|ầ|ấ|ậ|ẩ|ẫ|ă|ằ|ắ|ặ|ẳ|ẵ/g, "a");
  str = str.replace(/è|é|ẹ|ẻ|ẽ|ê|ề|ế|ệ|ể|ễ/g, "e");
  str = str.replace(/ì|í|ị|ỉ|ĩ/g, "i");
  str = str.replace(/ò|ó|ọ|ỏ|õ|ô|ồ|ố|ộ|ổ|ỗ|ơ|ờ|ớ|ợ|ở|ỡ/g, "o");
  str = str.replace(/ù|ú|ụ|ủ|ũ|ư|ừ|ứ|ự|ử|ữ/g, "u");
  str = str.replace(/ỳ|ý|ỵ|ỷ|ỹ/g, "y");
  str = str.replace(/đ/g, "d");
  str = str.replace(/À|Á|Ạ|Ả|Ã|Â|Ầ|Ấ|Ậ|Ẩ|Ẫ|Ă|Ằ|Ắ|Ặ|Ẳ|Ẵ/g, "A");
  str = str.replace(/È|É|Ẹ|Ẻ|Ẽ|Ê|Ề|Ế|Ệ|Ể|Ễ/g, "E");
  str = str.replace(/Ì|Í|Ị|R|Ĩ/g, "I");
  str = str.replace(/Ò|Ó|Ọ|Ỏ|Õ|Ô|Ồ|Ố|Ộ|Ổ|Ỗ|Ơ|Ờ|Ớ|Ợ|Ở|Ỡ/g, "O");
  str = str.replace(/Ù|Ú|Ụ|Ủ|Ũ|Ư|Ừ|Ứ|Ự|Ử|Ữ/g, "U");
  str = str.replace(/Ỳ|Ý|Y|Ỷ|Ỹ/g, "Y");
  str = str.replace(/Đ/g, "D");
  str = str.replace(/\u0300|\u0301|\u0303|\u0309|\u0323/g, "");
  str = str.replace(/\u02C6|\u0306|\u031B/g, "");
  return str;
}

function createWorkspaceId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getWorkspaceId() {
  let workspaceId = localStorage.getItem(WORKSPACE_ID_STORAGE_KEY);
  if (!workspaceId) {
    workspaceId = createWorkspaceId();
    localStorage.setItem(WORKSPACE_ID_STORAGE_KEY, workspaceId);
  }
  return workspaceId;
}

const state = {
  workspaceId: getWorkspaceId(),
  settings: null,
  history: [],
  styles: [],
  clearedAssets: {
    logo: false,
    backgroundMusic: false,
    introVideo: false,
    outroVideo: false
  },
  selectedReferenceImageFile: null,
  selectedBackgroundMusicFiles: [],
  activeJobs: [],
  motionOptions: [],
  transitionOptions: [],
  aspectRatioOptions: [],
  videoLanguageOptions: [],
  imageTextDensityOptions: [],
  aiProviderOptions: [],
  imageSourceOptions: [],
  flowImageModelOptions: [],
  flowVideoModelOptions: [],
  flowVideoDurationOptions: [],
  omnivoiceDefaultVoiceOptions: [],
  imageGenerationProviderOptions: [],
  htmlGenerationProviderOptions: [],
  ttsProviderOptions: [],
  subtitleFontOptions: [],
  subtitleEffectOptions: [],
  currentProjectId: null,
  currentProject: null,
  currentLogs: [],
  running: false,
  processingSceneNums: new Set(), // các scene đang chạy job, để hiện badge
  chato1KeysText: '',
  imageProviderKeys: {},
  providerKeys: {},
  voiceSamples: [],
  sceneVersions: {},          // sceneNumber → stable ?v= timestamp khi image lần đầu xuất hiện
  thumbnailVersion: null,     // stable ?v= timestamp cho thumbnail
  groups: [],
  collapsedGroups: {}
};

function updateProcessingScenesFromActiveJobs(activeJobs) {
  state.processingSceneNums.clear();
  if (Array.isArray(activeJobs)) {
    for (const jobId of activeJobs) {
      const parts = jobId.split(':');
      if (parts.length >= 3 && parts[1] === 'scene') {
        const sceneNum = Number(parts[2]);
        if (!isNaN(sceneNum)) {
          state.processingSceneNums.add(sceneNum);
        }
      }
    }
  }
}

const elements = {
  projectForm: document.getElementById('project-form'),
  historyList: document.getElementById('history-list'),
  deleteAll: document.getElementById('delete-all'),
  projectTitle: document.getElementById('project-title'),

  sceneList: document.getElementById('scene-list'),
  finalOutput: document.getElementById('final-output'),
  refreshProject: document.getElementById('refresh-project'),
  resumeProject: document.getElementById('resume-project'),
  pauseProject: document.getElementById('pause-project'),
  renderAllProject: document.getElementById('render-all-project'),
  statusBar: document.getElementById('status-bar'),
};

const DEFAULT_LLM_MODELS = {
  chat01: 'gpt-5-5-thinking',
  openai: 'gpt-5.5',
  claude: 'claude-opus-4-6',
  gemini: 'gemini-flash-latest',
  deepseek: 'deepseek-v4-pro',
  nineRouter: 'kr/claude-sonnet-4.5',
  custom: ''
};

const DEFAULT_IMAGE_MODELS = {
  chat01: 'gpt-5-5',
  openai: 'gpt-image-2',
  gemini: 'gemini-2.5-flash-image'
};

const API_PROVIDER_HELP = {
  chat01: {
    title: 'Chat01',
    text: 'Đăng nhập Chat01, vào mục API/Keys rồi tạo key mới.',
    links: [{ label: 'Mở Chat01', url: 'https://chat01.ai/' }]
  },
  openai: {
    title: 'OpenAI',
    text: 'Đăng nhập OpenAI Platform, mở trang API keys và tạo secret key mới.',
    links: [{ label: 'API keys', url: 'https://platform.openai.com/api-keys' }]
  },
  claude: {
    title: 'Claude / Anthropic',
    text: 'Đăng nhập Anthropic Console, vào Settings hoặc API Keys để tạo key.',
    links: [{ label: 'Anthropic Console', url: 'https://console.anthropic.com/settings/keys' }]
  },
  gemini: {
    title: 'Gemini',
    text: 'Dùng Google AI Studio để tạo và quản lý Gemini API key.',
    links: [{ label: 'Get API key', url: 'https://aistudio.google.com/apikey' }]
  },
  deepseek: {
    title: 'DeepSeek',
    text: 'Đăng nhập DeepSeek Platform, vào API keys để tạo key.',
    links: [{ label: 'API keys', url: 'https://platform.deepseek.com/api_keys' }]
  },
  nineRouter: {
    title: '9Router',
    text: 'Chạy 9Router local, cấu hình provider trong dashboard, rồi dán API key và model hoặc combo 9Router vào đây.',
    links: [
      { label: 'Dashboard local', url: 'http://127.0.0.1:20128/dashboard' },
      { label: 'GitHub', url: 'https://github.com/decolua/9router' }
    ]
  },
  custom: {
    title: 'Custom API',
    text: 'Chọn chuẩn tương thích, nhập URL Base, tên model và khoá API do nhà cung cấp cấp.'
  },
  serper: {
    title: 'Serper.dev',
    text: 'Đăng ký Serper.dev, vào dashboard để lấy API key dùng cho Images hoặc Scrape.',
    links: [{ label: 'Serper dashboard', url: 'https://serper.dev/api-keys' }]
  },
  pexels: {
    title: 'Pexels',
    text: 'Đăng nhập Pexels, vào trang API để request key miễn phí cho Photos và Videos.',
    links: [{ label: 'Pexels API', url: 'https://www.pexels.com/api/' }]
  },
  larvoice: {
    title: 'LarVoice',
    text: 'Đăng nhập LarVoice Pro, mở Quản lý API và tạo key TTS.',
    links: [{ label: 'LarVoice API', url: 'https://app.larvoice.com/api' }]
  },
  vivibe: {
    title: 'Vivibe',
    text: 'Đăng nhập Vivibe, vào khu vực API hoặc tích hợp để lấy key TTS.',
    links: [{ label: 'Mở Vivibe', url: 'https://vivibe.com/' }]
  },
  elevenlabs: {
    title: 'ElevenLabs',
    text: 'Đăng nhập ElevenLabs, mở API Keys trong dashboard để tạo key.',
    links: [{ label: 'API keys', url: 'https://elevenlabs.io/app/settings/api-keys' }]
  },
  vbee: {
    title: 'Vbee',
    text: 'Vào Vbee API để tạo ứng dụng, lấy App ID và token rồi dán vào đây.',
    links: [{ label: 'Vbee API', url: 'https://api.vbee.vn/' }]
  },
  omnivoice: {
    title: 'OmniVoice Local',
    text: 'Chạy model OmniVoice ngay trên máy qua service local. Không cần API key; cần setup runtime trước khi tạo voice.'
  }
};

function getDisplayTitle(title) {
  const normalized = String(title || '').trim();
  return normalized || 'Đang tạo tiêu đề...';
}

async function request(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('X-Workspace-Id', state.workspaceId);
  const response = await fetch(url, { ...options, headers });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

function fillSettings(settings) {
  state.settings = settings;
  state.chato1KeysText = settings.chato1KeysText || '';
  state.imageProviderKeys = {
    chat01: settings.imageChat01KeysText || '',
    openai: settings.imageOpenaiKeysText || '',
    gemini: settings.imageGeminiKeysText || ''
  };
  state.providerKeys = {
    chat01: settings.chato1KeysText || '',
    openai: settings.openaiKeysText || '',
    claude: settings.claudeKeysText || '',
    gemini: settings.geminiKeysText || '',
    deepseek: settings.deepseekKeysText || '',
    nineRouter: settings.nineRouterKeysText || '',
    custom: settings.customApiKeysText || '',
    larvoice: settings.larvoiceKeysText || settings.larvoiceApiKey || '',
    omnivoice: '',
    vivibe: settings.vivibeKeysText || '',
    elevenlabs: settings.elevenlabsKeysText || '',
    vbee: settings.vbeeKeysText || ''
  };

  // Restore chato1 key count display
  const chato1Display = document.getElementById('chato1-file-display');
  if (chato1Display) {
    const count = (state.providerKeys.chat01 || state.chato1KeysText).split('\n').filter(Boolean).length;
    chato1Display.textContent = count ? `${count} key đã lưu` : 'Chưa tải file';
  }
  const searchProvider = settings.imageSource === 'pexels-video'
    ? 'pexels'
    : ['serper', 'pexels'].includes(settings.imageSource) ? settings.imageSource : 'serper';
  document.getElementById('apiImageSearchProvider').value = searchProvider;
  document.getElementById('pexelsExcludedVideoUrlsText').value = settings.pexelsExcludedVideoUrlsText || '';
  document.getElementById('apiCrawlProvider').value = 'serper';
  document.getElementById('imageGenerationProvider').value = settings.imageGenerationProvider || 'chat01';
  document.getElementById('thumbnailImageProvider').value = settings.thumbnailImageProvider || 'chat01';
  document.getElementById('imageModel').value = settings.imageModel || '';
  const imageModelSelect = document.getElementById('imageModelSelect');
  if (imageModelSelect) {
    imageModelSelect.value = settings.imageModel || 'gpt-5-5';
  }
  document.getElementById('flowApiBaseUrl').value = settings.flowApiBaseUrl || 'http://127.0.0.1:8100';
  document.getElementById('flowImageModel').value = settings.flowImageModel || 'nano_banana_pro';
  document.getElementById('flowVideoModel').value = settings.flowVideoModel || 'veo_3_1_lite';
  document.getElementById('flowVideoDurationSec').value = String(settings.flowVideoDurationSec || 8);
  updateFlowImageModelHelp();
  updateFlowVideoModelHelp();
  document.getElementById('flowGenerationTimeoutSec').value = String(Math.round((settings.flowGenerationTimeoutMs || 900000) / 1000));
  document.getElementById('flowPollIntervalSec').value = String(Math.round((settings.flowPollIntervalMs || 5000) / 1000));
  const referenceDisplay = document.getElementById('reference-image-display');
  if (referenceDisplay) referenceDisplay.textContent = 'Chưa chọn file';
  updateImageModelPlaceholder();
  document.getElementById('apiProvider').value = settings.apiProvider || 'chat01';
  document.getElementById('aiModel').value = settings.aiModel || '';
  const aiModelSelect = document.getElementById('aiModelSelect');
  if (aiModelSelect) {
    aiModelSelect.value = settings.aiModel || 'gpt-5-5-thinking';
  }
  document.getElementById('customApiStandard').value = settings.customApiStandard || 'openai';
  document.getElementById('customApiBaseUrl').value = settings.customApiBaseUrl || '';
  document.getElementById('nineRouterBaseUrl').value = settings.nineRouterBaseUrl || 'http://127.0.0.1:20128/v1';
  document.getElementById('claudeMaxTokens').value = settings.claudeMaxTokens || 16384;
  document.getElementById('htmlConcurrency').value = String(settings.htmlConcurrency || 2);
  document.getElementById('renderConcurrency').value = String(settings.renderConcurrency || 2);
  document.getElementById('projectConcurrency').value = String(settings.projectConcurrency || 1);
  document.getElementById('renderPreset').value = settings.renderPreset || 'fast';
  updateAiModelPlaceholder();
  document.getElementById('ttsProvider').value = settings.ttsProvider || 'larvoice';
  document.getElementById('ttsProviderQuick').value = settings.ttsProvider || 'larvoice';
  document.getElementById('videoLanguage').value = settings.videoLanguage || 'vi';
  refreshKeyFieldDisplays();
  if (document.getElementById('ttsVoiceId')) {
    document.getElementById('ttsVoiceId').value = settings.ttsVoiceId || '';
  }
  document.getElementById('ttsVoiceIdQuick').value = settings.ttsVoiceId || '';
  document.getElementById('vbeeAppId').value = settings.vbeeAppId || '';
  document.getElementById('omnivoiceApiBaseUrl').value = settings.omnivoiceApiBaseUrl || 'http://127.0.0.1:8101';
  document.getElementById('omnivoiceInstruct').value = settings.omnivoiceInstruct || '';
  document.getElementById('omnivoiceNumStep').value = String(settings.omnivoiceNumStep || 32);
  renderOmniVoiceVoiceOptions(settings.omnivoiceVoices || [], settings.omnivoiceVoiceId || '');
  renderOmniVoiceVoicesList(settings.omnivoiceVoices || []);
  document.getElementById('elevenlabsModelId').value = settings.elevenlabsModelId || 'eleven_multilingual_v2';
  document.getElementById('elevenlabsLanguageCode').value = settings.elevenlabsLanguageCode || '';
  renderLarVoiceOptions(state.voiceSamples, settings.larvoiceVoiceId);
  document.getElementById('referenceImageUrl').value = settings.referenceImageUrl || '';
  document.getElementById('generateThumbnailEnabled').checked = Boolean(settings.generateThumbnailEnabled);
  document.getElementById('generateSeoEnabled').checked = Boolean(settings.generateSeoEnabled);
  document.getElementById('subtitleEnabled').checked = Boolean(settings.subtitleEnabled);
  document.getElementById('subtitleFontFamily').value = settings.subtitleFontFamily || 'Be Vietnam Pro';
  document.getElementById('subtitleEffect').value = settings.subtitleEffect || 'karaoke-fill';
  document.getElementById('subtitleTextCase').value = settings.subtitleTextCase || 'original';
  document.getElementById('subtitleColor').value = settings.subtitleColor || '#ffffff';
  document.getElementById('subtitleHighlightColor').value = settings.subtitleHighlightColor || '#ffd84d';
  document.getElementById('subtitleMaxWordsPerLine').value = String(settings.subtitleMaxWordsPerLine || 5);
  document.getElementById('subtitlePositionY').value = String(settings.subtitlePositionY ?? 86);
  updateSubtitleYLabel(settings.subtitlePositionY ?? 86);
  document.getElementById('subtitleFontScale').value = String(settings.subtitleFontScale || 1);
  updateSubtitleSizeLabel(settings.subtitleFontScale || 1);
  document.getElementById('subtitleOpacity').value = String(settings.subtitleOpacity ?? 1);
  updateSubtitleOpacityLabel(settings.subtitleOpacity ?? 1);
  document.getElementById('logoSize').value = String(settings.logoSize || 120);
  updateLogoSizeLabel(settings.logoSize || 120);
  document.getElementById('logoPosition').value = settings.logoPosition || 'top-right';
  document.getElementById('logoOpacity').value = String(settings.logoOpacity ?? 1);
  updateLogoOpacityLabel(settings.logoOpacity ?? 1);
  document.getElementById('watermarkText').value = settings.watermarkText || '';
  document.getElementById('watermarkFontSize').value = String(settings.watermarkFontSize || 24);
  updateWatermarkFontSizeLabel(settings.watermarkFontSize || 24);
  document.getElementById('watermarkOpacity').value = String(settings.watermarkOpacity ?? 30);
  updateWatermarkOpacityLabel(settings.watermarkOpacity ?? 30);
  document.getElementById('watermarkBehavior').value = settings.watermarkBehavior || 'interval';
  document.getElementById('watermarkInterval').value = String(settings.watermarkInterval || 5);
  updateWatermarkIntervalLabel(settings.watermarkInterval || 5);
  document.getElementById('watermarkSpeed').value = settings.watermarkSpeed || 'medium';
  updateWatermarkControlsVisibility();
  document.getElementById('aspectRatio').value = settings.aspectRatio || '16:9';
  document.getElementById('imageStyle').value = settings.imageStyle || 'cinematic';
  document.getElementById('imageTextDensity').value = settings.imageTextDensity || 'medium';
  document.getElementById('imageSource').value = imageSourceSelectValue(settings);
  if (document.getElementById('styleManagerSelect')) {
    document.getElementById('styleManagerSelect').value = settings.imageStyle || 'cinematic';
  }
  updateCustomStyleEditor();
  document.getElementById('motionPreset').value = safeMotionPreset(settings.motionPreset);
  document.getElementById('transitionPreset').value = settings.transitionPreset || 'fade';
  document.getElementById('voiceSpeed').value = voiceSpeedSelectValue(settings.voiceSpeed);
  const vol = settings.musicVolume ?? 0.18;
  document.getElementById('musicVolume').value = String(vol);
  updateMusicVolumeLabel(vol);
  const sfxVol = settings.htmlSfxVolume ?? 0.45;
  document.getElementById('htmlSfxVolume').value = String(sfxVol);
  updateHtmlSfxVolumeLabel(sfxVol);
  updateProviderFieldVisibility();
  updateSubtitlePreview();
  startWatermarkAnimationLoop();
  updateDefaultHtmlMediaDisplay(settings);
  updateConfigSummary();
}

function renderStyleOptions(styles) {
  const select = document.getElementById('imageStyle');
  const optionsHtml = styles
    .map((style) => {
      const label = style.custom ? `${style.label} (tuỳ chỉnh)` : style.label;
      return `<option value="${escapeHtml(style.value)}">${escapeHtml(label)}</option>`;
    })
    .join('');
  select.innerHTML = optionsHtml;
  const managerSelect = document.getElementById('styleManagerSelect');
  if (managerSelect) {
    managerSelect.innerHTML = `<option value="__new__">Tạo phong cách mới</option>${optionsHtml}`;
  }
  updateCustomStyleEditor();
}

function getSelectedImageStyle() {
  const managerValue = document.getElementById('styleManagerSelect')?.value || '';
  const value = managerValue || document.getElementById('imageStyle')?.value || '';
  if (value === '__new__') return null;
  return state.styles.find((style) => style.value === value) || null;
}

function updateCustomStyleEditor() {
  const selected = getSelectedImageStyle();
  const nameInput = document.getElementById('customStyleName');
  const promptInput = document.getElementById('customStylePrompt');
  const deleteButton = document.getElementById('btn-delete-style');
  if (!nameInput || !promptInput || !deleteButton) return;
  if (selected) {
    nameInput.value = selected.label || '';
    promptInput.value = selected.prompt || '';
    deleteButton.disabled = false;
  } else {
    nameInput.value = '';
    promptInput.value = '';
    deleteButton.disabled = true;
  }
}

function renderMotionOptions(options) {
  const select = document.getElementById('motionPreset');
  select.innerHTML = options
    .map((option) => `<option value="${option.value}">${option.label}</option>`)
    .join('');
}

function safeMotionPreset(value) {
  const normalized = String(value || '').trim();
  return (state.motionOptions || []).some((option) => option.value === normalized) ? normalized : 'zoom-in';
}

function renderTransitionOptions(options) {
  const select = document.getElementById('transitionPreset');
  if (!select) return;
  select.innerHTML = options
    .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
    .join('');
}

function renderAspectRatioOptions(options) {
  const select = document.getElementById('aspectRatio');
  select.innerHTML = options
    .map((option) => `<option value="${option.value}">${option.label}</option>`)
    .join('');
}

function renderImageTextDensityOptions(options) {
  const select = document.getElementById('imageTextDensity');
  if (!select) return;
  select.innerHTML = (options || [])
    .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
    .join('');
}

function renderSimpleOptions(selectId, options) {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.innerHTML = (options || [])
    .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
    .join('');
}

function renderFlowImageModelOptions(options) {
  const select = document.getElementById('flowImageModel');
  if (!select) return;
  const groups = new Map();
  (options || []).forEach((option) => {
    const group = option.group || 'Khác';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(option);
  });
  select.innerHTML = [...groups.entries()].map(([group, groupOptions]) => (
    `<optgroup label="${escapeHtml(group)}">`
    + groupOptions.map((option) => (
      `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`
    )).join('')
    + '</optgroup>'
  )).join('');
  select.addEventListener('change', updateFlowImageModelHelp);
  renderFlowImageModelCatalog(options);
}

function selectedFlowImageModelOption() {
  const value = document.getElementById('flowImageModel')?.value || '';
  return (state.flowImageModelOptions || []).find((option) => option.value === value) || null;
}

function updateFlowImageModelHelp() {
  const note = document.getElementById('flow-image-model-note');
  if (!note) return;
  const option = selectedFlowImageModelOption();
  if (!option) {
    note.textContent = 'Model ảnh chưa nằm trong danh sách. Hệ thống sẽ dùng mặc định Nano Banana Pro.';
    return;
  }
  note.textContent = [
    `${option.credits || 'Không rõ credit'}`,
    `Free: ${option.freeUsage || 'không rõ'}`,
    `Thường/paid: ${option.paidUsage || 'không rõ'}`,
    option.note || ''
  ].filter(Boolean).join(' · ');
}

function renderFlowImageModelCatalog(options) {
  const container = document.getElementById('flow-image-model-catalog');
  if (!container) return;
  container.innerHTML = (options || []).map((option) => `
    <div style="padding:8px 0;border-bottom:1px solid rgba(0,0,0,.08)">
      <strong>${escapeHtml(option.label)}</strong>
      <div>Key: <code>${escapeHtml(option.value)}</code></div>
      <div>Credit: ${escapeHtml(option.credits || 'Không rõ')} · Chất lượng: ${escapeHtml(option.quality || 'Không rõ')} · Tốc độ: ${escapeHtml(option.speed || 'Không rõ')}</div>
      <div>Free: ${escapeHtml(option.freeUsage || 'Không rõ')} · Tài khoản thường: ${escapeHtml(option.paidUsage || 'Không rõ')}</div>
      <div>${escapeHtml(option.note || '')}</div>
    </div>
  `).join('');
}

function renderFlowVideoModelOptions(options) {
  const select = document.getElementById('flowVideoModel');
  if (!select) return;
  const groups = new Map();
  (options || []).forEach((option) => {
    const group = option.group || 'Khác';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(option);
  });
  select.innerHTML = [...groups.entries()].map(([group, groupOptions]) => (
    `<optgroup label="${escapeHtml(group)}">`
    + groupOptions.map((option) => (
      `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)} — ${escapeHtml(option.credits || '')}</option>`
    )).join('')
    + '</optgroup>'
  )).join('');
  select.addEventListener('change', updateFlowVideoModelHelp);
  renderFlowVideoModelCatalog(options);
}

function selectedFlowVideoModelOption() {
  const value = document.getElementById('flowVideoModel')?.value || '';
  return (state.flowVideoModelOptions || []).find((option) => option.value === value) || null;
}

function updateFlowVideoModelHelp() {
  const note = document.getElementById('flow-video-model-note');
  if (!note) return;
  const option = selectedFlowVideoModelOption();
  if (!option) {
    note.textContent = 'Model chưa nằm trong danh sách. Hệ thống sẽ gửi key này trực tiếp cho Flowkit nếu tài khoản cho phép.';
    return;
  }
  note.textContent = [
    `${option.credits || 'Không rõ credit'}`,
    `Duration: ${(option.durations || [4, 6, 8]).map((item) => `${item}s`).join(', ')}`,
    `Free: ${option.freeUsage || 'không rõ'}`,
    `Paid thường: ${option.paidUsage || 'không rõ'}`,
    `Tier/Ultra: ${option.tierRequirement || 'không rõ'}`,
    option.note || ''
  ].filter(Boolean).join(' · ');
}

function renderFlowVideoModelCatalog(options) {
  const container = document.getElementById('flow-video-model-catalog');
  if (!container) return;
  container.innerHTML = (options || []).map((option) => `
    <div style="padding:8px 0;border-bottom:1px solid rgba(0,0,0,.08)">
      <strong>${escapeHtml(option.label)}</strong>
      <div>Key: <code>${escapeHtml(option.value)}</code></div>
      <div>Credit: ${escapeHtml(option.credits || 'Không rõ')} · Chất lượng: ${escapeHtml(option.quality || 'Không rõ')} · Tốc độ: ${escapeHtml(option.speed || 'Không rõ')}</div>
      <div>Duration hỗ trợ: ${escapeHtml((option.durations || [4, 6, 8]).map((item) => `${item}s`).join(', '))}</div>
      <div>Free: ${escapeHtml(option.freeUsage || 'Không rõ')} · Paid thường: ${escapeHtml(option.paidUsage || 'Không rõ')} · Tier/Ultra: ${escapeHtml(option.tierRequirement || 'Không rõ')}</div>
      <div>${escapeHtml(option.note || '')}</div>
    </div>
  `).join('');
}

function renderImageSourceOptions() {
  const select = document.getElementById('imageSource');
  if (!select) return;
  const aiOptions = (state.imageGenerationProviderOptions || []).map((option) => ({
    value: `ai:${option.value}`,
    label: option.label
  }));
  const htmlOptions = (state.htmlGenerationProviderOptions || []).map((option) => ({
    value: `html:${option.value}`,
    label: option.label
  }));
  const searchOptions = (state.imageSourceOptions || []).filter((option) => option.value !== 'ai');
  select.innerHTML = [...aiOptions, ...searchOptions, ...htmlOptions]
    .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
    .join('');
}

function imageSourceSelectValue(settings = state.settings || {}) {
  const source = settings.imageSource || 'ai';
  if (source.startsWith('video-api:')) return `ai:${settings.imageGenerationProvider || source.slice(10) || 'chat01'}`;
  if (source === 'ai') return `ai:${settings.imageGenerationProvider || 'chat01'}`;
  return source;
}

function selectedImageSourceValue() {
  return document.getElementById('imageSource')?.value || 'ai:chat01';
}

function selectedImageSourceIsAi() {
  return selectedImageSourceValue().startsWith('ai:');
}

function valueUsesFlowSource(imageSource) {
  return ['flow-videos', 'flow-images', 'flow-image-video', 'flow-video-az', 'flow-image-video-az', 'flow-film']
    .includes(String(imageSource || '').trim());
}

function valueUsesFlowImageOnlySource(imageSource) {
  return String(imageSource || '').trim() === 'flow-images';
}

function valueUsesFlowVideoSource(imageSource) {
  return ['flow-videos', 'flow-image-video', 'flow-video-az', 'flow-image-video-az', 'flow-film']
    .includes(String(imageSource || '').trim());
}

function valueUsesFlowAudioSource(imageSource) {
  return ['flow-video-az', 'flow-image-video-az', 'flow-film']
    .includes(String(imageSource || '').trim());
}

function selectedImageSourceIsApiVideo() {
  return selectedImageSourceValue().startsWith('video-api:');
}

function valueUsesHtmlSource(imageSource) {
  return String(imageSource || 'ai').trim().startsWith('html:');
}

function valueUsesImageSearchSource(imageSource) {
  const source = String(imageSource || 'ai').trim();
  return Boolean(source) && source !== 'ai' && source !== 'direct-media' && !source.startsWith('ai:') && !source.startsWith('video-api:') && !valueUsesVideoSearchSource(source) && !valueUsesHtmlSource(source) && !valueUsesFlowSource(source);
}

function valueUsesVideoSearchSource(imageSource) {
  return String(imageSource || 'ai').trim() === 'pexels-video';
}

function valueUsesDirectMediaSource(imageSource) {
  return String(imageSource || 'ai').trim() === 'direct-media';
}

function sceneUsesVideoSource(scene, imageSource) {
  return valueUsesVideoSearchSource(imageSource)
    || valueUsesFlowVideoSource(imageSource)
    || (valueUsesDirectMediaSource(imageSource) && scene?.mediaType === 'video');
}

function selectedImageGenerationProvider() {
  const value = selectedImageSourceValue();
  if (value.startsWith('ai:')) return value.slice(3) || 'chat01';
  return document.getElementById('imageGenerationProvider')?.value || 'chat01';
}

function syncImageGenerationProviderFromSource() {
  const provider = selectedImageGenerationProvider();
  const providerSelect = document.getElementById('imageGenerationProvider');
  if (providerSelect && providerSelect.value !== provider) {
    providerSelect.value = provider;
  }
  updateImageModelPlaceholder();
}

function syncImageSourceFromGenerationProvider() {
  const source = document.getElementById('imageSource');
  const provider = document.getElementById('imageGenerationProvider')?.value || 'chat01';
  if (source && selectedImageSourceIsAi()) {
    source.value = `ai:${provider}`;
  }
}

function updateKeyCountDisplay(id, text) {
  const display = document.getElementById(id);
  if (!display) return;
  const count = parseKeyList(text).length;
  display.textContent = count ? `${count} key đã lưu` : 'Chưa có key';
}

function parseKeyList(text) {
  return String(text || '')
    .split(/[\n,;]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function maskKeyLine(key) {
  const value = String(key || '').trim();
  if (!value) return '';
  return '*'.repeat(Math.min(24, Math.max(8, value.length)));
}

function maskKeysText(text) {
  return parseKeyList(text).map(maskKeyLine).join('\n');
}

function markKeyFieldMasked(id, text) {
  const input = document.getElementById(id);
  if (!input) return;
  input.value = maskKeysText(text);
  input.dataset.masked = 'true';
  input.dataset.dirty = 'false';
}

function keyFieldIsDirty(id) {
  const input = document.getElementById(id);
  return input?.dataset.dirty === 'true';
}

function getImageSearchKeysForCurrentProvider() {
  const provider = document.getElementById('apiImageSearchProvider')?.value || 'serper';
  return provider === 'pexels' ? (state.settings?.pexelsKeysText || '') : (state.settings?.serperKeysText || '');
}

function getCrawlKeys() {
  return state.settings?.serperKeysText || '';
}

function refreshKeyFieldDisplays() {
  const imageGenerationKeys = getImageGenerationKeysForCurrentProvider();
  markKeyFieldMasked('imageGenerationKeysText', imageGenerationKeys);
  updateKeyCountDisplay('image-generation-key-display', imageGenerationKeys);

  const imageSearchKeys = getImageSearchKeysForCurrentProvider();
  markKeyFieldMasked('imageSearchKeysText', imageSearchKeys);
  updateKeyCountDisplay('image-search-key-display', imageSearchKeys);

  const crawlKeys = getCrawlKeys();
  markKeyFieldMasked('crawlKeysText', crawlKeys);
  updateKeyCountDisplay('crawl-key-display', crawlKeys);

  const apiProvider = document.getElementById('apiProvider')?.value || 'chat01';
  const llmKeys = state.providerKeys[apiProvider] || '';
  markKeyFieldMasked('llmKeysText', llmKeys);
  updateKeyCountDisplay('llm-key-display', llmKeys);

  const ttsProvider = document.getElementById('ttsProvider')?.value || document.getElementById('ttsProviderQuick')?.value || 'larvoice';
  const ttsKeys = state.providerKeys[ttsProvider] || '';
  markKeyFieldMasked('ttsKeysText', ttsKeys);
  updateKeyCountDisplay('tts-key-display', ttsKeys);
}

function renderApiProviderHelp(targetId, provider) {
  const target = document.getElementById(targetId);
  if (!target) return;
  const help = API_PROVIDER_HELP[provider];
  if (!help) {
    target.innerHTML = '';
    target.classList.add('is-hidden');
    return;
  }
  const links = (help.links || [])
    .map((link) => `<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a>`)
    .join('');
  target.classList.remove('is-hidden');
  target.innerHTML = `
    <strong>${escapeHtml(help.title)}</strong>
    <span>${escapeHtml(help.text)}</span>
    ${links ? `<div class="api-provider-help-links">${links}</div>` : ''}
  `;
}

function updateApiProviderHelp() {
  renderApiProviderHelp(
    'image-generation-provider-help',
    document.getElementById('imageGenerationProvider')?.value || 'chat01'
  );
  renderApiProviderHelp(
    'thumbnail-provider-help',
    document.getElementById('thumbnailImageProvider')?.value || 'chat01'
  );
  renderApiProviderHelp(
    'image-search-provider-help',
    document.getElementById('apiImageSearchProvider')?.value || 'serper'
  );
  renderApiProviderHelp(
    'voice-provider-help',
    document.getElementById('ttsProvider')?.value || document.getElementById('ttsProviderQuick')?.value || 'larvoice'
  );
  renderApiProviderHelp(
    'llm-provider-help',
    document.getElementById('apiProvider')?.value || 'chat01'
  );
  renderApiProviderHelp(
    'crawl-provider-help',
    document.getElementById('apiCrawlProvider')?.value || 'serper'
  );
}

function getImageGenerationKeysForCurrentProvider() {
  const provider = document.getElementById('imageGenerationProvider')?.value || 'chat01';
  return state.imageProviderKeys[provider] || '';
}

function setupMaskedKeyFields() {
  ['imageGenerationKeysText', 'imageSearchKeysText', 'crawlKeysText', 'llmKeysText', 'ttsKeysText'].forEach((id) => {
    const input = document.getElementById(id);
    if (!input || input.dataset.maskSetup === 'true') return;
    input.dataset.maskSetup = 'true';
    input.addEventListener('focus', () => {
      if (input.dataset.masked === 'true') {
        input.value = '';
        input.dataset.masked = 'false';
        input.dataset.dirty = 'false';
      }
    });
    input.addEventListener('input', () => {
      input.dataset.masked = 'false';
      input.dataset.dirty = 'true';
    });
  });
}

function llmKeyField(provider) {
  return {
    chat01: 'chato1KeysText',
    openai: 'openaiKeysText',
    claude: 'claudeKeysText',
    gemini: 'geminiKeysText',
    deepseek: 'deepseekKeysText',
    nineRouter: 'nineRouterKeysText',
    custom: 'customApiKeysText'
  }[provider];
}

const LLM_MODEL_PRESETS = {
  chat01: [
    { value: 'gpt-5-5-thinking', label: 'gpt-5-5-thinking (Mặc định)' },
    { value: 'gpt-5-5', label: 'gpt-5-5' }
  ],
  openai: [
    { value: 'gpt-4o', label: 'gpt-4o (Mặc định)' },
    { value: 'gpt-4o-mini', label: 'gpt-4o-mini' },
    { value: 'o3-mini', label: 'o3-mini (Thinking)' },
    { value: 'o1-mini', label: 'o1-mini (Thinking)' },
    { value: 'o1', label: 'o1 (Thinking)' }
  ],
  claude: [
    { value: 'claude-3-7-sonnet', label: 'claude-3-7-sonnet (Mặc định)' },
    { value: 'claude-3-5-sonnet', label: 'claude-3-5-sonnet' },
    { value: 'claude-3-5-haiku', label: 'claude-3-5-haiku' }
  ],
  gemini: [
    { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash (Mặc định)' },
    { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
    { value: 'gemini-1.5-flash', label: 'gemini-1.5-flash' },
    { value: 'gemini-1.5-pro', label: 'gemini-1.5-pro' }
  ],
  deepseek: [
    { value: 'deepseek-chat', label: 'deepseek-chat (Mặc định)' },
    { value: 'deepseek-reasoner', label: 'deepseek-reasoner (Thinking)' }
  ]
};

const IMAGE_MODEL_PRESETS = {
  chat01: [
    { value: 'gpt-5-5', label: 'gpt-5-5 (Mặc định)' },
    { value: 'gpt-5-5-thinking', label: 'gpt-5-5-thinking' }
  ],
  openai: [
    { value: 'gpt-image-2', label: 'gpt-image-2 (Mặc định)' },
    { value: 'dall-e-3', label: 'dall-e-3' },
    { value: 'dall-e-2', label: 'dall-e-2' }
  ],
  gemini: [
    { value: 'imagen-3.0-generate-002', label: 'imagen-3.0-generate-002 (Mặc định)' }
  ]
};

function updateAiModelPlaceholder() {
  const input = document.getElementById('aiModel');
  const select = document.getElementById('aiModelSelect');
  if (!input) return;
  const provider = document.getElementById('apiProvider')?.value || 'chat01';
  const defaultModel = DEFAULT_LLM_MODELS[provider] || '';

  input.placeholder = provider === 'custom'
    ? 'Bắt buộc nhập tên model'
    : defaultModel ? `Mặc định: ${defaultModel}` : 'Để trống để dùng mặc định';
  input.dataset.defaultModel = defaultModel;

  const presets = LLM_MODEL_PRESETS[provider];
  if (presets && select) {
    select.innerHTML = presets.map(p => `<option value="${p.value}">${p.label}</option>`).join('') +
                       `<option value="other">[Nhập model khác...]</option>`;
    
    const currentValue = input.value.trim();
    const hasPreset = presets.some(p => p.value === currentValue);
    if (currentValue === '') {
      select.value = presets[0].value;
      input.value = presets[0].value;
      input.classList.add('is-hidden');
      select.classList.remove('is-hidden');
    } else if (hasPreset) {
      select.value = currentValue;
      input.classList.add('is-hidden');
      select.classList.remove('is-hidden');
    } else {
      select.value = 'other';
      input.classList.remove('is-hidden');
      select.classList.remove('is-hidden');
    }
  } else if (select) {
    select.classList.add('is-hidden');
    input.classList.remove('is-hidden');
  }
}

function updateImageModelPlaceholder() {
  const input = document.getElementById('imageModel');
  const select = document.getElementById('imageModelSelect');
  if (!input) return;
  const provider = document.getElementById('imageGenerationProvider')?.value || selectedImageGenerationProvider();
  const defaultModel = DEFAULT_IMAGE_MODELS[provider] || '';

  input.placeholder = defaultModel ? `Mặc định: ${defaultModel}` : 'Để trống để dùng mặc định';
  input.dataset.defaultModel = defaultModel;

  const presets = IMAGE_MODEL_PRESETS[provider];
  if (presets && select) {
    select.innerHTML = presets.map(p => `<option value="${p.value}">${p.label}</option>`).join('') +
                       `<option value="other">[Nhập model khác...]</option>`;
    
    const currentValue = input.value.trim();
    const hasPreset = presets.some(p => p.value === currentValue);
    if (currentValue === '') {
      select.value = presets[0].value;
      input.value = presets[0].value;
      input.classList.add('is-hidden');
      select.classList.remove('is-hidden');
    } else if (hasPreset) {
      select.value = currentValue;
      input.classList.add('is-hidden');
      select.classList.remove('is-hidden');
    } else {
      select.value = 'other';
      input.classList.remove('is-hidden');
      select.classList.remove('is-hidden');
    }
  } else if (select) {
    select.classList.add('is-hidden');
    input.classList.remove('is-hidden');
  }
}

function ttsKeyField(provider) {
  return {
    larvoice: 'larvoiceKeysText',
    vivibe: 'vivibeKeysText',
    elevenlabs: 'elevenlabsKeysText',
    vbee: 'vbeeKeysText'
  }[provider];
}

function updateProviderFieldVisibility() {
  const apiProvider = document.getElementById('apiProvider')?.value || 'chat01';
  const ttsProvider = document.getElementById('ttsProvider')?.value || 'larvoice';
  const isLarVoice = ttsProvider === 'larvoice';
  const isOmniVoice = ttsProvider === 'omnivoice';
  const isCustomApi = apiProvider === 'custom';
  const isNineRouter = apiProvider === 'nineRouter';
  const isClaudeApi = apiProvider === 'claude'
    || (isCustomApi && document.getElementById('customApiStandard')?.value === 'claude');
  document.querySelector('[data-llm-key-field]')?.classList.toggle('is-hidden', false);
  document.querySelectorAll('[data-custom-api-field]').forEach((field) => {
    field.classList.toggle('is-hidden', !isCustomApi);
  });
  document.querySelectorAll('[data-nine-router-api-field]').forEach((field) => {
    field.classList.toggle('is-hidden', !isNineRouter);
  });
  document.querySelector('[data-claude-max-tokens-field]')?.classList.toggle('is-hidden', !isClaudeApi);
  document.getElementById('ttsKeysText')?.closest('.settings-field')?.classList.toggle('is-hidden', isOmniVoice);
  document.getElementById('ttsVoiceId')?.classList.toggle('is-hidden', isLarVoice || isOmniVoice);
  document.getElementById('ttsVoiceIdQuick')?.classList.toggle('is-hidden', isLarVoice || isOmniVoice);
  document.querySelectorAll('[data-larvoice-voice-ui]').forEach((element) => {
    element.classList.toggle('is-hidden', !isLarVoice);
  });
  document.querySelectorAll('[data-omnivoice-voice-ui]').forEach((element) => {
    element.classList.toggle('is-hidden', !isOmniVoice);
  });
  document.getElementById('vbeeAppId')?.closest('.settings-field')?.classList.toggle('is-hidden', ttsProvider !== 'vbee');
  document.querySelectorAll('[data-tts-config]').forEach((field) => {
    field.classList.toggle('is-hidden', field.dataset.ttsConfig !== ttsProvider);
  });

  updateApiKindPanels();
  updateApiProviderHelp();
  updateImageSourceControls();
}

function updateApiKindPanels() {
  const kind = document.getElementById('apiSettingsKind')?.value || 'image-generation';
  document.querySelectorAll('[data-api-kind-panel]').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.apiKindPanel === kind);
  });
}

function setActiveSettingsTab(activeButton) {
  const tab = activeButton.dataset.settingsTab;
  const apiKind = activeButton.dataset.apiKindTab || '';
  if (apiKind) {
    const kindSelect = document.getElementById('apiSettingsKind');
    if (kindSelect) kindSelect.value = apiKind;
    updateApiKindPanels();
  }
  document.querySelectorAll('[data-settings-tab]').forEach((item) => {
    const sameRegularTab = !apiKind && !item.dataset.apiKindTab && item.dataset.settingsTab === tab;
    const sameApiKind = apiKind && item.dataset.settingsTab === 'api' && item.dataset.apiKindTab === apiKind;
    item.classList.toggle('active', Boolean(sameRegularTab || sameApiKind));
  });
  document.querySelectorAll('[data-settings-panel]').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.settingsPanel === tab);
  });
  if (tab === 'subtitle') requestAnimationFrame(updateSubtitlePreview);
}

function syncTtsProvider(value) {
  if (!value) return;
  const modal = document.getElementById('ttsProvider');
  const quick = document.getElementById('ttsProviderQuick');
  if (modal && modal.value !== value) modal.value = value;
  if (quick && quick.value !== value) quick.value = value;
}

function syncTtsVoiceId(value) {
  const modal = document.getElementById('ttsVoiceId');
  const quick = document.getElementById('ttsVoiceIdQuick');
  if (modal && modal.value !== value) modal.value = value;
  if (quick && quick.value !== value) quick.value = value;
}

function syncOmniVoiceInstruct(value) {
  const modal = document.getElementById('omnivoiceInstruct');
  if (modal && modal.value !== value) modal.value = value;
}

function syncOmniVoiceVoiceId(value) {
  const quick = document.getElementById('omnivoiceVoiceIdQuick');
  if (quick && quick.value !== value) quick.value = value;
}

function updateImageSourceControls() {
  const useFlow = valueUsesFlowSource(selectedImageSourceValue());
  const useFlowVideo = valueUsesFlowVideoSource(selectedImageSourceValue());
  const useFlowAudio = valueUsesFlowAudioSource(selectedImageSourceValue());
  const useGeneratedAudio = useFlowAudio;
  const useAiImage = selectedImageSourceIsAi() || useFlow;
  const useHtml = valueUsesHtmlSource(selectedImageSourceValue());
  const useVideoSearch = valueUsesVideoSearchSource(selectedImageSourceValue());
  const useApiVideo = selectedImageSourceIsApiVideo();
  document.querySelectorAll('[data-image-ai-only]').forEach((section) => {
    section.classList.toggle('is-hidden', !useAiImage);
  });
  document.querySelectorAll('[data-motion-section]').forEach((section) => {
    section.classList.toggle('is-hidden', useHtml || useVideoSearch || useApiVideo || useFlowVideo);
  });
  document.querySelectorAll('[data-html-media-section]').forEach((section) => {
    section.hidden = !useHtml;
    section.classList.toggle('is-hidden', !useHtml);
  });
  document.querySelectorAll('[data-generated-voice-only]').forEach((section) => {
    section.classList.toggle('is-hidden', useGeneratedAudio);
  });
  const subtitleEnabled = document.getElementById('subtitleEnabled');
  if (subtitleEnabled) {
    if (useGeneratedAudio) subtitleEnabled.checked = false;
    subtitleEnabled.disabled = useGeneratedAudio;
  }
}

function renderVideoLanguageOptions(options) {
  const select = document.getElementById('videoLanguage');
  if (!select) return;
  select.innerHTML = (options || [])
    .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
    .join('');
}

function renderSubtitleFontOptions(options) {
  const select = document.getElementById('subtitleFontFamily');
  if (!select) return;
  select.innerHTML = (options || [])
    .map((font) => `<option value="${escapeHtml(font.value)}">${escapeHtml(font.label || font.value)}</option>`)
    .join('');
}

function renderSubtitleEffectOptions(options) {
  const select = document.getElementById('subtitleEffect');
  if (!select) return;
  select.innerHTML = (options || [])
    .map((effect) => `<option value="${escapeHtml(effect.value)}">${escapeHtml(effect.label || effect.value)}</option>`)
    .join('');
}

function getSelectedVideoLanguage() {
  return document.getElementById('videoLanguage')?.value || state.settings?.videoLanguage || 'vi';
}

function getDefaultVoiceIdForLanguage(language) {
  const option = state.videoLanguageOptions.find((item) => item.value === language);
  return String(option?.defaultVoiceId || '');
}

function getSubtitleFontForVideoLanguage(language) {
  const option = state.videoLanguageOptions.find((item) => item.value === language);
  return option?.subtitleFontFamily || 'Be Vietnam Pro';
}

function getVoiceLanguageForVideoLanguage(language) {
  const option = state.videoLanguageOptions.find((item) => item.value === language);
  return option?.voiceLanguage || language || 'vi';
}

function updateVoiceLanguageLabel() {
  const label = document.getElementById('voice-language-label');
  if (!label) return;
  const selectedLanguage = getSelectedVideoLanguage();
  const languageOption = state.videoLanguageOptions.find((item) => item.value === selectedLanguage);
  const voiceLanguage = getVoiceLanguageForVideoLanguage(selectedLanguage);
  const count = state.voiceSamples.filter((voice) => !voice.language || voice.language === voiceLanguage).length;
  label.textContent = `${languageOption?.label || 'Tiếng Việt'} · ${count || 0} giọng`;
}

function renderLarVoiceOptions(samples, preferredVoiceId = null) {
  const select = document.getElementById('larvoiceVoiceId');
  if (!select) return;
  const voiceLanguage = getVoiceLanguageForVideoLanguage(getSelectedVideoLanguage());
  const voices = (Array.isArray(samples) ? samples : []).filter((voice) => (
    !voice.language || voice.language === voiceLanguage
  ));
  const preferred = String(preferredVoiceId || select.value || getDefaultVoiceIdForLanguage(getSelectedVideoLanguage()));
  const selected = voices.some((voice) => String(voice.id) === preferred)
    ? preferred
    : String(voices[0]?.id || '');
  select.innerHTML = voices.length
    ? voices.map((voice) => {
        const lang = voice.language ? ` · ${voice.language.toUpperCase()}` : '';
        return `<option value="${voice.id}">${escapeHtml(voice.name)} (#${voice.id}${lang})</option>`;
      }).join('')
    : '<option value="">Không có voice LarVoice cho ngôn ngữ này</option>';
  select.value = selected;
  updateVoiceLanguageLabel();
  updateVoicePreview();
  updateConfigSummary();
}

function normalizeLanguageValue(value) {
  return String(value || '').trim().toLowerCase();
}

function omniVoiceDefaultVoicesForLanguage(language = getSelectedVideoLanguage()) {
  const selected = normalizeLanguageValue(language);
  return (state.omnivoiceDefaultVoiceOptions || []).filter((voice) => (
    normalizeLanguageValue(voice.language) === selected
  ));
}

function renderOmniVoiceVoiceOptions(voices, preferredVoiceId = '') {
  const select = document.getElementById('omnivoiceVoiceIdQuick');
  if (!select) return;
  const defaultItems = omniVoiceDefaultVoicesForLanguage();
  const customItems = Array.isArray(voices) ? voices : [];
  select.innerHTML = [
    '<option value="">Auto voice</option>',
    defaultItems.length ? `<optgroup label="Giọng mặc định">${defaultItems.map((voice) => (
      `<option value="${escapeHtml(voice.id)}">${escapeHtml(voice.name)}</option>`
    )).join('')}</optgroup>` : '',
    customItems.length ? `<optgroup label="Giọng của bạn">${customItems.map((voice) => (
      `<option value="${escapeHtml(voice.id)}">${escapeHtml(voice.name)}</option>`
    )).join('')}</optgroup>` : ''
  ].join('');
  const preferred = String(preferredVoiceId ?? select.value ?? '').trim();
  const allItems = [...defaultItems, ...customItems];
  if (preferred === '') {
    select.value = '';
  } else {
    select.value = allItems.some((voice) => String(voice.id) === preferred)
      ? preferred
      : String(defaultItems[0]?.id || '');
  }
  updateConfigSummary();
}

function renderOmniVoiceVoicesList(voices) {
  const target = document.getElementById('omnivoice-voices-list');
  if (!target) return;
  const items = Array.isArray(voices) ? voices : [];
  target.innerHTML = items.length
    ? items.map((voice) => `
      <div class="api-provider-help" style="margin-top:8px">
        <strong>${escapeHtml(voice.name)}</strong>
        <span>${escapeHtml(voice.originalName || 'Audio mẫu')} · ${voice.refText ? 'có transcript' : 'chưa có transcript'}</span>
        <div class="api-provider-help-links">
          <button type="button" class="btn-ghost-xs danger" data-delete-omnivoice-voice="${escapeHtml(voice.id)}">Xoá</button>
        </div>
      </div>
    `).join('')
    : 'Chưa có giọng clone nào. Nếu không thêm, OmniVoice sẽ dùng Auto voice.';
}

function getSelectedVoiceSample() {
  const selectedId = String(document.getElementById('larvoiceVoiceId')?.value || '1');
  return state.voiceSamples.find((voice) => String(voice.id) === selectedId) || null;
}

function updateVoicePreview() {
  const audio = document.getElementById('voice-preview-audio');
  if (!audio) return;
  const ttsProvider = document.getElementById('ttsProvider')?.value || document.getElementById('ttsProviderQuick')?.value || 'larvoice';
  if (ttsProvider !== 'larvoice') {
    audio.removeAttribute('src');
    audio.load();
    return;
  }
  const sample = getSelectedVoiceSample();
  audio.src = sample?.sampleUrl || '';
}

function voiceSpeedSelectValue(value) {
  const speed = Number(value);
  if (speed === 0.9) return '0.9';
  if (speed === 1.1) return '1.1';
  return '1.0';
}

function renderHistory() {
  const grouped = {};
  state.history.forEach(item => {
    const gid = item.groupId || 'ungrouped';
    if (!grouped[gid]) grouped[gid] = [];
    grouped[gid].push(item);
  });

  const renderProjectItem = (item) => `
    <article class="history-item ${item.id === state.currentProjectId ? 'active' : ''}">
      <h3>${getDisplayTitle(item.title)}</h3>
      <div class="muted">${item.status} · ${new Date(item.updatedAt).toLocaleString('vi-VN')}</div>
      <div class="history-actions">
        <button type="button" data-open="${item.id}">Mở</button>
        <button type="button" data-delete="${item.id}" class="danger">Xoá</button>
      </div>
    </article>`;

  const itemsHtml = [];

  // Render group folders
  (state.groups || []).forEach(group => {
    const groupProjects = grouped[group.id] || [];
    const isCollapsed = state.collapsedGroups[group.id] === true;
    itemsHtml.push(`
      <div class="group-folder" data-group-id="${group.id}">
        <div class="group-folder-header">
          <span class="folder-toggle-icon">${isCollapsed ? '▶' : '▼'}</span>
          <span class="folder-name">📁 ${escapeHtml(group.name)} (&nbsp;${groupProjects.length})</span>
          <div class="folder-actions">
            <button type="button" data-delete-group="${group.id}" title="Xoá nhóm">✕</button>
          </div>
        </div>
        <div class="group-folder-contents ${isCollapsed ? 'collapsed' : ''}">
          ${groupProjects.length ? groupProjects.map(renderProjectItem).join('') : '<div class="muted" style="padding: 6px 10px; font-size: 11px;">Thư mục trống</div>'}
        </div>
      </div>`);
  });

  // Render ungrouped projects at the bottom
  const ungroupedProjects = grouped['ungrouped'] || [];
  if (ungroupedProjects.length || (state.groups || []).length === 0) {
    const isCollapsed = state.collapsedGroups['ungrouped'] === true;
    itemsHtml.push(`
      <div class="group-folder" data-group-id="ungrouped">
        <div class="group-folder-header">
          <span class="folder-toggle-icon">${isCollapsed ? '▶' : '▼'}</span>
          <span class="folder-name">📁 Chưa phân nhóm (&nbsp;${ungroupedProjects.length})</span>
        </div>
        <div class="group-folder-contents ${isCollapsed ? 'collapsed' : ''}">
          ${ungroupedProjects.length ? ungroupedProjects.map(renderProjectItem).join('') : '<div class="muted" style="padding: 6px 10px; font-size: 11px;">Thư mục trống</div>'}
        </div>
      </div>`);
  }

  elements.historyList.innerHTML = itemsHtml.join('');
}

function updateGroupSelect() {
  const selectCreate = document.getElementById('project-group-select');
  const selectAssign = document.getElementById('project-folder-assign');
  [selectCreate, selectAssign].forEach(select => {
    if (!select) return;
    const val = select.value;
    select.innerHTML = '<option value="">(Không phân nhóm)</option>' +
      (state.groups || []).map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
    if ((state.groups || []).some(g => g.id === val)) {
      select.value = val;
    } else {
      select.value = '';
    }
  });
}

const STEP_LABELS = {
  'started':          { next: 'Đang tạo script...' },
  'script-ready':     { next: 'Đang tạo ảnh...' },
  'images-ready':     { next: 'Đang tạo voice...' },
  'voices-ready':     { next: 'Đang tạo phụ đề...' },
  'subtitles-ready':  { next: 'Đang render từng cảnh...' },
  'scenes-rendered':  { next: 'Đang ghép video cuối...' },
  'video-assembled':  { next: 'Đang xử lý thumbnail/SEO nếu được bật...' },
  'thumbnail-ready':  { next: 'Đang tạo SEO nếu được bật...' },
  'done':             { next: 'Hoàn thành' }
};

// Tên hiển thị cho từng action
const ACTION_LABELS = {
  image:    'tạo ảnh',
  voice:    'tạo voice',
  subtitle: 'tạo phụ đề',
  render:   'render video',
  thumbnail:'tạo thumbnail',
  finalize: 'ghép video cuối',
  seo:      'tạo SEO',
};

function setStatus(text, type = 'running') {
  const logTextEl = document.querySelector('.progress-log-text');
  if (logTextEl) {
    logTextEl.innerHTML = text;
    return;
  }
  const dot  = document.getElementById('status-dot');
  const span = document.getElementById('status-text');
  if (!dot || !span) return;
  dot.className = 'status-dot'
    + (type === 'running' ? ' dot-running'
     : type === 'done'    ? ' dot-done'
     : type === 'error'   ? ' dot-failed' : '');
  span.innerHTML = text;
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getFlowJsonScriptSample(source) {
  if (source === 'flow-images') {
    return {
      title: 'JSON cho Flow - Ảnh tĩnh cho từng cảnh',
      desc: 'Dán JSON có imagePrompt cho từng cảnh. Flow tạo ảnh, sau đó app dựng video từ ảnh bằng hiệu ứng chuyển động đang chọn.',
      sample: {
        title: 'Tiêu đề video của bạn',
        thumbnailPrompt: 'cinematic dramatic thumbnail, readable Vietnamese headline, high contrast',
        entities: [
          {
            name: 'Nhân vật chính',
            entityType: 'character',
            description: 'Vietnamese young adult, warm friendly face, simple modern outfit, consistent hairstyle',
            imagePrompt: 'Single full-body reference image of a Vietnamese young adult with a warm friendly face, simple modern outfit, consistent hairstyle, neutral background, realistic lighting',
            voiceDescription: 'Warm natural Vietnamese voice, calm and clear'
          },
          {
            name: 'Phố buổi sáng',
            entityType: 'location',
            description: 'Vietnamese street at sunrise with small shops, soft warm light, gentle morning atmosphere',
            imagePrompt: 'Single landscape reference image of a Vietnamese street at sunrise with small shops, soft warm light, realistic cinematic style'
          }
        ],
        scenes: [
          {
            sceneNumber: 1,
            voiceText: 'Lời thoại / thuyết minh cho cảnh mở đầu.',
            entityNames: ['Nhân vật chính', 'Phố buổi sáng'],
            imagePrompt: 'Nhân vật chính walks along Phố buổi sáng, looking hopeful. Wide-medium shot, sunrise rim light, safe composition',
            useReferenceImage: true
          },
          {
            sceneNumber: 2,
            voiceText: 'Lời thoại / thuyết minh cho cảnh thứ hai.',
            entityNames: ['Nhân vật chính'],
            imagePrompt: 'Nhân vật chính looks at a phone in a modern cafe, emotional close-up, soft natural light',
            useReferenceImage: 'https://example.com/character-reference.jpg'
          }
        ]
      },
      notes: [
        '<strong>imagePrompt</strong> — Bắt buộc, nên viết tiếng Anh để Flow tạo ảnh tốt hơn.',
        '<strong>entities/entityNames</strong> — Khai báo nhân vật/bối cảnh/đạo cụ một lần, rồi mỗi cảnh chỉ liệt kê tên entity cần dùng để giữ đồng nhất.',
        '<strong>useReferenceImage</strong> — <code>true</code>: dùng ảnh tham chiếu chung; <code>false</code>: không dùng; URL: tải ảnh riêng cho cảnh rồi gửi vào Flow.',
        '<strong>Không dùng videoPrompt</strong> — Chế độ này chỉ tạo ảnh Flow rồi app tự dựng chuyển động từ ảnh.',
        '<strong>Thời lượng cảnh</strong> — App tự lấy theo độ dài voice tương ứng của từng cảnh.'
      ]
    };
  }

  if (source === 'flow-video-az' || source === 'flow-image-video-az') {
    const imageFirst = source === 'flow-image-video-az';
    return {
      title: imageFirst ? 'JSON cho Flow - Ảnh thành video có giọng nói' : 'JSON cho Flow - Video có giọng nói',
      desc: imageFirst
        ? 'Dán JSON có imagePrompt và videoPrompt cho từng cảnh. Flow tạo ảnh trước rồi tạo video có audio; app giữ audio Flow, không tạo TTS/phụ đề.'
        : 'Dán JSON có imagePrompt và videoPrompt cho từng cảnh. Flow tạo video có audio; app giữ audio Flow, không tạo TTS/phụ đề.',
      sample: {
        title: 'Tiêu đề video của bạn',
        entities: [
          {
            name: 'Presenter',
            entityType: 'character',
            description: 'Vietnamese presenter, expressive friendly face, neat dark hair, clean casual blazer',
            imagePrompt: 'Single full-body reference image of a Vietnamese presenter with expressive friendly face, neat dark hair, clean casual blazer, neutral studio background, realistic lighting',
            voiceDescription: 'Friendly clear Vietnamese voice, confident pacing'
          },
          {
            name: 'Bright Studio',
            entityType: 'location',
            description: 'bright modern studio with clean background and soft daylight',
            imagePrompt: 'Single landscape reference image of a bright modern studio with clean background and soft daylight, realistic cinematic lighting'
          }
        ],
        scenes: [
          {
            sceneNumber: 1,
            voiceText: 'Nội dung tham chiếu cho cảnh, dùng để quản lý kịch bản.',
            entityNames: ['Presenter', 'Bright Studio'],
            imagePrompt: 'Presenter stands in Bright Studio, medium shot, clean background, soft daylight',
            videoPrompt: 'Medium shot of Presenter standing in Bright Studio, speaking naturally in Vietnamese with a friendly clear voice and subtle hand gestures. The camera slowly pushes in. Audio: clean studio room tone and natural speech. Negative: subtitles, captions, watermark, text on screen.',
            flowDurationSec: 6,
            useReferenceImage: true
          },
          {
            sceneNumber: 2,
            voiceText: 'Nội dung tham chiếu cho cảnh thứ hai.',
            entityNames: ['Presenter'],
            imagePrompt: 'A close-up of hands opening a notebook on a wooden desk, warm morning light',
            videoPrompt: 'Natural desk sounds, pages turning, soft ambient room tone, camera pans slowly across the notebook',
            flowDurationSec: 4,
            useReferenceImage: 'https://example.com/character-reference.jpg'
          }
        ]
      },
      notes: [
        imageFirst
          ? '<strong>imagePrompt</strong> — Bắt buộc, Flow tạo ảnh trước rồi dùng ảnh đó tạo video.'
          : '<strong>imagePrompt</strong> — Nên có, mô tả frame/bối cảnh mở đầu bằng tiếng Anh.',
        '<strong>videoPrompt</strong> — Bắt buộc, mô tả chuyển động và audio/lời nói Flow cần tạo.',
        '<strong>entities/entityNames</strong> — Entity tạo ảnh tham chiếu một lần; scene dùng <code>entityNames</code> để Flow giữ cùng nhân vật/bối cảnh/đạo cụ.',
        '<strong>flowDurationSec</strong> — Tuỳ chọn cho clip gửi Flow: <code>4</code>, <code>6</code>, <code>8</code>; Omni Flash hỗ trợ thêm <code>10</code>.',
        '<strong>useReferenceImage</strong> — <code>true</code>: dùng ảnh tham chiếu chung; <code>false</code>: không dùng; URL: tải ảnh riêng cho cảnh rồi gửi vào Flow.',
        '<strong>voiceText</strong> — Chỉ dùng làm nội dung tham chiếu/quản lý; chế độ này không tạo TTS/phụ đề.',
        '<strong>Thời lượng cảnh</strong> — Theo video/audio mà Flow tạo ra cho từng cảnh.',
        '<strong>Không yêu cầu subtitle/caption/logo</strong> trong videoPrompt để tránh chữ dính trong video.'
      ]
    };
  }

  if (source === 'flow-film') {
    return {
      title: 'JSON cho Flow - Nối cảnh phim',
      desc: 'Dán JSON có videoPrompt nối tiếp từng cảnh. Tool tạo tuần tự, lấy frame cuối cảnh trước làm ảnh đầu vào cảnh sau, giữ audio Flow.',
      sample: {
        title: 'Tiêu đề phim của bạn',
        entities: [
          {
            name: 'Người em',
            entityType: 'character',
            description: 'poor Vietnamese young farmer, gentle face, simple brown rural clothes, slim build',
            imagePrompt: 'Single full-body reference image of a poor Vietnamese young farmer with gentle face, simple brown rural clothes, slim build, neutral background, realistic cinematic lighting',
            voiceDescription: 'Gentle sincere Vietnamese male voice'
          },
          {
            name: 'Làng quê',
            entityType: 'location',
            description: 'old Vietnamese rural village road at sunrise, small houses, warm dusty light',
            imagePrompt: 'Single landscape reference image of an old Vietnamese rural village road at sunrise, small houses, warm dusty light, realistic cinematic style'
          }
        ],
        scenes: [
          {
            sceneNumber: 1,
            chainType: 'ROOT',
            voiceText: 'Nội dung/lời thoại dự kiến cho cảnh mở đầu.',
            entityNames: ['Người em', 'Làng quê'],
            imagePrompt: 'Người em walks along Làng quê at sunrise, carrying simple farming tools. Wide shot, warm dusty light',
            videoPrompt: 'Wide shot of Người em walking along Làng quê at sunrise, carrying simple farming tools with a quiet hopeful expression. The camera slowly pushes forward. Audio: morning birds, soft wind, natural Vietnamese speech. Negative: subtitles, captions, watermark, text on screen.',
            flowDurationSec: 6,
            useReferenceImage: false
          },
          {
            sceneNumber: 2,
            chainType: 'CONTINUATION',
            parentSceneNumber: 1,
            voiceText: 'Nội dung/lời thoại dự kiến cho cảnh tiếp theo.',
            entityNames: ['Người em', 'Làng quê'],
            imagePrompt: 'Người em reaches the edge of Làng quê and pauses under warm sunlight. Medium shot, same morning atmosphere',
            videoPrompt: 'Continue from the previous final frame. The camera moves forward smoothly as a person appears in the distance. Keep the same lighting and location. Natural ambience and Vietnamese dialogue.',
            flowDurationSec: 6
          },
          {
            sceneNumber: 3,
            chainType: 'ROOT',
            voiceText: 'Nội dung/lời thoại dự kiến cho cảnh kết.',
            entityNames: ['Người em'],
            imagePrompt: 'Người em stands in a new quiet emotional ending moment under warm sunlight, medium shot, cinematic composition',
            videoPrompt: 'Medium shot of Người em standing under warm sunlight in a quiet emotional ending moment. The camera slowly dollies in. Audio: soft wind, natural Vietnamese speech, peaceful ambience. Negative: subtitles, captions, watermark, text on screen.',
            flowDurationSec: 8
          }
        ]
      },
      notes: [
        '<strong>Cảnh 1</strong> — Có thể dùng text hoặc ảnh tham chiếu chung để mở phim.',
        '<strong>chainType</strong> — <code>CONTINUATION</code>: nối bằng frame cuối cảnh cha; <code>ROOT</code>: mở chain mới khi đổi bối cảnh/nhảy thời gian/đổi tuyến nhân vật.',
        '<strong>entities/entityNames</strong> — Giữ đồng nhất nhân vật/bối cảnh/đạo cụ bằng ảnh tham chiếu riêng từng entity.',
        '<strong>videoPrompt</strong> — Với CONTINUATION nên viết kiểu “Continue from the previous final frame...”; với ROOT viết như cảnh mới.',
        '<strong>voiceText</strong> — Chỉ dùng làm nội dung tham chiếu/quản lý; audio thật do Flow tạo trong video.',
        '<strong>Thời lượng cảnh</strong> — Theo video/audio Flow trả về; <code>flowDurationSec</code> chỉ là độ dài clip gửi Flow.'
      ]
    };
  }

  return {
    title: source === 'flow-videos' ? 'JSON cho Flow - Văn bản thành video' : 'JSON cho Flow - Ảnh thành video',
    desc: source === 'flow-videos'
      ? 'Dán JSON có videoPrompt cho từng cảnh. Có thể thêm imagePrompt nếu muốn định hình frame mở đầu; app sẽ lồng voice/phụ đề sau khi Flow tạo video.'
      : 'Dán JSON có imagePrompt và videoPrompt cho từng cảnh. Flow tạo frame mở đầu rồi tạo video; app sẽ lồng voice/phụ đề sau đó.',
    sample: {
      title: 'Tiêu đề video của bạn',
      thumbnailPrompt: 'cinematic dramatic thumbnail, readable Vietnamese headline, high contrast',
      entities: [
        {
          name: 'Main Character',
          entityType: 'character',
          description: 'Vietnamese young entrepreneur, focused expression, simple smart casual outfit, consistent hairstyle',
          imagePrompt: 'Single full-body reference image of a Vietnamese young entrepreneur with focused expression, simple smart casual outfit, consistent hairstyle, neutral background, realistic lighting',
          voiceDescription: 'Clear energetic Vietnamese voice'
        },
        {
          name: 'Morning Market',
          entityType: 'location',
          description: 'busy Vietnamese street market at sunrise, warm light, natural crowd movement',
          imagePrompt: 'Single landscape reference image of a busy Vietnamese street market at sunrise, warm light, realistic cinematic style'
        }
      ],
      scenes: [
        {
          sceneNumber: 1,
          voiceText: 'Lời thoại / thuyết minh cho cảnh mở đầu.',
          entityNames: ['Main Character', 'Morning Market'],
          imagePrompt: 'Main Character walks through Morning Market at sunrise, wide-medium shot, warm realistic lighting',
          videoPrompt: 'Camera glides forward through the market, people move naturally, warm sunlight, energetic but realistic motion',
          flowDurationSec: 4,
          useReferenceImage: true
        },
        {
          sceneNumber: 2,
          voiceText: 'Lời thoại / thuyết minh cho cảnh thứ hai.',
          entityNames: ['Main Character'],
          imagePrompt: 'Main Character works on a laptop in a cafe, focused expression, soft daylight',
          videoPrompt: 'Slow dolly-in, the person types and looks up thoughtfully, coffee steam moves gently',
          flowDurationSec: 6,
          useReferenceImage: 'https://example.com/character-reference.jpg'
        }
      ]
    },
    notes: [
      '<strong>imagePrompt</strong> — Nên có cho Flow / Image / Video; với Flow / Videos có thể dùng để định hình frame mở đầu.',
      '<strong>videoPrompt</strong> — Bắt buộc/ưu tiên, mô tả hành động, camera, chuyển động; không chỉ lặp lại imagePrompt.',
      '<strong>entities/entityNames</strong> — Khai báo reference entity một lần, rồi scene dùng tên entity để giữ đồng nhất xuyên cảnh.',
      '<strong>flowDurationSec</strong> — Tuỳ chọn cho Flow video: <code>4</code>, <code>6</code>, <code>8</code>; Omni Flash hỗ trợ thêm <code>10</code>. Đây là duration clip gửi Flow.',
      '<strong>useReferenceImage</strong> — <code>true</code>: dùng ảnh tham chiếu chung; <code>false</code>: không dùng; URL: tải ảnh riêng cho cảnh rồi gửi vào Flow.',
      '<strong>voiceText</strong> — App dùng để tạo TTS/phụ đề và lồng vào video sau khi Flow render.',
      '<strong>Thời lượng cảnh</strong> — App tự kéo dài/co giãn cảnh theo độ dài voice; <code>flowDurationSec</code> không phải duration cuối cùng của scene.',
      '<strong>Không yêu cầu narration/subtitle/caption/logo</strong> trong videoPrompt vì app xử lý voice/phụ đề riêng.'
    ]
  };
}

function getJsonScriptSampleForCurrentSource() {
  if (valueUsesDirectMediaSource(selectedImageSourceValue())) {
    return {
      title: 'JSON cho URL ảnh/video trực tiếp',
      desc: 'Dán JSON có mediaUrl cho từng cảnh. Có thể trộn ảnh và video trong cùng project; hệ thống tải trực tiếp media thay vì tìm qua API.',
      sample: {
        title: 'Tiêu đề video của bạn',
        scenes: [
          {
            sceneNumber: 1,
            voiceText: 'Lời thoại cho cảnh dùng ảnh.',
            mediaType: 'image',
            mediaUrl: 'https://example.com/opening-image.jpg'
          },
          {
            sceneNumber: 2,
            voiceText: 'Lời thoại cho cảnh dùng video.',
            mediaType: 'video',
            mediaUrl: '/assets/my-video.mp4'
          }
        ]
      },
      notes: [
        '<strong>mediaUrl</strong> — URL internet hoặc đường dẫn website như <code>/assets/...</code>, <code>/projects/...</code>.',
        '<strong>mediaType</strong> — <code>image</code> hoặc <code>video</code>; có thể bỏ qua nếu URL có đuôi file rõ ràng.',
        '<strong>Mix media</strong> — Mỗi scene tự chọn ảnh hoặc video độc lập.',
        '<strong>Bắt buộc JSON</strong> — Chế độ này không nhận prompt văn bản thường.'
      ]
    };
  }

  if (valueUsesHtmlSource(selectedImageSourceValue())) {
    return {
      title: 'JSON kịch bản cho AI HTML video',
      desc: 'Dán JSON có htmlSpec vào ô nhập. Hệ thống tạo voice/phụ đề trước, rồi dùng AI dựng HTML chuyển động và render thành video cho từng cảnh.',
      sample: {
        title: 'Lời cầu nguyện buổi sáng',
        thumbnailKeyword: 'peaceful sunrise mountain prayer',
        scenes: [
          {
            sceneNumber: 1,
            targetDurationSec: 14,
            voiceText: 'Lạy Chúa, trong ánh sáng đầu tiên của ngày mới, con xin dâng lên Ngài lòng biết ơn và niềm tin bình an.',
            visual: 'Bình minh mở ra trên núi, ánh sáng vàng lan qua mây, cảm giác thiêng liêng và an yên.',
            htmlSpec: {
              concept: 'cinematic sunrise prayer opening',
              mood: 'peaceful, sacred, hopeful',
              layout: { pattern: 'HERO', composition: 'wide sunrise background, soft prayer title above center, lower third clear' },
              elements: [
                { id: 'sunrise', type: 'video/image background', content: 'use uploaded sunrise or nature media if available' },
                { id: 'title', type: 'text', content: 'Lời cầu nguyện buổi sáng' }
              ],
              timeline: [
                { beat: 'dawn reveal', startHint: 0, endHint: 4, animation: 'light slowly blooms from horizon' },
                { beat: 'prayer title', startHint: 4, endHint: 10, animation: 'title fades in with gentle glow' }
              ]
            },
            sfxPlan: [
              { file: 'morning-birds.mp3', timingPhrase: 'ánh sáng đầu tiên', startSec: 0.4, volume: 0.18 }
            ]
          }
        ]
      },
      notes: [
        '<strong>htmlSpec</strong> — Mô tả bố cục, thành phần, timeline để AI dựng HTML chuyển động.',
        '<strong>Media upload</strong> — Đặt tên file tự mô tả; AI sẽ chọn media theo tên file và nội dung cảnh.',
        '<strong>Flow HTML</strong> — Voice và subtitle timing tạo trước, sau đó HTML được render theo đúng độ dài voice.',
        '<strong>Không dùng CHUYỂN ĐỘNG CẢNH</strong> — Chuyển động nằm trong HTML do AI tạo.'
      ]
    };
  }

  if (valueUsesFlowSource(selectedImageSourceValue())) {
    return getFlowJsonScriptSample(selectedImageSourceValue());
  }

  if (valueUsesVideoSearchSource(selectedImageSourceValue())) {
    return {
      title: 'JSON kịch bản cho tìm kiếm video',
      desc: 'Dán JSON dạng keyword vào ô nhập. Hệ thống tạo voice trước, rồi dùng videoKeyword để tìm video Pexels phù hợp từng cảnh.',
      sample: {
        title: 'Tiêu đề video của bạn',
        thumbnailKeyword: 'dramatic city skyline sunrise',
        scenes: [
          {
            sceneNumber: 1,
            voiceText: 'Lời thoại / thuyết minh cho cảnh mở đầu.',
            videoKeyword: 'busy vietnam street market morning footage'
          },
          {
            sceneNumber: 2,
            voiceText: 'Lời thoại / thuyết minh cho cảnh thứ hai.',
            videoKeyword: 'young entrepreneur working laptop cafe video'
          },
          {
            sceneNumber: 3,
            voiceText: 'Lời thoại / thuyết minh cho cảnh kết.',
            videoKeyword: 'sunset mountain road hopeful cinematic footage'
          }
        ]
      },
      notes: [
        '<strong>thumbnailKeyword</strong> — Từ khoá tiếng Anh ngắn để tìm ảnh thumbnail.',
        '<strong>videoKeyword</strong> — Từ khoá tiếng Anh 4-10 từ cho từng cảnh; ưu tiên footage có chủ thể, bối cảnh, hành động rõ.',
        '<strong>Flow video</strong> — Hệ thống tạo voice trước, chọn video gần nhất theo thời lượng voice và tỉ lệ khung hình, rồi tua nhanh/chậm để khớp voice.',
        '<strong>Không dùng imagePrompt/imageKeyword/useReferenceImage</strong> — Nhánh này không gọi AI tạo ảnh cho cảnh.'
      ]
    };
  }

  if (!selectedImageSourceIsAi()) {
    return {
      title: 'JSON kịch bản cho tìm kiếm hình ảnh',
      desc: 'Dán JSON dạng keyword vào ô nhập. Hệ thống bỏ qua bước AI viết kịch bản và dùng imageKeyword/thumbnailKeyword để tìm ảnh thật hoặc stock.',
      sample: {
        title: 'Tiêu đề video của bạn',
        thumbnailKeyword: 'dramatic city skyline sunrise',
        scenes: [
          {
            sceneNumber: 1,
            voiceText: 'Lời thoại / thuyết minh cho cảnh mở đầu.',
            imageKeyword: 'busy vietnam street market morning'
          },
          {
            sceneNumber: 2,
            voiceText: 'Lời thoại / thuyết minh cho cảnh thứ hai.',
            imageKeyword: 'young entrepreneur working laptop cafe'
          },
          {
            sceneNumber: 3,
            voiceText: 'Lời thoại / thuyết minh cho cảnh kết.',
            imageKeyword: 'sunset mountain road hopeful mood'
          }
        ]
      },
      notes: [
        '<strong>thumbnailKeyword</strong> — Từ khoá tiếng Anh ngắn để tìm ảnh thumbnail.',
        '<strong>imageKeyword</strong> — Từ khoá tiếng Anh 4-10 từ cho từng cảnh; ưu tiên chủ thể, bối cảnh, hành động, cảm xúc.',
        '<strong>Không dùng imagePrompt/useReferenceImage</strong> — Nhánh này không gọi AI tạo ảnh và không dùng ảnh tham chiếu.',
        '<strong>Fallback ảnh</strong> — Mỗi keyword có thể có nhiều ảnh ứng viên; nếu ảnh đầu tải hoặc xử lý lỗi, hệ thống thử tiếp các ảnh còn lại.'
      ]
    };
  }

  return {
    title: 'JSON kịch bản cho tạo ảnh bằng AI',
    desc: 'Dán JSON dạng prompt vào ô nhập. Hệ thống bỏ qua bước AI viết kịch bản và dùng imagePrompt để tạo ảnh cho từng cảnh.',
    sample: {
      title: 'Tiêu đề video của bạn',
      thumbnailPrompt: 'A dramatic YouTube thumbnail in English prompt style, bold readable headline, cinematic composition',
      scenes: [
        {
          sceneNumber: 1,
          voiceText: 'Lời thoại / thuyết minh cho cảnh này.',
          imagePrompt: 'Describe the scene image in English, cinematic style',
          useReferenceImage: false
        },
        {
          sceneNumber: 2,
          voiceText: 'Dùng ảnh tham chiếu chung đã cấu hình.',
          imagePrompt: 'Second scene description in English',
          useReferenceImage: true
        },
        {
          sceneNumber: 3,
          voiceText: 'Dùng URL ảnh tham chiếu riêng cho cảnh này.',
          imagePrompt: 'Third scene description in English',
          useReferenceImage: 'https://example.com/character.jpg'
        }
      ]
    },
    notes: [
      '<strong>thumbnailPrompt</strong> — Prompt tiếng Anh để AI tạo ảnh thumbnail.',
      '<strong>imagePrompt</strong> — Prompt tiếng Anh cho ảnh nền từng cảnh; càng rõ chủ thể, bố cục, ánh sáng càng tốt.',
      '<strong>useReferenceImage</strong> — <code>false</code>: không dùng ảnh tham chiếu · <code>true</code>: dùng ảnh tham chiếu chung · <code>"https://..."</code>: dùng URL riêng cho cảnh.',
      '<strong>Không dùng imageKeyword</strong> — Nhánh AI không tìm ảnh stock nên keyword tìm kiếm sẽ bị bỏ qua.'
    ]
  };
}

function renderJsonSampleModal() {
  const config = getJsonScriptSampleForCurrentSource();
  const title = document.getElementById('json-modal-title');
  const desc = document.getElementById('json-modal-desc');
  const code = document.getElementById('json-sample-code');
  const notes = document.getElementById('json-modal-notes');
  if (title) title.textContent = config.title;
  if (desc) desc.textContent = config.desc;
  if (code) code.textContent = JSON.stringify(config.sample, null, 2);
  if (notes) {
    notes.innerHTML = config.notes.map((note) => `<p>${note}</p>`).join('');
  }
}

function padSceneNumber(sceneNumber) {
  return String(sceneNumber || '').padStart(2, '0');
}

function selectedOptionLabel(id, fallback = '') {
  const select = document.getElementById(id);
  return select?.selectedOptions?.[0]?.textContent?.trim() || fallback;
}

function getEstimatedSceneText() {
  const durationValue = document.getElementById('videoDurationSec')?.value || 'free';
  if (durationValue === 'free') return 'AI tự quyết định độ dài theo nội dung';
  const duration = parseInt(durationValue) || 60;
  const sceneValue = document.getElementById('sceneDurationSec')?.value || 'auto';
  if (sceneValue === 'auto') return `AI tự chia cảnh trong khoảng ${duration} giây`;
  const sceneDuration = parseInt(sceneValue) || 10;
  const count = Math.max(1, Math.floor(duration / sceneDuration));
  return `${count} cảnh, khoảng ${sceneDuration} s/cảnh`;
}

function updateConfigSummary() {
  const container = document.getElementById('config-summary');
  if (!container) return;
  const subtitleLabel = document.getElementById('subtitleEnabled')?.checked ? 'Bật' : 'Tắt';
  const thumbnailLabel = document.getElementById('generateThumbnailEnabled')?.checked ? 'Bật' : 'Tắt';
  const seoLabel = document.getElementById('generateSeoEnabled')?.checked ? 'Bật' : 'Tắt';
  const musicLabel = document.getElementById('music-display')?.textContent?.trim() || 'Chưa có nhạc nền';
  const introLabel = document.getElementById('intro-video-display')?.textContent?.trim() || 'Không thêm video';
  const outroLabel = document.getElementById('outro-video-display')?.textContent?.trim() || 'Không nối video';
  const htmlMediaLabel = document.getElementById('html-media-display')?.textContent?.trim() || '';
  const imageSource = selectedImageSourceValue();
  const ttsProvider = document.getElementById('ttsProvider')?.value || document.getElementById('ttsProviderQuick')?.value || 'larvoice';
  const voiceLabel = ttsProvider === 'larvoice'
    ? selectedOptionLabel('larvoiceVoiceId', '')
    : ttsProvider === 'omnivoice'
      ? selectedOptionLabel('omnivoiceVoiceIdQuick', 'Auto voice')
      : (document.getElementById('ttsVoiceIdQuick')?.value || document.getElementById('ttsVoiceId')?.value || '');
  const rows = [
    ['Ngôn ngữ', selectedOptionLabel('videoLanguage', 'Tiếng Việt')],
    ['Tỉ lệ', selectedOptionLabel('aspectRatio', '16:9')],
    ['Nguồn ảnh', selectedOptionLabel('imageSource', 'Chat01 - Tạo ảnh AI')],
    ['Chuyển cảnh', selectedOptionLabel('transitionPreset', 'Fade')],
    ...(imageSource.startsWith('ai:') ? [['Style ảnh', selectedOptionLabel('imageStyle', '')]] : []),
    ...(valueUsesHtmlSource(imageSource) ? [['HTML media', htmlMediaLabel || 'Chưa có media']] : []),
    ['TTS', selectedOptionLabel('ttsProvider', 'LarVoice / TTS')],
    ['Giọng đọc', voiceLabel],
    ['Phụ đề', `${subtitleLabel} · ${selectedOptionLabel('subtitleFontFamily', 'Be Vietnam Pro')}`],
    ['Thumbnail', thumbnailLabel],
    ['SEO YouTube + caption MXH', seoLabel],
    ['Nhạc', musicLabel],
    ['Video đầu', introLabel],
    ['Video cuối', outroLabel],
    ['Ước tính', getEstimatedSceneText()]
  ];
  container.innerHTML = `
    <div class="config-summary-title">Tóm tắt cấu hình</div>
    ${rows.map(([label, value]) => `
      <div class="config-summary-row">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    `).join('')}
  `;
}

function formatLogTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return '--:--:--.---';
  }
  return date.toISOString().slice(11, 23);
}

function formatLogEntry(entry) {
  if (!entry) {
    return '';
  }
  const { time, level = 'info', message = '', ...extra } = entry;
  const extraKeys = Object.keys(extra).filter((key) => extra[key] !== undefined);
  const normalizedLevel = String(level).toUpperCase().padEnd(5);
  const levelClass = `log-level-${String(level).toLowerCase()}`;
  const extraText = extraKeys.length
    ? `  ${JSON.stringify(Object.fromEntries(extraKeys.map((key) => [key, extra[key]])))}`
    : '';
  return [
    `<span class="status-log-time">[${escapeHtml(formatLogTime(time))}]</span>`,
    ` <span class="status-log-level ${levelClass}">[${escapeHtml(normalizedLevel)}]</span>`,
    ` <span class="status-log-message">${escapeHtml(message)}</span>`,
    extraText ? ` <span class="status-log-extra">${escapeHtml(extraText)}</span>` : ''
  ].join('');
}

function getLatestLog(logs, fallbackLevel = 'info', fallbackMessage = 'Sẵn sàng') {
  if (Array.isArray(logs) && logs.length) {
    return logs[logs.length - 1];
  }
  return {
    time: new Date().toISOString(),
    level: fallbackLevel,
    message: fallbackMessage
  };
}

function renderStatusBar(project, logs = [], isRunningParam = false) {
  const container = elements.statusBar || document.getElementById('status-bar');
  if (!container) return;

  if (!project) {
    container.className = 'status-bar status-bar-simple';
    container.innerHTML = `
      <span class="status-dot" id="status-dot"></span>
      <span id="status-text" class="status-text">Chưa chọn dự án</span>
    `;
    return;
  }

  const { status, lastCompletedStep } = project;
  const isRunning = isRunningParam || status === 'running' || status === 'queued';
  const isFailed  = status === 'failed';
  const isPaused  = status === 'paused';
  const isQueued  = status === 'queued';
  const isDone    = status === 'completed' && !isRunningParam;

  // 1. Lấy log cuối cùng
  let entry;
  if (isFailed) {
    entry = getLatestLog(logs, 'error', `Pipeline failed at step: ${lastCompletedStep || 'unknown'}`);
  } else if (isQueued) {
    entry = getLatestLog(logs, 'info', 'Đang xếp hàng chờ xử lý...');
  } else if (isRunning) {
    entry = getLatestLog(logs, 'info', STEP_LABELS[lastCompletedStep]?.next ?? 'Đang chạy');
  } else if (isDone) {
    entry = getLatestLog(logs, 'info', 'Pipeline completed');
  } else if (isPaused) {
    entry = getLatestLog(logs, '', 'Đã tạm dừng bởi người dùng');
  } else {
    entry = getLatestLog(logs, 'info', 'Sẵn sàng');
  }

  const formattedLog = formatLogEntry(entry);

  // 2. Tính toán trạng thái các bước (B1 -> B5)
  const scenes = project.scenes || [];
  const total = scenes.length;
  const hasImageCount = scenes.filter(s => s.files?.image || s.files?.sourceVideo || s.files?.html).length;
  const hasVoiceCount = scenes.filter(s => s.files?.voice).length;
  const hasVideoCount = scenes.filter(s => s.files?.video).length;

  const stepStates = [ 'pending', 'pending', 'pending', 'pending', 'pending' ];
  const stepDescs = [ 'Chờ...', 'Chờ...', 'Chờ...', 'Chờ...', 'Chờ...' ];

  let step2Label = 'B2 — Tạo ảnh';
  if (project.settings?.imageSource === 'video_search') {
    step2Label = 'B2 — Tìm video';
  } else if (project.settings?.imageSource === 'html') {
    step2Label = 'B2 — HTML Scene';
  }

  if (isDone) {
    for (let i = 0; i < 5; i++) stepStates[i] = 'completed';
    stepDescs[0] = 'Hoàn thành';
    stepDescs[1] = 'Hoàn thành';
    stepDescs[2] = 'Hoàn thành';
    stepDescs[3] = 'Hoàn thành';
    stepDescs[4] = 'Hoàn thành';
  } else if (isFailed || isPaused) {
    let failedIndex = 0;
    if (lastCompletedStep === 'started') {
      failedIndex = 0;
    } else if (lastCompletedStep === 'script-ready') {
      if (hasImageCount < total) failedIndex = 1;
      else if (hasVoiceCount < total) failedIndex = 2;
      else failedIndex = 3;
    } else if (lastCompletedStep === 'scenes-rendered' || lastCompletedStep === 'video-assembled' || lastCompletedStep === 'thumbnail-ready') {
      failedIndex = 4;
    }

    const stateVal = isFailed ? 'failed' : 'paused';
    const labelVal = isFailed ? 'Thất bại' : 'Tạm dừng';

    for (let i = 0; i < 5; i++) {
      if (i < failedIndex) {
        stepStates[i] = 'completed';
        stepDescs[i] = 'Hoàn thành';
      } else if (i === failedIndex) {
        stepStates[i] = stateVal;
        stepDescs[i] = labelVal;
      } else {
        stepStates[i] = 'pending';
        stepDescs[i] = 'Chờ...';
      }
    }
  } else if (isRunning) {
    if (lastCompletedStep === 'started') {
      stepStates[0] = 'running';
      stepDescs[0] = 'Đang tạo...';
    } else if (lastCompletedStep === 'script-ready') {
      stepStates[0] = 'completed';
      stepDescs[0] = 'Hoàn thành';

      // B2: Tạo ảnh/video/HTML
      if (hasImageCount < total) {
        stepStates[1] = 'running';
        stepDescs[1] = `Đang tạo (${hasImageCount}/${total})`;
      } else {
        stepStates[1] = 'completed';
        stepDescs[1] = 'Hoàn thành';
      }

      // B3: Tạo voice
      if (hasVoiceCount < total) {
        stepStates[2] = 'running';
        stepDescs[2] = `Đang tạo (${hasVoiceCount}/${total})`;
      } else {
        stepStates[2] = 'completed';
        stepDescs[2] = 'Hoàn thành';
      }

      // B4: Render cảnh
      if (stepStates[1] === 'completed' && stepStates[2] === 'completed') {
        if (hasVideoCount < total) {
          stepStates[3] = 'running';
          stepDescs[3] = `Đang render (${hasVideoCount}/${total})`;
        } else {
          stepStates[3] = 'completed';
          stepDescs[3] = 'Hoàn thành';
        }
      } else {
        if (hasVideoCount > 0 && hasVideoCount < total) {
          stepStates[3] = 'running';
          stepDescs[3] = `Đang render (${hasVideoCount}/${total})`;
        } else {
          stepStates[3] = 'pending';
          stepDescs[3] = 'Chờ...';
        }
      }
    } else if (lastCompletedStep === 'scenes-rendered' || lastCompletedStep === 'video-assembled' || lastCompletedStep === 'thumbnail-ready') {
      stepStates[0] = 'completed';
      stepStates[1] = 'completed';
      stepStates[2] = 'completed';
      stepStates[3] = 'completed';
      stepStates[4] = 'running';

      stepDescs[0] = 'Hoàn thành';
      stepDescs[1] = 'Hoàn thành';
      stepDescs[2] = 'Hoàn thành';
      stepDescs[3] = 'Hoàn thành';

      if (lastCompletedStep === 'scenes-rendered') {
        stepDescs[4] = 'Đang ghép & trộn...';
      } else if (lastCompletedStep === 'video-assembled') {
        stepDescs[4] = 'Tạo thumbnail...';
      } else if (lastCompletedStep === 'thumbnail-ready') {
        stepDescs[4] = 'Tối ưu SEO...';
      }
    }
  } else {
    // Idle
    const hasScript = (project.scenes && project.scenes.length > 0 && project.scenes[0].voiceText);
    stepStates[0] = hasScript ? 'completed' : 'pending';
    stepStates[1] = (hasScript && hasImageCount === total) ? 'completed' : 'pending';
    stepStates[2] = (hasScript && hasVoiceCount === total) ? 'completed' : 'pending';
    stepStates[3] = (hasScript && hasVideoCount === total) ? 'completed' : 'pending';
    stepStates[4] = (hasScript && project.outputs?.videoFinal) ? 'completed' : 'pending';

    for (let i = 0; i < 5; i++) {
      stepDescs[i] = stepStates[i] === 'completed' ? 'Hoàn thành' : (i === 0 ? 'Chờ tạo' : 'Chờ...');
    }
  }

  // Helper render icons & connectors
  const getIcon = (st) => {
    if (st === 'completed') return '<span class="progress-step-icon">✓</span>';
    if (st === 'running') return '<span class="progress-step-icon">⟳</span>';
    if (st === 'failed') return '<span class="progress-step-icon">✗</span>';
    if (st === 'paused') return '<span class="progress-step-icon">⏸</span>';
    return '<span class="progress-step-icon"></span>';
  };

  const getConnector = (stLeft, stRight) => {
    let cls = 'progress-connector';
    if (stLeft === 'completed' && stRight === 'completed') cls += ' active';
    else if (stLeft === 'completed' && stRight === 'running') cls += ' running';
    return `<div class="${cls}"></div>`;
  };

  container.className = 'status-bar status-bar-detailed';
  container.innerHTML = `
    <div class="progress-panel">
      <div class="progress-steps">
        <div class="progress-step-card ${stepStates[0]}">
          ${getIcon(stepStates[0])}
          <div class="progress-step-info">
            <span class="progress-step-title">B1 — Kịch bản</span>
            <span class="progress-step-desc">${stepDescs[0]}</span>
          </div>
        </div>

        ${getConnector(stepStates[0], stepStates[1])}

        <div class="progress-step-card ${stepStates[1]}">
          ${getIcon(stepStates[1])}
          <div class="progress-step-info">
            <span class="progress-step-title">${step2Label}</span>
            <span class="progress-step-desc">${stepDescs[1]}</span>
          </div>
        </div>

        ${getConnector(stepStates[1], stepStates[2])}

        <div class="progress-step-card ${stepStates[2]}">
          ${getIcon(stepStates[2])}
          <div class="progress-step-info">
            <span class="progress-step-title">B3 — Tạo voice</span>
            <span class="progress-step-desc">${stepDescs[2]}</span>
          </div>
        </div>

        ${getConnector(stepStates[2], stepStates[3])}

        <div class="progress-step-card ${stepStates[3]}">
          ${getIcon(stepStates[3])}
          <div class="progress-step-info">
            <span class="progress-step-title">B4 — Render cảnh</span>
            <span class="progress-step-desc">${stepDescs[3]}</span>
          </div>
        </div>

        ${getConnector(stepStates[3], stepStates[4])}

        <div class="progress-step-card ${stepStates[4]}">
          ${getIcon(stepStates[4])}
          <div class="progress-step-info">
            <span class="progress-step-title">B5 — Ghép & Mix</span>
            <span class="progress-step-desc">${stepDescs[4]}</span>
          </div>
        </div>
      </div>

      <div class="progress-log-box">
        <span class="progress-log-icon">🔍</span>
        <div class="progress-log-text">${formattedLog}</div>
      </div>
    </div>
  `;
}

function renderSummary(project, isRunning = false) {
  elements.projectTitle.textContent = getDisplayTitle(project.title);
  renderStatusBar(project, state.currentLogs, isRunning);

  const running = isRunning || project.status === 'running';
  if (elements.pauseProject) {
    elements.pauseProject.style.display = running ? 'inline-block' : 'none';
  }
  if (elements.resumeProject) {
    elements.resumeProject.style.display = running ? 'none' : 'inline-block';
  }
  if (elements.renderAllProject) {
    elements.renderAllProject.style.display = running ? 'none' : 'inline-block';
  }
}

function toPublicAssetPath(filePath) {
  if (!filePath) return '';
  const normalized = String(filePath).replaceAll('\\', '/');
  const marker = '/projects/';
  const index = normalized.indexOf(marker);
  return index >= 0 ? normalized.slice(index) : normalized;
}

function fileNameFromPath(filePath, fallback = '') {
  if (!filePath) return fallback;
  return String(filePath).replaceAll('\\', '/').split('/').filter(Boolean).pop() || fallback;
}

function updateHtmlMediaDisplay(project = state.currentProject) {
  const input = document.getElementById('htmlMedia');
  const display = document.getElementById('html-media-display');
  if (!display) return;
  const selected = Array.from(input?.files || []);
  if (selected.length) {
    display.textContent = `${selected.length} file đã chọn (${selected.map((file) => file.name).join(', ')})`;
    return;
  }
  const media = project?.outputs?.htmlMedia || [];
  display.textContent = media.length
    ? `${media.length} media trong project`
    : 'Chưa có media';
}

function summarizeHtmlMediaList(list = [], emptyText = 'Chưa có media') {
  const media = Array.isArray(list) ? list : [];
  if (!media.length) return emptyText;
  const names = media.slice(-3).map((item) => item.originalName || item.fileName || 'media');
  return media.length <= 3
    ? `${media.length} file (${names.join(', ')})`
    : `${media.length} file (${names.join(', ')}...)`;
}

function updateDefaultHtmlMediaDisplay(settings = state.settings) {
  const sfxDisplay = document.getElementById('default-html-sfx-display');
  const brandDisplay = document.getElementById('html-brand-assets-display');
  if (sfxDisplay) {
    sfxDisplay.textContent = summarizeHtmlMediaList(settings?.htmlDefaultSfx, 'Chưa có SFX');
  }
  if (brandDisplay) {
    brandDisplay.textContent = summarizeHtmlMediaList(settings?.htmlBrandAssets, 'Chưa có ảnh thương hiệu');
  }
  const jsonText = document.getElementById('html-media-json-text');
  if (jsonText) {
    jsonText.value = JSON.stringify(buildEditableHtmlMediaJson(settings), null, 2);
  }
}

function buildEditableHtmlMediaJson(settings = state.settings) {
  return {
    soundEffects: (Array.isArray(settings?.htmlDefaultSfx) ? settings.htmlDefaultSfx : []).map((item) => ({
      id: item.id || '',
      type: 'audio',
      fileName: item.originalName || item.fileName || '',
      description: item.description || '',
      path: item.path || '',
      durationSec: item.durationSec || null
    })),
    brandAssets: (Array.isArray(settings?.htmlBrandAssets) ? settings.htmlBrandAssets : []).map((item) => {
      const asset = {
        id: item.id || '',
        type: item.type || 'image',
        fileName: item.originalName || item.fileName || '',
        description: item.description || '',
        path: item.path || ''
      };
      if (item.width) asset.width = item.width;
      if (item.height) asset.height = item.height;
      if (item.durationSec) asset.durationSec = item.durationSec;
      return asset;
    })
  };
}

function syncSidebarFromProject(project) {
  if (!project) return;
  const settings = project.settings || {};
  const setValue = (id, value) => {
    const element = document.getElementById(id);
    if (element && value !== undefined && value !== null) element.value = String(value);
  };
  const setChecked = (id, value) => {
    const element = document.getElementById(id);
    if (element) element.checked = Boolean(value);
  };

  setValue('motionPreset', safeMotionPreset(settings.motionPreset));
  setValue('transitionPreset', settings.transitionPreset || 'fade');
  setChecked('generateThumbnailEnabled', settings.generateThumbnailEnabled === true);
  setChecked('generateSeoEnabled', settings.generateSeoEnabled === true);
  setChecked('subtitleEnabled', settings.subtitleEnabled !== false);
  setValue('subtitleFontFamily', settings.subtitleFontFamily);
  setValue('subtitleEffect', settings.subtitleEffect || 'karaoke-fill');
  setValue('subtitleTextCase', settings.subtitleTextCase || 'original');
  setValue('subtitleColor', settings.subtitleColor);
  setValue('subtitleHighlightColor', settings.subtitleHighlightColor || '#ffd84d');
  setValue('subtitleMaxWordsPerLine', settings.subtitleMaxWordsPerLine || 5);
  setValue('subtitlePositionY', settings.subtitlePositionY ?? 86);
  setValue('subtitleFontScale', settings.subtitleFontScale ?? 1);
  setValue('subtitleOpacity', settings.subtitleOpacity ?? state.settings?.subtitleOpacity ?? 1);
  setValue('logoSize', settings.logoSize ?? state.settings?.logoSize ?? 120);
  setValue('logoPosition', settings.logoPosition || state.settings?.logoPosition || 'top-right');
  setValue('logoOpacity', settings.logoOpacity ?? state.settings?.logoOpacity ?? 1);
  setValue('watermarkText', settings.watermarkText ?? state.settings?.watermarkText ?? '');
  setValue('watermarkFontSize', settings.watermarkFontSize ?? state.settings?.watermarkFontSize ?? 24);
  setValue('watermarkOpacity', settings.watermarkOpacity ?? state.settings?.watermarkOpacity ?? 30);
  setValue('watermarkBehavior', settings.watermarkBehavior ?? state.settings?.watermarkBehavior ?? 'interval');
  setValue('watermarkInterval', settings.watermarkInterval ?? state.settings?.watermarkInterval ?? 5);
  setValue('watermarkSpeed', settings.watermarkSpeed ?? state.settings?.watermarkSpeed ?? 'medium');
  setValue('musicVolume', settings.musicVolume ?? state.settings?.musicVolume ?? 0.18);

  ['logoFile', 'backgroundMusic', 'introVideo', 'outroVideo', 'htmlMedia'].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });

  state.clearedAssets = {
    logo: false,
    backgroundMusic: false,
    introVideo: false,
    outroVideo: false
  };

  const updateClearButtonVisibility = (type, hasFile) => {
    const btn = document.getElementById(`btn-clear-${type}`);
    if (btn) btn.style.display = hasFile ? 'inline-flex' : 'none';
  };

  // Không clear input nếu đang có file lưu trong state để tránh mất tham chiếu của trình duyệt
  ['logoFile', 'introVideo', 'outroVideo', 'htmlMedia'].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });
  if (!state.selectedBackgroundMusicFiles || state.selectedBackgroundMusicFiles.length === 0) {
    const musicInput = document.getElementById('backgroundMusic');
    if (musicInput) musicInput.value = '';
  }

  const outputs = project.outputs || {};
  const logoDisplay = document.getElementById('logo-display');
  if (logoDisplay) logoDisplay.textContent = fileNameFromPath(outputs.logo, 'Chưa có logo');
  updateClearButtonVisibility('logo', Boolean(outputs.logo));

  // Hiển thị nhạc nền: Ưu tiên file nhạc cục bộ đang chọn trong state
  const musicDisplay = document.getElementById('music-display');
  if (musicDisplay) {
    if (state.selectedBackgroundMusicFiles && state.selectedBackgroundMusicFiles.length > 0) {
      const files = state.selectedBackgroundMusicFiles;
      musicDisplay.textContent = files.length === 1
        ? files[0].name
        : `${files.length} file nhạc (${files.map(f => f.name).join(', ')})`;
      updateClearButtonVisibility('music', true);
    } else {
      const musicPaths = outputs.backgroundMusicFiles || (outputs.backgroundMusic ? [outputs.backgroundMusic] : []);
      musicDisplay.textContent = musicPaths.length === 0
        ? 'Chưa có nhạc nền'
        : musicPaths.length === 1
          ? fileNameFromPath(musicPaths[0], 'Nhạc nền hiện tại')
          : `${musicPaths.length} file nhạc (${musicPaths.map((item) => fileNameFromPath(item, 'nhạc')).join(', ')})`;
      updateClearButtonVisibility('music', musicPaths.length > 0);
    }
  }

  // Hiển thị ảnh tham chiếu: Ưu tiên ảnh tham chiếu cục bộ đang chọn trong state
  const referenceDisplay = document.getElementById('reference-image-display');
  if (referenceDisplay) {
    if (state.selectedReferenceImageFile) {
      referenceDisplay.textContent = state.selectedReferenceImageFile.name;
    } else if (settings.referenceImageUrl) {
      referenceDisplay.textContent = 'Đang dùng URL cấu hình';
    } else {
      referenceDisplay.textContent = 'Chưa chọn file';
    }
  }

  document.querySelectorAll('.outro-video-display').forEach((display) => {
    display.textContent = fileNameFromPath(outputs.outroVideo, 'Không nối video');
  });
  updateClearButtonVisibility('outro-video', Boolean(outputs.outroVideo));

  document.querySelectorAll('.intro-video-display').forEach((display) => {
    display.textContent = fileNameFromPath(outputs.introVideo, 'Không thêm video');
  });
  updateClearButtonVisibility('intro-video', Boolean(outputs.introVideo));

  updateHtmlMediaDisplay(project);

  updateMusicVolumeLabel(document.getElementById('musicVolume')?.value || 0.18);
  updateHtmlSfxVolumeLabel(document.getElementById('htmlSfxVolume')?.value || 0.45);
  updateSubtitleSizeLabel(document.getElementById('subtitleFontScale')?.value || 1);
  updateSubtitleYLabel(document.getElementById('subtitlePositionY')?.value || 86);
  updateSubtitleOpacityLabel(document.getElementById('subtitleOpacity')?.value || 1);
  updateLogoSizeLabel(document.getElementById('logoSize')?.value || 120);
  updateLogoOpacityLabel(document.getElementById('logoOpacity')?.value || 1);
  updateWatermarkFontSizeLabel(document.getElementById('watermarkFontSize')?.value || 24);
  updateWatermarkOpacityLabel(document.getElementById('watermarkOpacity')?.value || 30);
  updateWatermarkIntervalLabel(document.getElementById('watermarkInterval')?.value || 5);
  updateWatermarkControlsVisibility();
  updateSubtitlePreview();
  updateConfigSummary();
}

function buildRenderFormDataFromSidebar() {
  const formData = new FormData();
  formData.set('motionPreset', document.getElementById('motionPreset')?.value || 'zoom-in');
  formData.set('transitionPreset', document.getElementById('transitionPreset')?.value || 'fade');
  formData.set('generateThumbnailEnabled', document.getElementById('generateThumbnailEnabled')?.checked ? 'true' : 'false');
  formData.set('generateSeoEnabled', document.getElementById('generateSeoEnabled')?.checked ? 'true' : 'false');
  formData.set('subtitleEnabled', document.getElementById('subtitleEnabled')?.checked ? 'true' : 'false');
  formData.set('subtitleFontFamily', document.getElementById('subtitleFontFamily')?.value || 'Be Vietnam Pro');
  formData.set('subtitleEffect', document.getElementById('subtitleEffect')?.value || 'karaoke-fill');
  formData.set('subtitleTextCase', document.getElementById('subtitleTextCase')?.value || 'original');
  formData.set('subtitleColor', document.getElementById('subtitleColor')?.value || '#ffffff');
  formData.set('subtitleHighlightColor', document.getElementById('subtitleHighlightColor')?.value || '#ffd84d');
  formData.set('subtitleMaxWordsPerLine', document.getElementById('subtitleMaxWordsPerLine')?.value || '5');
  formData.set('subtitlePositionY', document.getElementById('subtitlePositionY')?.value || '86');
  formData.set('subtitleFontScale', document.getElementById('subtitleFontScale')?.value || '1');
  formData.set('subtitleOpacity', document.getElementById('subtitleOpacity')?.value || '1');
  formData.set('logoSize', document.getElementById('logoSize')?.value || '120');
  formData.set('logoPosition', document.getElementById('logoPosition')?.value || 'top-right');
  formData.set('logoOpacity', document.getElementById('logoOpacity')?.value || '1');
  formData.set('watermarkText', document.getElementById('watermarkText')?.value || '');
  formData.set('watermarkFontSize', document.getElementById('watermarkFontSize')?.value || '24');
  formData.set('watermarkOpacity', document.getElementById('watermarkOpacity')?.value || '30');
  formData.set('watermarkBehavior', document.getElementById('watermarkBehavior')?.value || 'interval');
  formData.set('watermarkInterval', document.getElementById('watermarkInterval')?.value || '5');
  formData.set('watermarkSpeed', document.getElementById('watermarkSpeed')?.value || 'medium');
  formData.set('musicVolume', document.getElementById('musicVolume')?.value || '0.18');
  formData.set('htmlSfxVolume', document.getElementById('htmlSfxVolume')?.value || '0.45');
  formData.set('referenceImageUrl', document.getElementById('referenceImageUrl')?.value || '');

  const logoFile = document.getElementById('logoFile')?.files?.[0];
  const musicFiles = (state.selectedBackgroundMusicFiles && state.selectedBackgroundMusicFiles.length > 0)
    ? state.selectedBackgroundMusicFiles
    : (document.getElementById('backgroundMusic')?.files || []);
  const introVideo = document.getElementById('introVideo')?.files?.[0];
  const outroVideo = document.getElementById('outroVideo')?.files?.[0];
  const referenceImage = state.selectedReferenceImageFile || document.getElementById('referenceImageFile')?.files?.[0];
  const htmlMedia = document.getElementById('htmlMedia')?.files || [];
  if (state.clearedAssets?.logo) {
    formData.set('clearLogo', 'true');
  } else if (logoFile) {
    formData.append('logo', logoFile);
  }

  if (state.clearedAssets?.backgroundMusic) {
    formData.set('clearBackgroundMusic', 'true');
  } else {
    for (const file of musicFiles) formData.append('backgroundMusic', file);
  }

  if (state.clearedAssets?.introVideo) {
    formData.set('clearIntroVideo', 'true');
  } else if (introVideo) {
    formData.append('introVideo', introVideo);
  }

  if (state.clearedAssets?.outroVideo) {
    formData.set('clearOutroVideo', 'true');
  } else if (outroVideo) {
    formData.append('outroVideo', outroVideo);
  }

  if (referenceImage) {
    formData.append('referenceImage', referenceImage);
  }

  for (const file of htmlMedia) formData.append('htmlMedia', file);
  return formData;
}

function v(project) {
  return `?v=${new Date(project.updatedAt || 0).getTime()}`;
}

function getAspectRatioOption(value) {
  return state.aspectRatioOptions.find((option) => option.value === value)
    || state.aspectRatioOptions.find((option) => option.value === '16:9')
    || { value: '16:9', width: 1920, height: 1080 };
}

function mediaAspectStyle(aspectRatio) {
  const ratio = getAspectRatioOption(aspectRatio);
  const width = Number(ratio.width || 1920);
  const height = Number(ratio.height || 1080);
  return `--media-aspect: ${width} / ${height};`;
}

function renderHtmlPreviewFrame(htmlPath, version, aspectRatio, extraClass = '') {
  const ratio = getAspectRatioOption(aspectRatio);
  const width = Number(ratio.width || 1920);
  const height = Number(ratio.height || 1080);
  const onload = `try{var d=this.contentDocument;var sx=this.clientWidth/${width};var sy=this.clientHeight/${height};var s=Math.min(sx,sy);d.documentElement.style.width='${width}px';d.documentElement.style.height='${height}px';d.documentElement.style.margin='0';d.documentElement.style.overflow='hidden';d.body.style.width='${width}px';d.body.style.height='${height}px';d.body.style.margin='0';d.body.style.overflow='hidden';d.body.style.transformOrigin='0 0';d.body.style.transform='scale('+s+')';d.body.style.zoom='';}catch(e){}`;
  const classes = ['scene-html-preview', extraClass].filter(Boolean).join(' ');
  return `<iframe class="${escapeHtml(classes)}" style="${mediaAspectStyle(aspectRatio)}" src="${escapeHtml(htmlPath + version)}" loading="lazy" onload="${escapeHtml(onload)}"></iframe>`;
}

function finalVideoFrameStyle(aspectRatio) {
  const ratio = getAspectRatioOption(aspectRatio);
  const width = Number(ratio.width || 1920);
  const height = Number(ratio.height || 1080);
  const aspect = width / height;
  const maxHeight = aspect < 1 ? 620 : 560;
  const maxWidth = Math.round(maxHeight * aspect);
  return `${mediaAspectStyle(aspectRatio)} --final-video-max-width: ${maxWidth}px; --final-video-max-height: ${maxHeight}px;`;
}

function renderSceneStepTimeline(scene, project) {
  const files = scene.files || {};
  const flowAudioMode = valueUsesFlowAudioSource(project.settings?.imageSource);
  const generatedAudioMode = flowAudioMode;
  const subtitleEnabled = project.settings?.subtitleEnabled !== false && !generatedAudioMode;
  const usesVideoSearch = sceneUsesVideoSource(scene, project.settings?.imageSource);
  const usesHtml = valueUsesHtmlSource(project.settings?.imageSource);
  const steps = [
    { label: 'Script', done: Boolean(scene.voiceText || scene.imageKeyword || scene.videoKeyword || scene.imagePrompt) },
    { label: generatedAudioMode ? 'Audio Flow' : 'Voice', done: generatedAudioMode ? Boolean(files.sourceVideo) : Boolean(files.voice) },
    { label: 'Phụ đề', done: Boolean(files.subtitle || files.karaokeAss), skipped: !subtitleEnabled },
    usesHtml
      ? { label: 'HTML', done: Boolean(files.html) }
      : { label: usesVideoSearch ? 'Video' : 'Ảnh', done: usesVideoSearch ? Boolean(files.sourceVideo) : Boolean(files.image) },
    { label: 'Render', done: Boolean(files.video) }
  ];
  const activeIndex = steps.findIndex((step) => !step.done && !step.skipped);
  return `
    <div class="scene-step-timeline" aria-label="Tiến trình cảnh">
      ${steps.map((step, index) => {
        const className = [
          'scene-step',
          step.done ? 'done' : '',
          step.skipped ? 'skipped' : '',
          index === activeIndex ? 'active' : ''
        ].filter(Boolean).join(' ');
        const marker = step.skipped ? '-' : step.done ? '✓' : index === activeIndex ? '•' : '';
        return `
          <div class="${className}">
            <span class="scene-step-dot">${marker}</span>
            <span>${escapeHtml(step.label)}</span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function getSceneSourceVideoUrl(scene) {
  const candidates = [
    scene?.metadata?.videoSearch?.selected?.pageUrl,
    scene?.metadata?.videoUrl
  ];
  return candidates.find((value) => /^https?:\/\//i.test(String(value || '').trim())) || '';
}

function renderScenes(project) {
  const ver = v(project);
  const isRunning = project.status === 'running';
  const projectMediaStyle = mediaAspectStyle(project.settings?.aspectRatio);
  const usesImageSearch = valueUsesImageSearchSource(project.settings?.imageSource);
  const usesHtml = valueUsesHtmlSource(project.settings?.imageSource);

  // Chưa có scenes: show placeholder nếu đang chạy
  if (!project.scenes?.length) {
    elements.sceneList.innerHTML = isRunning
      ? `<div class="scene-skeleton-msg">⟳ Đang tạo kịch bản...</div>`
      : '';
    return;
  }

  const sceneCards = project.scenes.map((scene) => {
    const usesVideoSearch = sceneUsesVideoSource(scene, project.settings?.imageSource);
    const imagePath = toPublicAssetPath(scene.files?.image);
    const sourceVideoPath = toPublicAssetPath(scene.files?.sourceVideo);
    const htmlPath = toPublicAssetPath(scene.files?.html);
    const videoPath = toPublicAssetPath(scene.files?.video);
    const sourceVideoUrl = getSceneSourceVideoUrl(scene);
    const sceneNum = padSceneNumber(scene.sceneNumber);

    // Ghi nhận stable cache key khi image lần đầu xuất hiện — tránh flicker khi polling
    if (imagePath && !state.sceneVersions[scene.sceneNumber]) {
      state.sceneVersions[scene.sceneNumber] = `?v=${Date.now()}`;
    }
    const imgVer = state.sceneVersions[scene.sceneNumber] || ver;

    const hasDone = Boolean(videoPath);
    const isProcessing = state.processingSceneNums.has(Number(scene.sceneNumber));
    const isWaiting = isRunning && !hasDone && !imagePath && !isProcessing;

    const badgeClass = isProcessing ? 'badge-running'
      : hasDone ? 'badge-done'
      : scene.status === 'error' ? 'badge-error'
      : isWaiting ? 'badge-running'
      : 'badge-pending';
    const badgeLabel = isProcessing ? '⟳ Đang xử lý...'
      : hasDone ? '✓ Video'
      : isWaiting ? '⟳ Đang tạo...'
      : scene.status || 'pending';

    const fullDesc = scene.voiceText || '';
    const desc = fullDesc.length > 120 ? fullDesc.slice(0, 120) + '…' : fullDesc;

    return `
      <article class="scene-card${isProcessing ? ' scene-processing' : ''}" data-scene-num="${scene.sceneNumber}">
        <div class="scene-thumb" style="${projectMediaStyle}">
          ${sourceVideoPath
            ? `<video muted playsinline preload="metadata" src="${sourceVideoPath}${ver}"></video>`
            : htmlPath
            ? renderHtmlPreviewFrame(htmlPath, ver, project.settings?.aspectRatio)
            : imagePath
            ? `<img src="${imagePath}${imgVer}" alt="Cảnh ${scene.sceneNumber}" loading="lazy" />`
            : `<div class="thumb-empty${isWaiting ? ' thumb-loading' : ''}"></div>`
          }
          <span class="scene-status-badge ${badgeClass}">${badgeLabel}</span>
        </div>
        <div class="scene-card-body">
          <strong class="scene-number">Cảnh ${scene.sceneNumber}</strong>
          <p class="scene-desc">${desc ? escapeHtml(desc) : '<em style="opacity:.5">Chưa có nội dung</em>'}</p>
          ${renderSceneStepTimeline(scene, project)}
          <div class="scene-card-actions">
            <button type="button" class="btn-scene-action" data-scene-toggle="${scene.sceneNumber}">✏ Sửa</button>
            ${sourceVideoUrl
              ? `<a href="${escapeHtml(sourceVideoUrl)}" target="_blank" rel="noopener noreferrer" class="btn-scene-action">↗ Nguồn video</a>`
              : sourceVideoPath
              ? `<a href="${sourceVideoPath}${ver}" download="scene-${sceneNum}-source-video.mp4" class="btn-scene-action">↓ Video nguồn</a>`
              : htmlPath
              ? `<a href="${htmlPath}${ver}" target="_blank" download="scene-${sceneNum}.html" class="btn-scene-action">↓ HTML</a>`
              : imagePath
              ? `<a href="${imagePath}${imgVer}" download="scene-${sceneNum}-image.png" class="btn-scene-action">↓ Ảnh</a>`
              : `<button type="button" class="btn-scene-action" disabled>↓ ${usesHtml ? 'HTML' : usesVideoSearch ? 'Video nguồn' : 'Ảnh'}</button>`
            }
            ${videoPath
              ? `<a href="${videoPath}${ver}" target="_blank" class="btn-scene-action">▶ Xem</a>`
              : `<button type="button" class="btn-scene-action" disabled>▶ Xem</button>`
            }
            ${videoPath
              ? `<a href="${videoPath}${ver}" download="scene-${sceneNum}.mp4" class="btn-scene-action btn-scene-download">↓ Video</a>`
              : `<button type="button" class="btn-scene-action" disabled>↓ Video</button>`
            }
          </div>
        </div>
      </article>
    `;
  }).join('');

  // Thumbnail card — rendered in the same scene-grid so it sits on the same row
  let thumbnailCard = '';
  const thumbnailEnabled = project.settings?.generateThumbnailEnabled === true;
  if (thumbnailEnabled) {
    const isLandscape = project.settings?.aspectRatio === '16:9';
    if (isLandscape) {
      let cardHorizontal = '';
      if (project.outputs?.thumbnail) {
        if (!state.thumbnailVersion) state.thumbnailVersion = `?v=${Date.now()}`;
        const srcHor = toPublicAssetPath(project.outputs.thumbnail);
        cardHorizontal = `
          <article class="scene-card">
            <div class="scene-thumb" style="${projectMediaStyle}">
              <img src="${srcHor}${state.thumbnailVersion}" alt="thumbnail horizontal" />
              <span class="scene-status-badge badge-done">✓ Thumbnail ngang</span>
              <a href="${srcHor}${state.thumbnailVersion}" download="thumbnail.jpg" class="thumb-download-button">↓ Tải thumbnail ngang</a>
            </div>
            <div class="scene-card-body">
              <strong class="scene-number">Thumbnail ngang</strong>
              <textarea id="project-thumbnail-prompt" class="thumb-prompt" rows="2" placeholder="Prompt thumbnail ngang...">${escapeHtml(project.thumbnailPrompt || project.thumbnailKeyword || '')}</textarea>
              <div class="scene-card-actions">
                <button type="button" class="btn-scene-action" data-output-action="thumbnail">↺ Tạo lại</button>
                <a href="${srcHor}${state.thumbnailVersion}" download="thumbnail.jpg" class="btn-scene-action btn-scene-download">↓ Tải ngang</a>
              </div>
            </div>
          </article>`;
      } else if (isRunning) {
        cardHorizontal = `
          <article class="scene-card">
            <div class="scene-thumb" style="${projectMediaStyle}">
              <div class="thumb-empty thumb-loading"></div>
              <span class="scene-status-badge badge-running">⟳ Đang tạo...</span>
            </div>
            <div class="scene-card-body">
              <strong class="scene-number">Thumbnail ngang</strong>
              <p class="scene-desc"><em style="opacity:.5">Đang tạo thumbnail ngang...</em></p>
            </div>
          </article>`;
      }

      let cardVertical = '';
      const styleVertical = mediaAspectStyle('9:16');
      if (project.outputs?.thumbnailVertical) {
        const srcVer = toPublicAssetPath(project.outputs.thumbnailVertical);
        cardVertical = `
          <article class="scene-card">
            <div class="scene-thumb" style="${styleVertical}">
              <img src="${srcVer}${state.thumbnailVersion}" alt="thumbnail vertical" />
              <span class="scene-status-badge badge-done">✓ Thumbnail dọc</span>
              <a href="${srcVer}${state.thumbnailVersion}" download="thumbnail.vertical.jpg" class="thumb-download-button">↓ Tải thumbnail dọc</a>
            </div>
            <div class="scene-card-body">
              <strong class="scene-number">Thumbnail dọc</strong>
              <textarea id="project-thumbnail-prompt-vertical" class="thumb-prompt" rows="2" placeholder="Prompt thumbnail dọc...">${escapeHtml(project.thumbnailPromptVertical || '')}</textarea>
              <div class="scene-card-actions">
                <button type="button" class="btn-scene-action" data-output-action="thumbnail-vertical">↺ Tạo lại</button>
                <a href="${srcVer}${state.thumbnailVersion}" download="thumbnail.vertical.jpg" class="btn-scene-action btn-scene-download">↓ Tải dọc</a>
              </div>
            </div>
          </article>`;
      } else {
        const isGeneratingVer = isRunning && !project.outputs?.thumbnail;
        cardVertical = `
          <article class="scene-card">
            <div class="scene-thumb" style="${styleVertical}">
              <div class="thumb-empty ${isGeneratingVer ? 'thumb-loading' : ''}"></div>
              <span class="scene-status-badge ${isGeneratingVer ? 'badge-running' : 'badge-pending'}">${isGeneratingVer ? '⟳ Đang tạo...' : 'chờ'}</span>
            </div>
            <div class="scene-card-body">
              <strong class="scene-number">Thumbnail dọc</strong>
              <textarea id="project-thumbnail-prompt-vertical" class="thumb-prompt" rows="2" placeholder="Prompt thumbnail dọc...">${escapeHtml(project.thumbnailPromptVertical || '')}</textarea>
              <div class="scene-card-actions">
                <button type="button" class="btn-scene-action" data-output-action="thumbnail-vertical">↺ Tạo lại</button>
              </div>
            </div>
          </article>`;
      }

      thumbnailCard = cardHorizontal + cardVertical;
    } else {
      let cardSingle = '';
      if (project.outputs?.thumbnail) {
        if (!state.thumbnailVersion) state.thumbnailVersion = `?v=${Date.now()}`;
        const src = toPublicAssetPath(project.outputs.thumbnail);
        cardSingle = `
          <article class="scene-card">
            <div class="scene-thumb" style="${projectMediaStyle}">
              <img src="${src}${state.thumbnailVersion}" alt="thumbnail" />
              <span class="scene-status-badge badge-done">✓ Thumbnail</span>
              <a href="${src}${state.thumbnailVersion}" download="thumbnail.jpg" class="thumb-download-button">↓ Tải thumbnail</a>
            </div>
            <div class="scene-card-body">
              <strong class="scene-number">Thumbnail</strong>
              <textarea id="project-thumbnail-prompt" class="thumb-prompt" rows="2" placeholder="Prompt thumbnail...">${escapeHtml(project.thumbnailPrompt || project.thumbnailKeyword || '')}</textarea>
              <div class="scene-card-actions">
                <button type="button" class="btn-scene-action" data-output-action="thumbnail">↺ Tạo lại</button>
                <a href="${src}${state.thumbnailVersion}" download="thumbnail.jpg" class="btn-scene-action btn-scene-download">↓ Tải ảnh</a>
              </div>
            </div>
          </article>`;
      } else if (isRunning) {
        cardSingle = `
          <article class="scene-card">
            <div class="scene-thumb" style="${projectMediaStyle}">
              <div class="thumb-empty thumb-loading"></div>
              <span class="scene-status-badge badge-running">⟳ Đang tạo...</span>
            </div>
            <div class="scene-card-body">
              <strong class="scene-number">Thumbnail</strong>
              <p class="scene-desc"><em style="opacity:.5">Đang tạo thumbnail...</em></p>
            </div>
          </article>`;
      }
      thumbnailCard = cardSingle;
    }
  }

  elements.sceneList.innerHTML = sceneCards + thumbnailCard;
}


function renderOutputs(project, seo) {
  const items = [];
  const ver = v(project);
  const finalMediaStyle = finalVideoFrameStyle(project.settings?.aspectRatio);

  // YouTube-style panel — video large + SEO info below
  const videoSrc = project.outputs?.videoFinal ? toPublicAssetPath(project.outputs.videoFinal) : null;
  const seoEnabled = project.settings?.generateSeoEnabled === true;
  const visibleSeo = seoEnabled ? seo : null;
  if (videoSrc || visibleSeo) {
    const title   = visibleSeo?.title || getDisplayTitle(project.title);
    const desc    = visibleSeo?.description || '';
    
    const hashtagsText = (visibleSeo?.tags || []).map(t => {
      const clean = removeVietnameseTones(t)
        .split(/\s+/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join('');
      return `#${clean}`;
    }).join(' ');

    const tagsText = (visibleSeo?.tags || []).map(t => t.toLowerCase()).join(', ');

    const socialCaptions = (visibleSeo?.socialCaptions || []).slice(0, 3);
    const socialCaptionHtml = socialCaptions.length
      ? `<section class="social-caption-section">
          <h3>Caption ngắn cho mạng xã hội</h3>
          <div class="social-caption-list">
            ${socialCaptions.map((caption, index) => `
              <article class="social-caption-option">
                <div class="social-caption-heading">
                  <strong>Lựa chọn ${index + 1}</strong>
                  <button type="button" class="btn-secondary" data-copy-social-caption>Sao chép</button>
                </div>
                <pre class="social-caption-text">${escapeHtml(caption)}</pre>
              </article>
            `).join('')}
          </div>
        </section>`
      : '';

    let mainPanelHtml = `
      <div class="yt-panel" style="margin-bottom: 0;">
        ${videoSrc ? `
          <div class="yt-video-wrap" style="${finalMediaStyle}">
            <video controls src="${videoSrc}${ver}"></video>
          </div>` : ''}
        <div class="yt-info">
          <div class="yt-title-row">
            <h2 class="yt-title">${title}</h2>
            <div class="yt-actions">
              ${videoSrc ? `
                <button type="button" class="btn-secondary" data-output-action="finalize">↺ Ghép lại</button>
                <a href="${videoSrc}${ver}" download class="btn-outline-blue">↓ Tải về</a>` : ''}
            </div>
          </div>
          ${desc ? `
            <hr class="yt-divider">
            <div class="social-caption-heading" style="margin-top: 12px; margin-bottom: 8px;">
              <strong>Mô tả chi tiết video</strong>
              <button type="button" class="btn-secondary" data-copy-desc>Sao chép</button>
            </div>
            <pre class="yt-desc">${escapeHtml(desc)}</pre>
          ` : ''}
          ${(visibleSeo?.tags && visibleSeo.tags.length) ? `
            <div class="seo-keywords-container">
              <div class="seo-keyword-row">
                <div class="seo-keyword-info">
                  <div class="seo-keyword-label">Hashtags (Dành cho Mô tả/Bài viết)</div>
                  <div class="seo-keyword-value" id="seo-hashtags-text">${escapeHtml(hashtagsText)}</div>
                </div>
                <button type="button" class="btn-secondary btn-copy-keyword" data-copy-target="seo-hashtags-text">Sao chép</button>
              </div>
              <div class="seo-keyword-row">
                <div class="seo-keyword-info">
                  <div class="seo-keyword-label">Tags (Dành cho ô Từ khóa YouTube)</div>
                  <div class="seo-keyword-value" id="seo-tags-text">${escapeHtml(tagsText)}</div>
                </div>
                <button type="button" class="btn-secondary btn-copy-keyword" data-copy-target="seo-tags-text">Sao chép</button>
              </div>
            </div>
          ` : ''}
          ${socialCaptionHtml}
          ${visibleSeo ? `
            <div>
              <button type="button" class="btn-secondary" data-output-action="seo">↺ Tạo lại SEO</button>
            </div>` : ''}
        </div>
      </div>
    `;

    const isLandscape = project.settings?.aspectRatio === '16:9';
    const hasVideo = Boolean(videoSrc);

    if (isLandscape && hasVideo) {
      const vSettings = project.verticalSettings || {};
      const vTopText = (vSettings.topText ?? '').toUpperCase();
      const vBottomText = (vSettings.bottomText ?? '').toUpperCase();
      const vFontFamily = vSettings.fontFamily ?? state.settings?.subtitleFontFamily ?? 'Arial';
      const vTopFontSize = vSettings.topFontSize ?? vSettings.fontSize ?? 64;
      const vBottomFontSize = vSettings.bottomFontSize ?? vSettings.fontSize ?? 64;
      const vTopPositionY = vSettings.topPositionY ?? 18;
      const vBottomPositionY = vSettings.bottomPositionY ?? 83;
      const vTopColor = vSettings.topColor ?? '#ffffff';
      const vBottomColor = vSettings.bottomColor ?? '#ffeb3b';
      const vBlurPercent = vSettings.blurPercent ?? 50;
      const vTopLineHeight = vSettings.topLineHeight ?? 1.4;
      const vBottomLineHeight = vSettings.bottomLineHeight ?? 1.4;

      const fontOptionsHtml = (state.subtitleFontOptions || [])
        .map(f => `<option value="${escapeHtml(f.value)}" ${f.value === vFontFamily ? 'selected' : ''}>&nbsp;${escapeHtml(f.label || f.value)}</option>`)
        .join('');

      const hasVerticalOutput = project.outputs?.videoVertical;
      const isVerticalRunning = (state.activeJobs || []).includes(`${project.id}:vertical`);

      const verticalPanelHtml = `
        <div class="vertical-convert-panel">
          <h3 class="vertical-convert-heading">
            <span>📱</span> Tạo Phiên Bản Dọc 9:16
          </h3>
          
          ${hasVerticalOutput ? `
            <div class="vertical-video-wrap" id="vertical-video-wrap-ready">
              <video controls src="${toPublicAssetPath(project.outputs.videoVertical)}${ver}"></video>
            </div>
            <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;" id="vertical-ready-actions">
              <a href="${toPublicAssetPath(project.outputs.videoVertical)}${ver}" download class="btn-green" style="text-align: center; text-decoration: none;">↓ Tải video dọc</a>
              <button type="button" id="btn-toggle-vertical-form" class="btn-secondary">⚙ Cấu hình & Tạo lại</button>
            </div>
          ` : ''}

          <!-- Live Preview Wrapper -->
          <div id="vertical-preview-wrapper" class="vertical-preview-wrapper" style="${hasVerticalOutput ? 'display: none;' : ''}">
            <div class="vertical-preview-box">
              <img id="vertical-preview-bg" src="${toPublicAssetPath(project.outputs.thumbnail)}" class="vertical-preview-bg">
              <div class="vertical-preview-pane-top"></div>
              <div class="vertical-preview-pane-bottom"></div>
              <video id="vertical-preview-fg" src="${toPublicAssetPath(project.outputs.videoFinal)}" muted loop autoplay playsinline class="vertical-preview-fg"></video>
              <div id="vertical-preview-text-top" class="vertical-preview-text-top"></div>
              <div id="vertical-preview-text-bottom" class="vertical-preview-text-bottom"></div>
            </div>
          </div>

          <form id="vertical-convert-form" class="vertical-convert-form" style="${hasVerticalOutput ? 'display: none;' : ''}">
            <div class="vertical-field">
              <span>Tiêu đề phía trên (Top Title)</span>
              <textarea id="vertical-top-text" rows="2" placeholder="Ví dụ: NHỮNG QUY TẮC&#10;GIAO DỊCH SỐNG CÒN">${escapeHtml(vTopText)}</textarea>
            </div>
            
            <div class="vertical-field">
              <span>Tiêu đề phía dưới (Bottom Title)</span>
              <textarea id="vertical-bottom-text" rows="2" placeholder="Ví dụ: NHẬN DIỆN BẪY&#10;THỊ TRƯỜNG">${escapeHtml(vBottomText)}</textarea>
            </div>

            <div class="vertical-field">
              <span>Font chữ</span>
              <select id="vertical-font-family" class="dark-select-sm" style="background: #fdfdfc; color: var(--text);">
                ${fontOptionsHtml}
              </select>
            </div>

            <div class="vertical-field">
              <span>Cỡ chữ tiêu đề trên: <span id="vertical-top-font-size-label">${vTopFontSize}px</span></span>
              <input type="range" id="vertical-top-font-size" min="30" max="120" value="${vTopFontSize}" style="accent-color: var(--blue);">
            </div>

            <div class="vertical-field">
              <span>Vị trí Y tiêu đề trên: <span id="vertical-top-position-y-label">${vTopPositionY}%</span></span>
              <input type="range" id="vertical-top-position-y" min="0" max="34" value="${vTopPositionY}" style="accent-color: var(--blue);">
            </div>

            <div class="vertical-field">
              <span>Khoảng cách dòng trên: <span id="vertical-top-line-height-label">${vTopLineHeight}</span></span>
              <input type="range" id="vertical-top-line-height" min="1.0" max="2.0" step="0.05" value="${vTopLineHeight}" style="accent-color: var(--blue);">
            </div>

            <div class="vertical-field">
              <span>Cỡ chữ tiêu đề dưới: <span id="vertical-bottom-font-size-label">${vBottomFontSize}px</span></span>
              <input type="range" id="vertical-bottom-font-size" min="30" max="120" value="${vBottomFontSize}" style="accent-color: var(--blue);">
            </div>

            <div class="vertical-field">
              <span>Vị trí Y tiêu đề dưới: <span id="vertical-bottom-position-y-label">${vBottomPositionY}%</span></span>
              <input type="range" id="vertical-bottom-position-y" min="66" max="100" value="${vBottomPositionY}" style="accent-color: var(--blue);">
            </div>

            <div class="vertical-field">
              <span>Khoảng cách dòng dưới: <span id="vertical-bottom-line-height-label">${vBottomLineHeight}</span></span>
              <input type="range" id="vertical-bottom-line-height" min="1.0" max="2.0" step="0.05" value="${vBottomLineHeight}" style="accent-color: var(--blue);">
            </div>

            <div class="vertical-field">
              <span>Độ mờ ảnh nền: <span id="vertical-blur-percent-label">${vBlurPercent}%</span></span>
              <input type="range" id="vertical-blur-percent" min="0" max="100" value="${vBlurPercent}" style="accent-color: var(--blue);">
            </div>

            <div class="vertical-color-row">
              <div class="vertical-field">
                <span>Màu chữ trên</span>
                <div class="vertical-color-picker">
                  <input type="color" id="vertical-top-color" value="${vTopColor}">
                  <span style="font-size: 11px;">${vTopColor}</span>
                </div>
              </div>
              <div class="vertical-field">
                <span>Màu chữ dưới</span>
                <div class="vertical-color-picker">
                  <input type="color" id="vertical-bottom-color" value="${vBottomColor}">
                  <span style="font-size: 11px;">${vBottomColor}</span>
                </div>
              </div>
            </div>

            ${isVerticalRunning
              ? `<button type="button" id="btn-submit-vertical" class="btn-green" disabled>⟳ Đang chuyển đổi...</button>`
              : `<button type="button" id="btn-submit-vertical" class="btn-green">Tạo video dọc 9:16</button>`}
          </form>
        </div>
      `;
      elements.finalOutput.innerHTML = `<div class="yt-panel-split">${mainPanelHtml}${verticalPanelHtml}</div>`;
    } else {
      elements.finalOutput.innerHTML = mainPanelHtml;
    }
  } else {
    elements.finalOutput.innerHTML = '';
  }
}



document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy-social-caption]');
  if (!button) return;
  const caption = button.closest('.social-caption-option')?.querySelector('.social-caption-text')?.textContent || '';
  if (!caption) return;
  const originalText = button.textContent;
  try {
    await navigator.clipboard.writeText(caption);
    button.textContent = 'Đã sao chép';
    setTimeout(() => { button.textContent = originalText; }, 1200);
  } catch {
    setStatus('Không thể sao chép caption.', 'error');
  }
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy-desc]');
  if (!button) return;
  const descText = button.closest('.yt-info')?.querySelector('.yt-desc')?.textContent || '';
  if (!descText) return;
  const originalText = button.textContent;
  try {
    await navigator.clipboard.writeText(descText);
    button.textContent = 'Đã sao chép';
    setTimeout(() => { button.textContent = originalText; }, 1200);
  } catch {
    setStatus('Không thể sao chép mô tả.', 'error');
  }
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('.btn-copy-keyword');
  if (!button) return;
  const targetId = button.getAttribute('data-copy-target');
  const targetEl = document.getElementById(targetId);
  const text = targetEl?.textContent || '';
  if (!text) return;
  const originalText = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Đã sao chép';
    setTimeout(() => { 
      button.textContent = originalText; 
    }, 1200);
  } catch {
    setStatus('Không thể sao chép từ khóa.', 'error');
  }
});

// Event delegation for output action buttons (thumbnail in scene-list, video/seo in final-output)
document.addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-output-action]');
  if (!btn || !state.currentProjectId) return;

  const action = btn.dataset.outputAction;
  const originalText = btn.textContent;
  const actionLabel  = ACTION_LABELS[action] || action;
  btn.disabled = true;
  btn.textContent = '⟳ Đang xử lý...';
  setStatus(`Đang ${actionLabel}...`);

  try {
    if (action === 'thumbnail') {
      const prompt = document.getElementById('project-thumbnail-prompt')?.value || '';
      await request(`/api/projects/${state.currentProjectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thumbnailPrompt: prompt })
      });
      state.thumbnailVersion = null; // force reload thumbnail mới
    } else if (action === 'thumbnail-vertical') {
      const prompt = document.getElementById('project-thumbnail-prompt-vertical')?.value || '';
      await request(`/api/projects/${state.currentProjectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thumbnailPromptVertical: prompt })
      });
      state.thumbnailVersion = null; // force reload thumbnail mới
    }
    const options = action === 'finalize'
      ? { method: 'POST', body: buildRenderFormDataFromSidebar() }
      : { method: 'POST' };
    await request(`/api/projects/${state.currentProjectId}/actions/${action}`, options);
    startPolling(state.currentProjectId);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = originalText;
    setStatus(`Lỗi: ${err.message}`, 'error');
  }
});

function updateEstimate() {
  const durationValue = document.getElementById('videoDurationSec').value;
  const sceneValue = document.getElementById('sceneDurationSec').value;
  const el = document.getElementById('estimate-text');
  if (!el) return;
  if (durationValue === 'free') {
    el.textContent = 'AI tự quyết định tổng thời lượng, số cảnh và nhịp kể dựa trên nội dung nhập vào.';
    updateConfigSummary();
    return;
  }
  const dur = parseInt(durationValue) || 60;
  if (sceneValue === 'auto') {
    el.textContent = `AI tự chia nhịp cảnh linh hoạt theo nội dung, tổng khoảng ${dur} giây.`;
    updateConfigSummary();
    return;
  }
  const scene = parseInt(sceneValue) || 10;
  const count = Math.max(1, Math.floor(dur / scene));
  el.textContent = `Ước tính ${count} cảnh, khoảng ${scene} s/cảnh.`;
  updateConfigSummary();
}

function initLicenseActivation(license) {
  const modal = document.getElementById('license-modal');
  const machineInput = document.getElementById('license-machine-id');
  const copyBtn = document.getElementById('license-copy-machine-id');
  const copyStatus = document.getElementById('license-copy-status');
  const fileInput = document.getElementById('license-file-input');
  const uploadBtn = document.getElementById('license-upload-btn');
  const fileNameText = document.getElementById('license-file-name');
  const errorDiv = document.getElementById('license-error');
  const successDiv = document.getElementById('license-success');

  if (!modal || !machineInput) return;

  machineInput.value = license.machineId;
  modal.style.display = 'flex';

  if (license.reason && license.reason !== 'Chưa kích hoạt bản quyền.') {
    errorDiv.textContent = license.reason;
    errorDiv.style.display = 'block';
  }

  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(license.machineId);
    copyStatus.style.display = 'block';
    setTimeout(() => { copyStatus.style.display = 'none'; }, 2000);
  });

  uploadBtn.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    fileNameText.textContent = file.name;
    errorDiv.style.display = 'none';

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const content = e.target.result;
        const res = await request('/api/license/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ licenseContent: content })
        });
        if (res.ok) {
          successDiv.style.display = 'block';
          errorDiv.style.display = 'none';
          setTimeout(() => {
            window.location.reload();
          }, 1500);
        } else {
          errorDiv.textContent = res.error || 'Kích hoạt bản quyền thất bại.';
          errorDiv.style.display = 'block';
        }
      } catch (err) {
        errorDiv.textContent = err.message || 'Lỗi khi đọc hoặc gửi file bản quyền.';
        errorDiv.style.display = 'block';
      }
    };
    reader.readAsText(file);
  });
}

async function loadBootstrap() {
  const license = await request('/api/license/status').catch(() => ({ valid: false, machineId: 'ERROR', reason: 'Không kết nối được server.' }));
  if (!license.valid) {
    initLicenseActivation(license);
    return;
  }

  const data = await request('/api/bootstrap');
  state.history = data.history;
  state.groups = data.groups || [];
  state.collapsedGroups = {};
  state.styles = data.styles;
  state.motionOptions = data.motionOptions || [];
  state.transitionOptions = data.transitionOptions || [];
  state.aspectRatioOptions = data.aspectRatioOptions || [];
  state.videoLanguageOptions = data.videoLanguageOptions || [];
  state.imageTextDensityOptions = data.imageTextDensityOptions || [];
  state.aiProviderOptions = data.aiProviderOptions || [];
  state.imageSourceOptions = data.imageSourceOptions || [];
  state.flowImageModelOptions = data.flowImageModelOptions || [];
  state.flowVideoModelOptions = data.flowVideoModelOptions || [];
  state.flowVideoDurationOptions = data.flowVideoDurationOptions || [];
  state.omnivoiceDefaultVoiceOptions = data.omnivoiceDefaultVoiceOptions || [];
  state.imageGenerationProviderOptions = data.imageGenerationProviderOptions || [];
  state.htmlGenerationProviderOptions = data.htmlGenerationProviderOptions || [];
  state.ttsProviderOptions = data.ttsProviderOptions || [];
  state.subtitleFontOptions = data.subtitleFontOptions || [];
  state.subtitleEffectOptions = data.subtitleEffectOptions || [];
  state.voiceSamples = data.voiceSamples || [];
  renderStyleOptions(data.styles);
  renderMotionOptions(state.motionOptions);
  renderTransitionOptions(state.transitionOptions);
  renderAspectRatioOptions(state.aspectRatioOptions);
  renderVideoLanguageOptions(state.videoLanguageOptions);
  renderImageTextDensityOptions(state.imageTextDensityOptions);
  renderSimpleOptions('apiProvider', state.aiProviderOptions);
  renderSimpleOptions('imageGenerationProvider', state.imageGenerationProviderOptions);
  renderSimpleOptions('thumbnailImageProvider', state.imageGenerationProviderOptions);
  renderFlowImageModelOptions(state.flowImageModelOptions);
  renderFlowVideoModelOptions(state.flowVideoModelOptions);
  renderSimpleOptions('flowVideoDurationSec', state.flowVideoDurationOptions);
  renderImageSourceOptions();
  renderSimpleOptions('ttsProvider', state.ttsProviderOptions);
  renderSimpleOptions('ttsProviderQuick', state.ttsProviderOptions);
  renderSubtitleFontOptions(state.subtitleFontOptions);
  renderSubtitleEffectOptions(state.subtitleEffectOptions);
  fillSettings(data.settings);
  updateGroupSelect();
  renderHistory();

  // Khôi phục nhạc nền và ảnh tham chiếu từ IndexedDB
  try {
    const cachedImage = await PersistedFilesDB.get('referenceImage');
    if (cachedImage) {
      state.selectedReferenceImageFile = cachedImage;
      const display = document.getElementById('reference-image-display');
      if (display) display.textContent = cachedImage.name;
    }
    const cachedMusic = await PersistedFilesDB.get('backgroundMusic');
    if (Array.isArray(cachedMusic) && cachedMusic.length) {
      state.selectedBackgroundMusicFiles = cachedMusic;
      const display = document.getElementById('music-display');
      if (display) {
        display.textContent = cachedMusic.length === 1
          ? cachedMusic[0].name
          : `${cachedMusic.length} file nhạc (${cachedMusic.map(f => f.name).join(', ')})`;
      }
      const clearBtn = document.getElementById('btn-clear-music');
      if (clearBtn) clearBtn.style.display = 'inline-flex';
    }
  } catch (err) {
    console.error('Failed to restore cached files from IndexedDB:', err);
  }

  const savedProjectId = sessionStorage.getItem(CURRENT_PROJECT_STORAGE_KEY);
  if (savedProjectId && state.history.some((item) => item.id === savedProjectId)) {
    try {
      await loadProject(savedProjectId);
    } catch {
      sessionStorage.removeItem(CURRENT_PROJECT_STORAGE_KEY);
    }
  }
}

async function saveCustomStyleFromForm() {
  const selected = getSelectedImageStyle();
  const nameInput = document.getElementById('customStyleName');
  const promptInput = document.getElementById('customStylePrompt');
  const label = nameInput.value.trim();
  const prompt = promptInput.value.trim();
  if (!label || !prompt) {
    setStatus('Vui lòng nhập tên và mô tả phong cách.', 'error');
    return;
  }
  const payload = { label, prompt };
  if (selected) {
    payload.value = selected.value;
  }
  const data = await request('/api/styles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  state.styles = data.styles || [];
  renderStyleOptions(state.styles);
  document.getElementById('imageStyle').value = data.style.value;
  document.getElementById('styleManagerSelect').value = data.style.value;
  updateCustomStyleEditor();
  await autoSaveSettings();
  setStatus(`Đã lưu phong cách ảnh: ${escapeHtml(data.style.label)}`, 'done');
}

async function deleteSelectedCustomStyle() {
  const selected = getSelectedImageStyle();
  if (!selected) return;
  const data = await request(`/api/styles/${encodeURIComponent(selected.value)}`, { method: 'DELETE' });
  state.styles = data.styles || [];
  renderStyleOptions(state.styles);
  const nextStyle = data.settings?.imageStyle || state.styles[0]?.value || 'cinematic';
  document.getElementById('imageStyle').value = nextStyle;
  document.getElementById('styleManagerSelect').value = '__new__';
  updateCustomStyleEditor();
  fillSettings(data.settings || state.settings || {});
  setStatus(`Đã xoá phong cách ảnh: ${escapeHtml(selected.label)}`, 'done');
}

async function loadProject(projectId) {
  state.sceneVersions = {};
  state.thumbnailVersion = null;
  const data = await request(`/api/projects/${projectId}`);
  state.currentProjectId = projectId;
  state.currentProject = data.project;
  state.currentLogs = data.logs || [];
  state.running = data.running || false;
  state.activeJobs = data.activeJobs || [];

  // Cập nhật các scene đang chạy từ activeJobs
  updateProcessingScenesFromActiveJobs(data.activeJobs);

  sessionStorage.setItem(CURRENT_PROJECT_STORAGE_KEY, projectId);
  syncSidebarFromProject(data.project);
  renderHistory();
  renderSummary(data.project, data.running);
  renderScenes(data.project);
  renderOutputs(data.project, data.seo);
  if (data.running) startPolling(projectId);

  const assignWrap = document.getElementById('project-folder-assign-wrap');
  const assignSelect = document.getElementById('project-folder-assign');
  if (assignWrap && assignSelect) {
    assignSelect.value = data.project.groupId || '';
    assignWrap.style.display = 'flex';
  }
}

async function triggerProjectAction(action) {
  if (!state.currentProjectId) return;
  const options = action === 'render-all' || action === 'finalize'
    ? { method: 'POST', body: buildRenderFormDataFromSidebar() }
    : { method: 'POST' };
  await request(`/api/projects/${state.currentProjectId}/actions/${action}`, options);
  startPolling(state.currentProjectId);
}

// ── Settings: auto-save ───────────────────────────────────

function updateMusicVolumeLabel(value) {
  const label = document.getElementById('music-volume-label');
  if (label) label.textContent = `${Math.round(Number(value) * 100)}%`;
}

function updateHtmlSfxVolumeLabel(value) {
  const label = document.getElementById('html-sfx-volume-label');
  if (label) label.textContent = `${Math.round(Number(value ?? 0.45) * 100)}%`;
}

function updateSubtitleSizeLabel(value) {
  const label = document.getElementById('subtitle-size-label');
  if (label) label.textContent = `${Math.round(Number(value || 1) * 100)}%`;
}

function updateSubtitleYLabel(value) {
  const label = document.getElementById('subtitle-y-label');
  if (label) label.textContent = `${Math.round(Number(value || 86))}%`;
}

function updateSubtitleOpacityLabel(value) {
  const label = document.getElementById('subtitle-opacity-label');
  if (label) label.textContent = `${Math.round(Number(value ?? 1) * 100)}%`;
}

function updateLogoSizeLabel(value) {
  const label = document.getElementById('logo-size-label');
  if (label) label.textContent = `${Math.round(Number(value || 120))}px`;
}

function updateLogoOpacityLabel(value) {
  const label = document.getElementById('logo-opacity-label');
  if (label) label.textContent = `${Math.round(Number(value ?? 1) * 100)}%`;
}

function ensureSubtitlePreviewFrames() {
  const stage = document.getElementById('subtitle-preview-stage');
  if (!stage) return [];
  const allRatios = state.aspectRatioOptions.length
    ? state.aspectRatioOptions
    : [
        { value: '16:9', label: '16:9', width: 1920, height: 1080 },
        { value: '9:16', label: '9:16', width: 1080, height: 1920 },
        { value: '1:1', label: '1:1', width: 1080, height: 1080 },
        { value: '4:3', label: '4:3', width: 1440, height: 1080 }
      ];
  const mode = document.getElementById('subtitlePreviewMode')?.value || 'all';
  const selectedRatio = document.getElementById('aspectRatio')?.value || state.settings?.aspectRatio || '16:9';
  const selected = allRatios.find((ratio) => ratio.value === selectedRatio) || allRatios[0];
  const ratios = mode === 'current' && selected ? [selected] : allRatios;
  const signature = `${mode}:${ratios.map((ratio) => ratio.value).join('|')}`;
  if (stage.dataset.signature !== signature) {
    stage.dataset.signature = signature;
    stage.innerHTML = ratios.map((ratio) => `
      <div class="subtitle-preview-item">
        <div class="subtitle-preview-ratio-label">${escapeHtml(ratio.label || ratio.value)}</div>
        <div class="subtitle-preview-frame" data-preview-ratio="${escapeHtml(ratio.value)}">
          <div class="subtitle-preview-backdrop">
            <div class="subtitle-preview-horizon"></div>
            <div class="subtitle-preview-subject"></div>
          </div>
          <div class="subtitle-preview-safe-area"></div>
          <img class="logo-preview-mark" src="/demo-logo.png" alt="" />
          <div class="subtitle-preview-y-line"></div>
          <div class="subtitle-preview-text"><span class="subtitle-preview-highlight">Đây là dòng</span> phụ đề tiếng Việt mẫu</div>
          <div class="watermark-preview-mark"></div>
        </div>
      </div>
    `).join('');
  }
  return ratios;
}

function getSubtitlePreviewLines(language, maxWordsPerLine) {
  const previewText = String(language?.previewText || 'Đây là dòng phụ đề mẫu').trim();
  const words = previewText.split(/\s+/).filter(Boolean);
  if (!words.length) {
    return [];
  }
  const wordsPerLine = Math.min(10, Math.max(1, Math.round(Number(maxWordsPerLine) || 5)));
  return [words.slice(0, wordsPerLine)];
}

function applySubtitleTextCase(word, textCase) {
  const value = String(word || '');
  if (textCase === 'lower') return value.toLocaleLowerCase();
  if (textCase === 'upper') return value.toLocaleUpperCase();
  if (textCase === 'title') {
    return value.replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase());
  }
  return value;
}

function renderSubtitlePreviewText(lines, activeWordIndex) {
  let wordIndex = 0;
  return lines.map((line) => {
    const words = line.map((word) => {
      const className = wordIndex === activeWordIndex
        ? 'subtitle-preview-word subtitle-preview-highlight'
        : 'subtitle-preview-word';
      wordIndex += 1;
      return `<span class="${className}">${escapeHtml(word)}</span>`;
    }).join(' ');
    return `<span class="subtitle-preview-line">${words}</span>`;
  }).join('');
}

function updateSubtitlePreview() {
  const ratios = ensureSubtitlePreviewFrames();
  const stage = document.getElementById('subtitle-preview-stage');
  if (!stage) return;
  const videoLanguage = document.getElementById('videoLanguage')?.value || state.settings?.videoLanguage || 'vi';
  const language = state.videoLanguageOptions.find((option) => option.value === videoLanguage);
  const fontFamily = document.getElementById('subtitleFontFamily')?.value || 'Be Vietnam Pro';
  const effect = document.getElementById('subtitleEffect')?.value || 'karaoke-fill';
  const textCase = document.getElementById('subtitleTextCase')?.value || 'original';
  const color = document.getElementById('subtitleColor')?.value || '#ffffff';
  const highlightColor = document.getElementById('subtitleHighlightColor')?.value || '#ffd84d';
  const maxWordsPerLine = Math.min(10, Math.max(1, Math.round(Number(document.getElementById('subtitleMaxWordsPerLine')?.value || 5))));
  const positionY = Math.min(94, Math.max(6, Number(document.getElementById('subtitlePositionY')?.value || 86)));
  const scale = Number(document.getElementById('subtitleFontScale')?.value || 1);
  const subtitleOpacity = Math.min(1, Math.max(0.1, Number(document.getElementById('subtitleOpacity')?.value ?? 1)));
  const logoSize = Math.min(360, Math.max(40, Number(document.getElementById('logoSize')?.value || 120)));
  const logoPosition = document.getElementById('logoPosition')?.value || 'top-right';
  const logoOpacity = Math.min(1, Math.max(0.1, Number(document.getElementById('logoOpacity')?.value ?? 1)));
  const renderFontSizeByRatio = {
    '16:9': 58,
    '9:16': 72,
    '1:1': 62,
    '4:3': 58
  };
  const activeWordEffects = new Set(['active-fill', 'active-zoom-fill', 'active-outline', 'sweep-glow', 'active-pop-fill', 'glow-pulse', 'karaoke-fill', 'tiktok-pill', 'tiktok-pop-pill', 'neon-active', 'bounce-outline']);
  const previewLines = getSubtitlePreviewLines(language, maxWordsPerLine)
    .map((line) => line.map((word) => applySubtitleTextCase(word, textCase)));
  const activeWordIndex = previewLines[0]?.length ? Math.min(1, previewLines[0].length - 1) : 0;
  const clampedScale = Math.max(0.7, Math.min(2.4, scale));
  updateSubtitleYLabel(positionY);
  updateSubtitleOpacityLabel(subtitleOpacity);

  ratios.forEach((ratio) => {
    const frame = stage.querySelector(`[data-preview-ratio="${CSS.escape(ratio.value)}"]`);
    if (!frame) return;
    const text = frame.querySelector('.subtitle-preview-text');
    const line = frame.querySelector('.subtitle-preview-y-line');
    const logo = frame.querySelector('.logo-preview-mark');
    const width = Number(ratio.width || 1920);
    const height = Number(ratio.height || 1080);
    const aspect = width / height;
    frame.style.aspectRatio = `${width} / ${height}`;
    frame.style.width = `${Math.min(100, Math.max(42, aspect * 72))}%`;
    if (text) {
      text.innerHTML = renderSubtitlePreviewText(previewLines, activeWordEffects.has(effect) ? activeWordIndex : -1);
      text.style.direction = language?.direction || 'ltr';
      const highlight = text.querySelector('.subtitle-preview-highlight');
      const frameHeight = frame.getBoundingClientRect().height || 220;
      const renderFontSize = renderFontSizeByRatio[ratio.value] || renderFontSizeByRatio['16:9'];
      text.style.fontFamily = `"${fontFamily}", "Noto Sans", system-ui, sans-serif`;
      text.style.color = color;
      text.style.opacity = String(subtitleOpacity);
      text.style.top = `${positionY}%`;
      text.style.fontSize = `${Math.max(6, Math.round(frameHeight * renderFontSize / height * clampedScale))}px`;
      text.className = `subtitle-preview-text subtitle-effect-${effect}`;
      text.style.background = '';
      text.style.borderRadius = '';
      text.style.padding = '';
      text.style.textShadow = '';
      text.querySelectorAll('.subtitle-preview-word').forEach((word) => {
        word.style.color = color;
        word.style.webkitTextStroke = '';
        word.style.transform = '';
        word.style.background = '';
        word.style.borderRadius = '';
        word.style.padding = '';
        word.style.boxShadow = '';
      });
      if (effect === 'plain-text') {
        text.style.textShadow = '0 2px 0 #000, 0 -2px 0 #000, 2px 0 0 #000, -2px 0 0 #000, 0 4px 12px rgba(0,0,0,.9)';
        if (highlight) {
          highlight.style.color = color;
          highlight.style.webkitTextStroke = '';
          highlight.style.transform = '';
        }
      } else if (effect === 'active-zoom-fill') {
        text.style.textShadow = '0 2px 0 #000, 0 -2px 0 #000, 2px 0 0 #000, -2px 0 0 #000, 0 4px 12px rgba(0,0,0,.9)';
        if (highlight) {
          highlight.style.color = highlightColor;
          highlight.style.webkitTextStroke = '';
          highlight.style.transform = 'scale(1.16)';
        }
      } else if (effect === 'tiktok-pill' || effect === 'tiktok-pop-pill') {
        text.style.textShadow = '0 2px 0 #000, 0 -2px 0 #000, 2px 0 0 #000, -2px 0 0 #000, 0 4px 12px rgba(0,0,0,.9)';
        if (highlight) {
          highlight.style.color = color;
          highlight.style.webkitTextStroke = '';
          highlight.style.background = highlightColor;
          highlight.style.borderRadius = '0.28em';
          highlight.style.padding = '0.04em 0.22em 0.12em';
          highlight.style.boxShadow = `0 0 0 0.08em ${highlightColor}`;
          highlight.style.transform = effect === 'tiktok-pop-pill' ? 'scale(1.12)' : '';
        }
      } else if (effect === 'neon-active') {
        text.style.textShadow = '0 2px 0 #000, 0 -2px 0 #000, 2px 0 0 #000, -2px 0 0 #000, 0 4px 12px rgba(0,0,0,.9)';
        if (highlight) {
          highlight.style.color = highlightColor;
          highlight.style.webkitTextStroke = '';
          highlight.style.boxShadow = `0 0 0.35em ${highlightColor}, 0 0 0.9em ${highlightColor}`;
          highlight.style.transform = '';
        }
      } else if (effect === 'bounce-outline') {
        text.style.textShadow = '0 2px 0 #000, 0 -2px 0 #000, 2px 0 0 #000, -2px 0 0 #000, 0 4px 12px rgba(0,0,0,.9)';
        if (highlight) {
          highlight.style.color = color;
          highlight.style.webkitTextStroke = `1px ${highlightColor}`;
          highlight.style.transform = 'scale(1.2)';
        }
      } else if (effect === 'active-outline') {
        text.style.textShadow = `0 2px 0 #000, 0 -2px 0 #000, 2px 0 0 #000, -2px 0 0 #000, 0 0 10px ${highlightColor}`;
        if (highlight) {
          highlight.style.color = color;
          highlight.style.webkitTextStroke = `1px ${highlightColor}`;
          highlight.style.transform = '';
        }
      } else if (effect === 'sweep-glow') {
        text.style.textShadow = `0 2px 0 #000, 0 -2px 0 #000, 2px 0 0 #000, -2px 0 0 #000, 0 0 14px ${highlightColor}`;
        if (highlight) {
          highlight.style.color = highlightColor;
          highlight.style.webkitTextStroke = '';
          highlight.style.transform = '';
        }
      } else if (effect === 'active-pop-fill') {
        text.style.textShadow = '0 2px 0 #000, 0 -2px 0 #000, 2px 0 0 #000, -2px 0 0 #000, 0 4px 14px rgba(0,0,0,.9)';
        if (highlight) {
          highlight.style.color = highlightColor;
          highlight.style.webkitTextStroke = '';
          highlight.style.transform = 'scale(1.26)';
        }
      } else if (effect === 'glow-pulse') {
        text.style.textShadow = `0 2px 0 #000, 0 -2px 0 #000, 2px 0 0 #000, -2px 0 0 #000, 0 0 18px ${highlightColor}`;
        if (highlight) {
          highlight.style.color = highlightColor;
          highlight.style.webkitTextStroke = `1px ${highlightColor}`;
          highlight.style.transform = 'scale(1.12)';
        }
      } else if (effect === 'highlight-box') {
        text.style.background = `${highlightColor}55`;
        text.style.borderRadius = '6px';
        text.style.padding = '0.12em 0.35em 0.18em';
        text.style.textShadow = '0 2px 0 #000, 0 -2px 0 #000, 2px 0 0 #000, -2px 0 0 #000';
        if (highlight) {
          highlight.style.color = color;
          highlight.style.webkitTextStroke = '';
          highlight.style.transform = '';
        }
      } else if (effect === 'typewriter') {
        text.style.textShadow = '0 2px 0 #000, 0 -2px 0 #000, 2px 0 0 #000, -2px 0 0 #000, 0 4px 12px rgba(0,0,0,.9)';
        if (highlight) {
          highlight.style.color = color;
          highlight.style.webkitTextStroke = '';
          highlight.style.transform = '';
        }
      } else {
        text.style.textShadow = '0 2px 0 #000, 0 -2px 0 #000, 2px 0 0 #000, -2px 0 0 #000, 0 4px 12px rgba(0,0,0,.9)';
        if (highlight) {
          highlight.style.color = highlightColor;
          highlight.style.webkitTextStroke = '';
          highlight.style.transform = '';
        }
      }
    }
    if (line) line.style.top = `${positionY}%`;
    if (logo) {
      const frameWidth = frame.getBoundingClientRect().width || 320;
      const frameHeight = frame.getBoundingClientRect().height || 180;
      const previewLogoWidth = Math.max(12, Math.round(frameWidth * logoSize / width));
      const paddingX = Math.max(2, Math.round(frameWidth * 18 / width));
      const paddingY = Math.max(2, Math.round(frameHeight * 18 / height));
      logo.style.width = `${previewLogoWidth}px`;
      logo.style.opacity = String(logoOpacity);
      logo.style.left = logoPosition.endsWith('left') ? `${paddingX}px` : 'auto';
      logo.style.right = logoPosition.endsWith('right') ? `${paddingX}px` : 'auto';
      logo.style.top = logoPosition.startsWith('top') ? `${paddingY}px` : 'auto';
      logo.style.bottom = logoPosition.startsWith('bottom') ? `${paddingY}px` : 'auto';
    }
  });
}

async function autoSaveSettings() {
  const apiProvider = document.getElementById('apiProvider')?.value || 'chat01';
  const imageGenerationProvider = selectedImageGenerationProvider();
  const ttsProvider = document.getElementById('ttsProvider')?.value || document.getElementById('ttsProviderQuick')?.value || 'larvoice';
  const imageSearchProvider = document.getElementById('apiImageSearchProvider')?.value || 'serper';
  const imageSourceValue = selectedImageSourceValue();
  let imageSearchKeys = getImageSearchKeysForCurrentProvider();
  let crawlKeys = getCrawlKeys();
  if (keyFieldIsDirty('imageSearchKeysText')) {
    imageSearchKeys = document.getElementById('imageSearchKeysText')?.value || '';
  }
  if (keyFieldIsDirty('crawlKeysText')) {
    crawlKeys = document.getElementById('crawlKeysText')?.value || '';
  }
  if (keyFieldIsDirty('imageGenerationKeysText')) {
    const imageGenerationKeys = document.getElementById('imageGenerationKeysText')?.value || '';
    state.imageProviderKeys[imageGenerationProvider] = imageGenerationKeys;
  }
  const llmField = llmKeyField(apiProvider);
  const ttsField = ttsKeyField(ttsProvider);
  if (llmField && keyFieldIsDirty('llmKeysText')) {
    state.providerKeys[apiProvider] = document.getElementById('llmKeysText')?.value || '';
    if (apiProvider === 'chat01') state.chato1KeysText = state.providerKeys.chat01 || '';
  }
  if (ttsField && keyFieldIsDirty('ttsKeysText')) state.providerKeys[ttsProvider] = document.getElementById('ttsKeysText')?.value || '';
  const providerKeyPayload = {};
  Object.entries({
    chat01: 'chato1KeysText',
    openai: 'openaiKeysText',
    claude: 'claudeKeysText',
    gemini: 'geminiKeysText',
    deepseek: 'deepseekKeysText',
    nineRouter: 'nineRouterKeysText',
    custom: 'customApiKeysText',
    larvoice: 'larvoiceKeysText',
    omnivoice: '',
    vivibe: 'vivibeKeysText',
    elevenlabs: 'elevenlabsKeysText',
    vbee: 'vbeeKeysText'
  }).forEach(([provider, field]) => {
    if (!field) return;
    providerKeyPayload[field] = state.providerKeys[provider] || '';
  });
  const data = await request('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiProvider,
      aiModel: document.getElementById('aiModel')?.value || '',
      customApiStandard: document.getElementById('customApiStandard')?.value || 'openai',
      customApiBaseUrl: document.getElementById('customApiBaseUrl')?.value || '',
      nineRouterBaseUrl: document.getElementById('nineRouterBaseUrl')?.value || 'http://localhost:20128/v1',
      claudeMaxTokens: Number(document.getElementById('claudeMaxTokens')?.value || 16384),
      htmlConcurrency: Number(document.getElementById('htmlConcurrency')?.value || 2),
      imageGenerationProvider,
      thumbnailImageProvider: document.getElementById('thumbnailImageProvider')?.value || 'chat01',
      imageModel: document.getElementById('imageModel')?.value || '',
      flowApiBaseUrl: document.getElementById('flowApiBaseUrl')?.value || 'http://localhost:8100',
      flowImageModel: document.getElementById('flowImageModel')?.value || 'nano_banana_pro',
      flowVideoModel: document.getElementById('flowVideoModel')?.value || '',
      flowVideoDurationSec: Number(document.getElementById('flowVideoDurationSec')?.value || 8),
      flowGenerationTimeoutMs: Number(document.getElementById('flowGenerationTimeoutSec')?.value || 900) * 1000,
      flowPollIntervalMs: Number(document.getElementById('flowPollIntervalSec')?.value || 5) * 1000,
      imageChat01KeysText: state.imageProviderKeys.chat01 || '',
      imageOpenaiKeysText: state.imageProviderKeys.openai || '',
      imageGeminiKeysText: state.imageProviderKeys.gemini || '',
      ...providerKeyPayload,
      imageSource: imageSourceValue.startsWith('ai:') ? 'ai' : imageSourceValue,
      serperKeysText: imageSearchProvider === 'serper' ? imageSearchKeys : crawlKeys,
      pexelsKeysText: imageSearchProvider === 'pexels' || imageSourceValue === 'pexels-video' ? imageSearchKeys : (state.settings?.pexelsKeysText || ''),
      pexelsExcludedVideoUrlsText: document.getElementById('pexelsExcludedVideoUrlsText')?.value || '',
      ttsProvider,
      ttsVoiceId: document.getElementById('ttsVoiceId')?.value || document.getElementById('ttsVoiceIdQuick')?.value || '',
      vbeeAppId: document.getElementById('vbeeAppId')?.value || '',
      elevenlabsModelId: document.getElementById('elevenlabsModelId')?.value || '',
      elevenlabsLanguageCode: document.getElementById('elevenlabsLanguageCode')?.value || '',
      elevenlabsStability: 0.5,
      elevenlabsSimilarityBoost: 0.75,
      elevenlabsUseSpeakerBoost: true,
      vbeeCallbackUrl: 'https://example.com/vbee-callback',
      vbeeAudioType: 'mp3',
      vbeeBitrate: 128,
      omnivoiceApiBaseUrl: document.getElementById('omnivoiceApiBaseUrl')?.value || 'http://127.0.0.1:8101',
      omnivoiceVoiceId: document.getElementById('omnivoiceVoiceIdQuick')?.value || '',
      omnivoiceInstruct: document.getElementById('omnivoiceInstruct')?.value || '',
      omnivoiceNumStep: Number(document.getElementById('omnivoiceNumStep')?.value || 32),
      larvoiceKeysText: state.providerKeys.larvoice || '',
      larvoiceVoiceId: document.getElementById('larvoiceVoiceId').value,
      videoLanguage: document.getElementById('videoLanguage').value,
      referenceImageUrl: document.getElementById('referenceImageUrl').value,
      aspectRatio: document.getElementById('aspectRatio').value,
      imageStyle: document.getElementById('imageStyle').value,
      imageTextDensity: document.getElementById('imageTextDensity').value,
      motionPreset: document.getElementById('motionPreset').value,
      transitionPreset: document.getElementById('transitionPreset')?.value || 'fade',
      generateThumbnailEnabled: document.getElementById('generateThumbnailEnabled').checked,
      generateSeoEnabled: document.getElementById('generateSeoEnabled').checked,
      subtitleEnabled: document.getElementById('subtitleEnabled').checked,
      subtitleFontFamily: document.getElementById('subtitleFontFamily').value,
      subtitleEffect: document.getElementById('subtitleEffect').value,
      subtitleTextCase: document.getElementById('subtitleTextCase').value,
      subtitleColor: document.getElementById('subtitleColor').value,
      subtitleHighlightColor: document.getElementById('subtitleHighlightColor').value,
      subtitleMaxWordsPerLine: Number(document.getElementById('subtitleMaxWordsPerLine').value),
      subtitlePositionY: Number(document.getElementById('subtitlePositionY').value),
      subtitleFontScale: Number(document.getElementById('subtitleFontScale').value),
      subtitleOpacity: Number(document.getElementById('subtitleOpacity').value),
      logoSize: Number(document.getElementById('logoSize').value),
      logoPosition: document.getElementById('logoPosition').value,
      logoOpacity: Number(document.getElementById('logoOpacity').value),
    watermarkText: document.getElementById('watermarkText').value,
    watermarkFontSize: Number(document.getElementById('watermarkFontSize').value),
    watermarkOpacity: Number(document.getElementById('watermarkOpacity').value),
    watermarkBehavior: document.getElementById('watermarkBehavior').value,
    watermarkInterval: Number(document.getElementById('watermarkInterval').value),
    watermarkSpeed: document.getElementById('watermarkSpeed').value,
      voiceSpeed: Number(document.getElementById('voiceSpeed').value),
      musicVolume: Number(document.getElementById('musicVolume').value),
      htmlSfxVolume: Number(document.getElementById('htmlSfxVolume')?.value ?? 0.45),
      renderConcurrency: Number(document.getElementById('renderConcurrency')?.value || 2),
      projectConcurrency: Number(document.getElementById('projectConcurrency')?.value || 1),
      renderPreset: document.getElementById('renderPreset')?.value || 'fast'
    })
  }).catch(() => null);
  if (data?.settings) {
    state.settings = data.settings;
    state.chato1KeysText = data.settings.chato1KeysText || '';
    state.imageProviderKeys = {
      chat01: data.settings.imageChat01KeysText || '',
      openai: data.settings.imageOpenaiKeysText || '',
      gemini: data.settings.imageGeminiKeysText || ''
    };
    state.providerKeys = {
      ...state.providerKeys,
      chat01: data.settings.chato1KeysText || '',
      openai: data.settings.openaiKeysText || '',
      claude: data.settings.claudeKeysText || '',
      gemini: data.settings.geminiKeysText || '',
      deepseek: data.settings.deepseekKeysText || '',
      nineRouter: data.settings.nineRouterKeysText || '',
      custom: data.settings.customApiKeysText || '',
      larvoice: data.settings.larvoiceKeysText || data.settings.larvoiceApiKey || '',
      omnivoice: '',
      vivibe: data.settings.vivibeKeysText || '',
      elevenlabs: data.settings.elevenlabsKeysText || '',
      vbee: data.settings.vbeeKeysText || ''
    };
    document.getElementById('imageGenerationProvider').value = data.settings.imageGenerationProvider || 'chat01';
    document.getElementById('thumbnailImageProvider').value = data.settings.thumbnailImageProvider || 'chat01';
    document.getElementById('imageModel').value = data.settings.imageModel || '';
    const imageModelSelect = document.getElementById('imageModelSelect');
    if (imageModelSelect) {
      imageModelSelect.value = data.settings.imageModel || 'gpt-5-5';
    }
    document.getElementById('imageSource').value = imageSourceSelectValue(data.settings);
    renderOmniVoiceVoiceOptions(data.settings.omnivoiceVoices || [], data.settings.omnivoiceVoiceId || '');
    renderOmniVoiceVoicesList(data.settings.omnivoiceVoices || []);
    updateImageModelPlaceholder();
    refreshKeyFieldDisplays();
    updateDefaultHtmlMediaDisplay(data.settings);
  }
}

// Chato1 keys: load from .txt file
document.getElementById('btn-upload-chato1')?.addEventListener('click', () => {
  document.getElementById('chato1FileInput').click();
});

document.getElementById('chato1FileInput')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  state.chato1KeysText = await file.text();
  state.providerKeys.chat01 = state.chato1KeysText;
  const count = state.chato1KeysText.split('\n').filter(Boolean).length;
  const display = document.getElementById('chato1-file-display');
  if (display) display.textContent = `${file.name} · ${count} key`;
  await autoSaveSettings();
});

document.querySelectorAll('[data-upload-keys-target]').forEach((button) => {
  button.addEventListener('click', () => {
    const input = document.getElementById('apiKeysFileInput');
    if (!input) return;
    input.dataset.target = button.dataset.uploadKeysTarget || '';
    input.value = '';
    input.click();
  });
});

document.getElementById('apiKeysFileInput')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  const targetId = e.target.dataset.target;
  const target = targetId ? document.getElementById(targetId) : null;
  if (!file || !target) return;
  target.value = await file.text();
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
});

document.getElementById('btn-save-api-keys')?.addEventListener('click', async () => {
  const button = document.getElementById('btn-save-api-keys');
  const original = button?.textContent || 'Lưu API';
  if (button) {
    button.disabled = true;
    button.textContent = 'Đang lưu...';
  }
  try {
    await autoSaveSettings();
    setStatus('Đã lưu API và ẩn các khoá đã lưu.', 'done');
  } catch (error) {
    setStatus(`Lỗi lưu API: ${error.message}`, 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
});

document.getElementById('btn-save-performance')?.addEventListener('click', async () => {
  const button = document.getElementById('btn-save-performance');
  const original = button?.textContent || 'Lưu hiệu năng';
  if (button) {
    button.disabled = true;
    button.textContent = 'Đang lưu...';
  }
  try {
    await autoSaveSettings();
    setStatus('Đã lưu cấu hình hiệu năng kết xuất.', 'done');
  } catch (error) {
    setStatus(`Lỗi lưu hiệu năng: ${error.message}`, 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
});

document.getElementById('larvoiceVoiceId')?.addEventListener('change', () => {
  updateVoicePreview();
  updateConfigSummary();
  autoSaveSettings();
});

document.getElementById('videoLanguage')?.addEventListener('change', () => {
  const subtitleFont = document.getElementById('subtitleFontFamily');
  if (subtitleFont) subtitleFont.value = getSubtitleFontForVideoLanguage(getSelectedVideoLanguage());
  renderLarVoiceOptions(state.voiceSamples, getDefaultVoiceIdForLanguage(getSelectedVideoLanguage()));
  renderOmniVoiceVoiceOptions(state.settings?.omnivoiceVoices || [], document.getElementById('omnivoiceVoiceIdQuick')?.value || '');
  updateSubtitlePreview();
  updateConfigSummary();
  autoSaveSettings();
});

document.getElementById('btn-preview-voice')?.addEventListener('click', async () => {
  const button = document.getElementById('btn-preview-voice');
  const audio = document.getElementById('voice-preview-audio');
  const provider = document.getElementById('ttsProvider')?.value || document.getElementById('ttsProviderQuick')?.value || 'larvoice';
  if (provider === 'larvoice') {
    updateVoicePreview();
    audio?.play().catch(() => {});
    return;
  }
  const originalText = button?.textContent || 'Nghe thử';
  if (button) {
    button.disabled = true;
    button.textContent = 'Đang tạo...';
  }
  try {
    syncTtsProvider(provider);
    syncTtsVoiceId(document.getElementById('ttsVoiceIdQuick')?.value || document.getElementById('ttsVoiceId')?.value || '');
    syncOmniVoiceVoiceId(document.getElementById('omnivoiceVoiceIdQuick')?.value || '');
    await autoSaveSettings();
    const data = await request('/api/tts/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ttsProvider: provider,
        ttsVoiceId: document.getElementById('ttsVoiceIdQuick')?.value || document.getElementById('ttsVoiceId')?.value || '',
        videoLanguage: getSelectedVideoLanguage(),
        voiceSpeed: Number(document.getElementById('voiceSpeed')?.value || 1),
        omnivoiceApiBaseUrl: document.getElementById('omnivoiceApiBaseUrl')?.value || 'http://127.0.0.1:8101',
        omnivoiceVoiceId: document.getElementById('omnivoiceVoiceIdQuick')?.value || '',
        omnivoiceInstruct: document.getElementById('omnivoiceInstruct')?.value || '',
        omnivoiceNumStep: Number(document.getElementById('omnivoiceNumStep')?.value || 32),
        vbeeAudioType: 'mp3'
      })
    });
    if (audio && data.audioUrl) {
      audio.src = `${data.audioUrl}?t=${Date.now()}`;
      audio.load();
      await audio.play().catch(() => {});
    }
  } catch (error) {
    setStatus(`Lỗi nghe thử: ${error.message}`, 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
});

document.getElementById('btn-crawl-url')?.addEventListener('click', async () => {
  const button = document.getElementById('btn-crawl-url');
  const status = document.getElementById('crawl-status');
  const url = document.getElementById('crawlUrl')?.value || '';
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Đang crawl...';
  if (status) status.textContent = 'Đang lấy nội dung từ URL... Video/Reels/Shorts/TikTok có thể cần tải audio và trích phụ đề.';
  try {
    const data = await request('/api/crawl-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const sourceLabel = data.sourceType === 'video' ? 'phụ đề video' : 'nội dung bài viết';
    document.getElementById('inputText').value = data.text || '';
    if (status) status.textContent = `Đã lấy ${String(data.text || '').length.toLocaleString('vi-VN')} ký tự từ ${sourceLabel}.`;
  } catch (error) {
    if (status) status.textContent = `Lỗi: ${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

// Auto-save on change for text/password fields
[
  'apiSettingsKind',
  'aiModel', 'customApiStandard', 'customApiBaseUrl', 'nineRouterBaseUrl', 'claudeMaxTokens', 'htmlConcurrency', 'renderConcurrency', 'projectConcurrency', 'renderPreset', 'imageGenerationProvider', 'thumbnailImageProvider', 'imageModel',
  'apiCrawlProvider', 'pexelsExcludedVideoUrlsText',
  'ttsVoiceId', 'ttsVoiceIdQuick', 'vbeeAppId', 'omnivoiceApiBaseUrl', 'omnivoiceInstruct', 'omnivoiceNumStep',
  'elevenlabsModelId', 'elevenlabsLanguageCode',
  'referenceImageUrl', 'aspectRatio', 'imageStyle', 'imageTextDensity', 'motionPreset', 'transitionPreset', 'generateThumbnailEnabled', 'generateSeoEnabled', 'subtitleEnabled',
  'subtitleFontFamily', 'subtitleEffect', 'subtitleTextCase', 'subtitleColor', 'subtitleHighlightColor', 'subtitleMaxWordsPerLine', 'subtitlePositionY', 'subtitleFontScale', 'subtitleOpacity',
  'logoSize', 'logoPosition', 'logoOpacity',
  'watermarkText', 'watermarkFontSize', 'watermarkOpacity', 'watermarkBehavior', 'watermarkInterval', 'watermarkSpeed',
  'voiceSpeed', 'musicVolume', 'htmlSfxVolume'
].forEach((id) => {
  document.getElementById(id)?.addEventListener('change', () => {
    if (id === 'apiSettingsKind') updateApiKindPanels();
    if (id === 'imageGenerationProvider') {
      syncImageSourceFromGenerationProvider();
      markKeyFieldMasked('imageGenerationKeysText', getImageGenerationKeysForCurrentProvider());
      updateKeyCountDisplay('image-generation-key-display', getImageGenerationKeysForCurrentProvider());
      updateImageModelPlaceholder();
      updateApiProviderHelp();
      updateProviderFieldVisibility();
    }
    if (['thumbnailImageProvider', 'apiCrawlProvider'].includes(id)) {
      updateApiProviderHelp();
      if (id === 'thumbnailImageProvider') updateProviderFieldVisibility();
    }
    if (id === 'customApiStandard') updateProviderFieldVisibility();
    if (['logoSize', 'logoPosition', 'logoOpacity', 'subtitleFontFamily', 'subtitleEffect', 'subtitleTextCase', 'subtitleColor', 'subtitleHighlightColor', 'subtitleMaxWordsPerLine', 'subtitlePositionY', 'subtitleFontScale', 'subtitleOpacity', 'watermarkText', 'watermarkFontSize', 'watermarkOpacity', 'watermarkBehavior', 'watermarkInterval', 'watermarkSpeed'].includes(id)) {
      updateSubtitlePreview();
    }
    updateConfigSummary();
    autoSaveSettings();
  });
});

document.getElementById('ttsVoiceId')?.addEventListener('input', (e) => syncTtsVoiceId(e.target.value));
document.getElementById('ttsVoiceIdQuick')?.addEventListener('input', (e) => syncTtsVoiceId(e.target.value));
document.getElementById('omnivoiceInstruct')?.addEventListener('input', (e) => syncOmniVoiceInstruct(e.target.value));
document.getElementById('omnivoiceVoiceIdQuick')?.addEventListener('change', (e) => {
  syncOmniVoiceVoiceId(e.target.value);
  updateVoicePreview();
  updateConfigSummary();
  autoSaveSettings();
});

document.getElementById('btn-pick-omnivoice-audio')?.addEventListener('click', () => {
  document.getElementById('omnivoiceRefAudioFile')?.click();
});

document.getElementById('omnivoiceRefAudioFile')?.addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  const display = document.getElementById('omnivoice-audio-display');
  if (display) display.textContent = file ? `${file.name} · ${Math.round(file.size / 1024)} KB` : 'Chưa chọn audio mẫu';
});

document.getElementById('btn-save-omnivoice-voice')?.addEventListener('click', async () => {
  const button = document.getElementById('btn-save-omnivoice-voice');
  const original = button?.textContent || 'Thêm giọng';
  const fileInput = document.getElementById('omnivoiceRefAudioFile');
  const nameInput = document.getElementById('omnivoiceVoiceName');
  const refTextInput = document.getElementById('omnivoiceRefText');
  const file = fileInput?.files?.[0];
  if (!String(nameInput?.value || '').trim() || !file) {
    setStatus('Vui lòng nhập tên giọng và chọn audio mẫu OmniVoice.', 'error');
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = 'Đang chuẩn bị giọng...';
  }
  try {
    const formData = new FormData();
    formData.set('name', nameInput.value);
    formData.set('refText', refTextInput?.value || '');
    formData.append('refAudio', file);
    const data = await request('/api/settings/omnivoice-voices', { method: 'POST', body: formData });
    state.settings = data.settings;
    renderOmniVoiceVoiceOptions(data.settings.omnivoiceVoices || [], data.settings.omnivoiceVoiceId || '');
    renderOmniVoiceVoicesList(data.settings.omnivoiceVoices || []);
    if (nameInput) nameInput.value = '';
    if (refTextInput) refTextInput.value = '';
    if (fileInput) fileInput.value = '';
    const display = document.getElementById('omnivoice-audio-display');
    if (display) display.textContent = 'Chưa chọn audio mẫu';
    updateConfigSummary();
    setStatus('Đã thêm và chuẩn bị giọng OmniVoice.', 'done');
  } catch (error) {
    setStatus(`Lỗi thêm giọng OmniVoice: ${error.message}`, 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
});

document.getElementById('omnivoice-voices-list')?.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-delete-omnivoice-voice]');
  if (!button) return;
  const id = button.dataset.deleteOmnivoiceVoice;
  if (!id || !confirm('Xoá giọng OmniVoice này?')) return;
  try {
    const data = await request(`/api/settings/omnivoice-voices/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.settings = data.settings;
    renderOmniVoiceVoiceOptions(data.settings.omnivoiceVoices || [], data.settings.omnivoiceVoiceId || '');
    renderOmniVoiceVoicesList(data.settings.omnivoiceVoices || []);
    updateConfigSummary();
    setStatus('Đã xoá giọng OmniVoice.', 'done');
  } catch (error) {
    setStatus(`Lỗi xoá giọng OmniVoice: ${error.message}`, 'error');
  }
});

document.getElementById('apiImageSearchProvider')?.addEventListener('change', (e) => {
  const provider = e.target.value;
  const source = document.getElementById('imageSource');
  if (source) source.value = provider;
  refreshKeyFieldDisplays();
  updateApiProviderHelp();
  updateImageSourceControls();
  updateConfigSummary();
  if (document.getElementById('json-modal')?.classList.contains('open')) {
    renderJsonSampleModal();
  }
  autoSaveSettings();
});

document.getElementById('imageSearchKeysText')?.addEventListener('input', () => {
  if (keyFieldIsDirty('imageSearchKeysText') && document.getElementById('apiImageSearchProvider')?.value === 'serper') {
    document.getElementById('crawlKeysText').value = document.getElementById('imageSearchKeysText').value;
    document.getElementById('crawlKeysText').dataset.dirty = 'true';
    document.getElementById('crawlKeysText').dataset.masked = 'false';
  }
});

document.getElementById('crawlKeysText')?.addEventListener('input', () => {
  if (keyFieldIsDirty('crawlKeysText') && document.getElementById('apiImageSearchProvider')?.value === 'serper') {
    document.getElementById('imageSearchKeysText').value = document.getElementById('crawlKeysText').value;
    document.getElementById('imageSearchKeysText').dataset.dirty = 'true';
    document.getElementById('imageSearchKeysText').dataset.masked = 'false';
  }
});

document.getElementById('apiProvider')?.addEventListener('change', (e) => {
  markKeyFieldMasked('llmKeysText', state.providerKeys[e.target.value] || '');
  updateKeyCountDisplay('llm-key-display', state.providerKeys[e.target.value] || '');
  updateAiModelPlaceholder();
  updateProviderFieldVisibility();
  updateApiProviderHelp();
  updateConfigSummary();
  autoSaveSettings();
});

document.getElementById('aiModelSelect')?.addEventListener('change', (e) => {
  const val = e.target.value;
  const input = document.getElementById('aiModel');
  if (input) {
    if (val === 'other') {
      input.classList.remove('is-hidden');
      input.focus();
    } else {
      input.value = val;
      input.classList.add('is-hidden');
    }
  }
  updateConfigSummary();
  autoSaveSettings();
});

document.getElementById('imageModelSelect')?.addEventListener('change', (e) => {
  const val = e.target.value;
  const input = document.getElementById('imageModel');
  if (input) {
    if (val === 'other') {
      input.classList.remove('is-hidden');
      input.focus();
    } else {
      input.value = val;
      input.classList.add('is-hidden');
    }
  }
  updateConfigSummary();
  autoSaveSettings();
});

document.getElementById('ttsProvider')?.addEventListener('change', (e) => {
  syncTtsProvider(e.target.value);
  markKeyFieldMasked('ttsKeysText', state.providerKeys[e.target.value] || '');
  updateKeyCountDisplay('tts-key-display', state.providerKeys[e.target.value] || '');
  updateProviderFieldVisibility();
  updateApiProviderHelp();
  updateVoicePreview();
  updateConfigSummary();
  autoSaveSettings();
});

document.getElementById('ttsProviderQuick')?.addEventListener('change', (e) => {
  syncTtsProvider(e.target.value);
  markKeyFieldMasked('ttsKeysText', state.providerKeys[e.target.value] || '');
  updateKeyCountDisplay('tts-key-display', state.providerKeys[e.target.value] || '');
  updateProviderFieldVisibility();
  updateApiProviderHelp();
  updateVoicePreview();
  updateConfigSummary();
  autoSaveSettings();
});

document.getElementById('imageSource')?.addEventListener('change', () => {
  const value = selectedImageSourceValue();
  if (value.startsWith('ai:')) {
    syncImageGenerationProviderFromSource();
    markKeyFieldMasked('imageGenerationKeysText', getImageGenerationKeysForCurrentProvider());
    updateKeyCountDisplay('image-generation-key-display', getImageGenerationKeysForCurrentProvider());
  }
  if (['serper', 'pexels', 'pexels-video'].includes(value)) {
    document.getElementById('apiImageSearchProvider').value = value === 'pexels-video' ? 'pexels' : value;
    refreshKeyFieldDisplays();
  }
  updateImageSourceControls();
  updateConfigSummary();
  if (document.getElementById('json-modal')?.classList.contains('open')) {
    renderJsonSampleModal();
  }
  autoSaveSettings();
});

document.getElementById('imageStyle')?.addEventListener('change', () => {
  const managerSelect = document.getElementById('styleManagerSelect');
  if (managerSelect) managerSelect.value = document.getElementById('imageStyle').value;
  updateCustomStyleEditor();
});
document.getElementById('styleManagerSelect')?.addEventListener('change', updateCustomStyleEditor);
document.getElementById('btn-save-style')?.addEventListener('click', () => {
  saveCustomStyleFromForm().catch((error) => setStatus(`Lỗi: ${error.message}`, 'error'));
});
document.getElementById('btn-delete-style')?.addEventListener('click', () => {
  deleteSelectedCustomStyle().catch((error) => setStatus(`Lỗi: ${error.message}`, 'error'));
});

document.getElementById('musicVolume')?.addEventListener('input', (e) => {
  updateMusicVolumeLabel(e.target.value);
});

document.getElementById('htmlSfxVolume')?.addEventListener('input', (e) => {
  updateHtmlSfxVolumeLabel(e.target.value);
});

document.getElementById('subtitleFontScale')?.addEventListener('input', (e) => {
  updateSubtitleSizeLabel(e.target.value);
  updateSubtitlePreview();
});

document.getElementById('subtitleOpacity')?.addEventListener('input', (e) => {
  updateSubtitleOpacityLabel(e.target.value);
  updateSubtitlePreview();
});

document.getElementById('subtitlePositionY')?.addEventListener('input', (e) => {
  updateSubtitleYLabel(e.target.value);
  updateSubtitlePreview();
});

document.getElementById('logoSize')?.addEventListener('input', (e) => {
  updateLogoSizeLabel(e.target.value);
  updateSubtitlePreview();
});

document.getElementById('watermarkFontSize')?.addEventListener('input', (e) => {
  updateWatermarkFontSizeLabel(e.target.value);
});
document.getElementById('watermarkOpacity')?.addEventListener('input', (e) => {
  updateWatermarkOpacityLabel(e.target.value);
});
document.getElementById('watermarkInterval')?.addEventListener('input', (e) => {
  updateWatermarkIntervalLabel(e.target.value);
});
document.getElementById('watermarkBehavior')?.addEventListener('change', () => {
  updateWatermarkControlsVisibility();
});
document.getElementById('logoOpacity')?.addEventListener('input', (e) => {
  updateLogoOpacityLabel(e.target.value);
  updateSubtitlePreview();
});

document.getElementById('btn-change-html-media')?.addEventListener('click', () => {
  document.getElementById('htmlMedia')?.click();
});

document.getElementById('htmlMedia')?.addEventListener('change', () => {
  updateHtmlMediaDisplay();
  updateConfigSummary();
});

document.getElementById('btn-change-reference-image')?.addEventListener('click', () => {
  document.getElementById('referenceImageFile')?.click();
});

document.getElementById('referenceImageFile')?.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  state.selectedReferenceImageFile = file || null;
  const display = document.getElementById('reference-image-display');
  if (display) display.textContent = file ? file.name : 'Chưa chọn file';
  
  try {
    if (file) {
      await PersistedFilesDB.set('referenceImage', file);
    } else {
      await PersistedFilesDB.delete('referenceImage');
    }
  } catch (err) {
    console.error('Failed to save reference image to IndexedDB:', err);
  }
  
  updateConfigSummary();
});

async function uploadDefaultHtmlMedia(fieldName, files) {
  const selected = Array.from(files || []);
  if (!selected.length) return;
  const formData = new FormData();
  selected.forEach((file) => formData.append(fieldName, file));
  const data = await request('/api/settings/html-default-media', {
    method: 'POST',
    body: formData
  });
  state.settings = data.settings;
  updateDefaultHtmlMediaDisplay(data.settings);
  updateConfigSummary();
}

document.getElementById('btn-upload-default-html-sfx')?.addEventListener('click', () => {
  document.getElementById('defaultHtmlSfxFiles')?.click();
});

document.getElementById('btn-upload-html-brand-assets')?.addEventListener('click', () => {
  document.getElementById('htmlBrandAssetFiles')?.click();
});

document.getElementById('defaultHtmlSfxFiles')?.addEventListener('change', async (event) => {
  try {
    await uploadDefaultHtmlMedia('defaultSfx', event.target.files);
    event.target.value = '';
  } catch (error) {
    alert(error.message || 'Không tải được SFX mặc định');
  }
});

document.getElementById('htmlBrandAssetFiles')?.addEventListener('change', async (event) => {
  try {
    await uploadDefaultHtmlMedia('brandAssets', event.target.files);
    event.target.value = '';
  } catch (error) {
    alert(error.message || 'Không tải được ảnh thương hiệu');
  }
});

document.getElementById('btn-save-html-media-json')?.addEventListener('click', async () => {
  const text = document.getElementById('html-media-json-text')?.value || '';
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    alert('JSON chưa hợp lệ. Kiểm tra dấu phẩy, ngoặc kép và ngoặc đóng/mở.');
    return;
  }
  try {
    const data = await request('/api/settings/html-default-media-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    state.settings = data.settings;
    updateDefaultHtmlMediaDisplay(data.settings);
    updateConfigSummary();
  } catch (error) {
    alert(error.message || 'Không lưu được JSON media');
  }
});

document.getElementById('btn-reset-html-media')?.addEventListener('click', async () => {
  if (!confirm('Reset toàn bộ media mặc định cho HTML? File đã upload cũ sẽ không còn trong catalog đưa vào AI.')) return;
  try {
    const data = await request('/api/settings/html-default-media-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ soundEffects: [], brandAssets: [] })
    });
    state.settings = data.settings;
    updateDefaultHtmlMediaDisplay(data.settings);
    updateConfigSummary();
  } catch (error) {
    alert(error.message || 'Không reset được media HTML');
  }
});

[
  'aspectRatio',
  'subtitleFontFamily',
  'subtitleEffect',
  'subtitleTextCase',
  'subtitleColor',
  'subtitleHighlightColor',
  'subtitleMaxWordsPerLine',
  'subtitleOpacity',
  'subtitlePreviewMode',
].forEach((id) => {
  document.getElementById(id)?.addEventListener('input', updateSubtitlePreview);
  document.getElementById(id)?.addEventListener('change', updateSubtitlePreview);
});

document.querySelectorAll('[data-sidebar-tab]').forEach((button) => {
  button.addEventListener('click', () => {
    const tab = button.dataset.sidebarTab;
    document.querySelectorAll('[data-sidebar-tab]').forEach((item) => {
      item.classList.toggle('active', item.dataset.sidebarTab === tab);
    });
    document.querySelectorAll('[data-sidebar-panel]').forEach((panel) => {
      panel.classList.toggle('active', panel.dataset.sidebarPanel === tab);
    });
  });
});

document.querySelectorAll('[data-settings-tab]').forEach((button) => {
  button.addEventListener('click', () => {
    setActiveSettingsTab(button);
  });
});

document.getElementById('btn-check-flow')?.addEventListener('click', async () => {
  const display = document.getElementById('flow-status-display');
  display.textContent = 'Đang kiểm tra Flowkit...';
  try {
    await autoSaveSettings();
    const data = await request('/api/flow/status');
    const connected = Boolean(data.flow?.connected);
    const credits = data.credits?.credits ?? data.credits?.remainingCredits ?? data.credits?.balance;
    const tier = data.credits?.userPaygateTier || data.credits?.tier || '';
    const serviceTier = data.credits?.serviceTier || '';
    const accountClass = tier === 'PAYGATE_TIER_NOT_PAID' || serviceTier === 'SERVICE_TIER_ENTRY'
      ? 'Free'
      : serviceTier === 'SERVICE_TIER_ULTRA' ? 'Ultra' : 'Paid';
    display.textContent = [
      `Flowkit: ${data.health?.status === 'ok' ? 'đang chạy' : 'không sẵn sàng'}`,
      `Extension: ${connected ? 'đã kết nối' : 'chưa kết nối'}`,
      tier ? `Tier: ${tier}` : '',
      serviceTier ? `Service: ${serviceTier}` : '',
      `Loại TK: ${accountClass}`,
      credits !== undefined ? `Credits: ${credits}` : '',
      `Model đang chọn: ${document.getElementById('flowVideoModel')?.value || 'veo_3_1_lite'}`,
      accountClass === 'Free' ? 'Free sẽ dùng VEO 3.1 Lite để chạy bằng credit hằng ngày, tránh model 0-credit dễ bị 403.' : '',
      accountClass !== 'Ultra' ? 'Ultra relaxed chỉ chạy khi service tier là ULTRA.' : ''
    ].filter(Boolean).join(' · ');
  } catch (error) {
    display.textContent = `Không thể kết nối Flowkit: ${error.message}`;
  }
});

document.getElementById('btn-save-flow')?.addEventListener('click', async () => {
  const display = document.getElementById('flow-status-display');
  try {
    await autoSaveSettings();
    display.textContent = 'Đã lưu cấu hình Flow.';
  } catch (error) {
    display.textContent = `Không thể lưu cấu hình Flow: ${error.message}`;
  }
});

// ── Event listeners ───────────────────────────────────────

elements.projectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData();
  formData.set('inputText', document.getElementById('inputText').value);
  formData.set('imageStyle', document.getElementById('imageStyle').value);
  formData.set('imageTextDensity', document.getElementById('imageTextDensity').value);
  const imageSourceValue = selectedImageSourceValue();
  formData.set('imageSource', imageSourceValue.startsWith('ai:') ? 'ai' : imageSourceValue);
  formData.set('imageGenerationProvider', selectedImageGenerationProvider());
  const selectedGroupId = document.getElementById('project-group-select')?.value || '';
  formData.set('groupId', selectedGroupId);
  formData.set('imageModel', document.getElementById('imageModel')?.value || '');
  formData.set('flowImageModel', document.getElementById('flowImageModel')?.value || 'nano_banana_pro');
  formData.set('flowVideoModel', document.getElementById('flowVideoModel')?.value || '');
  formData.set('flowVideoDurationSec', document.getElementById('flowVideoDurationSec')?.value || '8');
  formData.set('motionPreset', document.getElementById('motionPreset').value);
  formData.set('transitionPreset', document.getElementById('transitionPreset')?.value || 'fade');
  formData.set('aspectRatio', document.getElementById('aspectRatio').value);
  formData.set('videoLanguage', document.getElementById('videoLanguage').value);
  formData.set('referenceImageUrl', document.getElementById('referenceImageUrl')?.value || '');
  formData.set('generateThumbnailEnabled', document.getElementById('generateThumbnailEnabled').checked);
  formData.set('generateSeoEnabled', document.getElementById('generateSeoEnabled').checked);
  formData.set('subtitleEnabled', document.getElementById('subtitleEnabled').checked);
  formData.set('subtitleFontFamily', document.getElementById('subtitleFontFamily').value);
  formData.set('subtitleEffect', document.getElementById('subtitleEffect').value);
  formData.set('subtitleTextCase', document.getElementById('subtitleTextCase').value);
  formData.set('subtitleColor', document.getElementById('subtitleColor').value);
  formData.set('subtitleHighlightColor', document.getElementById('subtitleHighlightColor').value);
  formData.set('subtitleMaxWordsPerLine', document.getElementById('subtitleMaxWordsPerLine').value);
  formData.set('subtitlePositionY', document.getElementById('subtitlePositionY').value);
  formData.set('subtitleFontScale', document.getElementById('subtitleFontScale').value);
  formData.set('subtitleOpacity', document.getElementById('subtitleOpacity').value);
  formData.set('logoSize', document.getElementById('logoSize').value);
  formData.set('logoPosition', document.getElementById('logoPosition').value);
  formData.set('logoOpacity', document.getElementById('logoOpacity').value);
  formData.set('watermarkText', document.getElementById('watermarkText').value);
  formData.set('watermarkFontSize', document.getElementById('watermarkFontSize').value);
  formData.set('watermarkOpacity', document.getElementById('watermarkOpacity').value);
  formData.set('watermarkBehavior', document.getElementById('watermarkBehavior').value);
  formData.set('watermarkInterval', document.getElementById('watermarkInterval').value);
  formData.set('watermarkSpeed', document.getElementById('watermarkSpeed').value);
  formData.set('videoDurationSec', document.getElementById('videoDurationSec').value);
  formData.set('sceneDurationSec', document.getElementById('sceneDurationSec').value);
  formData.set('voiceSpeed', document.getElementById('voiceSpeed').value);
  formData.set('musicVolume', document.getElementById('musicVolume').value);
  formData.set('htmlSfxVolume', document.getElementById('htmlSfxVolume')?.value || '0.45');
  const logoFile = document.getElementById('logoFile').files[0];
  const musicFiles = (state.selectedBackgroundMusicFiles && state.selectedBackgroundMusicFiles.length > 0)
    ? state.selectedBackgroundMusicFiles
    : (document.getElementById('backgroundMusic').files || []);
  const introVideo = document.getElementById('introVideo').files[0];
  const outroVideo = document.getElementById('outroVideo').files[0];
  const referenceImage = state.selectedReferenceImageFile || document.getElementById('referenceImageFile')?.files?.[0];
  const htmlMedia = document.getElementById('htmlMedia')?.files || [];
  if (logoFile) formData.append('logo', logoFile);
  for (const mf of musicFiles) formData.append('backgroundMusic', mf);
  if (introVideo) formData.append('introVideo', introVideo);
  if (outroVideo) formData.append('outroVideo', outroVideo);
  if (referenceImage) formData.append('referenceImage', referenceImage);
  for (const file of htmlMedia) formData.append('htmlMedia', file);
  const data = await request('/api/projects', { method: 'POST', body: formData });
  document.getElementById('inputText').value = '';
  const createdProjects = Array.isArray(data.projects) && data.projects.length ? data.projects : [data.project];
  state.history.unshift(...createdProjects);
  renderHistory();
  await loadProject(data.project.id);
  startPolling(data.project.id);
});

elements.historyList.addEventListener('click', async (event) => {
  const openId = event.target.dataset.open;
  const deleteId = event.target.dataset.delete;
  const header = event.target.closest('.group-folder-header');
  const deleteGroupBtn = event.target.closest('[data-delete-group]');

  if (deleteGroupBtn) {
    event.stopPropagation();
    const groupId = deleteGroupBtn.dataset.deleteGroup;
    const group = state.groups.find(g => g.id === groupId);
    if (!group) return;
    if (confirm(`Bạn có chắc muốn xóa nhóm "${group.name}"? Các dự án bên trong sẽ chuyển sang "Chưa phân nhóm".`)) {
      try {
        await request(`/api/groups/${groupId}`, { method: 'DELETE' });
        state.groups = state.groups.filter(g => g.id !== groupId);
        state.history = state.history.map(p => {
          if (p.groupId === groupId) p.groupId = null;
          return p;
        });
        updateGroupSelect();
        renderHistory();
        setStatus(`Đã xóa nhóm "${group.name}"`, 'done');
      } catch (err) {
        setStatus(`Lỗi khi xóa nhóm: ${err.message}`, 'error');
      }
    }
    return;
  }

  if (header) {
    const folder = header.closest('.group-folder');
    const groupId = folder.dataset.groupId;
    state.collapsedGroups[groupId] = !state.collapsedGroups[groupId];
    renderHistory();
    return;
  }

  if (openId) {
    await loadProject(openId);
  }
  if (deleteId) {
    await request(`/api/projects/${deleteId}`, { method: 'DELETE' });
    state.history = state.history.filter((item) => item.id !== deleteId);
    if (state.currentProjectId === deleteId) {
      state.currentProjectId = null;
      elements.projectTitle.textContent = 'Chưa chọn dự án';
      elements.sceneList.innerHTML = '';
      elements.finalOutput.innerHTML = '';
      const assignWrap = document.getElementById('project-folder-assign-wrap');
      if (assignWrap) assignWrap.style.display = 'none';
    }
    renderHistory();
  }
});
elements.sceneList.addEventListener('click', (event) => {
  const thumb = event.target.closest('.scene-thumb');
  if (thumb) {
    const img = thumb.querySelector('img');
    if (img && img.src && !event.target.closest('.thumb-download-button')) {
      event.preventDefault();
      event.stopPropagation();
      openLightbox(img.src);
      return;
    }
  }

  const toggleBtn = event.target.closest('[data-scene-toggle]');
  if (toggleBtn) {
    const num = Number(toggleBtn.dataset.sceneToggle);
    const scene = state.currentProject?.scenes.find((s) => Number(s.sceneNumber) === num);
    if (scene) openSceneModal(scene);
  }
});

function openLightbox(src) {
  const modal = document.getElementById('lightbox-modal');
  const img = document.getElementById('lightbox-img');
  if (modal && img) {
    img.src = src;
    modal.classList.add('open');
  }
}

function closeLightbox() {
  const modal = document.getElementById('lightbox-modal');
  const img = document.getElementById('lightbox-img');
  if (modal) {
    modal.classList.remove('open');
    if (img) img.src = '';
  }
}

document.getElementById('lightbox-modal')?.addEventListener('click', () => {
  closeLightbox();
});
document.getElementById('lightbox-close')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeLightbox();
});

elements.deleteAll.addEventListener('click', async () => {
  if (!confirm('Bạn có chắc muốn xoá toàn bộ lịch sử dự án?')) return;
  await request('/api/projects', { method: 'DELETE' });
  state.history = [];
  state.currentProjectId = null;
  renderHistory();
  elements.projectTitle.textContent = 'Chưa chọn dự án';
  elements.sceneList.innerHTML = '';
  elements.finalOutput.innerHTML = '';
  const assignWrap = document.getElementById('project-folder-assign-wrap');
  if (assignWrap) assignWrap.style.display = 'none';
});


elements.refreshProject.addEventListener('click', async () => {
  if (!state.currentProjectId) return;
  setStatus('Đang tải lại...', 'running');
  try {
    await loadProject(state.currentProjectId);
  } catch (err) {
    setStatus(`Lỗi: ${err.message}`, 'error');
  }
});

elements.resumeProject.addEventListener('click', async () => {
  if (!state.currentProjectId) return;
  setStatus('Đang tiếp tục xử lý...', 'running');
  try {
    await request(`/api/projects/${state.currentProjectId}/resume`, { method: 'POST' });
    await loadProject(state.currentProjectId);
    setStatus('Đang tiếp tục xử lý...', 'running');
    startPolling(state.currentProjectId);
  } catch (err) {
    setStatus(`Lỗi: ${err.message}`, 'error');
  }
});

elements.pauseProject.addEventListener('click', async () => {
  if (!state.currentProjectId) return;
  setStatus('Đang yêu cầu tạm dừng...', 'running');
  try {
    await request(`/api/projects/${state.currentProjectId}/pause`, { method: 'POST' });
    setStatus('Đang tạm dừng... Vui lòng chờ tác vụ hiện tại hoàn thành.', 'running');
    await loadProject(state.currentProjectId);
  } catch (err) {
    setStatus(`Lỗi: ${err.message}`, 'error');
  }
});

elements.renderAllProject.addEventListener('click', async () => {
  if (!state.currentProjectId) return;
  setStatus('Đang render lại tất cả cảnh...', 'running');
  try {
    await request(`/api/projects/${state.currentProjectId}/actions/render-all`, {
      method: 'POST',
      body: buildRenderFormDataFromSidebar()
    });
    startPolling(state.currentProjectId);
  } catch (err) {
    setStatus(`Lỗi: ${err.message}`, 'error');
  }
});




// ── Scene edit modal ──────────────────────────────────────

function openSceneModal(scene) {
  const modal    = document.getElementById('scene-modal');
  const titleEl  = document.getElementById('modal-title');
  const mediaEl  = document.getElementById('modal-media');
  const fieldsEl = document.getElementById('modal-fields');
  const footerEl = document.getElementById('modal-footer');

  const imagePath    = toPublicAssetPath(scene.files?.image);
  const sourceVideoPath = toPublicAssetPath(scene.files?.sourceVideo);
  const sourceVideoUrl = getSceneSourceVideoUrl(scene);
  const htmlPath     = toPublicAssetPath(scene.files?.html);
  const videoPath    = toPublicAssetPath(scene.files?.video);
  const audioPath    = toPublicAssetPath(scene.files?.voice);
  const subtitlePath = toPublicAssetPath(scene.files?.subtitle);
  const assPath      = toPublicAssetPath(scene.files?.karaokeAss);
  const ver          = v(state.currentProject);
  const usesImageSearch = valueUsesImageSearchSource(state.currentProject?.settings?.imageSource);
  const usesVideoSearch = sceneUsesVideoSource(scene, state.currentProject?.settings?.imageSource);
  const usesFlow = valueUsesFlowSource(state.currentProject?.settings?.imageSource);
  const usesFlowVideo = valueUsesFlowVideoSource(state.currentProject?.settings?.imageSource);
  const usesFlowAudio = valueUsesFlowAudioSource(state.currentProject?.settings?.imageSource);
  const usesGeneratedAudio = usesFlowAudio;
  const usesDirectMedia = valueUsesDirectMediaSource(state.currentProject?.settings?.imageSource);
  const usesHtml = valueUsesHtmlSource(state.currentProject?.settings?.imageSource);
  const durationSec = usesGeneratedAudio ? scene.durations?.sourceVideoSec : scene.durations?.voiceSec;
  const dur = durationSec ? `· ${Math.round(durationSec)}s` : '';
  const selectedVideoModel = (state.flowVideoModelOptions || []).find((option) => (
    option.value === (state.currentProject?.settings?.flowVideoModel || state.settings?.flowVideoModel)
  ));
  const allowedFlowDurations = selectedVideoModel?.durations || [4, 6, 8];
  const flowDuration = allowedFlowDurations.includes(Number(scene.flowDurationSec || state.currentProject?.settings?.flowVideoDurationSec || state.settings?.flowVideoDurationSec || 8))
    ? Number(scene.flowDurationSec || state.currentProject?.settings?.flowVideoDurationSec || state.settings?.flowVideoDurationSec || 8)
    : 8;
  const flowDurationOptionsHtml = (state.flowVideoDurationOptions || [
    { value: 4, label: '4s' },
    { value: 6, label: '6s' },
    { value: 8, label: '8s' },
    { value: 10, label: '10s' }
  ]).filter((option) => allowedFlowDurations.includes(Number(option.value))).map((option) => (
    `<option value="${escapeHtml(option.value)}" ${Number(option.value) === flowDuration ? 'selected' : ''}>${escapeHtml(option.label)}</option>`
  )).join('');
  const imageInputValue = usesDirectMedia ? (scene.mediaUrl || '') : usesVideoSearch && !usesFlow ? (scene.videoKeyword || '') : usesImageSearch ? (scene.imageKeyword || '') : (scene.imagePrompt || '');
  const promptLabel = usesHtml ? 'Visual / hướng dựng HTML' : usesDirectMedia ? `URL ${scene.mediaType === 'video' ? 'video' : 'ảnh'}` : usesVideoSearch && !usesFlow ? 'Từ khoá tìm video (tiếng Anh)' : usesImageSearch ? 'Từ khoá tìm ảnh (tiếng Anh)' : 'Prompt ảnh';

  titleEl.textContent = `Cảnh ${scene.sceneNumber} ${dur}`;

  mediaEl.innerHTML = `
    ${imagePath ? `<img src="${imagePath}${ver}" alt="Cảnh ${scene.sceneNumber}" />` : ''}
    ${sourceVideoPath ? `<video controls muted src="${sourceVideoPath}${ver}"></video>` : ''}
    ${htmlPath ? renderHtmlPreviewFrame(htmlPath, ver, state.currentProject?.settings?.aspectRatio, 'modal-html-preview') : ''}
    ${videoPath ? `<video controls src="${videoPath}${ver}"></video>` : ''}
    ${audioPath ? `<audio controls src="${audioPath}${ver}"></audio>` : ''}
  `;

  fieldsEl.innerHTML = `
    <label class="modal-label">${usesGeneratedAudio ? 'Nội dung cảnh / lời thoại Flow' : 'Voice text'}
      <textarea id="modal-voice" rows="5">${scene.voiceText || ''}</textarea>
    </label>
    <label class="modal-label">${promptLabel}
      <textarea id="modal-prompt" rows="4">${escapeHtml(usesHtml ? (scene.visual || '') : imageInputValue)}</textarea>
    </label>
    ${usesFlowVideo ? `<label class="modal-label">Prompt chuyển động${usesFlowAudio ? ' và âm thanh' : ''} video
      <textarea id="modal-video-prompt" rows="4">${escapeHtml(scene.videoPrompt || '')}</textarea>
    </label>
    <label class="modal-label">Thời lượng clip Flow
      <select id="modal-flow-duration" class="modal-input">${flowDurationOptionsHtml}</select>
    </label>` : ''}
    ${usesHtml ? `<label class="modal-label">htmlSpec
      <textarea id="modal-html-spec" rows="8">${escapeHtml(JSON.stringify(scene.htmlSpec || {}, null, 2))}</textarea>
    </label>` : ''}
    ${usesImageSearch || (usesVideoSearch && !usesFlow) || usesDirectMedia || usesHtml ? '' : `<label class="modal-check">
      <input type="checkbox" id="modal-ref" ${scene.useReferenceImage ? 'checked' : ''} />
      Dùng ảnh tham chiếu nhân vật
    </label>
    <label class="modal-label">URL ảnh tham chiếu (ghi đè cài đặt chung)
      <input type="url" id="modal-scene-ref-url" class="modal-input" placeholder="Để trống = dùng ảnh tham chiếu mặc định" value="${escapeHtml(scene.sceneReferenceImageUrl || (typeof scene.useReferenceImage === 'string' ? scene.useReferenceImage : '') || '')}" />
    </label>`}
    <div class="modal-links">
      ${subtitlePath ? `<a href="${subtitlePath}${ver}" target="_blank" download="scene-${padSceneNumber(scene.sceneNumber)}.srt">SRT</a>` : ''}
      ${assPath      ? `<a href="${assPath}${ver}"      target="_blank" download="scene-${padSceneNumber(scene.sceneNumber)}.ass">ASS</a>` : ''}
      ${audioPath    ? `<a href="${audioPath}${ver}"    target="_blank" download="scene-${padSceneNumber(scene.sceneNumber)}-voice.wav">Voice</a>` : ''}
      ${imagePath    ? `<a href="${imagePath}${ver}"    download="scene-${padSceneNumber(scene.sceneNumber)}-image.png">Ảnh</a>` : ''}
      ${sourceVideoUrl
        ? `<a href="${escapeHtml(sourceVideoUrl)}" target="_blank" rel="noopener noreferrer">Nguồn video</a>`
        : sourceVideoPath
        ? `<a href="${sourceVideoPath}${ver}" target="_blank" download="scene-${padSceneNumber(scene.sceneNumber)}-source-video.mp4">Video nguồn</a>`
        : ''}
      ${htmlPath ? `<a href="${htmlPath}${ver}" target="_blank" download="scene-${padSceneNumber(scene.sceneNumber)}.html">HTML</a>` : ''}
      ${videoPath    ? `<a href="${videoPath}${ver}"    target="_blank" download="scene-${padSceneNumber(scene.sceneNumber)}.mp4">Video</a>` : ''}
    </div>
  `;

  const n = scene.sceneNumber;
  footerEl.innerHTML = `
    <button type="button" class="btn-secondary" data-modal-action="save"         data-scene-number="${n}">Lưu</button>
    <button type="button" class="btn-secondary" data-modal-action="upload-image" data-scene-number="${n}">Tải ảnh lên</button>
    <button type="button" class="btn-secondary" data-modal-action="upload-video" data-scene-number="${n}">Tải video lên</button>
    <button type="button" class="btn-secondary" data-modal-action="image"        data-scene-number="${n}">${usesHtml ? 'Tạo HTML' : usesFlow ? 'Tạo lại Flow' : usesDirectMedia ? `Tải ${scene.mediaType === 'video' ? 'video' : 'ảnh'}` : usesVideoSearch ? 'Tìm video' : usesImageSearch ? 'Tìm ảnh' : 'Tạo ảnh'}</button>
    ${usesGeneratedAudio ? '' : `<button type="button" class="btn-secondary" data-modal-action="voice" data-scene-number="${n}">Tạo voice</button>
    <button type="button" class="btn-secondary" data-modal-action="subtitle" data-scene-number="${n}">Tạo SRT</button>`}
    <button type="button" class="btn-secondary" data-modal-action="render"       data-scene-number="${n}">Render lại</button>
  `;

  if (state.processingSceneNums.has(Number(n))) {
    const allBtns = footerEl.querySelectorAll('button');
    allBtns.forEach((b) => {
      b.disabled = true;
      if (b.dataset.modalAction === 'render' || b.dataset.modalAction === 'image' || b.dataset.modalAction === 'voice' || b.dataset.modalAction === 'subtitle') {
        b.textContent = '⟳ Đang xử lý...';
      }
    });
  }

  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function getSceneModalPayload() {
  const voiceText = document.getElementById('modal-voice')?.value ?? '';
  const imageInput = document.getElementById('modal-prompt')?.value ?? '';
  const usesImageSearch = valueUsesImageSearchSource(state.currentProject?.settings?.imageSource);
  const usesVideoSearch = valueUsesVideoSearchSource(state.currentProject?.settings?.imageSource);
  const usesFlow = valueUsesFlowSource(state.currentProject?.settings?.imageSource);
  const usesFlowVideo = valueUsesFlowVideoSource(state.currentProject?.settings?.imageSource);
  const usesDirectMedia = valueUsesDirectMediaSource(state.currentProject?.settings?.imageSource);
  const usesHtml = valueUsesHtmlSource(state.currentProject?.settings?.imageSource);
  if (usesHtml) {
    return {
      voiceText,
      visual: imageInput,
      htmlSpec: document.getElementById('modal-html-spec')?.value || ''
    };
  }
  if (usesVideoSearch) {
    return { voiceText, videoKeyword: imageInput };
  }
  if (usesFlow) {
    return {
      voiceText,
      imagePrompt: imageInput,
      ...(usesFlowVideo ? { videoPrompt: document.getElementById('modal-video-prompt')?.value || '' } : {}),
      ...(usesFlowVideo ? { flowDurationSec: Number(document.getElementById('modal-flow-duration')?.value || 8) } : {}),
      useReferenceImage: document.getElementById('modal-ref')?.checked ?? false,
      sceneReferenceImageUrl: document.getElementById('modal-scene-ref-url')?.value ?? ''
    };
  }
  if (usesDirectMedia) {
    return { voiceText, mediaUrl: imageInput };
  }
  if (usesImageSearch) {
    return { voiceText, imageKeyword: imageInput };
  }
  return {
    voiceText,
    imagePrompt: imageInput,
    useReferenceImage: document.getElementById('modal-ref')?.checked ?? false,
    sceneReferenceImageUrl: document.getElementById('modal-scene-ref-url')?.value ?? ''
  };
}

function closeSceneModal() {
  document.getElementById('scene-modal').classList.remove('open');
  document.body.style.overflow = '';
}

document.getElementById('modal-close')?.addEventListener('click', closeSceneModal);

document.getElementById('scene-modal')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeSceneModal();
});

document.getElementById('modal-footer')?.addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-modal-action]');
  if (!btn || !state.currentProjectId) return;

  const action      = btn.dataset.modalAction;
  const sceneNumber = btn.dataset.sceneNumber;

  if (action === 'save') {
    setStatus(`Đang lưu cảnh ${sceneNumber}...`);
    await request(`/api/projects/${state.currentProjectId}/scenes/${sceneNumber}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(getSceneModalPayload())
    });
    setStatus(`Đã lưu cảnh ${sceneNumber}`, 'done');
    closeSceneModal();
    await loadProject(state.currentProjectId);
    return;
  }

  if (action === 'upload-image') {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.onchange = async () => {
      const file = fileInput.files[0];
      if (!file) return;
      const allBtns = document.querySelectorAll('#modal-footer button');
      allBtns.forEach((b) => { b.disabled = true; });
      setStatus(`Đang tải ảnh lên cảnh ${sceneNumber}...`);
      try {
        const formData = new FormData();
        formData.append('image', file);
        await request(
          `/api/projects/${state.currentProjectId}/scenes/${sceneNumber}/upload-image`,
          { method: 'POST', body: formData }
        );
        await loadProject(state.currentProjectId);
        const updatedScene = state.currentProject?.scenes?.find(
          (s) => Number(s.sceneNumber) === Number(sceneNumber)
        );
        if (updatedScene) openSceneModal(updatedScene);
        setStatus(`Đã cập nhật ảnh cảnh ${sceneNumber}`, 'done');
      } catch (err) {
        setStatus(`Lỗi: ${err.message}`, 'error');
        allBtns.forEach((b) => { b.disabled = false; });
      }
    };
    fileInput.click();
    return;
  }

  if (action === 'upload-video') {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'video/*';
    fileInput.onchange = async () => {
      const file = fileInput.files[0];
      if (!file) return;
      const allBtns = document.querySelectorAll('#modal-footer button');
      allBtns.forEach((b) => { b.disabled = true; });
      setStatus(`Đang tải video lên cảnh ${sceneNumber}...`);
      try {
        const formData = new FormData();
        formData.append('video', file);
        await request(
          `/api/projects/${state.currentProjectId}/scenes/${sceneNumber}/upload-video`,
          { method: 'POST', body: formData }
        );
        await loadProject(state.currentProjectId);
        const updatedScene = state.currentProject?.scenes?.find(
          (s) => Number(s.sceneNumber) === Number(sceneNumber)
        );
        if (updatedScene) openSceneModal(updatedScene);
        setStatus(`Đã cập nhật video nguồn cảnh ${sceneNumber}`, 'done');
      } catch (err) {
        setStatus(`Lỗi: ${err.message}`, 'error');
        allBtns.forEach((b) => { b.disabled = false; });
      }
    };
    fileInput.click();
    return;
  }

  // Auto-save text fields trước khi chạy action
  try {
    await request(`/api/projects/${state.currentProjectId}/scenes/${sceneNumber}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(getSceneModalPayload())
    });
  } catch { /* non-critical */ }

  const actionLabel = ACTION_LABELS[action] || action;
  setStatus(`Đang ${actionLabel} cảnh ${sceneNumber}...`);

  const allBtns = document.querySelectorAll('#modal-footer button');
  const originalLabel = btn.textContent;
  allBtns.forEach((b) => { b.disabled = true; });
  btn.textContent = '⟳ Đang xử lý...';

  state.processingSceneNums.add(Number(sceneNumber));
  updateSceneBadge(Number(sceneNumber), true);

  try {
    await request(`/api/projects/${state.currentProjectId}/scenes/${sceneNumber}/actions/${action}`, {
      method: 'POST'
    });
  } catch (err) {
    state.processingSceneNums.delete(Number(sceneNumber));
    updateSceneBadge(Number(sceneNumber), false);
    allBtns.forEach((b) => { b.disabled = false; });
    btn.textContent = originalLabel;
    setStatus(`Lỗi: ${err.message}`, 'error');
    return;
  }

  watchSceneJob(state.currentProjectId, Number(sceneNumber), allBtns, actionLabel);
});

// Update just one card's badge without re-rendering the whole list
function updateSceneBadge(sceneNum, isProcessing) {
  const card = document.querySelector(`#scene-list [data-scene-num="${sceneNum}"]`);
  if (!card) return;
  const badge = card.querySelector('.scene-status-badge');
  if (!badge) return;
  if (isProcessing) {
    badge.className = 'scene-status-badge badge-running';
    badge.textContent = '⟳ Đang xử lý...';
    card.classList.add('scene-processing');
  } else {
    card.classList.remove('scene-processing');
    // Let next renderScenes set the correct badge state
  }
}

// Poll for a scene-level job: only update status bar while running, full re-render when done
function watchSceneJob(projectId, sceneNum, footerBtns, actionLabel = '') {
  const timer = setInterval(async () => {
    try {
      const data = await request(`/api/projects/${projectId}`);
      
      // Cập nhật danh sách các scene đang chạy
      updateProcessingScenesFromActiveJobs(data.activeJobs);
      state.activeJobs = data.activeJobs || [];
      
      // Kiểm tra xem job của scene cụ thể này đã kết thúc chưa
      const isSceneJobStillRunning = data.activeJobs?.some(jobId => jobId.startsWith(`${projectId}:scene:${sceneNum}:`));
      
      if (!isSceneJobStillRunning) {
        clearInterval(timer);
        state.currentProject     = data.project;
        state.processingSceneNums.delete(sceneNum);
        // Xóa stable cache key của scene này để ảnh mới được load thật sự
        delete state.sceneVersions[sceneNum];

        renderScenes(data.project);
        renderOutputs(data.project, data.seo);

        const freshScene = data.project.scenes.find((s) => Number(s.sceneNumber) === sceneNum);
        const hasError   = freshScene?.status === 'error' && freshScene.errors?.length;

        if (hasError) {
          const lastErr = freshScene.errors[freshScene.errors.length - 1];
          setStatus(`Lỗi cảnh ${sceneNum}: ${lastErr}`, 'error');
        } else {
          setStatus(`Hoàn thành: ${actionLabel || 'xử lý'} cảnh ${sceneNum}`, 'done');
        }

        // Chỉ reload modal nếu modal vẫn đang mở và hiển thị đúng cảnh này
        const modal = document.getElementById('scene-modal');
        const activeSceneNumInModal = document.querySelector('#modal-footer button')?.dataset.sceneNumber;
        if (modal?.classList.contains('open') && Number(activeSceneNumInModal) === sceneNum && freshScene) {
          openSceneModal(freshScene);
          if (hasError) {
            const lastErr = freshScene.errors[freshScene.errors.length - 1];
            const banner = document.createElement('div');
            banner.className = 'modal-error-banner';
            banner.textContent = `⚠ Lỗi: ${lastErr}`;
            document.getElementById('modal-fields')?.prepend(banner);
          }
        }
      }
    } catch {
      clearInterval(timer);
      state.processingSceneNums.delete(sceneNum);
      if (footerBtns) footerBtns.forEach((b) => { b.disabled = false; });
      setStatus('Lỗi kết nối server', 'error');
    }
  }, 2000);
}

// ── Auto-poll while pipeline is running ──────────────────

let pollTimer = null;
let pollErrorCount = 0;
const POLL_MAX_ERRORS = 4;

function startPolling(projectId) {
  stopPolling();
  pollErrorCount = 0;
  pollTimer = setInterval(async () => {
    if (!state.currentProjectId) { stopPolling(); return; }
    try {
      const data = await request(`/api/projects/${projectId}`);
      pollErrorCount = 0;
      state.currentProject = data.project;
      state.currentLogs = data.logs || [];
      state.running = data.running || false;
      state.activeJobs = data.activeJobs || [];

      // Cập nhật các scene đang chạy
      updateProcessingScenesFromActiveJobs(data.activeJobs);

      renderSummary(data.project, data.running);
      renderScenes(data.project);
      if (!data.running) {
        state.processingSceneNums.clear();
        state.running = false;
        stopPolling();
        renderOutputs(data.project, data.seo);
      }
    } catch {
      pollErrorCount += 1;
      // Chỉ dừng sau nhiều lỗi liên tiếp — tránh dừng vì lỗi mạng thoáng qua
      if (pollErrorCount >= POLL_MAX_ERRORS) stopPolling();
    }
  }, 3000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Settings modal ────────────────────────────────────────

function openSettingsModal() {
  const managerSelect = document.getElementById('styleManagerSelect');
  const mainSelect = document.getElementById('imageStyle');
  if (managerSelect && mainSelect) {
    managerSelect.value = mainSelect.value;
  }
  updateCustomStyleEditor();
  document.getElementById('settings-modal')?.classList.add('open');
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(updateSubtitlePreview);
}

function closeSettingsModal() {
  document.getElementById('settings-modal')?.classList.remove('open');
  document.body.style.overflow = '';
}

document.getElementById('open-settings')?.addEventListener('click', openSettingsModal);
document.getElementById('settings-modal-close')?.addEventListener('click', closeSettingsModal);
document.getElementById('settings-modal')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    closeSettingsModal();
  }
});

// ── JSON sample modal ────────────────────────────────────

document.getElementById('show-json-sample')?.addEventListener('click', (e) => {
  e.preventDefault();
  renderJsonSampleModal();
  document.getElementById('json-modal')?.classList.add('open');
  document.body.style.overflow = 'hidden';
});

document.getElementById('json-modal-close')?.addEventListener('click', () => {
  document.getElementById('json-modal')?.classList.remove('open');
  document.body.style.overflow = '';
});

document.getElementById('json-modal')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.classList.remove('open');
    document.body.style.overflow = '';
  }
});

// ── File input triggers ───────────────────────────────────

document.getElementById('btn-change-logo')?.addEventListener('click', () => {
  document.getElementById('logoFile').click();
});

document.getElementById('btn-change-music')?.addEventListener('click', () => {
  document.getElementById('backgroundMusic').click();
});

document.querySelectorAll('#btn-change-intro-video, .btn-change-intro-video').forEach((button) => {
  button.addEventListener('click', () => {
    document.getElementById('introVideo').click();
  });
});

document.querySelectorAll('#btn-change-outro-video, .btn-change-outro-video').forEach((button) => {
  button.addEventListener('click', () => {
    document.getElementById('outroVideo').click();
  });
});

document.getElementById('logoFile')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  const display = document.getElementById('logo-display');
  if (display) display.textContent = file ? file.name : 'Chưa có logo';
  state.clearedAssets.logo = !file;
  const clearBtn = document.getElementById('btn-clear-logo');
  if (clearBtn) clearBtn.style.display = file ? 'inline-flex' : 'none';
  updateConfigSummary();
});

document.getElementById('btn-clear-logo')?.addEventListener('click', () => {
  const input = document.getElementById('logoFile');
  if (input) input.value = '';
  const display = document.getElementById('logo-display');
  if (display) display.textContent = 'Chưa có logo';
  state.clearedAssets.logo = true;
  const clearBtn = document.getElementById('btn-clear-logo');
  if (clearBtn) clearBtn.style.display = 'none';
  updateConfigSummary();
});

document.getElementById('backgroundMusic')?.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  state.selectedBackgroundMusicFiles = files;
  const display = document.getElementById('music-display');
  if (!display) return;
  const clearBtn = document.getElementById('btn-clear-music');
  if (!files.length) {
    display.textContent = 'Chưa có nhạc nền';
    state.clearedAssets.backgroundMusic = true;
    if (clearBtn) clearBtn.style.display = 'none';
    try {
      await PersistedFilesDB.delete('backgroundMusic');
    } catch (err) {
      console.error('Failed to delete background music from IndexedDB:', err);
    }
    updateConfigSummary();
    return;
  }
  display.textContent = files.length === 1
    ? files[0].name
    : `${files.length} file nhạc (${files.map(f => f.name).join(', ')})`;
  state.clearedAssets.backgroundMusic = false;
  if (clearBtn) clearBtn.style.display = 'inline-flex';
  
  try {
    await PersistedFilesDB.set('backgroundMusic', files);
  } catch (err) {
    console.error('Failed to save background music to IndexedDB:', err);
  }
  
  updateConfigSummary();
});

document.getElementById('btn-clear-music')?.addEventListener('click', async () => {
  const input = document.getElementById('backgroundMusic');
  if (input) input.value = '';
  state.selectedBackgroundMusicFiles = [];
  const display = document.getElementById('music-display');
  if (display) display.textContent = 'Chưa có nhạc nền';
  state.clearedAssets.backgroundMusic = true;
  const clearBtn = document.getElementById('btn-clear-music');
  if (clearBtn) clearBtn.style.display = 'none';
  
  try {
    await PersistedFilesDB.delete('backgroundMusic');
  } catch (err) {
    console.error('Failed to delete background music from IndexedDB:', err);
  }
  
  updateConfigSummary();
});

document.getElementById('introVideo')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  document.querySelectorAll('.intro-video-display').forEach((display) => {
    display.textContent = file ? file.name : 'Không thêm video';
  });
  state.clearedAssets.introVideo = !file;
  const clearBtn = document.getElementById('btn-clear-intro-video');
  if (clearBtn) clearBtn.style.display = file ? 'inline-flex' : 'none';
  updateConfigSummary();
});

document.getElementById('btn-clear-intro-video')?.addEventListener('click', () => {
  const input = document.getElementById('introVideo');
  if (input) input.value = '';
  document.querySelectorAll('.intro-video-display').forEach((display) => {
    display.textContent = 'Không thêm video';
  });
  state.clearedAssets.introVideo = true;
  const clearBtn = document.getElementById('btn-clear-intro-video');
  if (clearBtn) clearBtn.style.display = 'none';
  updateConfigSummary();
});

document.getElementById('outroVideo')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  document.querySelectorAll('.outro-video-display').forEach((display) => {
    display.textContent = file ? file.name : 'Không nối video';
  });
  state.clearedAssets.outroVideo = !file;
  const clearBtn = document.getElementById('btn-clear-outro-video');
  if (clearBtn) clearBtn.style.display = file ? 'inline-flex' : 'none';
  updateConfigSummary();
});

document.getElementById('btn-clear-outro-video')?.addEventListener('click', () => {
  const input = document.getElementById('outroVideo');
  if (input) input.value = '';
  document.querySelectorAll('.outro-video-display').forEach((display) => {
    display.textContent = 'Không nối video';
  });
  state.clearedAssets.outroVideo = true;
  const clearBtn = document.getElementById('btn-clear-outro-video');
  if (clearBtn) clearBtn.style.display = 'none';
  updateConfigSummary();
});

// Estimate text update
document.getElementById('videoDurationSec')?.addEventListener('change', updateEstimate);
document.getElementById('sceneDurationSec')?.addEventListener('change', updateEstimate);
updateEstimate();
window.addEventListener('resize', updateSubtitlePreview);

setupMaskedKeyFields();
loadBootstrap().catch((error) => {
  console.error('Bootstrap failed:', error.message);
});


// Group / Folder event listeners
document.getElementById('btn-add-folder')?.addEventListener('click', () => {
  const box = document.getElementById('folder-create-box');
  if (box) {
    box.style.display = 'flex';
    document.getElementById('folder-name-input')?.focus();
  }
});

document.getElementById('btn-cancel-folder')?.addEventListener('click', () => {
  const box = document.getElementById('folder-create-box');
  if (box) box.style.display = 'none';
  const input = document.getElementById('folder-name-input');
  if (input) input.value = '';
});

document.getElementById('btn-save-folder')?.addEventListener('click', async () => {
  const input = document.getElementById('folder-name-input');
  const name = input?.value?.trim();
  if (!name) {
    setStatus('Vui lòng nhập tên nhóm.', 'error');
    return;
  }
  try {
    const data = await request('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    state.groups.push(data.group);
    updateGroupSelect();
    renderHistory();
    const box = document.getElementById('folder-create-box');
    if (box) box.style.display = 'none';
    if (input) input.value = '';
    setStatus(`Đã tạo nhóm "${name}" thành công`, 'done');
  } catch (err) {
    setStatus(`Lỗi khi tạo nhóm: ${err.message}`, 'error');
  }
});

document.getElementById('folder-name-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('btn-save-folder')?.click();
  }
});

document.getElementById('project-folder-assign')?.addEventListener('change', async (e) => {
  if (!state.currentProjectId) return;
  const groupId = e.target.value || null;
  try {
    await request(`/api/projects/${state.currentProjectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId })
    });
    state.history = state.history.map(p => {
      if (p.id === state.currentProjectId) p.groupId = groupId;
      return p;
    });
    renderHistory();
    setStatus('Đã di chuyển dự án vào nhóm thành công', 'done');
  } catch (err) {
    setStatus(`Lỗi khi di chuyển dự án: ${err.message}`, 'error');
  }
});

// Watermark helper UI functions & Animation loop
function updateWatermarkFontSizeLabel(value) {
  const label = document.getElementById('watermark-size-label');
  if (label) label.textContent = `${value}px`;
}
function updateWatermarkOpacityLabel(value) {
  const label = document.getElementById('watermark-opacity-label');
  if (label) label.textContent = `${value}%`;
}
function updateWatermarkIntervalLabel(value) {
  const label = document.getElementById('watermark-interval-label');
  if (label) label.textContent = `${value}s`;
}
function updateWatermarkControlsVisibility() {
  const behavior = document.getElementById('watermarkBehavior')?.value || 'interval';
  const speedField = document.getElementById('field-watermark-speed');
  const intervalField = document.getElementById('field-watermark-interval');
  if (speedField) speedField.style.display = behavior === 'continuous' ? 'flex' : 'none';
  if (intervalField) intervalField.style.display = behavior === 'interval' ? 'flex' : 'none';
}

let watermarkAnimFrameId = null;

function updateWatermarkPositions() {
  const text = document.getElementById('watermarkText')?.value || '';
  const fontSize = Number(document.getElementById('watermarkFontSize')?.value || 24);
  const opacity = Number(document.getElementById('watermarkOpacity')?.value || 30) / 100;
  const behavior = document.getElementById('watermarkBehavior')?.value || 'interval';
  const interval = Number(document.getElementById('watermarkInterval')?.value || 5);
  const speed = document.getElementById('watermarkSpeed')?.value || 'medium';

  const marks = document.querySelectorAll('.watermark-preview-mark');
  if (!text) {
    marks.forEach(m => m.style.display = 'none');
    return;
  }

  const time = Date.now() / 1000;

  marks.forEach(mark => {
    const parent = mark.parentElement;
    if (!parent) return;

    mark.style.display = 'block';
    mark.textContent = text;
    mark.style.opacity = opacity;

    const parentWidth = parent.clientWidth;
    const parentHeight = parent.clientHeight;
    
    // Scale font size based on preview frame aspect
    const scale = parentHeight / 1080;
    mark.style.fontSize = `${fontSize * scale}px`;

    const markWidth = mark.clientWidth;
    const markHeight = mark.clientHeight;

    const w = parentWidth - markWidth;
    const h = parentHeight - markHeight;

    let x = 0;
    let y = 0;

    if (behavior === 'interval') {
      const step = Math.floor(time / interval);
      const sinX = Math.sin(step * 12345.67);
      const sinY = Math.sin(step * 76543.21);
      
      x = w * (sinX + 1) / 2;
      y = h * (sinY + 1) / 2;
    } else {
      let speedX = 1.0;
      let speedY = 0.7;
      if (speed === 'slow') {
        speedX = 0.5;
        speedY = 0.35;
      } else if (speed === 'fast') {
        speedX = 2.0;
        speedY = 1.4;
      }

      const sinX = Math.sin(time * speedX);
      const sinY = Math.sin(time * speedY);
      
      x = w * (sinX + 1) / 2;
      y = h * (sinY + 1) / 2;
    }

    mark.style.left = `${x}px`;
    mark.style.top = `${y}px`;
  });
}

function startWatermarkAnimationLoop() {
  if (watermarkAnimFrameId) return;
  function loop() {
    updateWatermarkPositions();
    watermarkAnimFrameId = requestAnimationFrame(loop);
  }
  watermarkAnimFrameId = requestAnimationFrame(loop);
}

// Event listeners for vertical convert form live update & submission
document.addEventListener('input', (e) => {
  if (e.target && e.target.closest('#vertical-convert-form')) {
    const labelId = `${e.target.id}-label`;
    const label = document.getElementById(labelId);
    if (label) {
      const isPercent = e.target.id.includes('position') || e.target.id.includes('blur');
      const isLineHeight = e.target.id.includes('line-height');
      const suffix = isPercent ? '%' : (isLineHeight ? '' : 'px');
      label.textContent = `${e.target.value}${suffix}`;
    }
    updateVerticalLivePreview();
  }
});

document.addEventListener('change', (e) => {
  if (e.target && e.target.closest('#vertical-convert-form')) {
    updateVerticalLivePreview();
  }
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('#btn-toggle-vertical-form');
  if (btn) {
    const form = document.getElementById('vertical-convert-form');
    if (form) {
      const isHidden = form.style.display === 'none';
      form.style.display = isHidden ? 'flex' : 'none';
      btn.textContent = isHidden ? '✕ Ẩn cấu hình' : '⚙ Cấu hình & Tạo lại';
      
      const previewWrapper = document.getElementById('vertical-preview-wrapper');
      if (previewWrapper) previewWrapper.style.display = isHidden ? 'block' : 'none';
      if (isHidden) {
        updateVerticalLivePreview();
      }
    }
  }
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('#btn-submit-vertical');
  if (!btn) return;
  e.preventDefault();

  console.log('Nút Tạo video dọc 9:16 được click. Project ID:', state.currentProjectId);

  if (!state.currentProjectId) {
    alert('Lỗi: Không tìm thấy ID dự án hiện tại! Vui lòng tải lại dự án và thử lại.');
    return;
  }

  const form = document.getElementById('vertical-convert-form');
  if (!form) return;

  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⟳ Đang chuyển đổi...';
  setStatus('Đang chuyển đổi video dọc 9:16...');

  try {
    const payload = {
      topText: (document.getElementById('vertical-top-text')?.value || '').toUpperCase(),
      bottomText: (document.getElementById('vertical-bottom-text')?.value || '').toUpperCase(),
      fontFamily: document.getElementById('vertical-font-family')?.value || 'Arial',
      topFontSize: Number(document.getElementById('vertical-top-font-size')?.value || 64),
      bottomFontSize: Number(document.getElementById('vertical-bottom-font-size')?.value || 64),
      topPositionY: Number(document.getElementById('vertical-top-position-y')?.value ?? 18),
      bottomPositionY: Number(document.getElementById('vertical-bottom-position-y')?.value ?? 83),
      blurPercent: Number(document.getElementById('vertical-blur-percent')?.value ?? 50),
      topColor: document.getElementById('vertical-top-color')?.value || '#ffffff',
      bottomColor: document.getElementById('vertical-bottom-color')?.value || '#ffeb3b',
      topLineHeight: Number(document.getElementById('vertical-top-line-height')?.value ?? 1.4),
      bottomLineHeight: Number(document.getElementById('vertical-bottom-line-height')?.value ?? 1.4)
    };

    console.log('Gửi yêu cầu chuyển đổi dọc với payload:', payload);

    await request(`/api/projects/${state.currentProjectId}/actions/convert-vertical`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    console.log('Yêu cầu gửi thành công, bắt đầu poll trạng thái...');
    startPolling(state.currentProjectId);
  } catch (err) {
    console.error('Lỗi khi gửi yêu cầu chuyển đổi video dọc:', err);
    btn.disabled = false;
    btn.textContent = originalLabel;
    setStatus(`Lỗi: ${err.message}`, 'error');
    alert(`Lỗi khi tạo video dọc: ${err.message}`);
  }
});

function updateVerticalLivePreview() {
  const wrapper = document.getElementById('vertical-preview-wrapper');
  if (!wrapper || wrapper.style.display === 'none') return;

  const topText = (document.getElementById('vertical-top-text')?.value || '').toUpperCase();
  const bottomText = (document.getElementById('vertical-bottom-text')?.value || '').toUpperCase();
  const fontFamily = document.getElementById('vertical-font-family')?.value || 'Arial';
  const topFontSize = Number(document.getElementById('vertical-top-font-size')?.value || 64);
  const bottomFontSize = Number(document.getElementById('vertical-bottom-font-size')?.value || 64);
  const topPositionY = Number(document.getElementById('vertical-top-position-y')?.value ?? 18);
  const bottomPositionY = Number(document.getElementById('vertical-bottom-position-y')?.value ?? 83);
  const blurPercent = Number(document.getElementById('vertical-blur-percent')?.value ?? 50);
  const topColor = document.getElementById('vertical-top-color')?.value || '#ffffff';
  const bottomColor = document.getElementById('vertical-bottom-color')?.value || '#ffeb3b';
  const topLineHeight = Number(document.getElementById('vertical-top-line-height')?.value ?? 1.4);
  const bottomLineHeight = Number(document.getElementById('vertical-bottom-line-height')?.value ?? 1.4);

  const textTopEl = document.getElementById('vertical-preview-text-top');
  if (textTopEl) {
    textTopEl.textContent = topText;
    textTopEl.style.fontFamily = fontFamily;
    textTopEl.style.fontSize = `${(topFontSize / 1080) * 100}cqw`;
    textTopEl.style.color = topColor;
    textTopEl.style.top = `${topPositionY}%`;
    textTopEl.style.lineHeight = topLineHeight;
  }

  const textBottomEl = document.getElementById('vertical-preview-text-bottom');
  if (textBottomEl) {
    textBottomEl.textContent = bottomText;
    textBottomEl.style.fontFamily = fontFamily;
    textBottomEl.style.fontSize = `${(bottomFontSize / 1080) * 100}cqw`;
    textBottomEl.style.color = bottomColor;
    textBottomEl.style.top = `${bottomPositionY}%`;
    textBottomEl.style.lineHeight = bottomLineHeight;
  }

  const bgEl = document.getElementById('vertical-preview-bg');
  if (bgEl) {
    const blurRadius = (blurPercent / 100) * 40;
    bgEl.style.filter = `blur(${blurRadius}px)`;
  }
}
