const fs = require('fs').promises;
const path = require('path');
const IMAGE_URL_REGEX = /https:\/\/files\.chat01\.ai\/[^\s()<>]+?\.(png|jpg|jpeg|webp|gif)/i;

function stripCodeFence(content) {
  const trimmed = String(content || '').trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch ? fencedMatch[1].trim() : trimmed;
}

function extractFirstJsonObject(content) {
  const text = stripCodeFence(content);
  const start = text.indexOf('{');
  if (start < 0) {
    throw new Error(`No JSON object found in response: ${text.slice(0, 200)}`);
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  throw new Error(`Incomplete JSON object in response: ${text.slice(0, 200)}`);
}

function parseJsonContent(content) {
  const normalized = stripCodeFence(content);
  try {
    return JSON.parse(normalized);
  } catch {
    return JSON.parse(extractFirstJsonObject(normalized));
  }
}

function buildJsonRetryPrompt(prompt, error) {
  return [
    prompt,
    '',
    'LẦN TRẢ LỜI TRƯỚC BỊ LỖI JSON HOẶC BỊ CẮT GIỮA CHỪNG.',
    `Lỗi parser: ${String(error?.message || error).slice(0, 500)}`,
    'Hãy trả lại JSON hoàn chỉnh, hợp lệ, ngắn gọn hơn nếu cần.',
    'Không thêm markdown, không giải thích, không dùng backtick.'
  ].join('\n');
}

function parseKeys(chato1KeysText) {
  const seen = new Set();
  return String(chato1KeysText || '')
    .split(/[\s,;]+/g)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item)) {
        return false;
      }
      seen.add(item);
      return true;
    });
}

class Chat01Client {
  constructor(settings) {
    this.keys = parseKeys(settings.chato1KeysText);
    this.imageKeys = parseKeys(settings.imageChat01KeysText);
    this.aiModel = String(settings.aiModel || '').trim();
    this.imageModel = String(settings.imageModel || '').trim();
    this.index = 0;
    this.imageIndex = 0;
    this.projectId = settings._projectId || null;
  }

  getKeyPool(kind = 'llm') {
    return kind === 'image'
      ? { keys: this.imageKeys, index: this.imageIndex }
      : { keys: this.keys, index: this.index };
  }

  setKeyPool(kind = 'llm', keys, index) {
    if (kind === 'image') {
      this.imageKeys = keys;
      this.imageIndex = index;
      return;
    }
    this.keys = keys;
    this.index = index;
  }

  getNextKey(attempted = new Set(), kind = 'llm') {
    const pool = this.getKeyPool(kind);
    if (!pool.keys.length) {
      throw new Error('Missing Chato1 API key');
    }
    const scanCount = pool.keys.length;
    for (let offset = 0; offset < scanCount; offset += 1) {
      const key = pool.keys[pool.index % pool.keys.length];
      pool.index = (pool.index + 1) % pool.keys.length;
      this.setKeyPool(kind, pool.keys, pool.index);
      if (!attempted.has(key)) {
        return key;
      }
    }
    return null;
  }

  invalidateKey(key, kind = 'llm') {
    const pool = this.getKeyPool(kind);
    const removedIndex = pool.keys.indexOf(key);
    const previousIndex = pool.index;
    const nextKeys = pool.keys.filter((item) => item !== key);
    if (!nextKeys.length) {
      this.setKeyPool(kind, nextKeys, 0);
      return;
    }
    let nextIndex = previousIndex;
    if (removedIndex >= 0 && removedIndex < previousIndex) {
      nextIndex = Math.max(0, previousIndex - 1);
    }
    nextIndex %= nextKeys.length;
    this.setKeyPool(kind, nextKeys, nextIndex);
  }

