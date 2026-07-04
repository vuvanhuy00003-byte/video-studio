const { Chat01Client } = require('./chat01Client');
const { sanitizeApiKeyError, withApiKeyFallback } = require('./providerUtils');

const NINE_ROUTER_DEFAULT_BASE_URL = 'http://127.0.0.1:20128/v1';
const DEFAULT_AI_MAX_RETRIES = 5;
const DEFAULT_AI_RETRY_DELAY_MS = 2000;
const DEFAULT_AI_MAX_RETRY_DELAY_MS = 10000;

const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    keyField: 'openaiKeysText',
    endpoint: 'https://api.openai.com/v1/responses',
    apiKind: 'openai-responses',
    defaultModel: 'gpt-5.5'
  },
  claude: {
    label: 'Claude',
    keyField: 'claudeKeysText',
    endpoint: 'https://api.anthropic.com/v1/messages',
    apiKind: 'claude-messages',
    defaultModel: 'claude-opus-4-6',
    apiVersion: '2023-06-01'
  },
  gemini: {
    label: 'Gemini',
    keyField: 'geminiKeysText',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
    apiKind: 'gemini',
    defaultModel: 'gemini-flash-latest'
  },
  deepseek: {
    label: 'DeepSeek',
    keyField: 'deepseekKeysText',
    endpoint: 'https://api.deepseek.com/chat/completions',
    apiKind: 'chat',
    defaultModel: 'deepseek-v4-pro'
  }
};

