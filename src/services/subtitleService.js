const fs = require('fs/promises');
const path = require('path');
const { getAspectRatioConfig } = require('../config/constants');
const { getSafeSubtitleFont } = require('../config/languages');
const { runWhisperTranscription } = require('./whisperRuntime');

function parseSrtTime(timeText) {
  const match = String(timeText || '').trim().match(/(\d+):(\d+):(\d+),(\d+)/);
  if (!match) {
    return 0;
  }
  const [, hh, mm, ss, ms] = match;
  return (
    Number(hh) * 3600 * 1000 +
    Number(mm) * 60 * 1000 +
    Number(ss) * 1000 +
    Number(ms)
  );
}

function formatSrtTime(totalMs) {
  const safeMs = Math.max(0, Math.round(totalMs));
  const hh = String(Math.floor(safeMs / 3600000)).padStart(2, '0');
  const mm = String(Math.floor((safeMs % 3600000) / 60000)).padStart(2, '0');
  const ss = String(Math.floor((safeMs % 60000) / 1000)).padStart(2, '0');
  const ms = String(safeMs % 1000).padStart(3, '0');
  return `${hh}:${mm}:${ss},${ms}`;
}

function formatAssTime(totalMs) {
  const safeMs = Math.max(0, Math.round(totalMs));
  const hh = Math.floor(safeMs / 3600000);
  const mm = String(Math.floor((safeMs % 3600000) / 60000)).padStart(2, '0');
  const ss = String(Math.floor((safeMs % 60000) / 1000)).padStart(2, '0');
  const cs = String(Math.floor((safeMs % 1000) / 10)).padStart(2, '0');
  return `${hh}:${mm}:${ss}.${cs}`;
}

function escapeAssText(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    .replace(/\n/g, ' ');
}

function chunkWords(words, size = 5) {
  const chunks = [];
  for (let index = 0; index < words.length; index += size) {
    chunks.push(words.slice(index, index + size));
  }
  return chunks;
}

function hexToAssColor(hex, fallback = '#ffffff', opacity = 1) {
  const normalized = /^#[0-9a-fA-F]{6}$/.test(String(hex || '')) ? String(hex) : fallback;
  const safeOpacity = Math.min(1, Math.max(0.1, Number(opacity ?? 1) || 1));
  const alpha = Math.round((1 - safeOpacity) * 255).toString(16).padStart(2, '0');
  const rr = normalized.slice(1, 3);
  const gg = normalized.slice(3, 5);
  const bb = normalized.slice(5, 7);
  return `&H${alpha}${bb}${gg}${rr}`.toUpperCase();
}

function normalizeSubtitleSettings(settingsOrAspectRatio = {}) {
  const settings = typeof settingsOrAspectRatio === 'string'
    ? { aspectRatio: settingsOrAspectRatio }
    : (settingsOrAspectRatio || {});
  const legacyPositionY = { top: 14, middle: 50, bottom: 86 }[settings.subtitlePosition];
  const positionY = Number(settings.subtitlePositionY ?? settings.positionY ?? legacyPositionY ?? 86);
  const effectOptions = [
    'karaoke-fill',
    'active-fill',
    'active-zoom-fill',
    'tiktok-pill',
    'tiktok-pop-pill',
    'neon-active',
    'bounce-outline',
    'active-outline',
    'sweep-glow',
    'active-pop-fill',
    'glow-pulse',
    'highlight-box',
    'typewriter',
    'plain-text'
  ];
  return {
    aspectRatio: settings.aspectRatio || '16:9',
    videoLanguage: String(settings.videoLanguage || 'vi').toLowerCase(),
    fontFamily: getSafeSubtitleFont(
      settings.videoLanguage,
      settings.subtitleFontFamily || settings.fontFamily || 'Be Vietnam Pro'
    ),
    effect: effectOptions.includes(settings.subtitleEffect || settings.effect)
      ? String(settings.subtitleEffect || settings.effect)
      : 'karaoke-fill',
    textCase: ['original', 'lower', 'upper', 'title'].includes(settings.subtitleTextCase || settings.textCase)
      ? String(settings.subtitleTextCase || settings.textCase)
      : 'original',
    color: /^#[0-9a-fA-F]{6}$/.test(String(settings.subtitleColor || settings.color || '')) ? (settings.subtitleColor || settings.color) : '#ffffff',
    highlightColor: /^#[0-9a-fA-F]{6}$/.test(String(settings.subtitleHighlightColor || settings.highlightColor || '')) ? (settings.subtitleHighlightColor || settings.highlightColor) : '#ffd84d',
    maxWordsPerLine: Math.min(10, Math.max(1, Math.round(Number(settings.subtitleMaxWordsPerLine ?? settings.maxWordsPerLine ?? 0) || 5))),
    positionY: Math.min(94, Math.max(6, Number.isFinite(positionY) ? positionY : 86)),
    fontScale: Math.min(2.4, Math.max(0.7, Number(settings.subtitleFontScale ?? settings.fontScale ?? 1) || 1)),
    opacity: Math.min(1, Math.max(0.1, Number(settings.subtitleOpacity ?? settings.opacity ?? 1) || 1))
  };
}

