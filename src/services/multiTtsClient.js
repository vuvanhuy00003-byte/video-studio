const fs = require('fs/promises');
const path = require('path');
const { sanitizeApiKeyError, withApiKeyFallback } = require('./providerUtils');
const { synthesizeOmniVoice } = require('./omnivoiceClient');
const { getVideoLanguageConfig } = require('../config/languages');

const VIVIBE_RPC_URL = 'https://api.lucylab.io/json-rpc';
const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io';
const VBEE_API_BASE = 'https://vbee.vn/api/v1';
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clampSpeed = (value) => Math.max(0.5, Math.min(2.0, Number(value) || 1.0));
let vivibeJobQueue = Promise.resolve();
let vivibeQueuedJobs = 0;

function clampUnit(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, Number(num.toFixed(2))));
}

function providerUrl(base, pathOrUrl) {
  return /^https?:\/\//i.test(String(pathOrUrl || ''))
    ? String(pathOrUrl)
    : `${base}${String(pathOrUrl || '').startsWith('/') ? '' : '/'}${pathOrUrl}`;
}

function keyField(provider) {
  return {
    vivibe: 'vivibeKeysText',
    elevenlabs: 'elevenlabsKeysText',
    vbee: 'vbeeKeysText'
  }[provider];
}

function defaultVoiceId(settings) {
  return String(settings.ttsVoiceId || settings.larvoiceVoiceId || '').trim();
}

async function writeAudioResponse(res, outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, Buffer.from(await res.arrayBuffer()));
}

async function downloadRemoteAudio(url, outputPath, { apiKey, providerName }) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'VibeToolVideo/1.0', Accept: 'audio/*,*/*;q=0.8' },
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(`${providerName} download HTTP ${res.status}: ${sanitizeApiKeyError(raw, [apiKey]).slice(0, 300)}`);
  }
  await writeAudioResponse(res, outputPath);
}

function parseJsonResponse(raw, { providerName, status, apiKey }) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    const error = new Error(`${providerName} HTTP ${status}: ${sanitizeApiKeyError(raw, [apiKey]).slice(0, 500)}`);
    error.status = status;
    throw error;
  }
}

