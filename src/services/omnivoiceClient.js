const fs = require('fs/promises');
const path = require('path');
const { getOmniVoiceDefaultVoice, getVideoLanguageConfig } = require('../config/languages');
const { baseUrl: defaultRuntimeBaseUrl, ensureOmniVoiceRunning } = require('./omnivoiceRuntime');

const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function clampSpeed(value) {
  return Math.max(0.5, Math.min(1.5, Number(value) || 1.0));
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim() || defaultRuntimeBaseUrl();
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return defaultRuntimeBaseUrl();
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return defaultRuntimeBaseUrl();
  }
}

function normalizeNumStep(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 32;
  return Math.max(8, Math.min(64, Math.round(num)));
}

function normalizeChunkDuration(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 5;
  return Math.max(2, Math.min(15, num));
}

function normalizeChunkThreshold(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(30, num));
}

function selectedVoicePreset(settings = {}) {
  const id = String(settings.omnivoiceVoiceId || '').trim();
  if (!id) return null;
  return (Array.isArray(settings.omnivoiceVoices) ? settings.omnivoiceVoices : [])
    .find((voice) => String(voice?.id || '') === id && voice?.refAudioPath) || null;
}

function selectedDefaultVoice(settings = {}) {
  return getOmniVoiceDefaultVoice(settings.omnivoiceVoiceId);
}

async function writeAudioResponse(res, outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, Buffer.from(await res.arrayBuffer()));
}

async function getOmniVoiceStatus(settings = {}) {
  const apiBaseUrl = normalizeBaseUrl(settings.omnivoiceApiBaseUrl);
  let res;
  try {
    res = await fetch(`${apiBaseUrl}/health`, { signal: AbortSignal.timeout(3000) });
  } catch (error) {
    throw new Error(`Không kết nối được OmniVoice local tại ${apiBaseUrl}. Hãy chạy npm run omnivoice:setup rồi khởi động lại app.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`OmniVoice HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

async function prepareOmniVoiceVoice({ voice, settings }) {
  const apiBaseUrl = normalizeBaseUrl(settings.omnivoiceApiBaseUrl);
  const body = {
    voice_id: String(voice?.id || '').trim(),
    ref_audio: String(voice?.refAudioPath || '').trim(),
    ref_text: String(voice?.refText || '').trim(),
    preprocess_prompt: true
  };
  if (!body.voice_id || !body.ref_audio) throw new Error('Thiếu dữ liệu giọng OmniVoice để chuẩn bị');

  // Auto-restart OmniVoice if not running
  try {
    await ensureOmniVoiceRunning();
  } catch (restartErr) {
    throw new Error(`Không thể khởi động OmniVoice tại ${apiBaseUrl}: ${restartErr.message}. Hãy chạy npm run omnivoice:setup rồi khởi động lại app.`);
  }

  let res;
  try {
    res = await fetch(`${apiBaseUrl}/prepare-voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(settings.omnivoiceTimeoutMs) || DEFAULT_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(`Không kết nối được OmniVoice local tại ${apiBaseUrl}. Hãy chạy npm run omnivoice:setup rồi khởi động lại app.`);
  }
  const raw = await res.text().catch(() => '');
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {}
  if (!res.ok) {
    const msg = data?.error || data?.message || raw;
    throw new Error(`OmniVoice HTTP ${res.status}: ${String(msg || '').slice(0, 500)}`);
  }
  return data;
}

async function synthesizeOmniVoice({ text, outputPath, settings }) {
  const apiBaseUrl = normalizeBaseUrl(settings.omnivoiceApiBaseUrl);
  const language = getVideoLanguageConfig(settings.videoLanguage).voiceLanguage;
  const body = {
    text: String(text || '').trim(),
    language,
    speed: clampSpeed(settings.voiceSpeed),
    num_step: normalizeNumStep(settings.omnivoiceNumStep),
    audio_chunk_duration: normalizeChunkDuration(settings.omnivoiceChunkDurationSec),
    audio_chunk_threshold: normalizeChunkThreshold(settings.omnivoiceChunkThresholdSec),
    manual_chunk_max_words: 18,
    manual_chunk_crossfade_ms: 80
  };
  if (!body.text) throw new Error('Thiếu nội dung TTS cho OmniVoice');
  const voicePreset = selectedVoicePreset(settings);
  if (voicePreset) {
    body.voice_id = String(voicePreset.id || '').trim();
    body.ref_audio = voicePreset.refAudioPath;
    if (String(voicePreset.refText || '').trim()) body.ref_text = String(voicePreset.refText).trim();
  } else {
    const defaultVoice = selectedDefaultVoice(settings);
    body.instruct = String(defaultVoice?.instruct || settings.omnivoiceInstruct || '').trim();
  }

  // Auto-restart OmniVoice if not running before attempting synthesis
  try {
    await ensureOmniVoiceRunning();
  } catch (restartErr) {
    throw new Error(`Không thể khởi động OmniVoice tại ${apiBaseUrl}: ${restartErr.message}. Hãy chạy npm run omnivoice:setup rồi khởi động lại app.`);
  }

  let res;
  try {
    res = await fetch(`${apiBaseUrl}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'audio/wav,application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(settings.omnivoiceTimeoutMs) || DEFAULT_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(`Không kết nối được OmniVoice local tại ${apiBaseUrl} (${error.message}). Hãy chạy npm run omnivoice:setup rồi khởi động lại app.`);
  }
  if (res.ok && String(res.headers.get('content-type') || '').startsWith('audio/')) {
    await writeAudioResponse(res, outputPath);
    return;
  }
  const raw = await res.text().catch(() => '');
  let msg = raw;
  try {
    const data = raw ? JSON.parse(raw) : {};
    msg = data?.error || data?.message || raw;
  } catch {}
  throw new Error(`OmniVoice HTTP ${res.status}: ${String(msg || '').slice(0, 500)}`);
}

module.exports = {
  normalizeBaseUrl,
  getOmniVoiceStatus,
  prepareOmniVoiceVoice,
  synthesizeOmniVoice
};
