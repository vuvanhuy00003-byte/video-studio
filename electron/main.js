const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');

// Redirect Electron userData and system temp environment variables to D drive
const appRoot = path.resolve(__dirname, '..');
const dataRoot = path.join(appRoot, 'data');
fs.mkdirSync(path.join(dataRoot, 'userData'), { recursive: true });
fs.mkdirSync(path.join(dataRoot, 'tmp'), { recursive: true });
app.setPath('userData', path.join(dataRoot, 'userData'));
process.env.TEMP = path.join(dataRoot, 'tmp');
process.env.TMP = path.join(dataRoot, 'tmp');

if (app.isPackaged) {
  process.env.VIBE_TOOL_COMMERCIAL = 'true';
}

let serverHandle = null;
let localServicesHandle = null;
let mainWindow = null;
let isQuitting = false;
const logLines = [];
let serviceLinks = [];
const APP_NAME = 'Video Studio';
const DEFAULT_APP_PORT = 3000;
const LAUNCHER_WIDTH = 1160;
const LAUNCHER_HEIGHT = 860;
const FLOWKIT_EXTENSION_DIR = path.resolve(__dirname, '..', 'flowkit', 'extension');

function findFirstFile(rootDir, fileName) {
  if (!rootDir || !fs.existsSync(rootDir)) return '';
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isFile() && entry.name === fileName) {
        return fullPath;
      }
      if (entry.isDirectory()) {
        stack.push(fullPath);
      }
    }
  }
  return '';
}

function prependPathDirs(...dirs) {
  const validDirs = dirs.filter(Boolean);
  if (!validDirs.length) return;
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const currentPath = process.env[pathKey] || process.env.PATH || '';
  process.env[pathKey] = [...validDirs, currentPath].join(path.delimiter);
}

function currentToolPlatform() {
  if (process.platform === 'win32') return 'win32-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (process.platform === 'linux') return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  return `${process.platform}-${process.arch}`;
}

function executableIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  try {
    if (process.platform !== 'win32') fs.chmodSync(filePath, 0o755);
  } catch {}
  return filePath;
}

function resolveBundledTool(appRoot, baseName, fallbackPath) {
  const fileName = process.platform === 'win32' ? `${baseName}.exe` : baseName;
  return executableIfExists(path.join(appRoot, 'vendor', 'tools', currentToolPlatform(), fileName))
    || executableIfExists(fallbackPath)
    || fileName;
}

function resolveNodeRuntime(appRoot) {
  const fileName = process.platform === 'win32' ? 'node.exe' : 'node';
  return executableIfExists(path.join(appRoot, 'vendor', 'tools', currentToolPlatform(), fileName))
    || (app.isPackaged && executableIfExists(process.execPath))
    || executableIfExists(process.env.npm_node_execpath)
    || fileName;
}

function requirePackagedFile(filePath, label, executable = false) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`Packaged app is missing ${label}: ${filePath || '(not found)'}`);
  }
  return executable ? executableIfExists(filePath) : filePath;
}

function verifyPackagedWhisper(whisperPath) {
  const result = spawnSync(whisperPath, ['--self-test'], {
    cwd: path.dirname(whisperPath),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`Packaged Whisper runtime cannot start${detail ? `: ${detail}` : ''}`);
  }
}

