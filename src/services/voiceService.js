const { execFile } = require('child_process');
const { promisify } = require('util');
const { LarVoiceClient } = require('./larvoiceClient');
const { synthesizeWithProvider } = require('./multiTtsClient');
const { withApiKeyFallback } = require('./providerUtils');

const execFileAsync = promisify(execFile);

async function createSceneVoice({ scene, settings, sceneDir }) {
  if (settings.ttsProvider && settings.ttsProvider !== 'larvoice') {
    const ext = settings.ttsProvider === 'omnivoice' ? 'wav' : 'mp3';
    const voicePath = `${sceneDir}/voice.${ext}`;
    await synthesizeWithProvider({ text: scene.voiceText, outputPath: voicePath, settings });
    return {
      projectExportId: null,
      voicePath,
      rawSrtPath: null
    };
  }
  const { voicePath, rawSrtPath } = await withApiKeyFallback(
    settings.larvoiceKeysText || settings.larvoiceApiKey || process.env.LARVOICE_API_KEY,
    async (apiKey) => {
      const client = new LarVoiceClient({ ...settings, larvoiceApiKey: apiKey, larvoiceKeysText: apiKey });
      return client.synthesize(scene.voiceText, sceneDir);
    },
    { label: 'LarVoice' }
  );
  return {
    projectExportId: null,
    voicePath,
    rawSrtPath
  };
}

async function getAudioDuration(audioPath, ffprobePath = 'ffprobe') {
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      audioPath
    ]);
    return Number.parseFloat(stdout.trim() || '0');
  } catch (err) {
    try {
      return await getAudioDurationWithFfmpeg(audioPath, process.env.VIBE_TOOL_FFMPEG_PATH || 'ffmpeg');
    } catch (fallbackErr) {
      const detail = (err.stderr || err.message || '').slice(-400).trim();
      const fallbackDetail = (fallbackErr.stderr || fallbackErr.message || '').slice(-400).trim();
      throw new Error(`media duration probe error on ${audioPath}: ffprobe=${detail}; ffmpeg=${fallbackDetail}`);
    }
  }
}

async function getAudioDurationWithFfmpeg(audioPath, ffmpegPath) {
  let stderr = '';
  try {
    const result = await execFileAsync(ffmpegPath, ['-hide_banner', '-i', audioPath]);
    stderr = result.stderr || '';
  } catch (error) {
    stderr = error.stderr || error.message || '';
  }
  const match = String(stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) {
    throw new Error('ffmpeg did not report a duration');
  }
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

async function addAudioTailPadding(audioPath, outputPath, padMs, ffmpegPath = 'ffmpeg') {
  const padSec = (Number(padMs) || 0) / 1000;
  try {
    await execFileAsync(ffmpegPath, [
      '-y',
      '-i', audioPath,
      '-af', `loudnorm=I=-16:TP=-1.5:LRA=7,apad=pad_dur=${padSec}`,
      '-ar', '48000',
      outputPath
    ]);
  } catch (err) {
    const detail = (err.stderr || err.message || '').slice(-400).trim();
    throw new Error(`ffmpeg pad error: ${detail}`);
  }
  return outputPath;
}

module.exports = {
  createSceneVoice,
  getAudioDuration,
  addAudioTailPadding
};