function getSubtitleEffectConfig(settings) {
  const effect = settings.effect || 'karaoke-fill';
  const primaryColor = hexToAssColor(settings.color, '#ffffff', settings.opacity);
  const highlightColor = hexToAssColor(settings.highlightColor, '#ffd84d', settings.opacity);
  if (effect === 'active-fill') {
    return {
      karaokeTag: 'kf',
      primaryColor: highlightColor,
      secondaryColor: primaryColor,
      outlineColor: '&H00000000',
      backColor: '&HA0000000',
      outline: 4,
      shadow: 1,
      bold: 1,
      inlinePrefix: ''
    };
  }
  if (effect === 'active-outline') {
    return {
      karaokeTag: 'ko',
      primaryColor,
      secondaryColor: highlightColor,
      outlineColor: highlightColor,
      backColor: '&H96000000',
      outline: 5,
      shadow: 1,
      bold: 1,
      inlinePrefix: ''
    };
  }
  if (effect === 'sweep-glow') {
    return {
      karaokeTag: 'K',
      primaryColor: highlightColor,
      secondaryColor: primaryColor,
      outlineColor: '&H00000000',
      backColor: '&H7A000000',
      outline: 4,
      shadow: 3,
      bold: 1,
      inlinePrefix: '\\blur0.6'
    };
  }
  if (effect === 'active-pop-fill') {
    return {
      karaokeTag: '',
      primaryColor,
      secondaryColor: highlightColor,
      outlineColor: '&H00000000',
      backColor: '&H8A000000',
      outline: 4,
      shadow: 2,
      bold: 1,
      activeScale: 126,
      activeExtraTags: '\\blur0.25'
    };
  }
  if (effect === 'tiktok-pill') {
    return {
      karaokeTag: '',
      primaryColor,
      secondaryColor: primaryColor,
      outlineColor: '&H00000000',
      backColor: '&H8A000000',
      outline: 4,
      shadow: 1,
      bold: 1,
      activeScale: 100,
      activeExtraTags: `${assColorToOutlineTags(highlightColor)}\\bord10\\shad0`
    };
  }
  if (effect === 'tiktok-pop-pill') {
    return {
      karaokeTag: '',
      primaryColor,
      secondaryColor: primaryColor,
      outlineColor: '&H00000000',
      backColor: '&H8A000000',
      outline: 4,
      shadow: 1,
      bold: 1,
      activeScale: 112,
      activeExtraTags: `${assColorToOutlineTags(highlightColor)}\\bord10\\shad0`
    };
  }
  if (effect === 'neon-active') {
    return {
      karaokeTag: '',
      primaryColor,
      secondaryColor: highlightColor,
      outlineColor: '&H00000000',
      backColor: '&H8A000000',
      outline: 4,
      shadow: 2,
      bold: 1,
      activeScale: 106,
      activeExtraTags: '\\blur1.1\\bord5'
    };
  }
  if (effect === 'bounce-outline') {
    return {
      karaokeTag: '',
      primaryColor,
      secondaryColor: primaryColor,
      outlineColor: '&H00000000',
      backColor: '&H8A000000',
      outline: 4,
      shadow: 2,
      bold: 1,
      activeScale: 120,
      activeExtraTags: `${assColorToOutlineTags(highlightColor)}\\bord5\\blur0.2`
    };
  }
  if (effect === 'glow-pulse') {
    return {
      karaokeTag: '',
      primaryColor,
      secondaryColor: highlightColor,
      outlineColor: highlightColor,
      backColor: '&H8A000000',
      outline: 4,
      shadow: 2,
      bold: 1,
      activeScale: 112,
      activeExtraTags: '\\blur0.9\\bord5'
    };
  }
  if (effect === 'highlight-box') {
    return {
      karaokeTag: '',
      primaryColor,
      secondaryColor: primaryColor,
      outlineColor: '&H00000000',
      backColor: hexToAssColor(settings.highlightColor, '#ffd84d', 0.24),
      outline: 9,
      shadow: 0,
      bold: 1,
      borderStyle: 3,
      inlinePrefix: ''
    };
  }
  if (effect === 'typewriter') {
    return {
      karaokeTag: 'k',
      primaryColor,
      secondaryColor: hexToAssColor(settings.color, '#ffffff', 0.1),
      outlineColor: '&H00000000',
      backColor: '&H96000000',
      outline: 3,
      shadow: 1,
      bold: 1,
      inlinePrefix: ''
    };
  }
  if (effect === 'plain-text') {
    return {
      karaokeTag: '',
      primaryColor,
      secondaryColor: primaryColor,
      outlineColor: '&H00000000',
      backColor: '&H96000000',
      outline: 3,
      shadow: 1,
      bold: 1,
      inlinePrefix: ''
    };
  }
  return {
    karaokeTag: 'k',
    primaryColor,
    secondaryColor: highlightColor,
    outlineColor: '&H00000000',
    backColor: '&H96000000',
    outline: 3,
    shadow: 1,
    bold: 1,
    borderStyle: 1,
    inlinePrefix: ''
  };
}

