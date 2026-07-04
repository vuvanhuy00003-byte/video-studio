function parseApiKeys(value) {
  const seen = new Set();
  return String(value || '')
    .split(/[\n,;]+/g)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function maskApiKey(key) {
  const value = String(key || '');
  if (value.length <= 8) return value ? '••••' : '';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function sanitizeApiKeyError(value, extraKeys = []) {
  let text = String(value || '');
  for (const key of extraKeys.filter(Boolean)) {
    text = text.split(String(key)).join(maskApiKey(key));
  }
  return text;
}

function shouldTryNextApiKey(status, message = '') {
  const text = String(message || '').toLowerCase();
  return [401, 402, 403, 429].includes(Number(status))
    || /quota|credit|billing|unauthorized|forbidden|rate|limit|invalid api key|api key/i.test(text);
}

async function withApiKeyFallback(keys, fn, { label = 'API', onKeyError } = {}) {
  const parsed = parseApiKeys(keys);
  if (!parsed.length) throw new Error(`Missing ${label} API key`);
  let lastError;
  for (let i = 0; i < parsed.length; i += 1) {
    const apiKey = parsed[i];
    const keyMeta = { index: i, attempt: i + 1, total: parsed.length, maskedKey: maskApiKey(apiKey) };
    try {
      return await fn(apiKey, keyMeta);
    } catch (error) {
      lastError = error;
      const status = Number(error.status || error.statusCode || 0);
      if (i >= parsed.length - 1 || !shouldTryNextApiKey(status, error.message)) break;
      onKeyError?.(error, keyMeta);
    }
  }
  throw lastError || new Error(`${label} request failed`);
}

module.exports = {
  parseApiKeys,
  maskApiKey,
  sanitizeApiKeyError,
  shouldTryNextApiKey,
  withApiKeyFallback
};