async function vivibeRpc(method, params, apiKey) {
  const res = await fetch(VIVIBE_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ method, input: params }),
    signal: AbortSignal.timeout(60000)
  });
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    if (!res.ok) {
      const error = new Error(`Vivibe HTTP ${res.status}: ${sanitizeApiKeyError(raw, [apiKey]).slice(0, 500)}`);
      error.status = res.status;
      throw error;
    }
    throw new Error(`Vivibe trả về dữ liệu không phải JSON: ${sanitizeApiKeyError(raw, [apiKey]).slice(0, 300)}`);
  }
  if (!res.ok || data.error) {
    const msg = data?.error?.message || data?.message || raw || `HTTP ${res.status}`;
    const error = new Error(`Vivibe HTTP ${res.status}: ${sanitizeApiKeyError(msg, [apiKey]).slice(0, 500)}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

async function waitVivibeExport(projectExportId, apiKey) {
  const id = String(projectExportId || '').trim();
  if (!id) throw new Error('Vivibe không trả về projectExportId');
  const started = Date.now();
  while (Date.now() - started < MAX_POLL_MS) {
    await sleep(POLL_INTERVAL_MS);
    const status = await vivibeRpc('getExportStatus', { projectExportId: id }, apiKey);
    const result = status?.result || {};
    const state = String(result.state || '').toLowerCase();
    if (state === 'completed' && result.url) return String(result.url);
    if (state === 'failed') throw new Error(`Vivibe TTS thất bại: ${JSON.stringify(result).slice(0, 500)}`);
  }
  throw new Error('Vivibe TTS quá thời gian chờ');
}

async function runVivibeSequentially(task) {
  const previous = vivibeJobQueue.catch(() => {});
  let releaseQueue;
  vivibeJobQueue = new Promise((resolve) => {
    releaseQueue = resolve;
  });
  vivibeQueuedJobs += 1;
  await previous;
  try {
    return await task();
  } finally {
    vivibeQueuedJobs = Math.max(0, vivibeQueuedJobs - 1);
    releaseQueue?.();
  }
}

async function synthesizeVivibe({ text, outputPath, settings }) {
  return runVivibeSequentially(() => (
    withApiKeyFallback(settings[keyField('vivibe')], async (apiKey) => {
      const voiceId = defaultVoiceId(settings);
      if (!voiceId) throw new Error('Thiếu Vivibe Voice ID');
      const create = await vivibeRpc('ttsLongText', { text: String(text || '').trim(), userVoiceId: voiceId, speed: clampSpeed(settings.voiceSpeed) }, apiKey);
      const audioUrl = await waitVivibeExport(create?.result?.projectExportId, apiKey);
      await downloadRemoteAudio(audioUrl, outputPath, { providerName: 'Vivibe', apiKey });
    }, { label: 'Vivibe' })
  ));
}

async function synthesizeElevenLabs({ text, outputPath, settings }) {
  return withApiKeyFallback(settings[keyField('elevenlabs')], async (apiKey, keyMeta) => {
    const voiceId = defaultVoiceId(settings);
    if (!voiceId) throw new Error('Thiếu ElevenLabs voice_id');
    const url = new URL(`/v1/text-to-speech/${encodeURIComponent(voiceId)}`, ELEVENLABS_API_BASE);
    url.searchParams.set('output_format', settings.elevenlabsOutputFormat || 'mp3_44100_128');
    const body = {
      text: String(text || '').trim(),
      model_id: settings.elevenlabsModelId || 'eleven_multilingual_v2'
    };
    const languageCode = String(
      settings.elevenlabsLanguageCode || getVideoLanguageConfig(settings.videoLanguage).voiceLanguage || ''
    ).trim().toLowerCase();
    if (languageCode) body.language_code = languageCode;
    const voiceSettings = {};
    voiceSettings.stability = 0.5;
    voiceSettings.similarity_boost = 0.75;
    voiceSettings.style = 0;
    voiceSettings.speed = clampSpeed(settings.voiceSpeed);
    voiceSettings.use_speaker_boost = true;
    body.voice_settings = voiceSettings;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg, audio/*, application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000)
    });
    if (res.ok && String(res.headers.get('content-type') || '').startsWith('audio/')) {
      await writeAudioResponse(res, outputPath);
      return;
    }
    const raw = await res.text();
    let msg = raw;
    try { const data = raw ? JSON.parse(raw) : {}; msg = data?.detail?.message || data?.message || data?.error || raw; } catch {}
    const error = new Error(`ElevenLabs HTTP ${res.status} (key=${keyMeta.maskedKey}): ${sanitizeApiKeyError(typeof msg === 'string' ? msg : JSON.stringify(msg), [apiKey]).slice(0, 500)}`);
    error.status = res.status;
    throw error;
  }, { label: 'ElevenLabs' });
}

async function vbeeJson(pathOrUrl, { method = 'GET', body, apiKey } = {}) {
  const res = await fetch(providerUrl(VBEE_API_BASE, pathOrUrl), {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000)
  });
  const raw = await res.text();
  const data = parseJsonResponse(raw, { providerName: 'Vbee', status: res.status, apiKey });
  if (!res.ok || data?.status === 0) {
    const message = data?.error_message || data?.message || raw || `HTTP ${res.status}`;
    const error = new Error(`Vbee HTTP ${res.status}: ${sanitizeApiKeyError(message, [apiKey]).slice(0, 500)}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

async function waitVbeeRequest(requestId, apiKey) {
  const id = String(requestId || '').trim();
  if (!id) throw new Error('Vbee không trả về request_id');
  const started = Date.now();
  while (Date.now() - started < MAX_POLL_MS) {
    await sleep(POLL_INTERVAL_MS);
    const data = await vbeeJson(`/tts/${encodeURIComponent(id)}`, { apiKey });
    const result = data?.result || {};
    const state = String(result.status || '').toUpperCase();
    if (state === 'SUCCESS' && result.audio_link) return String(result.audio_link);
    if (state === 'FAILURE' || state === 'FAILED') {
      throw new Error(`Vbee TTS thất bại: ${JSON.stringify(result).slice(0, 500)}`);
    }
  }
  throw new Error('Vbee TTS quá thời gian chờ');
}

async function synthesizeVbee({ text, outputPath, settings }) {
  return withApiKeyFallback(settings[keyField('vbee')], async (apiKey, keyMeta) => {
    const voiceId = defaultVoiceId(settings);
    if (!voiceId) throw new Error('Thiếu Vbee voice_code');
    if (!String(settings.vbeeAppId || '').trim()) throw new Error('Thiếu Vbee Project/App ID');
    const body = {
      app_id: String(settings.vbeeAppId).trim(),
      response_type: 'indirect',
      callback_url: 'https://example.com/vbee-callback',
      input_text: String(text || '').trim(),
      voice_code: voiceId,
      audio_type: 'mp3',
      bitrate: 128,
      speed_rate: String(clampSpeed(settings.voiceSpeed).toFixed(1))
    };
    if (settings.vbeeSampleRate !== '') body.sample_rate = Number(settings.vbeeSampleRate);
    if (settings.vbeeEmphasisIntensity !== '') body.emphasis_intensity = Number(settings.vbeeEmphasisIntensity);
    const data = await vbeeJson('/tts', { method: 'POST', body, apiKey });
    const requestId = data?.result?.request_id;
    const audioUrl = await waitVbeeRequest(requestId, apiKey);
    await downloadRemoteAudio(audioUrl, outputPath, { providerName: 'Vbee', apiKey });
  }, { label: 'Vbee' });
}

async function synthesizeWithProvider({ text, outputPath, settings }) {
  const provider = String(settings.ttsProvider || 'larvoice');
  if (provider === 'vivibe') return synthesizeVivibe({ text, outputPath, settings });
  if (provider === 'elevenlabs') return synthesizeElevenLabs({ text, outputPath, settings });
  if (provider === 'vbee') return synthesizeVbee({ text, outputPath, settings });
  if (provider === 'omnivoice') return synthesizeOmniVoice({ text, outputPath, settings });
  throw new Error(`TTS provider chưa hỗ trợ: ${provider}`);
}

module.exports = {
  synthesizeWithProvider
};