function configureRuntime() {
  const appRoot = path.resolve(__dirname, '..');
  const dataRoot = path.join(appRoot, 'data');
  const toolPlatform = currentToolPlatform();
  const chromeRoot = path.join(appRoot, 'vendor', 'chrome');
  const chromeBinary = findFirstFile(chromeRoot, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
  const bundledToolsDir = path.join(appRoot, 'vendor', 'tools', toolPlatform);
  const nodePath = resolveNodeRuntime(appRoot);
  const bundledFfmpegPath = path.join(bundledToolsDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const bundledFfprobePath = path.join(bundledToolsDir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  const whisperPath = path.join(appRoot, 'vendor', 'whisper', toolPlatform, process.platform === 'win32' ? 'whisper-transcribe.exe' : 'whisper-transcribe');
  const whisperModelDir = path.join(appRoot, 'vendor', 'whisper', 'models', 'faster-whisper-small');
  const whisperModelFiles = ['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt'];
  const whisperFiles = [whisperPath, ...whisperModelFiles.map((fileName) => path.join(whisperModelDir, fileName))];
  const bundledWhisperReady = whisperFiles.every((filePath) => fs.existsSync(filePath));
  const ffmpegPath = app.isPackaged
    ? requirePackagedFile(bundledFfmpegPath, 'FFmpeg', true)
    : resolveBundledTool(appRoot, 'ffmpeg', require('ffmpeg-static'));
  const ffprobeModule = app.isPackaged ? null : require('ffprobe-static');
  const ffprobePath = app.isPackaged
    ? requirePackagedFile(bundledFfprobePath, 'FFprobe', true)
    : resolveBundledTool(appRoot, 'ffprobe', ffprobeModule.path || ffprobeModule);

  if (app.isPackaged) {
    requirePackagedFile(chromeBinary, 'Chrome Headless Shell', true);
    if (bundledWhisperReady) {
      verifyPackagedWhisper(requirePackagedFile(whisperPath, 'Whisper runtime', true));
    } else {
      console.warn('Bundled Whisper runtime is unavailable; subtitles will use text-duration timing.');
    }
  }

  process.env.VIBE_TOOL_DATA_DIR = dataRoot;
  process.env.VIBE_TOOL_NODE_PATH = nodePath;
  if (app.isPackaged && nodePath === process.execPath) {
    process.env.ELECTRON_RUN_AS_NODE = '1';
  }
  process.env.VIBE_TOOL_FFMPEG_PATH = ffmpegPath;
  process.env.VIBE_TOOL_FFPROBE_PATH = ffprobePath;
  process.env.VIBE_TOOL_FORCE_BUNDLED_TOOLS = '1';
  if (app.isPackaged) {
    process.env.VIBE_TOOL_REQUIRE_BUNDLED_RUNTIME = '1';
    if (bundledWhisperReady) {
      process.env.VIBE_TOOL_WHISPER_TRANSCRIBE = whisperPath;
      process.env.VIBE_TOOL_WHISPER_MODEL_DIR = path.join(appRoot, 'vendor', 'whisper', 'models');
      process.env.VIBE_TOOL_WHISPER_MODEL = 'small';
      process.env.VIBE_TOOL_WHISPER_DEVICE = 'cpu';
      process.env.VIBE_TOOL_WHISPER_COMPUTE_TYPE = 'int8';
    }
  }

  if (chromeBinary) {
    process.env.CHROME_PATH = chromeBinary;
    process.env.HYPERFRAMES_BROWSER_PATH = chromeBinary;
  }

  prependPathDirs(
    path.isAbsolute(nodePath) ? path.dirname(nodePath) : '',
    path.dirname(ffmpegPath),
    path.dirname(ffprobePath),
    chromeBinary && path.dirname(chromeBinary)
  );
}

function pushLog(message, level = 'info') {
  const entry = {
    time: new Date().toLocaleTimeString(),
    level,
    message: String(message)
  };
  logLines.push(entry);
  if (logLines.length > 500) logLines.shift();

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(`window.appendLog?.(${JSON.stringify(entry)})`).catch(() => {});
  }
}

function launcherHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${APP_NAME}</title>
  <style>
    * {
      box-sizing: border-box;
    }
    html,
    body {
      height: 100%;
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #1e293b;
      background: #eef2f5;
      overflow: hidden;
    }
    .app-shell {
      height: 100vh;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }
    header {
      padding: 18px 22px 14px;
      border-bottom: 1px solid rgba(0, 0, 0, 0.04);
      background: #ffffff;
    }
    .brand-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .brand {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }
    h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1.1;
      font-weight: 800;
      letter-spacing: -0.02em;
      color: #0f172a;
    }
    p {
      margin: 0;
      color: #64748b;
      font-size: 13px;
      line-height: 1.45;
    }
    .content {
      min-height: 0;
      overflow: auto;
      padding: 16px 22px 20px;
      display: grid;
      grid-template-columns: minmax(430px, 0.95fr) minmax(560px, 1.05fr);
      gap: 16px;
    }
    section {
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-width: 0;
    }
    .panel {
      border: 1px solid rgba(0, 0, 0, 0.04);
      border-radius: 20px;
      background: #ffffff;
      padding: 16px;
      min-width: 0;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.03), 0 1px 3px rgba(0, 0, 0, 0.02);
    }
    .right-stack {
      min-height: 0;
      display: grid;
      grid-template-rows: auto minmax(180px, 1fr);
      gap: 16px;
    }
    h2 {
      margin: 0;
      font-size: 14px;
      line-height: 1.2;
      font-weight: 700;
      color: #0f172a;
    }
    .panel-note {
      margin-top: -2px;
      color: #64748b;
      font-size: 12px;
      line-height: 1.45;
    }
    ul {
      display: grid;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(190px, auto);
      align-items: center;
      gap: 12px;
      padding: 10px 12px;
      border: 1px solid rgba(0, 0, 0, 0.04);
      border-radius: 12px;
      background: #ffffff;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.01);
    }
    .port-title {
      display: block;
      font-size: 13px;
      font-weight: 800;
      color: #0f172a;
    }
    .port-desc {
      display: block;
      margin-top: 3px;
      color: #64748b;
      font-size: 11px;
      line-height: 1.35;
    }
    .link-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
    }
    button {
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      background: #ffffff;
      color: #1e293b;
      font: inherit;
      font-size: 12px;
      font-weight: 700;
      padding: 8px 12px;
      cursor: pointer;
      max-width: 100%;
      transition: all 0.15s ease;
    }
    button:hover {
      background: #f8fafc;
      border-color: #94a3b8;
    }
    button:disabled {
      cursor: wait;
      opacity: 0.55;
    }
    .primary-button {
      border: none;
      background: linear-gradient(135deg, #2563eb, #1d4ed8);
      color: #ffffff;
      white-space: nowrap;
      box-shadow: 0 4px 12px rgba(37, 99, 235, 0.2);
    }
    .primary-button:hover {
      background: linear-gradient(135deg, #1d4ed8, #1e40af);
      box-shadow: 0 6px 16px rgba(37, 99, 235, 0.3);
    }
    .url-button {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      overflow-wrap: anywhere;
      text-align: right;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
    }
    .service-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(165px, 1fr));
      gap: 10px;
    }
    .service-card {
      border: 1px solid rgba(0, 0, 0, 0.04);
      border-radius: 12px;
      background: #ffffff;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-width: 0;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.01);
    }
    .service-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
    }
    .service-title {
      min-width: 0;
    }
    .service-title strong,
    .service-title span {
      display: block;
    }
    .service-title strong {
      font-size: 13px;
      color: #0f172a;
    }
    .service-title span,
    .service-meta {
      color: #64748b;
      font-size: 11px;
      line-height: 1.35;
      word-break: break-word;
    }
    .service-title span {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      overflow-wrap: anywhere;
    }
    .pill {
      align-self: flex-start;
      border-radius: 999px;
      padding: 4px 10px;
      background: #f1f5f9;
      color: #64748b;
      font-size: 11px;
      font-weight: 700;
    }
    .pill.running {
      background: rgba(37, 99, 235, 0.08);
      color: #2563eb;
    }
    .switch {
      position: relative;
      width: 42px;
      height: 24px;
      flex: 0 0 auto;
    }
    .switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .track {
      position: absolute;
      inset: 0;
      border-radius: 999px;
      background: #cbd5e1;
      transition: 0.18s ease;
    }
    .track::after {
      content: "";
      position: absolute;
      width: 18px;
      height: 18px;
      left: 3px;
      top: 3px;
      border-radius: 50%;
      background: #ffffff;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
      transition: 0.18s ease;
    }
    .switch input:checked + .track {
      background: #2563eb;
    }
    .switch input:checked + .track::after {
      transform: translateX(18px);
    }
    .service-actions {
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
    .extension-card {
      border: 1px dashed #cbd5e1;
      border-radius: 12px;
      padding: 12px;
      background: #f8fafc;
      display: grid;
      gap: 10px;
    }
    .extension-card strong {
      font-size: 13px;
      color: #0f172a;
    }
    pre {
      height: 100%;
      min-height: 150px;
      margin: 0;
      padding: 12px;
      overflow: auto;
      border-radius: 12px;
      background: #0f172a;
      color: #cbd5e1;
      border: 1px solid rgba(255, 255, 255, 0.03);
      font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre-wrap;
    }
    .error {
      color: #ef4444;
    }
    @media (max-width: 860px) {
      .content {
        grid-template-columns: 1fr;
      }
      .service-grid {
        grid-template-columns: 1fr;
      }
      .brand-row,
      .link-row {
        align-items: flex-start;
        flex-direction: column;
      }
      .actions {
        justify-content: flex-start;
      }
      li {
        grid-template-columns: 1fr;
      }
      .url-button {
        width: 100%;
        text-align: left;
      }
    }
  </style>
</head>
<body>
  <div class="app-shell">
    <header>
      <div class="brand-row">
        <div class="brand">
          <h1>Video Studio <span style="font-size: 14px; font-weight: normal; opacity: 0.6; margin-left: 8px; vertical-align: middle;">v${app.getVersion()}</span></h1>
          <p>Hãy giữ cửa sổ này mở trong khi làm việc. Giao diện tạo video dùng trong trình duyệt; các dịch vụ local chỉ bật khi quy trình cần.</p>
        </div>
        <button type="button" class="primary-button" data-open-url="http://localhost:3000">Mở Giao diện Web</button>
      </div>
    </header>
    <main class="content">
      <section class="panel">
        <h2>Các cổng truy cập trên trình duyệt</h2>
        <p class="panel-note">Mở các địa chỉ này trong trình duyệt. Nếu dịch vụ đang tắt, cổng tương ứng sẽ chưa phản hồi cho tới khi bạn bật ở bên phải.</p>
        <ul id="services"></ul>
        <div class="extension-card">
          <div>
            <strong>Extension Chrome cho FlowKit</strong>
            <p>Cần cho tính năng Google Flow. Tải extension, giải nén, rồi vào Chrome Extensions -> bật Developer mode -> Load unpacked.</p>
          </div>
          <button type="button" data-action="download-flowkit-extension">Tải extension FlowKit</button>
        </div>
      </section>
      <div class="right-stack">
        <section class="panel">
          <div class="link-row">
            <div>
              <h2>Dịch vụ local</h2>
              <p class="panel-note">Chỉ bật dịch vụ đang cần để giảm CPU/RAM khi máy rảnh.</p>
            </div>
            <div class="actions">
              <button type="button" data-action="refresh">Làm mới</button>
              <button type="button" data-action="restart-all">Khởi động lại dịch vụ</button>
              <button type="button" data-action="clear-logs">Xoá log</button>
            </div>
          </div>
          <div class="service-grid" id="service-grid"></div>
        </section>
        <section class="panel log-panel">
          <h2>Log terminal</h2>
          <pre id="logs"></pre>
        </section>
      </div>
    </main>
  </div>
  <script>
    const servicesEl = document.getElementById('services');
    const serviceGridEl = document.getElementById('service-grid');
    const logsEl = document.getElementById('logs');
    const statusText = (service) => {
      if (service.starting) return 'Đang khởi động...';
      if (service.running && service.managed) return 'Đang chạy bởi app';
      if (service.running && service.external) return 'Đang chạy ngoài app, app sẽ dừng khi thoát';
      if (service.skipped) return service.reason || 'Đã bỏ qua';
      return 'Đang tắt';
    };
    window.setServices = (services) => {
      servicesEl.innerHTML = services.map((service) => {
        return '<li><span><span class="port-title">' + service.name + '</span><span class="port-desc">' + service.description + '</span></span><button class="url-button" type="button" data-open-url="' + service.url + '">' + service.url + '</button></li>';
      }).join('');
    };
    window.setLocalServices = (data) => {
      const services = data?.services || [];
      serviceGridEl.innerHTML = services.map((service) => {
        const checked = service.running || service.starting ? 'checked' : '';
        const disabled = service.starting ? 'disabled' : '';
        const pillClass = service.running || service.starting ? 'pill running' : 'pill';
        const openUrl = service.dashboardUrl || service.url || '';
        const serviceAddress = String(service.url || '').replace('http://localhost:', 'Cổng ');
        return '<article class="service-card">' +
          '<div class="service-head">' +
            '<div class="service-title"><strong>' + service.label + '</strong><span>' + serviceAddress + '</span></div>' +
            '<label class="switch"><input type="checkbox" data-service-toggle="' + service.name + '" ' + checked + ' ' + disabled + '><span class="track"></span></label>' +
          '</div>' +
          '<span class="' + pillClass + '">' + statusText(service) + '</span>' +
          '<div class="service-meta">' + (service.reason || '') + '</div>' +
          '<div class="service-actions">' +
            '<button type="button" data-service-action="restart" data-service-name="' + service.name + '" ' + disabled + '>Khởi động lại</button>' +
            (openUrl ? '<button type="button" data-open-url="' + openUrl + '">Mở</button>' : '') +
          '</div>' +
        '</article>';
      }).join('');
    };
    window.appendLog = (entry) => {
      const line = document.createElement('div');
      line.className = entry.level === 'error' ? 'error' : '';
      line.textContent = '[' + entry.time + '] ' + entry.message;
      logsEl.appendChild(line);
      logsEl.scrollTop = logsEl.scrollHeight;
    };
    window.clearLogs = () => {
      logsEl.textContent = '';
    };
    async function refreshServices() {
      const data = await window.vibeLauncher.listServices();
      window.setLocalServices(data);
    }
    document.addEventListener('click', async (event) => {
      const openButton = event.target.closest('[data-open-url]');
      if (openButton) {
        await window.vibeLauncher.openExternal(openButton.dataset.openUrl);
        return;
      }
      const actionButton = event.target.closest('[data-action], [data-service-action]');
      if (!actionButton) return;
      actionButton.disabled = true;
      try {
        if (actionButton.dataset.action === 'refresh') await refreshServices();
        if (actionButton.dataset.action === 'restart-all') {
          window.setLocalServices(await window.vibeLauncher.restartServices());
        }
        if (actionButton.dataset.action === 'clear-logs') {
          await window.vibeLauncher.clearLogs();
          window.clearLogs();
          await refreshServices();
        }
        if (actionButton.dataset.action === 'download-flowkit-extension') {
          await window.vibeLauncher.downloadFlowkitExtension();
        }
        if (actionButton.dataset.serviceAction === 'restart') {
          window.setLocalServices(await window.vibeLauncher.restartService(actionButton.dataset.serviceName));
        }
      } catch (error) {
        window.appendLog({ time: new Date().toLocaleTimeString(), level: 'error', message: error.message || String(error) });
      } finally {
        actionButton.disabled = false;
      }
    });
    document.addEventListener('change', async (event) => {
      const toggle = event.target.closest('[data-service-toggle]');
      if (!toggle) return;
      toggle.disabled = true;
      try {
        const data = toggle.checked
          ? await window.vibeLauncher.startService(toggle.dataset.serviceToggle)
          : await window.vibeLauncher.stopService(toggle.dataset.serviceToggle);
        window.setLocalServices(data);
      } catch (error) {
        window.appendLog({ time: new Date().toLocaleTimeString(), level: 'error', message: error.message || String(error) });
        await refreshServices();
      }
    });
    setInterval(refreshServices, 5000);
    refreshServices().catch((error) => {
      window.appendLog({ time: new Date().toLocaleTimeString(), level: 'error', message: error.message || String(error) });
    });
  </script>
</body>
</html>`;
}

async function createLogWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: LAUNCHER_WIDTH,
    height: LAUNCHER_HEIGHT,
    minWidth: LAUNCHER_WIDTH,
    minHeight: LAUNCHER_HEIGHT,
    maxWidth: LAUNCHER_WIDTH,
    maxHeight: LAUNCHER_HEIGHT,
    resizable: false,
    maximizable: true,
    fullscreenable: true,
    title: APP_NAME,
    backgroundColor: '#f7f8f4',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(launcherHtml())}`);
  if (serviceLinks.length) {
    mainWindow.webContents.executeJavaScript(`window.setServices?.(${JSON.stringify(serviceLinks)})`).catch(() => {});
  }
  if (localServicesHandle) {
    const serviceState = await localServicesHandle.list();
    mainWindow.webContents.executeJavaScript(`window.setLocalServices?.(${JSON.stringify(serviceState)})`).catch(() => {});
  }
  for (const entry of logLines) {
    mainWindow.webContents.executeJavaScript(`window.appendLog?.(${JSON.stringify(entry)})`).catch(() => {});
  }
}