function applySubtitleTextCase(word, settingsOrCase = 'original') {
  const textCase = typeof settingsOrCase === 'string'
    ? settingsOrCase
    : settingsOrCase?.textCase;
  const value = String(word || '');
  if (textCase === 'lower') return value.toLocaleLowerCase();
  if (textCase === 'upper') return value.toLocaleUpperCase();
  if (textCase === 'title') {
    return value.replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase());
  }
  return value;
}

function buildKaraokeWordTag(word, durationCs, effectConfig, settingsOrCase = 'original') {
  const text = escapeAssText(applySubtitleTextCase(word, settingsOrCase));
  if (!effectConfig.karaokeTag) {
    return text;
  }
  const prefix = effectConfig.inlinePrefix ? `\\${effectConfig.inlinePrefix.replace(/^\\/, '')}` : '';
  return `{${prefix}\\${effectConfig.karaokeTag}${durationCs}}${text}`;
}

function getWordJoiner(settingsOrLanguage = 'vi') {
  const language = typeof settingsOrLanguage === 'string'
    ? settingsOrLanguage
    : settingsOrLanguage?.videoLanguage;
  return ['ja', 'th'].includes(String(language || '').toLowerCase()) ? '' : ' ';
}

function buildStaticSubtitleText(words, settingsOrLanguage = 'vi') {
  return words
    .map((word) => escapeAssText(applySubtitleTextCase(word, settingsOrLanguage)))
    .join(getWordJoiner(settingsOrLanguage));
}

function assColorToInlineTags(assColor) {
  const match = String(assColor || '').match(/^&H([0-9A-Fa-f]{2})([0-9A-Fa-f]{6})$/);
  if (!match) {
    return '\\c&HFFFFFF&';
  }
  return `\\c&H${match[2]}&\\alpha&H${match[1]}&`;
}

function assColorToOutlineTags(assColor) {
  const match = String(assColor || '').match(/^&H([0-9A-Fa-f]{2})([0-9A-Fa-f]{6})$/);
  if (!match) {
    return '\\3c&H000000&\\3a&H00&';
  }
  return `\\3c&H${match[2]}&\\3a&H${match[1]}&`;
}

function buildActiveStyledSubtitleText(words, activeIndex, effectConfig, settingsOrLanguage = 'vi') {
  const primaryTags = assColorToInlineTags(effectConfig.primaryColor);
  const highlightTags = assColorToInlineTags(effectConfig.secondaryColor);
  const outlineTags = assColorToOutlineTags(effectConfig.outlineColor);
  const activeScale = Math.max(100, Math.round(effectConfig.activeScale || 118));
  const inactiveTags = `${primaryTags}${outlineTags}\\fscx100\\fscy100\\bord${effectConfig.outline || 3}\\blur0`;
  const activeTags = `${highlightTags}\\fscx${activeScale}\\fscy${activeScale}${effectConfig.activeExtraTags || ''}`;
  const resetTags = `${primaryTags}${outlineTags}\\fscx100\\fscy100\\bord${effectConfig.outline || 3}\\blur0`;
  return words
    .map((word, index) => {
      const text = escapeAssText(applySubtitleTextCase(word, settingsOrLanguage));
      if (index !== activeIndex) {
        return `{${inactiveTags}}${text}`;
      }
      return `{${activeTags}}${text}{${resetTags}}`;
    })
    .join(getWordJoiner(settingsOrLanguage));
}

function isActiveWordEffect(effect) {
  return ['active-zoom-fill', 'active-pop-fill', 'glow-pulse', 'tiktok-pill', 'tiktok-pop-pill', 'neon-active', 'bounce-outline'].includes(effect);
}

function parseSrtBlocks(srtText) {
  return String(srtText || '')
    .trim()
    .split(/\n\s*\n/g)
    .map((block) => {
      const lines = block.split('\n').filter(Boolean);
      if (lines.length < 3) {
        return null;
      }
      const [start, end] = lines[1].split(/\s+-->\s+/);
      return {
        index: Number(lines[0]),
        time: lines[1],
        startMs: parseSrtTime(start),
        endMs: parseSrtTime(end),
        text: lines.slice(2).join(' ').trim()
      };
    })
    .filter(Boolean);
}

function buildSrt(blocks) {
  return blocks
    .map(
      (block, index) =>
        `${index + 1}\n${block.time || `${formatSrtTime(block.startMs)} --> ${formatSrtTime(block.endMs)}`}\n${block.text}\n`
    )
    .join('\n');
}