function stripCodeFence(content) {
  const trimmed = String(content || '').trim();
  const fencedMatch = trimmed.match(/^```(?:json|html|srt)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch ? fencedMatch[1].trim() : trimmed;
}

function extractFirstJsonObject(content) {
  const text = stripCodeFence(content);
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`No JSON object found in response: ${text.slice(0, 200)}`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
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

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(parsed, max);
}

function isRetryableProviderStatus(status) {
  return [429, 502, 503, 504].includes(Number(status));
}

function isRetryableProviderError(status, message = '') {
  const text = String(message || '');
  return isRetryableProviderStatus(status)
    || /RESOURCE_EXHAUSTED|RATE_LIMIT_EXCEEDED|rate.?limit|quota/i.test(text);
}

function parseRetryAfterHeader(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const dateMs = Date.parse(text);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

function parseDurationMs(value, numericUnit = 'seconds') {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return numericUnit === 'ms' ? value : value * 1000;
  }
  const text = String(value || '').trim();
  if (!text) return null;
  const match = text.match(/(\d+(?:\.\d+)?)\s*(ms|s)?\b/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  return match[2]?.toLowerCase() === 'ms' ? amount : amount * 1000;
}

function findRetryDelayMs(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const delay = findRetryDelayMs(item);
      if (delay != null) return delay;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    if (/retry.*delay|reset.*delay|quota.*delay|retry.*after/i.test(key)) {
      const delay = parseDurationMs(item, /ms$/i.test(key) ? 'ms' : 'seconds');
      if (delay != null) return delay;
    }
    if (item && typeof item === 'object') {
      const delay = findRetryDelayMs(item);
      if (delay != null) return delay;
    }
  }
  return null;
}

function retryDelayFromText(text) {
  const value = String(text || '');
  const named = value.match(/(?:quotaResetDelay|retryDelay|retryAfter|retry-after)\s*[:=]\s*["']?(\d+(?:\.\d+)?)\s*(ms|s)?/i);
  if (named) return parseDurationMs(`${named[1]}${named[2] || 's'}`);
  const reset = value.match(/quota (?:will )?reset(?:s)? after\s+(\d+(?:\.\d+)?)\s*(ms|s)?/i);
  if (reset) return parseDurationMs(`${reset[1]}${reset[2] || 's'}`);
  return null;
}

function getProviderErrorStatus(res, data) {
  if (!res.ok) return res.status;
  const code = Number(data?.error?.code || data?.code || data?.statusCode || data?.error?.statusCode || 0);
  if (Number.isFinite(code) && code > 0) return code;
  const statusText = String(data?.error?.status || data?.status || data?.error?.message || data?.message || '');
  if (/RESOURCE_EXHAUSTED|RATE_LIMIT_EXCEEDED|rate.?limit|quota/i.test(statusText)) return 429;
  return res.status;
}

function getProviderRetryDelayMs(res, data, raw, requestAttempt) {
  const maxDelay = parsePositiveInt(process.env.AI_MAX_RETRY_DELAY_MS, DEFAULT_AI_MAX_RETRY_DELAY_MS, 1000);
  const baseDelay = parsePositiveInt(process.env.AI_RETRY_DELAY_MS, DEFAULT_AI_RETRY_DELAY_MS, 250, maxDelay);
  const explicitDelay = parseRetryAfterHeader(res.headers?.get?.('retry-after'))
    ?? findRetryDelayMs(data)
    ?? retryDelayFromText(raw)
    ?? retryDelayFromText(data?.error?.message || data?.message || '');
  const delay = explicitDelay == null
    ? baseDelay * Math.pow(2, Math.max(0, requestAttempt - 1))
    : Math.max(baseDelay, explicitDelay + 500);
  return Math.min(delay, maxDelay);
}

function providerFetchError(provider, endpoint, error, apiKey = '') {
  const cause = error?.cause?.code || error?.cause?.message || error?.message || String(error);
  return new Error(`${provider.label} network request failed (${endpoint}): ${sanitizeApiKeyError(cause, [apiKey]).slice(0, 500)}`);
}

function extractContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (typeof part?.text === 'string') return part.text;
    if (typeof part?.content === 'string') return part.content;
    return '';
  }).join('');
}

function extractProviderText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  if (Array.isArray(data?.output)) return data.output.map((item) => extractContentText(item?.content)).join('');
  if (Array.isArray(data?.content)) return extractContentText(data.content);
  if (Array.isArray(data?.candidates)) {
    return data.candidates.map((candidate) => extractContentText(candidate?.content?.parts)).join('');
  }
  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  return extractContentText(choice?.message?.content ?? choice?.delta?.content ?? '');
}

function geminiEndpoint(provider, model) {
  return provider.endpoint.replace('{model}', encodeURIComponent(String(model || provider.defaultModel).replace(/^models\//i, '')));
}

function appendApiPath(baseUrl, version, resource) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (base.endsWith(resource)) return base;
  if (base.endsWith(`/${version}`)) return `${base}${resource}`;
  return `${base}/${version}${resource}`;
}

function nineRouterProvider(settings = {}) {
  const baseUrl = String(settings.nineRouterBaseUrl || NINE_ROUTER_DEFAULT_BASE_URL).trim();
  return {
    label: '9Router',
    keyField: 'nineRouterKeysText',
    endpoint: appendApiPath(baseUrl, 'v1', '/chat/completions'),
    apiKind: 'chat',
    defaultModel: 'kr/claude-sonnet-4.5'
  };
}

function customProvider(settings = {}) {
  const standard = String(settings.customApiStandard || 'openai');
  const baseUrl = String(settings.customApiBaseUrl || '').trim();
  if (!baseUrl) return null;
  if (standard === 'claude') {
    return {
      label: 'Custom API (Claude)',
      keyField: 'customApiKeysText',
      endpoint: appendApiPath(baseUrl, 'v1', '/messages'),
      apiKind: 'claude-messages',
      defaultModel: ''
    };
  }
  if (standard === 'gemini') {
    return {
      label: 'Custom API (Gemini)',
      keyField: 'customApiKeysText',
      endpoint: appendApiPath(baseUrl, 'v1beta', '/models/{model}:generateContent'),
      apiKind: 'gemini',
      defaultModel: ''
    };
  }
  if (standard === 'openai-responses') {
    return {
      label: 'Custom API (OpenAI Responses)',
      keyField: 'customApiKeysText',
      endpoint: appendApiPath(baseUrl, 'v1', '/responses'),
      apiKind: 'openai-responses',
      defaultModel: ''
    };
  }
  return {
    label: 'Custom API (OpenAI)',
    keyField: 'customApiKeysText',
    endpoint: appendApiPath(baseUrl, 'v1', '/chat/completions'),
    apiKind: 'chat',
    defaultModel: ''
  };
}

function buildRequest(provider, prompt, isJson, apiKey, model, claudeMaxTokens = 16384) {
  const finalPrompt = isJson
    ? `${prompt}\n\nCHỈ TRẢ VỀ JSON HỢP LỆ DUY NHẤT. KHÔNG DÙNG MARKDOWN, KHÔNG DÙNG BACKTICK.`
    : prompt;
  const selectedModel = model || provider.defaultModel;

  if (provider.apiKind === 'openai-responses') {
    return {
      endpoint: provider.endpoint,
      options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: selectedModel, input: finalPrompt, store: false })
      }
    };
  }
  if (provider.apiKind === 'claude-messages' || provider.apiKind === 'claude-proxy') {
    const maxTokens = Math.max(1024, Math.min(128000, Number(claudeMaxTokens) || 16384));
    const headers = {
      'Content-Type': 'application/json',
      Authorization: provider.apiKind === 'claude-proxy' ? `Bearer ${apiKey}` : undefined,
      'x-api-key': provider.apiKind === 'claude-messages' ? apiKey : undefined,
      'anthropic-version': provider.apiVersion || '2023-06-01'
    };
    Object.keys(headers).forEach((key) => headers[key] === undefined && delete headers[key]);
    return {
      endpoint: provider.endpoint,
      options: {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: selectedModel, max_tokens: maxTokens, messages: [{ role: 'user', content: finalPrompt }], stream: false })
      }
    };
  }
  if (provider.apiKind === 'gemini') {
    const generationConfig = {};
    if (isJson) generationConfig.responseMimeType = 'application/json';
    return {
      endpoint: geminiEndpoint(provider, selectedModel),
      options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: finalPrompt }] }], generationConfig })
      }
    };
  }
  return {
    endpoint: provider.endpoint,
    options: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: selectedModel,
        messages: [{ role: 'user', content: finalPrompt }],
        stream: false,
        ...(isJson && provider.responseFormat === 'json_object' ? { response_format: { type: 'json_object' } } : {})
      })
    }
  };
}

function openAiImageSize(aspectRatio, model = 'gpt-image-2') {
  const value = String(aspectRatio || '16:9');
  if (/^gpt-image-2\b/i.test(String(model || ''))) {
    if (value === '9:16') return '1152x2048';
    if (value === '1:1') return '1024x1024';
    if (value === '4:3' || value === '5:4') return '1536x1152';
    return '2048x1152';
  }
  if (value === '9:16') return '1024x1536';
  if (value === '1:1') return '1024x1024';
  if (value === '4:3' || value === '5:4') return '1536x1024';
  return '1536x1024';
}

function geminiImageAspectRatio(aspectRatio) {
  const value = String(aspectRatio || '16:9');
  if (value === '9:16') return '9:16';
  if (value === '1:1') return '1:1';
  if (value === '4:3' || value === '5:4') return '4:3';
  return '16:9';
}

function extractOpenAiImageBuffer(data) {
  const direct = Array.isArray(data?.data) ? data.data.find((item) => item?.b64_json || item?.url) : null;
  if (direct?.b64_json) return Buffer.from(direct.b64_json, 'base64');
  const generatedCall = Array.isArray(data?.output)
    ? data.output.find((item) => item?.type === 'image_generation_call')
    : null;
  if (generatedCall?.result) return Buffer.from(generatedCall.result, 'base64');
  return null;
}

function collectGeminiResponses(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.response)) return data.response;
  return [data];
}

function extractGeminiImageBuffer(data) {
  const responses = collectGeminiResponses(data);
  for (const response of responses) {
    const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
    for (const candidate of candidates) {
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
      for (const part of parts) {
        const inline = part?.inlineData || part?.inline_data;
        const mime = String(inline?.mimeType || inline?.mime_type || '');
        if (inline?.data && (!mime || mime.startsWith('image/'))) {
          return Buffer.from(inline.data, 'base64');
        }
      }
    }
  }
  return null;
}



class AiProviderClient {
  constructor(settings = {}) {
    this.settings = settings;
    this.chat01 = new Chat01Client(settings);
    this.providerId = String(settings.apiProvider || 'chat01');
  }

  provider() {
    if (this.providerId === 'nineRouter') return nineRouterProvider(this.settings);
    if (this.providerId === 'custom') return customProvider(this.settings);
    return PROVIDERS[this.providerId] || null;
  }

  async complete(prompt, isJson) {
    const provider = this.provider();
    if (this.providerId === 'custom' && !provider) {
      throw new Error('Custom API requires a valid URL Base');
    }
    if (!provider) return isJson ? this.chat01.generateJson(prompt) : this.chat01.generateText(prompt);
    if (!String(this.settings.aiModel || provider.defaultModel || '').trim()) {
      throw new Error(`${provider.label} requires a model name`);
    }
    const keys = this.settings[provider.keyField];
    return withApiKeyFallback(keys, async (apiKey, keyMeta) => {
      let activePrompt = prompt;
      const attempts = isJson ? 2 : 1;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const request = buildRequest(provider, activePrompt, isJson, apiKey, this.settings.aiModel, this.settings.claudeMaxTokens);
        let data = {};
        const maxRequestAttempts = parsePositiveInt(process.env.AI_MAX_RETRIES, DEFAULT_AI_MAX_RETRIES, 0) + 1;
        for (let requestAttempt = 1; requestAttempt <= maxRequestAttempts; requestAttempt += 1) {
          try {
            res = await fetch(request.endpoint, { ...request.options, signal: AbortSignal.timeout(600000) }); // Tăng lên 600 giây (10 phút) hỗ trợ thinking models và HTML generation nặng
          } catch (error) {
            if (requestAttempt < maxRequestAttempts) {
              await sleepMs(getProviderRetryDelayMs({ headers: new Map() }, {}, '', requestAttempt));
              continue;
            }
            throw providerFetchError(provider, request.endpoint, error, apiKey);
          }

          const raw = await res.text();
          try { data = raw ? JSON.parse(raw) : {}; } catch { data = { error: { message: raw } }; }
          if (!res.ok || data.error) {
            const message = data?.error?.message || data?.message || raw || `HTTP ${res.status}`;
            const status = getProviderErrorStatus(res, data);
            const error = new Error(`${provider.label} HTTP ${status} (key=${keyMeta.maskedKey}): ${sanitizeApiKeyError(message, [apiKey]).slice(0, 500)}`);
            error.status = status;
            if (requestAttempt < maxRequestAttempts && isRetryableProviderError(status, message || raw)) {
              await sleepMs(getProviderRetryDelayMs(res, data, raw, requestAttempt));
              continue;
            }
            throw error;
          }
          break;
        }
        const text = extractProviderText(data).trim();
        if (!text) throw new Error(`${provider.label} returned an empty response`);
        if (!isJson) return stripCodeFence(text);
        try {
          return parseJsonContent(text);
        } catch (error) {
          if (attempt >= attempts - 1) throw error;
          activePrompt = buildJsonRetryPrompt(prompt, error);
        }
      }
      throw new Error(`${provider.label} JSON generation failed`);
    }, { label: provider.label });
  }

  generateJson(prompt) {
    return this.complete(prompt, true);
  }

  generateText(prompt) {
    return this.complete(prompt, false);
  }

  async generateOpenAiImageBuffer(prompt) {
    const model = String(this.settings.imageModel || '').trim() || 'gpt-image-2';
    return withApiKeyFallback(this.settings.imageOpenaiKeysText, async (apiKey, keyMeta) => {
      const body = {
        model,
        prompt,
        n: 1,
        size: openAiImageSize(this.settings.aspectRatio, model),
        quality: 'auto',
        output_format: 'png'
      };
      const res = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000)
      });
      const raw = await res.text();
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch { data = { error: { message: raw } }; }
      if (!res.ok || data.error) {
        const message = data?.error?.message || data?.message || raw || `HTTP ${res.status}`;
        const error = new Error(`OpenAI Images HTTP ${res.status} (key=${keyMeta.maskedKey}): ${sanitizeApiKeyError(message, [apiKey]).slice(0, 500)}`);
        error.status = res.status;
        throw error;
      }
      const buffer = extractOpenAiImageBuffer(data);
      if (!buffer) throw new Error('OpenAI Images returned no image data');
      return buffer;
    }, { label: 'OpenAI Images' });
  }

  async generateGeminiImageBuffer(prompt) {
    const model = String(this.settings.imageModel || '').trim() || 'gemini-2.5-flash-image';
    return withApiKeyFallback(this.settings.imageGeminiKeysText, async (apiKey, keyMeta) => {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?key=${encodeURIComponent(apiKey)}`;
      const body = {
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          responseModalities: ['IMAGE', 'TEXT'],
          imageConfig: {
            aspectRatio: geminiImageAspectRatio(this.settings.aspectRatio)
          }
        }
      };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000)
      });
      const raw = await res.text();
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch { data = { error: { message: raw } }; }
      if (!res.ok || data.error) {
        const message = data?.error?.message || data?.message || raw || `HTTP ${res.status}`;
        const error = new Error(`Google Gemini Images HTTP ${res.status} (key=${keyMeta.maskedKey}): ${sanitizeApiKeyError(message, [apiKey]).slice(0, 500)}`);
        error.status = res.status;
        throw error;
      }
      const buffer = extractGeminiImageBuffer(data);
      if (!buffer) throw new Error('Google Gemini Images returned no inline image data');
      return buffer;
    }, { label: 'Google Gemini Images' });
  }

  generateImageBuffer(prompt, refImageUrl = '') {
    const provider = String(this.settings.imageGenerationProvider || 'chat01');
    if (provider === 'openai') {
      return this.generateOpenAiImageBuffer(prompt, refImageUrl);
    }
    if (provider === 'gemini') {
      return this.generateGeminiImageBuffer(prompt, refImageUrl);
    }
    return null;
  }

  generateImage(prompt, refImageUrl = '') {
    if (['openai', 'gemini'].includes(String(this.settings.imageGenerationProvider || 'chat01'))) {
      throw new Error('This image generation provider returns image buffers only');
    }
    return this.chat01.generateImage(prompt, refImageUrl);
  }
}

module.exports = { AiProviderClient };