  async request(body, kind = 'llm') {
    const pool = this.getKeyPool(kind);
    if (!pool.keys.length) {
      throw new Error('Missing Chato1 API key');
    }
    // LLM: timeout 600s (10min) - large script/HTML generation and thinking models need more time.
    // Image: timeout 300s (5min) as image generation is slower per-key.
    const timeoutMs = kind === 'image' ? 300000 : 600000;

    // LLM: retry max 3 keys to avoid 24×150s = 60-minute hang.
    // Image: retry all keys since each key has independent image capacity.
    const maxAttempts = kind === 'image' ? pool.keys.length : Math.min(pool.keys.length, 3);

    const attempted = new Set();
    let lastError = null;

    while (this.getKeyPool(kind).keys.length && attempted.size < maxAttempts) {
      const key = this.getNextKey(attempted, kind);
      if (!key) {
        break;
      }
      attempted.add(key);

      try {
        // Build combined abort signal: timeout + pause signal (if projectId is set)
        let signal;
        let pauseSignal = null;
        if (this.projectId) {
          try {
            const { createPauseSignal, clearPauseSignal } = require('./jobManager');
            pauseSignal = createPauseSignal(this.projectId);
          } catch (e) { /* jobManager not available */ }
        }
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        signal = pauseSignal
          ? (AbortSignal.any ? AbortSignal.any([timeoutSignal, pauseSignal]) : timeoutSignal)
          : timeoutSignal;

        const response = await fetch('https://chat01.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`
          },
          body: JSON.stringify(body),
          signal
        });

        if (response.ok) {
          const data = await response.json();
          return data.choices?.[0]?.message?.content || '';
        }

        const text = await response.text().catch(() => '');
        lastError = new Error(`Chat01 request failed: ${response.status} ${text}`);
        if (response.status === 401 || response.status === 403) {
          // Auth error — this key is invalid, rotate to next key
          this.invalidateKey(key, kind);
          continue;
        }
        // Other HTTP errors (429, 5xx): rotate key and try next
        if (response.status === 429 || response.status >= 500) {
          continue;
        }
        // 4xx client errors (bad request, unsupported model, etc.) — no point retrying
        throw lastError;
      } catch (error) {
        // Check if this was a pause abort — must propagate immediately regardless of kind
        if (this.projectId && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
          try {
            const { isPauseRequested } = require('./jobManager');
            if (isPauseRequested(this.projectId)) {
              const pauseErr = new Error('Tạm dừng bởi người dùng');
              pauseErr.name = 'PipelinePausedError';
              throw pauseErr;
            }
          } catch (pauseCheckErr) {
            if (pauseCheckErr.name === 'PipelinePausedError') throw pauseCheckErr;
          }
        }
        if (error.name === 'TimeoutError' || error.name === 'AbortError') {
          // Timeout: rotate to next key — the timeout may be specific to this key's server load.
          // maxAttempts cap (3 for LLM, all for image) prevents infinite loops.
          lastError = new Error(`Chat01 ${kind} request timed out after ${timeoutMs / 1000}s for this key. Trying next key...`);
          continue;
        }
        lastError = error;
        // For other unexpected errors, try next key
      }

    }

    const detail = lastError?.message ? ` Last error: ${lastError.message}` : '';
    throw new Error(`All Chat01 API keys failed for this session.${detail}`);
  }

  async generateJson(prompt, model = 'gpt-5-5') {
    let activePrompt = prompt;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const content = await this.request({
        model: this.aiModel || model,
        messages: [{ role: 'user', content: activePrompt }],
        response_format: { type: 'json_object' }
      });
      try {
        return parseJsonContent(content);
      } catch (error) {
        lastError = error;
        activePrompt = buildJsonRetryPrompt(prompt, error);
      }
    }
    throw lastError;
  }

  async generateText(prompt) {
    return this.request({
      model: this.aiModel || 'gpt-5-5',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7
    });
  }

  async generateImage(prompt, refImageUrl = '') {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 2000;

    const resolvedRefUrl = await getReferenceImageAsDataUrl(refImageUrl);

    let lastRaw = '';
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      // Lần retry cuối bỏ refImage — tránh trường hợp ảnh tham chiếu gây từ chối
      const useRef = resolvedRefUrl && attempt < MAX_RETRIES - 1;

      const content = useRef
        ? [
            {
              type: 'text',
              text: `CRITICAL INSTRUCTIONS FOR IMAGE GENERATION:
The attached reference image is used ONLY to identify the CHARACTER'S FACE AND IDENTITY.

${prompt}`
            },
            {
              type: 'image_url',
              image_url: { url: resolvedRefUrl }
            }
          ]
        : prompt;

      const raw = await this.request({
        model: this.imageModel || 'gpt-5-5',
        messages: [{ role: 'user', content }]
      }, 'image');

      const match = raw.match(IMAGE_URL_REGEX);
      if (match) return match[0];

      lastRaw = raw;
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }

    throw new Error(
      `Chat01 image response does not contain file URL after ${MAX_RETRIES} attempts. Last response: ${lastRaw.slice(0, 300) || '(empty)'}`
    );
  }
}

async function getReferenceImageAsDataUrl(refImageUrl) {
  if (!refImageUrl) return '';
  const trimmed = String(refImageUrl).trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('data:')) {
    return trimmed;
  }

  let absolutePath = trimmed;
  if (trimmed.startsWith('/projects/') || trimmed.startsWith('/assets/')) {
    try {
      const { resolveWebsitePath } = require('./mediaSourceService');
      absolutePath = resolveWebsitePath(trimmed);
    } catch (e) {
      const { PROJECTS_DIR, ASSETS_DIR, PUBLIC_DIR } = require('../config/constants');
      const cleanRelative = trimmed.split('?')[0].split('#')[0];
      if (cleanRelative.startsWith('/projects/')) {
        absolutePath = path.join(PROJECTS_DIR, cleanRelative.slice('/projects/'.length));
      } else if (cleanRelative.startsWith('/assets/')) {
        absolutePath = path.join(ASSETS_DIR, cleanRelative.slice('/assets/'.length));
      } else {
        absolutePath = path.join(PUBLIC_DIR, cleanRelative.slice(1));
      }
    }
  }

  const cleanPath = absolutePath.split('?')[0].split('#')[0];
  try {
    const buffer = await fs.readFile(cleanPath);
    const ext = path.extname(cleanPath).toLowerCase();
    let mimeType = 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
    else if (ext === '.webp') mimeType = 'image/webp';
    else if (ext === '.gif') mimeType = 'image/gif';
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  } catch (err) {
    console.error(`[Chat01Client] Failed to read reference image at ${cleanPath}:`, err.message);
    return trimmed;
  }
}

module.exports = {
  Chat01Client
};
