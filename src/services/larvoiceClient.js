const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { parseApiKeys } = require('./providerUtils');
const { VIDEO_LANGUAGE_CONFIGS, getVideoLanguageConfig } = require('../config/languages');

const execFileAsync = promisify(execFile);

const LARVOICE_API_BASE = 'https://larvoice.com/api/v1';
const DEFAULT_LARVOICE_VOICE_ID = '1';
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_MS = 10 * 60 * 1000;
const VOICE_CACHE_MS = 10 * 60 * 1000;
const SUPPORTED_LANGUAGES = new Set(Object.values(VIDEO_LANGUAGE_CONFIGS).map((language) => language.voiceLanguage));
const LARVOICE_VOICE_LANGUAGES = ['vi', 'en', 'zh', 'ja', 'ko'];
const LARVOICE_VOICE_SOURCES = ['public', 'personal'];

const FALLBACK_VOICES = [
  { id: 3473, name: 'Adam', language: 'vi' },
  { id: 3459, name: 'Ngan Ke', language: 'vi' },
  { id: 3458, name: 'Quang Minh', language: 'vi' },
  { id: 1, name: 'Anh Quan', language: 'vi' },
  { id: 3397, name: 'Ngoc Huyen', language: 'vi' },
  { id: 2393, name: 'Jeee', language: 'en' },
  { id: 2392, name: 'Arnold', language: 'en' },
  { id: 2391, name: 'Sam', language: 'en' },
  { id: 1363, name: 'Ava', language: 'en' }
];