function setServiceLinks(services) {
  serviceLinks = services;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.executeJavaScript(`window.setServices?.(${JSON.stringify(services)})`).catch(() => {});
}

function zipDirectory(sourceDir, outputFile, label = 'extension') {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Không tìm thấy thư mục ${label}: ${sourceDir}`);
  }
  if (process.platform === 'darwin') {
    const result = spawnSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', sourceDir, outputFile], {
      encoding: 'utf8'
    });
    if (result.error || result.status !== 0) {
      throw new Error(result.stderr || result.error?.message || `Không thể nén ${label}.`);
    }
    return;
  }
  if (process.platform === 'win32') {
    const command = [
      'Compress-Archive',
      '-Path',
      JSON.stringify(path.join(sourceDir, '*')),
      '-DestinationPath',
      JSON.stringify(outputFile),
      '-Force'
    ].join(' ');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
      encoding: 'utf8'
    });
    if (result.error || result.status !== 0) {
      throw new Error(result.stderr || result.error?.message || `Không thể nén ${label}.`);
    }
    return;
  }
  const result = spawnSync('zip', ['-qr', outputFile, path.basename(sourceDir)], {
    cwd: path.dirname(sourceDir),
    encoding: 'utf8'
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.stderr || result.error?.message || `Không thể nén ${label}.`);
  }
}

async function downloadFlowkitExtension() {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Lưu extension FlowKit',
    defaultPath: path.join(app.getPath('downloads'), 'flowkit-extension.zip'),
    filters: [{ name: 'Zip archive', extensions: ['zip'] }]
  });
  if (canceled || !filePath) return { canceled: true };
  zipDirectory(FLOWKIT_EXTENSION_DIR, filePath, 'extension FlowKit');
  pushLog(`Đã lưu extension FlowKit tại ${filePath}`);
  await shell.showItemInFolder(filePath);
  return { filePath };
}

async function webAppIsHealthy(url) {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return false;
    const data = await response.json().catch(() => ({}));
    return data?.ok === true;
  } catch {
    return false;
  }
}

async function startLocalServices() {
  await createLogWindow();
  configureRuntime();

  const { createLocalServiceManager, startServer, stopPortListeners } = require('../server');
  const port = Number(process.env.PORT || DEFAULT_APP_PORT);
  const host = 'localhost';
  const appUrl = `http://${host}:${port}`;
  localServicesHandle = createLocalServiceManager({ onLog: pushLog, stopExternal: true });

  if (await webAppIsHealthy(appUrl)) {
    pushLog(`Web app cũ đang chạy tại ${appUrl}; đang dừng để launcher quản lý vòng đời.`);
    await stopPortListeners(port);
  }
  pushLog('Đang khởi động giao diện web...');
  serverHandle = await startServer({
    host,
    port,
    localServices: localServicesHandle
  });

  setServiceLinks([
    {
      name: 'Giao diện web Video Studio',
      url: serverHandle.url,
      description: 'Giao diện chính để tạo, chỉnh sửa, render và quản lý dự án video.'
    },
    {
      name: '9Router dashboard',
      url: 'http://localhost:20128/dashboard',
      description: 'Trang quản trị trạm trung chuyển LLM. Kết nối các nền tảng AI tại đây, rồi Video Studio gọi qua 9Router.'
    },
    {
      name: '9Router API',
      url: 'http://localhost:20128/v1',
      description: 'Đầu API tương thích OpenAI. Video Studio dùng cổng này khi chọn nhà cung cấp LLM là 9Router.'
    },
    {
      name: 'FlowKit API',
      url: 'http://localhost:8100',
      description: 'Cầu nối local để tạo ảnh/video bằng Google Flow. Cần cài extension Chrome FlowKit.'
    },
    {
      name: 'OmniVoice API',
      url: 'http://localhost:8101',
      description: 'Dịch vụ TTS và clone giọng local, dùng để tạo lời đọc mà không cần API voice bên ngoài.'
    }
  ]);
  pushLog('Sẵn sàng. Mở Video Studio trên trình duyệt, rồi bật dịch vụ local khi cần.');
}