function realignSubtitleText(originalText, autoSrtText, settings = {}) {
  const blocks = parseSrtBlocks(autoSrtText);
  const sourceWords = splitTextWords(originalText, settings.videoLanguage);
  const joiner = getWordJoiner(settings);
  if (!blocks.length || !sourceWords.length) {
    return autoSrtText;
  }

  let cursor = 0;
  const corrected = blocks.map((block) => {
    const blockWordCount = Math.max(1, splitTextWords(block.text, settings.videoLanguage).length);
    const nextWords = sourceWords.slice(cursor, cursor + blockWordCount);
    cursor += blockWordCount;
    return {
      time: block.time,
      startMs: block.startMs,
      endMs: block.endMs,
      text: nextWords.join(joiner) || block.text
    };
  });

  if (cursor < sourceWords.length && corrected.length) {
    corrected[corrected.length - 1].text = `${corrected[corrected.length - 1].text}${joiner}${sourceWords.slice(cursor).join(joiner)}`.trim();
  }

  return buildSrt(corrected);
}

function splitWordsIntoSubtitleLines(text, maxWords = 7, maxChars = 46, videoLanguage = 'vi') {
  const words = splitTextWords(text, videoLanguage);
  const joiner = getWordJoiner(videoLanguage);
  const lines = [];
  let current = [];

  for (const word of words) {
    const next = [...current, word];
    if (current.length && (next.length > maxWords || next.join(joiner).length > maxChars)) {
      lines.push(current.join(joiner));
      current = [word];
    } else {
      current = next;
    }
  }
  if (current.length) lines.push(current.join(joiner));
  return lines;
}

function splitTextWords(text, videoLanguage = 'vi') {
  const value = String(text || '').trim();
  const language = String(videoLanguage || '').toLowerCase();
  if (!value || !['ja', 'th'].includes(language) || typeof Intl.Segmenter !== 'function') {
    return value.split(/\s+/).filter(Boolean);
  }
  return [...new Intl.Segmenter(language, { granularity: 'word' }).segment(value)]
    .filter((item) => item.isWordLike)
    .map((item) => item.segment);
}

function buildFallbackSrtFromText(text, durationSec = 1, settings = {}) {
  const lines = splitWordsIntoSubtitleLines(text, 7, 46, settings.videoLanguage);
  if (!lines.length) {
    return '';
  }

  const durationMs = Math.max(1000, Math.round((Number(durationSec) || 1) * 1000));
  const slotMs = durationMs / lines.length;
  const blocks = lines.map((line, index) => {
    const startMs = Math.round(index * slotMs);
    const endMs = index === lines.length - 1
      ? durationMs
      : Math.max(startMs + 300, Math.round((index + 1) * slotMs));
    return {
      startMs,
      endMs,
      text: line
    };
  });
  return buildSrt(blocks);
}

function getWhisperFallbackReason(error) {
  const message = String(error?.message || error?.stderr || '');
  if (
    error?.code === 'FASTER_WHISPER_UNAVAILABLE'
    || /faster_whisper runtime unavailable|No module named faster_whisper|Unable to import faster_whisper|not found|command not found|can't find .*faster_whisper/i.test(message)
  ) {
    return 'faster_whisper_unavailable';
  }
  return 'whisper_failed';
}

function normalizeTimedWords(words = []) {
  return (Array.isArray(words) ? words : [])
    .map((item) => {
      const word = String(item?.word || '').trim();
      const rawStartMs = item?.startMs ?? Number(item?.start || 0) * 1000;
      const rawEndMs = item?.endMs ?? Number(item?.end || 0) * 1000;
      const startMs = Math.max(0, Math.round(Number(rawStartMs) || 0));
      const endMs = Math.max(startMs + 30, Math.round(Number(rawEndMs) || 0));
      return word ? { word, startMs, endMs } : null;
    })
    .filter(Boolean);
}

async function readWhisperWords(wordsPath) {
  try {
    return normalizeTimedWords(JSON.parse(await fs.readFile(wordsPath, 'utf8')));
  } catch {
    return [];
  }
}

