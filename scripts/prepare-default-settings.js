const fs = require('fs');
const path = require('path');

const srcPath = path.join(__dirname, '..', 'data', 'storage', 'settings.json');
const destPath = path.join(__dirname, '..', 'assets', 'default-settings.json');

if (!fs.existsSync(srcPath)) {
  console.error('Không tìm thấy file settings.json tại data/storage/settings.json');
  process.exit(1);
}

try {
  const raw = fs.readFileSync(srcPath, 'utf8');
  const settings = JSON.parse(raw);

  // Xóa các API keys nhạy cảm để tránh rò rỉ cho khách hàng
  const keysToClear = [
    'chato1KeysText', 'openaiKeysText', 'claudeKeysText', 'geminiKeysText',
    'deepseekKeysText', 'nineRouterKeysText', 'customApiKeysText',
    'imageChat01KeysText', 'imageOpenaiKeysText', 'imageGeminiKeysText',
    'serperKeysText', 'pexelsKeysText', 'vivibeKeysText', 'elevenlabsKeysText',
    'vbeeKeysText', 'vbeeAppId'
  ];

  keysToClear.forEach(key => {
    if (key in settings) {
      settings[key] = '';
    }
  });

  // Giữ nguyên danh sách giọng nói omnivoiceVoices
  // Nhưng đổi refAudioPath thành tương đối hoặc để trống để sinh động khi cài đặt
  if (Array.isArray(settings.omnivoiceVoices)) {
    settings.omnivoiceVoices.forEach(voice => {
      // Chỉ giữ tên file để sau này service tự map đường dẫn tuyệt đối theo thư mục AppData máy khách
      const ext = path.extname(voice.refAudioPath || '.mp3');
      voice.refAudioPath = voice.id + ext; 
    });
  }

  fs.writeFileSync(destPath, JSON.stringify(settings, null, 2), 'utf8');
  console.log('Tạo thành công file default-settings.json tại assets/default-settings.json');
} catch (err) {
  console.error('Lỗi khi tạo default-settings.json:', err);
  process.exit(1);
}