function registerLauncherIpc() {
  ipcMain.handle('launcher:list-services', async () => localServicesHandle?.list() || { services: [], logs: [] });
  ipcMain.handle('launcher:start-service', async (event, name) => {
    await localServicesHandle.start(name);
    return localServicesHandle.list();
  });
  ipcMain.handle('launcher:stop-service', async (event, name) => {
    await localServicesHandle.stop(name);
    return localServicesHandle.list();
  });
  ipcMain.handle('launcher:restart-service', async (event, name) => {
    await localServicesHandle.restart(name);
    return localServicesHandle.list();
  });
  ipcMain.handle('launcher:restart-services', async () => {
    await localServicesHandle.stopAll();
    return localServicesHandle.startAll();
  });
  ipcMain.handle('launcher:clear-logs', async () => {
    logLines.length = 0;
    localServicesHandle?.clearLogs();
    return localServicesHandle?.list() || { services: [], logs: [] };
  });
  ipcMain.handle('launcher:open-external', async (event, url) => {
    await shell.openExternal(url);
  });
  ipcMain.handle('launcher:download-flowkit-extension', async () => downloadFlowkitExtension());
}

app.setName(APP_NAME);
registerLauncherIpc();

function setupAutoUpdater() {
  autoUpdater.logger = console;
  
  app.on('ready', () => {
    if (app.isPackaged) {
      autoUpdater.checkForUpdatesAndNotify().catch((err) => {
        pushLog(`Lỗi kiểm tra cập nhật: ${err.message}`, 'error');
      });
    }
  });

  autoUpdater.on('checking-for-update', () => {
    pushLog('Đang kiểm tra bản cập nhật mới...');
  });

  autoUpdater.on('update-available', (info) => {
    pushLog(`Phát hiện bản cập nhật mới: Phiên bản ${info.version}. Đang tiến hành tải xuống...`);
  });

  autoUpdater.on('update-not-available', () => {
    pushLog('Ứng dụng đã ở phiên bản mới nhất.');
  });

  autoUpdater.on('error', (err) => {
    pushLog(`Lỗi tự động cập nhật: ${err.message}`, 'error');
  });

  autoUpdater.on('download-progress', (progressObj) => {
    // Chạy ngầm hoàn toàn, không spam log trên giao diện
  });

  autoUpdater.on('update-downloaded', (info) => {
    pushLog(`Tải xong bản cập nhật phiên bản ${info.version}. Sẽ tự động cài đặt khi khởi động lại app.`);
    
    dialog.showMessageBox({
      type: 'info',
      title: 'Bản cập nhật đã sẵn sàng',
      message: `Bản cập nhật phiên bản ${info.version} đã tải xuống thành công. Khởi động lại ứng dụng ngay để hoàn tất nâng cấp?`,
      buttons: ['Khởi động lại ngay', 'Để sau']
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  });
}

setupAutoUpdater();

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady()
    .then(startLocalServices)
    .catch((error) => {
      pushLog(error?.stack || error?.message || String(error), 'error');
      dialog.showErrorBox(`${APP_NAME} failed to start`, error?.stack || error?.message || String(error));
      app.quit();
    });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createLogWindow().catch((error) => {
        dialog.showErrorBox(`${APP_NAME} failed to start`, error?.stack || error?.message || String(error));
      });
    }
  });

  app.on('before-quit', (event) => {
    if (isQuitting) return;
    isQuitting = true;
    event.preventDefault();
    pushLog('Đang dừng cưỡng bức các dịch vụ local và server...');
    Promise.resolve()
      .then(() => serverHandle?.localServices?.forceKillAll())
      .then(() => serverHandle?.close())
      .then(async () => {
        if (serverHandle?.external) {
          const { stopPortListeners } = require('../server');
          await stopPortListeners(DEFAULT_APP_PORT);
        }
      })
      .catch((error) => {
        pushLog(error?.stack || error?.message || String(error), 'error');
      })
      .finally(() => {
        app.exit(0);
      });
  });
}