let voiceCache = { at: 0, voices: [] };
let bundledVoiceCache = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fmtMs(ms) {
  return ms < 60000
    ? `${(ms / 1000).toFixed(1)}s`
    : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

function clampSpeed(value) {
  return Math.max(0.5, Math.min(2.0, Number(value) || 1.0));
}

function normalizeVoiceId(value) {
  return String(value || '').trim() || DEFAULT_LARVOICE_VOICE_ID;
}

function normalizeVoiceSource(value) {
  const source = String(value || '').trim().toLowerCase();
  return LARVOICE_VOICE_SOURCES.includes(source) ? source : 'public';
}

function resolveApiKey(settings = {}) {
  return parseApiKeys(settings.larvoiceKeysText || settings.larvoiceApiKey)[0] ||
    process.env.LARVOICE_API_KEY ||
    '';
}

function larvoiceUrl(pathOrUrl) {
  return /^https?:\/\//i.test(pathOrUrl)
    ? pathOrUrl
    : `${LARVOICE_API_BASE}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
}

function normalizeGender(gender) {
  if (gender === 1 || gender === '1') return 'male';
  if (gender === 0 || gender === '0') return 'female';
  const value = String(gender || '').toLowerCase();
  if (value === 'male' || value === 'female') return value;
  return '';
}

function normalizeLanguage(raw) {
  const value = String(raw?.language || raw?.language_code || raw?.country || '').toLowerCase();
  const aliases = {
    us: 'en', gb: 'en', vn: 'vi', kr: 'ko', jp: 'ja',
    br: 'pt', brazil: 'pt', mexico: 'es', india: 'hi', indonesia: 'id',
    thailand: 'th', korea: 'ko', japan: 'ja', germany: 'de', france: 'fr'
  };
  const code = aliases[value] || value.split(/[-_]/)[0];
  if (SUPPORTED_LANGUAGES.has(code)) return code;
  const name = String(raw?.language_name || '').toLowerCase();
  if (name.includes('anh') || name.includes('english')) return 'en';
  if (name.includes('viet')) return 'vi';
  if (name.includes('thai') || name.includes('thái')) return 'th';
  if (name.includes('korean') || name.includes('hàn')) return 'ko';
  if (name.includes('japanese') || name.includes('nhật')) return 'ja';
  if (name.includes('german') || name.includes('đức')) return 'de';
  if (name.includes('french') || name.includes('pháp')) return 'fr';
  if (name.includes('spanish') || name.includes('tây ban nha')) return 'es';
  if (name.includes('portuguese') || name.includes('bồ đào nha')) return 'pt';
  if (name.includes('indonesian') || name.includes('indonesia')) return 'id';
  if (name.includes('hindi')) return 'hi';
  if (name.includes('arabic') || name.includes('ả rập')) return 'ar';
  return value || 'vi';
}

function normalizeVoice(raw) {
  const apiVoiceId = String(raw?.voice_id || '').trim();
  const rawId = String(raw?.id || apiVoiceId || '').trim();
  if (!rawId && !apiVoiceId) return null;
  const numericId = Number(rawId);
  const voiceType = raw?.voice_type || raw?.source;
  return {
    id: Number.isFinite(numericId) ? numericId : (apiVoiceId || rawId),
    voiceId: apiVoiceId || rawId,
    larvoiceId: String(raw?.larvoiceId || raw?.larvoice_id || apiVoiceId || rawId).trim(),
    source: normalizeVoiceSource(voiceType),
    voiceType: normalizeVoiceSource(voiceType),
    name: String(raw?.name || `Voice ${apiVoiceId || rawId}`).trim(),
    language: normalizeLanguage(raw),
    gender: normalizeGender(raw?.gender),
    region: String(raw?.region || '').trim(),
    topics: String(raw?.topics || raw?.use_case || '').trim(),
    audio: String(raw?.preview_url || raw?.audio || '').trim()
  };
}

function readBundledVoices() {
  if (bundledVoiceCache) return bundledVoiceCache;
  try {
    const manifestPath = path.join(__dirname, '..', '..', 'public', 'voice-samples', '_manifest.json');
    const manifest = JSON.parse(fsSync.readFileSync(manifestPath, 'utf8'));
    bundledVoiceCache = (Array.isArray(manifest.ready) ? manifest.ready : [])
      .map(normalizeVoice)
      .filter(Boolean);
  } catch {
    bundledVoiceCache = [];
  }
  return bundledVoiceCache;
}

function resolveVoiceSelection(voiceId, voices = []) {
  const id = normalizeVoiceId(voiceId);
  const candidates = [...voices, ...readBundledVoices(), ...FALLBACK_VOICES.map(normalizeVoice).filter(Boolean)];
  const voice = candidates.find((item) => (
    String(item.id) === id ||
    String(item.voiceId) === id ||
    String(item.larvoiceId) === id
  ));
  return {
    voiceId: String(voice?.larvoiceId || voice?.voiceId || id),
    voiceType: normalizeVoiceSource(voice?.voiceType || voice?.source)
  };
}

function ttsRetryDelayMs(error, attempt) {
  const message = String(error?.message || '');
  if (/429|rate|too many|server error/i.test(message)) {
    return Math.min(90000, 12000 * attempt);
  }
  return Math.min(30000, 3000 * attempt);
}

function ttsPayload({ text, voiceId, language, speed }) {
  return {
    language,
    post_speed: clampSpeed(speed),
    post_volume: 0,
    post_pitch: 0,
    sentence_pause_ms: 750,
    line_break_pause_ms: 800,
    ellipsis_pause_ms: 800,
    comma_pause_ms: 220,
    gen_text: String(text || '').trim(),
    voice_id: normalizeVoiceId(voiceId)
  };
}

function normalizeJobInfo(response) {
  const data = response?.data || response || {};
  const job = data?.job || data;
  const id = job?.id ?? job?.job_id ?? data?.job_id ?? response?.job_id;
  return {
    id: id == null ? '' : String(id),
    jobUrl: job?.job_url || data?.job_url || response?.job_url || (id == null ? '' : `/jobs/${id}`),
    status: String(job?.status || data?.status || response?.status || '').toLowerCase(),
    audioUrl: job?.audio_url || job?.output_url || data?.audio_url || data?.output_url || response?.audio_url || response?.output_url || '',
    alignedSrtUrl: job?.aligned_srt_url || data?.aligned_srt_url || response?.aligned_srt_url || '',
    outputExpiresAt: job?.output_expires_at || data?.output_expires_at || response?.output_expires_at || '',
    cost: job?.cost ?? data?.cost ?? response?.cost ?? null,
    error: job?.error || job?.message || data?.error || data?.message || response?.error || response?.message || ''
  };
}

function isCompletedJob(job) {
  return job.status === 'completed' || job.status === 'success' || job.status === 'done' || (job.audioUrl && !job.status);
}

function isFailedJob(job) {
  return job.status === 'failed' || job.status === 'error';
}

class LarVoiceClient {
  constructor(settings = {}) {
    this.apiKey = resolveApiKey(settings);
    this.voiceId = normalizeVoiceId(settings.larvoiceVoiceId);
    this.speed = clampSpeed(settings.voiceSpeed);
    this.ffprobePath = settings.ffprobePath || 'ffprobe';
    this.language = getVideoLanguageConfig(settings.videoLanguage).voiceLanguage;
  }

  headers(extra = {}) {
    if (!this.apiKey) {
      throw new Error('Missing LarVoice API key');
    }
    return {
      Authorization: `Bearer ${this.apiKey}`,
      ...extra
    };
  }

  async json(pathOrUrl, { method = 'GET', body } = {}) {
    const response = await fetch(larvoiceUrl(pathOrUrl), {
      method,
      headers: this.headers(body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    const raw = await response.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`LarVoice returned non-JSON response: ${raw.slice(0, 300)}`);
    }
    if (!response.ok || data?.success === false || data?.status === 'error') {
      const error = new Error(`LarVoice HTTP ${response.status}: ${(data?.message || data?.error || raw).slice(0, 500)}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async listVoices({ force = false } = {}) {
    if (!force && voiceCache.voices.length && Date.now() - voiceCache.at < VOICE_CACHE_MS) {
      return voiceCache.voices;
    }

    try {
      const voices = [];
      for (const source of LARVOICE_VOICE_SOURCES) {
        for (const language of LARVOICE_VOICE_LANGUAGES) {
          let cursor = '';
          let pages = 0;
          do {
            const params = new URLSearchParams({
              option: source,
              language,
              limit: '20'
            });
            if (cursor) params.set('cursor', cursor);
            const data = await this.json(`/voices?${params.toString()}`);
            const payload = data?.data || data || {};
            const rows = Array.isArray(payload?.voices) ? payload.voices : [];
            voices.push(...rows.map((voice) => normalizeVoice({ ...voice, source })).filter(Boolean));
            const nextCursor = payload?.next_cursor == null ? '' : String(payload.next_cursor);
            cursor = payload?.has_more && nextCursor ? nextCursor : '';
            pages += 1;
          } while (cursor && pages < 20);
        }
      }

      const seen = new Set();
      const filtered = voices.filter((voice) => {
        if (!SUPPORTED_LANGUAGES.has(voice.language)) return false;
        const key = String(voice.voiceId || voice.id);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (!filtered.length) throw new Error('LarVoice did not return supported language voices');
      voiceCache = { at: Date.now(), voices: filtered };
      return filtered;
    } catch {
      if (voiceCache.voices.length) return voiceCache.voices;
      return FALLBACK_VOICES;
    }
  }

  voiceLanguage(voiceId) {
    const id = String(voiceId || '').trim();
    const voice = voiceCache.voices.find((item) => String(item.id) === id || String(item.voiceId) === id) ||
      FALLBACK_VOICES.find((item) => String(item.id) === id);
    return voice?.language || this.language;
  }

  async waitJob(job) {
    if (isFailedJob(job)) {
      throw new Error(`LarVoice TTS failed: ${(job.error || JSON.stringify(job)).slice(0, 500)}`);
    }
    if (isCompletedJob(job)) return job;
    if (!job.jobUrl && !job.id) {
      throw new Error(`LarVoice did not return job_id/job_url: ${JSON.stringify(job).slice(0, 500)}`);
    }

    const started = Date.now();
    while (Date.now() - started < MAX_POLL_MS) {
      await sleep(POLL_INTERVAL_MS);
      const status = normalizeJobInfo(await this.json(job.jobUrl || `/jobs/${job.id}`));

      if (isCompletedJob(status)) {
        return status;
      }
      if (isFailedJob(status)) {
        throw new Error(`LarVoice TTS failed: ${(status.error || JSON.stringify(status)).slice(0, 500)}`);
      }
    }
    throw new Error('LarVoice TTS polling timeout');
  }

  async downloadFile(url, outputPath) {
    const response = await fetch(larvoiceUrl(url), { headers: this.headers() });
    if (!response.ok) {
      const error = new Error(`LarVoice download HTTP ${response.status}: ${await response.text().catch(() => '')}`);
      error.status = response.status;
      throw error;
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
  }

  async synthesizeOnce(text, outputPath) {
    const voices = await this.listVoices();
    const selectedVoice = resolveVoiceSelection(this.voiceId, voices);
    const language = this.language || this.voiceLanguage(this.voiceId);
    const body = ttsPayload({
      text,
      voiceId: selectedVoice.voiceId,
      language,
      speed: this.speed
    });
    body.voice_type = selectedVoice.voiceType;
    if (!body.gen_text) throw new Error('Missing TTS text');
    if (body.gen_text.length > 50000) throw new Error('LarVoice TTS text exceeds 50000 characters');
    if (!body.voice_id) throw new Error('Missing LarVoice voice ID');

    const createResponse = await this.json('/tts', { method: 'POST', body });
    let job = normalizeJobInfo(createResponse);
    if (!job.audioUrl) {
      job = await this.waitJob(job);
    }
    if (!job.audioUrl) {
      throw new Error(`LarVoice did not return audio_url/output_url: ${JSON.stringify(createResponse).slice(0, 500)}`);
    }
    await this.downloadFile(job.audioUrl, outputPath);

    let rawSrtPath = null;
    if (job.alignedSrtUrl) {
      rawSrtPath = path.join(path.dirname(outputPath), 'voice.auto.srt');
      await this.downloadFile(job.alignedSrtUrl, rawSrtPath);
    }
    return { job, rawSrtPath };
  }

  async synthesize(text, sceneDir) {
    const voicePath = path.join(sceneDir, 'voice.wav');
    const started = Date.now();
    const maxRetries = 5;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        const result = await this.synthesizeOnce(text, voicePath);
        const duration = await this.probeAudioDuration(voicePath);
        const kb = fsSync.existsSync(voicePath) ? (fsSync.statSync(voicePath).size / 1024).toFixed(0) : '0';
        return {
          voicePath,
          rawSrtPath: result.rawSrtPath,
          metadata: {
            provider: 'larvoice',
            voiceId: this.voiceId,
            jobId: result.job.id || null,
            cost: result.job.cost,
            duration,
            sizeKb: Number(kb),
            elapsedMs: Date.now() - started
          }
        };
      } catch (error) {
        lastError = error;
        if (/Missing LarVoice API key|Missing TTS text|Missing LarVoice voice ID/i.test(error.message) || attempt === maxRetries) {
          break;
        }
        await sleep(ttsRetryDelayMs(error, attempt));
      }
    }

    throw new Error(`LarVoice TTS failed after ${fmtMs(Date.now() - started)}: ${lastError?.message || 'unknown error'}`);
  }

  async probeAudioDuration(file) {
    try {
      const { stdout } = await execFileAsync(this.ffprobePath, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        file
      ]);
      return Number.parseFloat(stdout.trim() || '0');
    } catch (error) {
      let stderr = '';
      try {
        const result = await execFileAsync(process.env.VIBE_TOOL_FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-i', file]);
        stderr = result.stderr || '';
      } catch (fallbackError) {
        stderr = fallbackError.stderr || fallbackError.message || '';
      }
      const match = String(stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!match) throw error;
      return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    }
  }
}

module.exports = {
  LarVoiceClient
};