function normalizeAlignmentText(text) {
  return String(text || '')
    .toLocaleLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function getEditDistance(leftText, rightText) {
  const left = String(leftText || '');
  const right = String(rightText || '');
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        substitution
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function getAlignmentSimilarity(sourceWords, timingWords) {
  const source = normalizeAlignmentText(sourceWords.join(''));
  const recognized = normalizeAlignmentText(timingWords.map((item) => item.word).join(''));
  if (!source || !recognized) {
    return 0;
  }
  return 1 - getEditDistance(source, recognized) / Math.max(source.length, recognized.length);
}

function distributeTimingAcrossWords(sourceWords, startMs, endMs) {
  const durationMs = Math.max(30, endMs - startMs);
  return sourceWords.map((word, index) => ({
    word,
    startMs: Math.round(startMs + durationMs * index / sourceWords.length),
    endMs: Math.round(startMs + durationMs * (index + 1) / sourceWords.length)
  }));
}

function alignSourceWordsToWhisperTiming(sourceWords, timings) {
  const sourceCount = sourceWords.length;
  const timingCount = timings.length;
  const maxSpan = 3;
  const gapCost = 0.72;
  const cost = Array.from({ length: sourceCount + 1 }, () => Array(timingCount + 1).fill(Number.POSITIVE_INFINITY));
  const previous = Array.from({ length: sourceCount + 1 }, () => Array(timingCount + 1).fill(null));
  cost[0][0] = 0;

  const update = (fromSource, fromTiming, sourceLength, timingLength, nextCost) => {
    const nextSource = fromSource + sourceLength;
    const nextTiming = fromTiming + timingLength;
    if (nextCost < cost[nextSource][nextTiming]) {
      cost[nextSource][nextTiming] = nextCost;
      previous[nextSource][nextTiming] = { fromSource, fromTiming, sourceLength, timingLength };
    }
  };

  for (let sourceIndex = 0; sourceIndex <= sourceCount; sourceIndex += 1) {
    for (let timingIndex = 0; timingIndex <= timingCount; timingIndex += 1) {
      const currentCost = cost[sourceIndex][timingIndex];
      if (!Number.isFinite(currentCost)) continue;

      if (sourceIndex < sourceCount) {
        update(sourceIndex, timingIndex, 1, 0, currentCost + gapCost);
      }
      if (timingIndex < timingCount) {
        update(sourceIndex, timingIndex, 0, 1, currentCost + gapCost);
      }

      for (let sourceLength = 1; sourceLength <= maxSpan && sourceIndex + sourceLength <= sourceCount; sourceLength += 1) {
        for (let timingLength = 1; timingLength <= maxSpan && timingIndex + timingLength <= timingCount; timingLength += 1) {
          const grouped = sourceLength !== 1 || timingLength !== 1;
          const similarity = getAlignmentSimilarity(
            sourceWords.slice(sourceIndex, sourceIndex + sourceLength),
            timings.slice(timingIndex, timingIndex + timingLength)
          );
          if (grouped && similarity < 0.72) continue;
          const groupingCost = grouped ? 0.14 * (Math.max(sourceLength, timingLength) - 1) : 0;
          update(
            sourceIndex,
            timingIndex,
            sourceLength,
            timingLength,
            currentCost + (1 - similarity) + groupingCost
          );
        }
      }
    }
  }

  const steps = [];
  let sourceIndex = sourceCount;
  let timingIndex = timingCount;
  while (sourceIndex || timingIndex) {
    const step = previous[sourceIndex][timingIndex];
    if (!step) return [];
    steps.unshift(step);
    sourceIndex = step.fromSource;
    timingIndex = step.fromTiming;
  }

  const mappedWords = Array(sourceCount).fill(null);
  for (const step of steps) {
    if (!step.sourceLength || !step.timingLength) continue;
    const matchedSource = sourceWords.slice(step.fromSource, step.fromSource + step.sourceLength);
    const matchedTiming = timings.slice(step.fromTiming, step.fromTiming + step.timingLength);
    if (step.sourceLength === step.timingLength) {
      for (let index = 0; index < step.sourceLength; index += 1) {
        mappedWords[step.fromSource + index] = { ...matchedTiming[index], word: matchedSource[index] };
      }
      continue;
    }
    const distributed = distributeTimingAcrossWords(
      matchedSource,
      matchedTiming[0].startMs,
      matchedTiming[matchedTiming.length - 1].endMs
    );
    for (let index = 0; index < distributed.length; index += 1) {
      mappedWords[step.fromSource + index] = distributed[index];
    }
  }

  for (let index = 0; index < mappedWords.length;) {
    if (mappedWords[index]) {
      index += 1;
      continue;
    }
    const missingStart = index;
    while (index < mappedWords.length && !mappedWords[index]) index += 1;
    const missingEnd = index;
    const previousWord = mappedWords[missingStart - 1];
    const nextWord = mappedWords[missingEnd];
    const startMs = previousWord?.endMs ?? timings[0].startMs;
    const endMs = nextWord?.startMs ?? timings[timings.length - 1].endMs;
    const fallbackEndMs = endMs > startMs ? endMs : startMs + 30 * (missingEnd - missingStart);
    const distributed = distributeTimingAcrossWords(
      sourceWords.slice(missingStart, missingEnd),
      startMs,
      fallbackEndMs
    );
    for (let offset = 0; offset < distributed.length; offset += 1) {
      mappedWords[missingStart + offset] = distributed[offset];
    }
  }

  return mappedWords;
}

function mapSourceWordsToWhisperTiming(sourceText, whisperWords, durationSec = 1, settings = {}) {
  const sourceWords = splitTextWords(sourceText, settings.videoLanguage);
  const timings = normalizeTimedWords(whisperWords);
  if (!sourceWords.length || !timings.length) {
    return [];
  }

  const alignedWords = alignSourceWordsToWhisperTiming(sourceWords, timings);
  if (alignedWords.length === sourceWords.length) {
    return alignedWords;
  }

  const firstStart = timings[0].startMs;
  const lastEnd = Math.max(firstStart + 500, timings[timings.length - 1].endMs);
  const durationMs = Math.max(1000, Math.round((Number(durationSec) || 1) * 1000));
  const timelineStart = Number.isFinite(firstStart) ? firstStart : 0;
  const timelineEnd = Number.isFinite(lastEnd) ? lastEnd : durationMs;
  const wordCountRatio = Math.max(sourceWords.length, timings.length) / Math.max(1, Math.min(sourceWords.length, timings.length));
  const useIndexedTiming = wordCountRatio <= 1.45;

  return sourceWords.map((word, index) => {
    if (useIndexedTiming) {
      const startIndex = Math.min(timings.length - 1, Math.floor(index * timings.length / sourceWords.length));
      const endIndex = Math.min(timings.length - 1, Math.max(startIndex, Math.ceil((index + 1) * timings.length / sourceWords.length) - 1));
      return {
        word,
        startMs: timings[startIndex].startMs,
        endMs: Math.max(timings[startIndex].startMs + 30, timings[endIndex].endMs)
      };
    }

    const startMs = Math.round(timelineStart + (timelineEnd - timelineStart) * index / sourceWords.length);
    const endMs = index === sourceWords.length - 1
      ? timelineEnd
      : Math.round(timelineStart + (timelineEnd - timelineStart) * (index + 1) / sourceWords.length);
    return {
      word,
      startMs,
      endMs: Math.max(startMs + 30, endMs)
    };
  });
}

function groupTimedWords(timedWords, settingsOrAspectRatio = '16:9', maxChars = 46) {
  const settings = normalizeSubtitleSettings(settingsOrAspectRatio);
  const joiner = getWordJoiner(settings);
  const ratioConfig = getAspectRatioConfig(settings.aspectRatio);
  const subtitleStyleByRatio = {
    '16:9': { wordsPerLine: 5 },
    '9:16': { wordsPerLine: 4 },
    '1:1': { wordsPerLine: 4 },
    '4:3': { wordsPerLine: 5 },
    '5:4': { wordsPerLine: 5 }
  };
  const defaultWordsPerLine = subtitleStyleByRatio[ratioConfig.value]?.wordsPerLine || 5;
  const wordsPerLine = settings.maxWordsPerLine || defaultWordsPerLine;
  const groups = [];
  let current = [];

  for (const word of timedWords) {
    const next = [...current, word];
    const nextText = next.map((item) => item.word).join(joiner);
    if (current.length && (next.length > wordsPerLine || nextText.length > maxChars)) {
      groups.push(current);
      current = [word];
    } else {
      current = next;
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

function buildTimedSubtitleBlocks(timedWords, settingsOrAspectRatio = '16:9') {
  const settings = normalizeSubtitleSettings(settingsOrAspectRatio);
  const joiner = getWordJoiner(settings);
  const groups = groupTimedWords(timedWords, settings);
  return groups
    .map((group, index) => {
      const startMs = group[0].startMs;
      const naturalEndMs = Math.max(startMs + 30, group[group.length - 1].endMs);
      const nextStartMs = groups[index + 1]?.[0]?.startMs;
      return {
        startMs,
        endMs: Number.isFinite(nextStartMs) ? Math.min(naturalEndMs, nextStartMs) : naturalEndMs,
        text: group.map((item) => item.word).join(joiner),
        words: group
      };
    })
    // ASR can map two source groups onto the same instant; no display
    // window is preferable to showing both lines at once.
    .filter((block) => block.endMs > block.startMs);
}

function buildSrtFromTimedWords(timedWords, settingsOrAspectRatio = '16:9') {
  return buildSrt(buildTimedSubtitleBlocks(timedWords, settingsOrAspectRatio));
}

function buildKaraokeAssFromSrtText(srtText, settingsOrAspectRatio = '16:9') {
  const blocks = parseSrtBlocks(srtText);
  const settings = normalizeSubtitleSettings(settingsOrAspectRatio);
  const ratioConfig = getAspectRatioConfig(settings.aspectRatio);
  // PlayRes matches actual render resolution so font sizes map 1-to-1
  const playResX = ratioConfig.width;
  const playResY = ratioConfig.height;
  const subtitleStyleByRatio = {
    '16:9': { fontSize: 58, marginV: 55, marginLR: 80, wordsPerLine: 5 },
    '9:16': { fontSize: 72, marginV: 110, marginLR: 50, wordsPerLine: 4 },
    '1:1': { fontSize: 62, marginV: 72, marginLR: 70, wordsPerLine: 4 },
    '4:3': { fontSize: 58, marginV: 60, marginLR: 80, wordsPerLine: 5 },
    '5:4': { fontSize: 60, marginV: 66, marginLR: 76, wordsPerLine: 5 }
  };
  const subtitleStyle = subtitleStyleByRatio[ratioConfig.value] || subtitleStyleByRatio['16:9'];
  const fontSize = Math.round(subtitleStyle.fontSize * settings.fontScale);
  const effectConfig = getSubtitleEffectConfig(settings);
  const wordsPerLine = settings.maxWordsPerLine || subtitleStyle.wordsPerLine;
  const subtitleX = Math.round(playResX / 2);
  const subtitleY = Math.round(playResY * settings.positionY / 100);
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${playResX}`,
    `PlayResY: ${playResY}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Karaoke,${settings.fontFamily},${fontSize},${effectConfig.primaryColor},${effectConfig.secondaryColor},${effectConfig.outlineColor},${effectConfig.backColor},${effectConfig.bold},0,0,0,100,100,0,0,${effectConfig.borderStyle || 1},${effectConfig.outline},${effectConfig.shadow},8,${subtitleStyle.marginLR},${subtitleStyle.marginLR},0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];

  const dialogueLines = [];

  for (const block of blocks) {
    const words = block.text.split(/\s+/).filter(Boolean);
    if (!words.length) {
      continue;
    }
    const pieces = chunkWords(words, wordsPerLine);
    const blockDuration = Math.max(1, block.endMs - block.startMs);
    const wordDuration = blockDuration / words.length;
    let localWordIndex = 0;

    for (const piece of pieces) {
      const startMs = block.startMs + Math.round(localWordIndex * wordDuration);
      const endMs = block.startMs + Math.round((localWordIndex + piece.length) * wordDuration);
      if (settings.effect === 'plain-text') {
        dialogueLines.push(
          `Dialogue: 0,${formatAssTime(startMs)},${formatAssTime(endMs)},Karaoke,,0,0,0,,{\\an8\\pos(${subtitleX},${subtitleY})}${buildStaticSubtitleText(piece, settings)}`
        );
      } else if (isActiveWordEffect(settings.effect)) {
        piece.forEach((word, index) => {
          const wordStartMs = block.startMs + Math.round((localWordIndex + index) * wordDuration);
          const wordEndMs = block.startMs + Math.round((localWordIndex + index + 1) * wordDuration);
          dialogueLines.push(
            `Dialogue: 0,${formatAssTime(wordStartMs)},${formatAssTime(wordEndMs)},Karaoke,,0,0,0,,{\\an8\\pos(${subtitleX},${subtitleY})}${buildActiveStyledSubtitleText(piece, index, effectConfig, settings)}`
          );
        });
      } else {
        const karaokeText = piece
          .map((word) => {
            const durationCs = Math.max(1, Math.round(wordDuration / 10));
            return buildKaraokeWordTag(word, durationCs, effectConfig, settings);
          })
          .join(getWordJoiner(settings));
        dialogueLines.push(
          `Dialogue: 0,${formatAssTime(startMs)},${formatAssTime(endMs)},Karaoke,,0,0,0,,{\\an8\\pos(${subtitleX},${subtitleY})}${karaokeText}`
        );
      }
      localWordIndex += piece.length;
    }
  }

  return `${header.join('\n')}\n${dialogueLines.join('\n')}\n`;
}

function buildKaraokeAssFromTimedWords(timedWords, settingsOrAspectRatio = '16:9') {
  const settings = normalizeSubtitleSettings(settingsOrAspectRatio);
  const ratioConfig = getAspectRatioConfig(settings.aspectRatio);
  const playResX = ratioConfig.width;
  const playResY = ratioConfig.height;
  const subtitleStyleByRatio = {
    '16:9': { fontSize: 58, marginLR: 80 },
    '9:16': { fontSize: 72, marginLR: 50 },
    '1:1': { fontSize: 62, marginLR: 70 },
    '4:3': { fontSize: 58, marginLR: 80 },
    '5:4': { fontSize: 60, marginLR: 76 }
  };
  const subtitleStyle = subtitleStyleByRatio[ratioConfig.value] || subtitleStyleByRatio['16:9'];
  const fontSize = Math.round(subtitleStyle.fontSize * settings.fontScale);
  const effectConfig = getSubtitleEffectConfig(settings);
  const subtitleX = Math.round(playResX / 2);
  const subtitleY = Math.round(playResY * settings.positionY / 100);
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${playResX}`,
    `PlayResY: ${playResY}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Karaoke,${settings.fontFamily},${fontSize},${effectConfig.primaryColor},${effectConfig.secondaryColor},${effectConfig.outlineColor},${effectConfig.backColor},${effectConfig.bold},0,0,0,100,100,0,0,${effectConfig.borderStyle || 1},${effectConfig.outline},${effectConfig.shadow},8,${subtitleStyle.marginLR},${subtitleStyle.marginLR},0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];
  const dialogueLines = buildTimedSubtitleBlocks(timedWords, settings).flatMap((block) => {
    if (settings.effect === 'plain-text') {
      return [
        `Dialogue: 0,${formatAssTime(block.startMs)},${formatAssTime(block.endMs)},Karaoke,,0,0,0,,{\\an8\\pos(${subtitleX},${subtitleY})}${buildStaticSubtitleText(block.words.map((word) => word.word), settings)}`
      ];
    }
    if (isActiveWordEffect(settings.effect)) {
      return block.words.map((activeWord, index) => {
        const words = block.words.map((word) => word.word);
        return `Dialogue: 0,${formatAssTime(activeWord.startMs)},${formatAssTime(activeWord.endMs)},Karaoke,,0,0,0,,{\\an8\\pos(${subtitleX},${subtitleY})}${buildActiveStyledSubtitleText(words, index, effectConfig, settings)}`;
      });
    }
    const karaokeText = block.words
      .map((word) => {
        const durationCs = Math.max(1, Math.round((word.endMs - word.startMs) / 10));
        return buildKaraokeWordTag(word.word, durationCs, effectConfig, settings);
      })
      .join(getWordJoiner(settings));
    return [`Dialogue: 0,${formatAssTime(block.startMs)},${formatAssTime(block.endMs)},Karaoke,,0,0,0,,{\\an8\\pos(${subtitleX},${subtitleY})}${karaokeText}`];
  });
  return `${header.join('\n')}\n${dialogueLines.join('\n')}\n`;
}

async function createSubtitleWithFasterWhisper({ audioPath, outputPath, wordsPath, metadataPath, settings }) {
  await runWhisperTranscription({
    audioPath,
    outputSrtPath: outputPath,
    outputWordsPath: wordsPath,
    metadataPath,
    settings
  });
  return outputPath;
}

async function writeSubtitleArtifacts(sceneDir, correctedText, settingsOrAspectRatio = '16:9', timedWords = []) {
  const srtPath = path.join(sceneDir, 'voice.corrected.srt');
  const assPath = path.join(sceneDir, 'voice.karaoke.ass');
  await fs.writeFile(srtPath, correctedText, 'utf8');
  const assText = timedWords.length
    ? buildKaraokeAssFromTimedWords(timedWords, settingsOrAspectRatio)
    : buildKaraokeAssFromSrtText(correctedText, settingsOrAspectRatio);
  await fs.writeFile(assPath, assText, 'utf8');
  return { srtPath, assPath };
}

async function createCorrectedSubtitle({ scene, sceneDir, settings, force = false }) {
  const autoPath = path.join(sceneDir, 'voice.auto.srt');
  const wordsPath = path.join(sceneDir, 'voice.auto.words.json');
  const metadataPath = path.join(sceneDir, 'voice.auto.whisper.json');
  let fallback = false;
  let reason = null;

  if (force) {
    await Promise.all([
      fs.rm(autoPath, { force: true }).catch(() => {}),
      fs.rm(wordsPath, { force: true }).catch(() => {}),
      fs.rm(metadataPath, { force: true }).catch(() => {})
    ]);
  }

  let autoSrtText = '';
  try {
    autoSrtText = await fs.readFile(autoPath, 'utf8');
  } catch {
    try {
      await createSubtitleWithFasterWhisper({
        audioPath: path.join(sceneDir, 'voice.padded.wav'),
        outputPath: autoPath,
        wordsPath,
        metadataPath,
        settings
      });
    } catch (error) {
      const fallbackSrt = buildFallbackSrtFromText(scene.voiceText, scene.durations?.voiceSec, settings);
      await fs.writeFile(autoPath, fallbackSrt, 'utf8');
      fallback = true;
      reason = getWhisperFallbackReason(error);
    }
    autoSrtText = await fs.readFile(autoPath, 'utf8');
  }

  const whisperWords = fallback ? [] : await readWhisperWords(wordsPath);
  const timedWords = mapSourceWordsToWhisperTiming(scene.voiceText, whisperWords, scene.durations?.voiceSec, settings);
  const corrected = fallback
    ? autoSrtText
    : timedWords.length
    ? buildSrtFromTimedWords(timedWords, settings)
    : realignSubtitleText(scene.voiceText, autoSrtText, settings);
  const artifacts = await writeSubtitleArtifacts(sceneDir, corrected, settings, timedWords);
  return {
    ...artifacts,
    fallback,
    reason
  };
}

async function readSubtitleText(sceneDir) {
  const subtitlePath = path.join(sceneDir, 'voice.corrected.srt');
  try {
    return await fs.readFile(subtitlePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

async function saveManualSubtitle({ sceneDir, subtitleText, settings, aspectRatio = '16:9' }) {
  return writeSubtitleArtifacts(sceneDir, subtitleText, settings || aspectRatio);
}

module.exports = {
  createCorrectedSubtitle,
  realignSubtitleText,
  parseSrtBlocks,
  buildKaraokeAssFromSrtText,
  readSubtitleText,
  saveManualSubtitle
};
