const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');
const { ASSETS_DIR, SUBTITLE_FONT_OPTIONS, getAspectRatioConfig } = require('../config/constants');
const { getVideoLanguageConfig } = require('../config/languages');
const { AiProviderClient } = require('./aiProviderClient');
const { getHtmlSourceProvider } = require('./projectService');
const { buildHtmlMediaCatalog } = require('./htmlMediaService');
const { sanitizeHtmlForHyperframes } = require('./htmlSanitizer');
const { validateHtmlSceneQuality } = require('./htmlSceneValidator');
const htmlPatternLibrary = require('../config/htmlPatternLibrary.json');

const DEFAULT_HTML_GENERATION_ATTEMPTS = 12;
const MAX_RETRY_ERROR_HISTORY = 6;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stripFence(value) {
  return String(value || '').trim()
    .replace(/^```(?:html)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function decodeEscapedHtmlText(value) {
  let text = String(value || '').trim();
  for (let i = 0; i < 2; i += 1) {
    const looksEscaped = /\\u003c|\\x3c|\\n|\\\"|&lt;!?doctype|&lt;html/i.test(text);
    if (!looksEscaped) break;
    try {
      text = JSON.parse(`"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    } catch {
      text = text
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\//g, '/');
    }
    text = text
      .replace(/\\\\u003c|\\u003c/gi, '<')
      .replace(/\\\\u003e|\\u003e/gi, '>')
      .replace(/\\\\x3c|\\x3c/gi, '<')
      .replace(/\\\\x3e|\\x3e/gi, '>')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");
  }
  return text;
}

function collectHtmlCandidates(value) {
  const raw = String(value || '');
  const stripped = stripFence(raw);
  const candidates = [stripped, decodeEscapedHtmlText(stripped)];
  try {
    const parsed = JSON.parse(stripped);
    const stack = [parsed];
    while (stack.length) {
      const item = stack.shift();
      if (typeof item === 'string') {
        candidates.push(item, decodeEscapedHtmlText(item));
      } else if (Array.isArray(item)) {
        stack.push(...item);
      } else if (item && typeof item === 'object') {
        for (const key of ['html', 'document', 'content', 'code', 'result', 'output', 'text']) {
          if (item[key] !== undefined) stack.push(item[key]);
        }
      }
    }
  } catch {}
  return [...new Set(candidates.map((candidate) => String(candidate || '').trim()).filter(Boolean))];
}

function extractHtmlDocument(value) {
  const documents = [];
  for (const text of collectHtmlCandidates(value)) {
    const doctypeIndex = text.search(/<!doctype\s+html/i);
    if (doctypeIndex >= 0) {
      const afterDoctype = text.slice(doctypeIndex);
      const endMatch = afterDoctype.match(/<\/html\s*>/i);
      documents.push(endMatch ? afterDoctype.slice(0, endMatch.index + endMatch[0].length).trim() : afterDoctype.trim());
      continue;
    }
    const htmlIndex = text.search(/<html[\s>]/i);
    if (htmlIndex >= 0) {
      const afterHtml = text.slice(htmlIndex);
      const endMatch = afterHtml.match(/<\/html\s*>/i);
      const doc = endMatch ? afterHtml.slice(0, endMatch.index + endMatch[0].length).trim() : afterHtml.trim();
      documents.push(`<!doctype html>\n${doc}`);
    }
  }
  const validDocument = documents.find((doc) => /<div[^>]+id=["']stage["']/i.test(doc));
  if (validDocument) return validDocument;
  if (documents.length) return documents[0];
  return stripFence(value);
}

function parseSrtTime(value) {
  const match = String(value || '').match(/(\d+):(\d+):(\d+),(\d+)/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function parseSrt(srtText) {
  return String(srtText || '').trim().split(/\n\s*\n/g).map((block) => {
    const lines = block.split(/\r?\n/).filter(Boolean);
    if (lines.length < 3) return null;
    const [start, end] = String(lines[1] || '').split(/\s+-->\s+/);
    return {
      index: Number(lines[0]) || null,
      startSec: parseSrtTime(start),
      endSec: parseSrtTime(end),
      text: lines.slice(2).join(' ').trim()
    };
  }).filter(Boolean);
}

async function readTextIfExists(filePath) {
  if (!filePath) return '';
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function readJsonIfExists(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function getSelectedPattern(scene) {
  const selected = String(scene.htmlSpec?.selectedPattern || scene.htmlSpec?.pattern || '').trim();
  const matched = htmlPatternLibrary.patterns.find((pattern) => pattern.id === selected);
  if (matched) return matched;
  const visualPlan = String(scene.htmlSpec?.visualPlan || scene.visual || '').toLowerCase();
  return htmlPatternLibrary.patterns.find((pattern) => visualPlan.includes(pattern.id)) || htmlPatternLibrary.patterns[0];
}

function compactPatternForPrompt(scene) {
  const pattern = getSelectedPattern(scene);
  return {
    id: pattern.id,
    category: pattern.category,
    components: pattern.components,
    requiredSlots: pattern.requiredSlots,
    optionalSlots: pattern.optionalSlots,
    motion: pattern.motion,
    htmlHints: pattern.htmlHints,
    exampleUse: pattern.exampleUse
  };
}

function compactRuntimeDesignForPrompt(scene) {
  const spec = scene.htmlSpec || {};
  const runtime = htmlPatternLibrary.runtimeDesign || {};
  const selectedMood = runtime.themeMoods?.find((mood) => mood.id === spec.designMood)
    || runtime.themeMoods?.[0]
    || null;
  const selectedBackgroundFx = runtime.backgroundFx?.find((fx) => fx.id === spec.backgroundFx)
    || runtime.backgroundFx?.[0]
    || null;
  const selectedRevealMode = runtime.revealModes?.find((mode) => mode.id === spec.revealMode)
    || runtime.revealModes?.[0]
    || null;
  return {
    themeMood: selectedMood ? {
      id: selectedMood.id,
      tokens: selectedMood.tokens,
      notes: selectedMood.notes
    } : null,
    backgroundFx: selectedBackgroundFx,
    revealMode: selectedRevealMode,
    sfxCues: runtime.sfxCues || []
  };
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s._-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sceneSearchText(scene) {
  return normalizeSearchText([
    scene.voiceText,
    scene.visual,
    scene.htmlSpec?.concept,
    scene.htmlSpec?.visualPlan,
    scene.htmlSpec?.selectedPattern,
    JSON.stringify(scene.htmlSpec?.contentSlots || {}),
    JSON.stringify(scene.htmlSpec?.assets || {}),
    JSON.stringify(scene.htmlSpec?.mediaHints || {}),
    JSON.stringify(scene.sfxPlan || [])
  ].filter(Boolean).join(' '));
}

function itemSearchText(item = {}) {
  return normalizeSearchText([
    item.id,
    item.fileName,
    item.description,
    item.role,
    item.type,
    item.mimeType
  ].filter(Boolean).join(' '));
}

function scoreMediaForScene(item, searchText) {
  const itemText = itemSearchText(item);
  if (!itemText) return 0;
  let score = 0;
  for (const token of itemText.split(/\s+/).filter((part) => part.length >= 3)) {
    if (searchText.includes(token)) score += 1;
  }
  if (item.role === 'brand-asset' && score) score += 4;
  if (item.role === 'scene-media' && score) score += 3;
  if (item.role === 'sound-effect' && score) score += 1;
  return score;
}

function filterHtmlMediaCatalogForScene(scene, mediaCatalog = []) {
  const searchText = sceneSearchText(scene);
  const hasSfxPlan = Array.isArray(scene.sfxPlan) && scene.sfxPlan.length > 0;
  const ranked = mediaCatalog
    .map((item) => ({ item, score: scoreMediaForScene(item, searchText) }))
    .filter(({ item, score }) => {
      if (score > 0) return true;
      if (item.role === 'scene-media') return true;
      return item.role === 'sound-effect' && hasSfxPlan;
    })
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item);

  const sceneMedia = ranked.filter((item) => item.role === 'scene-media').slice(0, 6);
  const brandAssets = ranked.filter((item) => item.role === 'brand-asset').slice(0, 4);
  const soundEffects = hasSfxPlan ? ranked.filter((item) => item.role === 'sound-effect').slice(0, 4) : [];
  return [...sceneMedia, ...brandAssets, ...soundEffects].slice(0, 10);
}

function compactMediaForPrompt(mediaCatalog = []) {
  return mediaCatalog.map((item) => ({
    id: item.id,
    role: item.role,
    type: item.type,
    fileName: item.fileName,
    description: item.description,
    src: item.src,
    width: item.width,
    height: item.height,
    durationSec: item.durationSec
  }));
}

function truncateText(value, maxLength = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function compactStringArray(items, limit = 4, maxLength = 120) {
  return (Array.isArray(items) ? items : [])
    .map((item) => truncateText(item, maxLength))
    .filter(Boolean)
    .slice(0, limit);
}

function compactHtmlSpecForPrompt(spec = {}) {
  return {
    concept: truncateText(spec.concept, 180),
    selectedPattern: truncateText(spec.selectedPattern || spec.pattern, 80),
    designMood: truncateText(spec.designMood, 80),
    backgroundFx: truncateText(spec.backgroundFx, 80),
    revealMode: truncateText(spec.revealMode, 80),
    visualPlan: truncateText(spec.visualPlan, 260),
    visualTwist: truncateText(spec.visualTwist, 180),
    contentSlots: Object.fromEntries(
      Object.entries(spec.contentSlots || {})
        .slice(0, 5)
        .map(([key, value]) => [key, truncateText(typeof value === 'string' ? value : JSON.stringify(value), 120)])
    )
  };
}

function compactPatternForModule(scene) {
  const pattern = compactPatternForPrompt(scene);
  return {
    id: pattern.id,
    category: pattern.category,
    components: (pattern.components || []).slice(0, 4),
    requiredSlots: (pattern.requiredSlots || []).slice(0, 4),
    motion: truncateText(pattern.motion, 160),
    htmlHints: compactStringArray(pattern.htmlHints, 4, 120)
  };
}

function compactRuntimeDesignForModule(scene) {
  const runtime = compactRuntimeDesignForPrompt(scene);
  return {
    themeMood: runtime.themeMood ? {
      id: runtime.themeMood.id,
      tokens: runtime.themeMood.tokens,
      notes: truncateText(runtime.themeMood.notes, 160)
    } : null,
    backgroundFx: runtime.backgroundFx ? {
      id: runtime.backgroundFx.id,
      notes: truncateText(runtime.backgroundFx.notes || runtime.backgroundFx.description, 140)
    } : null,
    revealMode: runtime.revealMode ? {
      id: runtime.revealMode.id,
      notes: truncateText(runtime.revealMode.notes || runtime.revealMode.description, 140)
    } : null
  };
}

function compactMediaForModule(mediaCatalog = [], limit = 40) {
  return compactMediaForPrompt(mediaCatalog)
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      scope: item.scope,
      role: item.role,
      type: item.type,
      fileName: item.fileName,
      description: truncateText(item.description, 130),
      src: item.src,
      width: item.width,
      height: item.height,
      durationSec: item.durationSec
    }));
}

function compactMediaForSelection(mediaCatalog = [], limit = 80) {
  return compactMediaForPrompt(mediaCatalog)
    .slice(0, limit)
    .map((item) => {
      const out = {
        id: item.id,
        name: truncateText(item.description || item.fileName, 46),
        kind: [item.role, item.type].filter(Boolean).join('/'),
        use: item.role === 'sound-effect'
        ? 'short sound cue'
        : item.role === 'brand-asset'
          ? 'preferred reusable brand/icon/character visual; use when its action or emotion fits the scene'
          : 'project scene media'
      };
      if (item.durationSec) out.dur = Number(Number(item.durationSec).toFixed(2));
      return out;
    });
}

function compactEscbaseBlockForSelection(pattern) {
  return {
    id: pattern.id,
    name: pattern.category,
    purpose: (pattern.useWhen || []).slice(0, 3).join(', '),
    use: (pattern.components || []).slice(0, 4).join(', ')
  };
}

function compactSfxCueForSelection(cue) {
  return {
    id: cue.id,
    purpose: `${cue.family || 'sfx'}: ${(cue.useWhen || []).slice(0, 2).join(', ')}`
  };
}

function compactSrtBeats(srtBeats = []) {
  return (Array.isArray(srtBeats) ? srtBeats : [])
    .slice(0, 8)
    .map((beat) => ({
      startSec: beat.startSec,
      endSec: beat.endSec,
      text: beat.text
    }));
}

function getHtmlGenerationAttemptLimit(settings = {}) {
  const configured = Number(settings.htmlMaxGenerationAttempts);
  if (Number.isFinite(configured) && configured === 0) return Infinity;
  if (Number.isFinite(configured) && configured > 0) return Math.round(configured);
  return DEFAULT_HTML_GENERATION_ATTEMPTS;
}

function describeAttemptLimit(limit) {
  return Number.isFinite(limit) ? String(limit) : 'until valid HTML passes validation';
}

function isRepairableHtmlError(error) {
  if (error?.report) return true;
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('html response')
    || message.includes('sanitized html')
    || message.includes('missing required')
    || message.includes('quality validation');
}

function summarizeValidationReport(report) {
  if (!report) return '';
  const issues = Array.isArray(report.issues)
    ? report.issues.map((issue) => `${issue.code}${issue.detail ? `: ${issue.detail}` : ''}`)
    : [];
  const metrics = report.metrics ? JSON.stringify(report.metrics).slice(0, 900) : '';
  return [
    issues.length ? `Issues: ${issues.slice(0, 8).join('; ')}` : '',
    metrics ? `Metrics: ${metrics}` : ''
  ].filter(Boolean).join('\n');
}

function buildTargetedRepairInstructions(error) {
  const message = `${error?.message || ''}\n${summarizeValidationReport(error?.report)}`.toLowerCase();
  const instructions = [];
  if (message.includes('safezone-bottom')) {
    instructions.push(
      'safezone-bottom fix: move important text/media upward into MODULE_CONTEXT_JSON.safeArea; keep the bottom subtitle gap completely empty.',
      'Keep the root scene element and backgrounds full-frame. Do not redefine or shrink #content or the root scene element.',
      'Reduce vertical stack height: shorten labels, use 2-3 cards max, smaller gaps, and avoid any footer/source text near the bottom.'
    );
  }
  if (message.includes('safezone-top')) {
    instructions.push('safezone-top fix: move important text/media down so it starts below MODULE_CONTEXT_JSON.safeArea.top.');
  }
  if (message.includes('safezone-side')) {
    instructions.push('safezone-side fix: keep important text/media inside MODULE_CONTEXT_JSON.safeArea.left/right; reduce width and font size if needed.');
  }
  if (message.includes('text-too-dense') || message.includes('text-block-too-long')) {
    instructions.push('text density fix: remove sentence-like copy from the canvas; use only short labels, numbers, icons, and 1-5 word chips.');
  }
  if (message.includes('text-too-small')) {
    instructions.push('text size fix: use font-size >= 15px for every visible text element, with line-height >= 1.25.');
  }
  if (message.includes('content-too-sparse')) {
    instructions.push('sparse content fix: add one strong central visual, 3-5 meaningful components, and clear hierarchy without adding long paragraphs.');
  }
  if (message.includes('composition-bunched-top') || message.includes('composition-too-short')) {
    instructions.push(
      '9:16 composition fix: redistribute the layout vertically; keep header small, place the main focal visual around the middle safe area, and add supporting chips/lines below it without entering the subtitle gap.',
      'Avoid one short horizontal banner near the top. Use a taller panel, radial/orbit/stacked layout, or vertical process occupying roughly y=220..1300.'
    );
  }
  if (message.includes('missing')) {
    instructions.push('structure fix: return a full HTML document with <!doctype html>, <html>, <body>, <div id="stage">, and <div id="content">.');
  }
  return instructions.length
    ? instructions
    : ['Repair the exact validation error. Change the layout, text amount, and CSS constraints materially; do not repeat the same composition.'];
}

function buildHtmlRetryPrompt(prompt, attempts, attempt, attemptLimit) {
  const last = attempts[attempts.length - 1] || {};
  const raw = String(last.rawResponse || '').trim();
  const head = raw.slice(0, 700);
  const tail = raw.length > 700 ? raw.slice(-700) : '';
  const history = attempts.slice(-MAX_RETRY_ERROR_HISTORY).map((entry) => ({
    attempt: entry.attempt,
    error: String(entry.error?.message || entry.error || '').slice(0, 700),
    report: summarizeValidationReport(entry.error?.report).slice(0, 900)
  }));
  const repairInstructions = buildTargetedRepairInstructions(last.error);
  return `${prompt}

PREVIOUS_ATTEMPT_ERRORS_JSON:
${JSON.stringify(history, null, 2)}

TARGETED_REPAIR_INSTRUCTIONS:
${repairInstructions.map((item) => `- ${item}`).join('\n')}

PREVIOUS RAW RESPONSE EXCERPT:
${head}${tail ? `\n...\n${tail}` : ''}

Retry ${attempt}/${describeAttemptLimit(attemptLimit)}. Return exactly one complete HTML document starting with <!doctype html>. No markdown, no explanation.`;
}

function ensureHtmlStandard(html, { scene, durationSec, aspectRatio }) {
  let out = extractHtmlDocument(html);
  if (!/^<!doctype\s+html>/i.test(out) || !/<html[\s>]/i.test(out) || !/<div[^>]+id=["']stage["']/i.test(out)) {
    throw new Error('HTML response is missing <!doctype html>, <html>, or <div id="stage">');
  }
  const ratio = getAspectRatioConfig(aspectRatio);
  if (!/data-composition-id=/i.test(out)) {
    out = out.replace(/(<div[^>]+id=["']stage["'][^>]*)(>)/i, `$1 data-composition-id="scene-${scene.sceneNumber}"$2`);
  }
  if (!/data-hf-duration-owner=/i.test(out)) {
    out = out.replace(/(<div[^>]+id=["']stage["'][^>]*)(>)/i, '$1 data-hf-duration-owner="root"$2');
  }
  if (!/data-vp-html-version=/i.test(out)) {
    out = out.replace(/(<div[^>]+id=["']stage["'][^>]*)(>)/i, '$1 data-vp-html-version="hyperframes-ai-v1"$2');
  }
  if (!/data-width=/i.test(out)) {
    out = out.replace(/(<div[^>]+id=["']stage["'][^>]*)(>)/i, `$1 data-width="${ratio.width}"$2`);
  }
  if (!/data-height=/i.test(out)) {
    out = out.replace(/(<div[^>]+id=["']stage["'][^>]*)(>)/i, `$1 data-height="${ratio.height}"$2`);
  }
  if (!/data-start=/i.test(out)) {
    out = out.replace(/(<div[^>]+id=["']stage["'][^>]*)(>)/i, '$1 data-start="0"$2');
  }
  if (!/data-duration=/i.test(out)) {
    out = out.replace(/(<div[^>]+id=["']stage["'][^>]*)(>)/i, `$1 data-duration="${durationSec.toFixed(3)}"$2`);
  }
  out = out.replace(/(<div[^>]+id=["']stage["'][^>]*data-width=["'])[^"']+(["'])/i, `$1${ratio.width}$2`);
  out = out.replace(/(<div[^>]+id=["']stage["'][^>]*data-height=["'])[^"']+(["'])/i, `$1${ratio.height}$2`);
  out = out.replace(/(<div[^>]+id=["']stage["'][^>]*data-duration=["'])[^"']+(["'])/i, `$1${durationSec.toFixed(3)}$2`);
  const sanitized = sanitizeHtmlForHyperframes(out);
  if (!/<div[^>]+id=["']stage["']/i.test(sanitized)) {
    throw new Error('Sanitized HTML lost required <div id="stage">');
  }
  if (!/<div[^>]+id=["']content["']/i.test(sanitized)) {
    throw new Error('HTML response is missing required <div id="content">');
  }
  return sanitized;
}

function buildHtmlPrompt({ project, scene, durationSec, srtBeats, mediaCatalog, settings = {} }) {
  const language = getVideoLanguageConfig(project.settings?.videoLanguage || settings.videoLanguage);
  const ratio = getAspectRatioConfig(project.settings?.aspectRatio);
  const safeTop = ratio.value === '9:16' ? 100 : Math.round(ratio.height * 0.07);
  const safeSide = ratio.value === '9:16' ? 28 : Math.round(ratio.width * 0.06);
  const safeBottomGap = ratio.value === '9:16' ? 200 : Math.round(ratio.height * 0.18);
  const safeBottom = ratio.height - safeBottomGap;
  const sfxVolume = Number(project.settings?.htmlSfxVolume ?? settings.htmlSfxVolume ?? 0.45);
  const sceneBrief = {
    visibleTextLanguage: language.englishName,
    sceneNumber: scene.sceneNumber,
    durationSec: Number(durationSec.toFixed(3)),
    narration: scene.voiceText || '',
    visualDirection: scene.visual || '',
    htmlSpec: scene.htmlSpec || {},
    sfxPlan: scene.sfxPlan || [],
    srtBeats: compactSrtBeats(srtBeats)
  };
  const patternContract = {
    globalRules: htmlPatternLibrary.globalRules,
    qualityGates: {
      visualPlan: htmlPatternLibrary.qualityGates?.visualPlan || [],
      html: htmlPatternLibrary.qualityGates?.html || []
    },
    selectedPattern: compactPatternForPrompt(scene),
    runtimeDesign: compactRuntimeDesignForPrompt(scene)
  };
  return `You are an expert HyperFrames HTML motion designer.

Generate ONE complete animated HTML scene for a ${ratio.width}x${ratio.height} ${ratio.value} video.
Return raw HTML only. Start with <!doctype html>. No markdown. No explanation.

SCENE_BRIEF_JSON:
${JSON.stringify(sceneBrief, null, 2)}

SELECTED_PATTERN_CONTRACT_JSON:
${JSON.stringify(patternContract, null, 2)}

AVAILABLE_LOCAL_MEDIA_JSON:
${JSON.stringify(compactMediaForPrompt(mediaCatalog), null, 2)}

HARD REQUIREMENTS:
- Root scene element must be:
  <div id="stage" data-vp-html-version="hyperframes-ai-v1" data-composition-id="scene-${scene.sceneNumber}" data-hf-duration-owner="root" data-width="${ratio.width}" data-height="${ratio.height}" data-start="0" data-duration="${durationSec.toFixed(3)}">
- All visible content must live inside <div id="content">.
- Fixed pixel layout for ${ratio.width}x${ratio.height}; do not use viewport units for sizing.
- Keep important text and focal visuals inside the safe area: x=${safeSide}..${ratio.width - safeSide}, y=${safeTop}..${safeBottom}. The lower ${safeBottomGap}px must stay free for subtitles and controls.
- #content must remain full-frame. Keep important text/media within x=${safeSide}..${ratio.width - safeSide}, y=${safeTop}..${safeBottom}; backgrounds should fill the full stage.
- Do not place footer labels, source tags, timelines, verdict cards, or final badges below y=${safeBottom - 20}. If the scene feels crowded, remove text before moving anything into the subtitle gap.
- Use the selected pattern components/slots. Do not create a generic text paragraph card.
- Visual-first: short ${language.englishName} labels, numbers, icons, diagrams, motion. Do not copy full narration into the canvas.
- All visible text must be natural ${language.englishName}. Do not mix other languages except unavoidable proper names.
- Text must not be clipped: line-height >= 1.25 and enough padding for the selected writing system.
- Use deterministic CSS animations only. No Math.random, Date.now, requestAnimationFrame, setInterval, infinite loops, remote scripts, remote CSS, remote fonts, iframes, or external URLs.
- Include no voiceover audio tag. Voiceover is injected by the pipeline.
- Use listed local media by exact "src" only. Do not invent paths. If no relevant media is listed, build the visual in CSS/SVG.
- Brand assets are preferred reusable visual characters/icons. When a listed brand asset reasonably matches the scene's action, emotion, subject, or metaphor, use it prominently instead of recreating a generic equivalent with CSS/SVG.
- Sound effects may be included only from local audio assets when useful. Use data-volume="${Math.max(0, Math.min(1, sfxVolume)).toFixed(2)}" unless a scene-specific reason requires lower volume. Every <audio src="..."> must include a unique id such as id="sfx-scene-${scene.sceneNumber}-1" and data-start="SECONDS"; include data-duration="SECONDS" when the sound should stop early. Use data-volume, not JavaScript timers.
- End with the final/climax visual state visible until the end.

QUALITY CHECK:
- One strong Escbase-style composition using selectedPattern.
- 3-5 main visual elements; 2-4 semantic reveal beats.
- Polished depth: gradients, glows, shadows, clear hierarchy, balanced safezone.
- Text is concise and readable on mobile; no tiny text, no dense labels.

RETURN ONLY THE HTML DOCUMENT.`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cleanCssBlock(value) {
  return String(value || '')
    .replace(/<\/?style\b[^>]*>/gi, '')
    .replace(/<\/?script\b[^>]*>/gi, '')
    .replace(/@import\b[^;]+;/gi, '')
    .trim();
}

function cleanHtmlFragment(value) {
  return String(value || '')
    .replace(/<!doctype[\s\S]*?>/gi, '')
    .replace(/<\/?(?:html|head|body|style)\b[^>]*>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .trim();
}

function cleanJsBlock(value) {
  return String(value || '')
    .replace(/<\/?script\b[^>]*>/gi, '')
    .trim();
}

function getHtmlSafeArea(project, durationSec) {
  const ratio = getAspectRatioConfig(project.settings?.aspectRatio);
  const safeTop = ratio.value === '9:16'
    ? 100
    : ratio.value === '16:9'
      ? Math.round(ratio.height * 0.07)
      : Math.round(ratio.height * 0.08);
  const safeSide = ratio.value === '9:16'
    ? 28
    : ratio.value === '16:9'
      ? Math.round(ratio.width * 0.06)
      : Math.round(ratio.width * 0.07);
  const safeBottomGap = ratio.value === '9:16'
    ? 240
    : ratio.value === '16:9'
      ? Math.round(ratio.height * 0.16)
      : Math.round(ratio.height * 0.18);
  const safeBottom = ratio.height - safeBottomGap;
  return {
    ratio,
    durationSec: Number(durationSec.toFixed(3)),
    safeTop,
    safeSide,
    safeBottom,
    safeBottomGap
  };
}

function getHtmlAspectLayoutGuide(safe) {
  const frameCanvas = {
    x: 0,
    y: 0,
    w: safe.ratio.width,
    h: safe.ratio.height
  };
  const safeContentBox = {
    x: safe.safeSide,
    y: safe.safeTop,
    w: safe.ratio.width - safe.safeSide * 2,
    h: safe.safeBottom - safe.safeTop
  };
  const canvasContract = { frameCanvas, safeContentBox };
  const guides = {
    '9:16': {
      composition: 'Tall vertical shorts frame. Build a full-height composition with main visual centered around y=520..1050, not a small card stuck at the top.',
      ...canvasContract,
      placement: [
        'Use stacked vertical hierarchy: short header/chip at top, main visual in the middle, support chips around or below it.',
        'Avoid putting the whole scene in the top 40%; leave the bottom subtitle gap empty but keep the visual body vertically balanced.',
        'Large panels should usually be x=80..1000 and y=220..1300, with height 520..900 depending on density.'
      ],
      avoid: [
        'Do not create one horizontal banner near the top with empty space below.',
        'Do not place important visuals below the safe bottom or behind subtitles.',
        'Do not use landscape-only layouts such as a single ultra-wide card.'
      ]
    },
    '16:9': {
      composition: 'Wide landscape frame. Use left/right split, centered hero plus side annotations, or horizontal process flow.',
      ...canvasContract,
      placement: [
        'Use width generously; keep main title and visual in the middle third.',
        'Prefer 2-column or horizontal timeline layouts over tall stacks.',
        'Keep all text above the subtitle lower band.'
      ],
      avoid: [
        'Do not make narrow portrait cards with lots of empty side space.',
        'Do not push focal content to the top edge.'
      ]
    },
    '1:1': {
      composition: 'Square social frame. Use centered radial, compact grid, or balanced card cluster.',
      ...canvasContract,
      placement: [
        'Keep focal visual centered; use 2x2 grids or radial layouts.',
        'Use compact labels around the center, not long horizontal rows.',
        'Reserve the lower subtitle band.'
      ],
      avoid: [
        'Do not use very wide banners.',
        'Do not stack too many vertical elements.'
      ]
    },
    '5:4': {
      composition: 'Near-square 5:4 frame. Use editorial centered composition with moderate width and height balance.',
      ...canvasContract,
      placement: [
        'Use a centered hero block with supporting chips left/right or below.',
        'Avoid both portrait-only tall stacks and landscape-only ultra-wide banners.',
        'Keep focal content around the center, with clean margins on every side.'
      ],
      avoid: [
        'Do not crop panels at top/bottom.',
        'Do not leave the lower half mostly empty.'
      ]
    },
    '4:3': {
      composition: 'Classic 4:3 frame. Use centered editorial panels, proof frame, or compact process layouts.',
      ...canvasContract,
      placement: [
        'Use medium-width cards or 2-column layouts.',
        'Balance top header with a main visual centered vertically.',
        'Keep bottom captions/subtitles clear.'
      ],
      avoid: [
        'Do not use tiny text or dense table layouts.',
        'Do not use extreme widescreen spacing.'
      ]
    }
  };
  return guides[safe.ratio.value] || guides['16:9'];
}

function buildSceneContext({ project, scene, durationSec, srtBeats, mediaCatalog }) {
  const safe = getHtmlSafeArea(project, durationSec);
  const language = getVideoLanguageConfig(project.settings?.videoLanguage);
  return {
    projectTitle: project.title || '',
    visibleTextLanguage: language.englishName,
    subtitleFontFamily: project.settings?.subtitleFontFamily || 'Be Vietnam Pro',
    htmlLanguageCode: language.value,
    sceneNumber: scene.sceneNumber,
    durationSec: safe.durationSec,
    aspectRatio: safe.ratio.value,
    frame: { width: safe.ratio.width, height: safe.ratio.height },
    safeArea: {
      left: safe.safeSide,
      right: safe.ratio.width - safe.safeSide,
      top: safe.safeTop,
      bottom: safe.safeBottom,
      bottomGap: safe.safeBottomGap
    },
    aspectLayout: getHtmlAspectLayoutGuide(safe),
    narration: truncateText(scene.voiceText, 700),
    visualDirection: truncateText(scene.visual, 420),
    existingHtmlSpec: compactHtmlSpecForPrompt(scene.htmlSpec || {}),
    sfxPlan: (Array.isArray(scene.sfxPlan) ? scene.sfxPlan : []).slice(0, 4),
    srtBeats: compactSrtBeats(srtBeats).slice(0, 6).map((beat) => ({
      ...beat,
      text: truncateText(beat.text, 120)
    })),
    pattern: compactPatternForPrompt(scene),
    runtimeDesign: compactRuntimeDesignForPrompt(scene),
    media: compactMediaForPrompt(mediaCatalog).slice(0, 8)
  };
}

function buildModuleSceneContext(sceneContext) {
  return {
    sceneNumber: sceneContext.sceneNumber,
    durationSec: sceneContext.durationSec,
    aspectRatio: sceneContext.aspectRatio,
    frame: sceneContext.frame,
    safeArea: sceneContext.safeArea,
    aspectLayout: sceneContext.aspectLayout,
    visibleTextLanguage: sceneContext.visibleTextLanguage,
    htmlLanguageCode: sceneContext.htmlLanguageCode,
    subtitleFontFamily: sceneContext.subtitleFontFamily,
    narration: truncateText(sceneContext.narration, 360),
    visualDirection: truncateText(sceneContext.visualDirection, 260),
    htmlSpec: compactHtmlSpecForPrompt(sceneContext.existingHtmlSpec),
    srtBeats: (sceneContext.srtBeats || []).slice(0, 4).map((beat) => ({
      startSec: beat.startSec,
      endSec: beat.endSec,
      text: truncateText(beat.text, 90)
    })),
    pattern: {
      id: sceneContext.pattern?.id,
      category: sceneContext.pattern?.category,
      components: (sceneContext.pattern?.components || []).slice(0, 4),
      requiredSlots: (sceneContext.pattern?.requiredSlots || []).slice(0, 4),
      motion: truncateText(sceneContext.pattern?.motion, 120)
    },
    runtimeDesign: {
      themeMood: sceneContext.runtimeDesign?.themeMood ? {
        id: sceneContext.runtimeDesign.themeMood.id,
        tokens: sceneContext.runtimeDesign.themeMood.tokens
      } : null,
      backgroundFx: sceneContext.runtimeDesign?.backgroundFx?.id,
      revealMode: sceneContext.runtimeDesign?.revealMode?.id
    },
    media: (sceneContext.media || []).slice(0, 5).map((item) => ({
      id: item.id,
      scope: item.scope,
      role: item.role,
      type: item.type,
      fileName: item.fileName,
      description: truncateText(item.description, 120),
      src: item.src,
      width: item.width,
      height: item.height,
      durationSec: item.durationSec
    }))
  };
}

function buildPlanningSceneContext(sceneContext, scene) {
  return {
    sceneNumber: sceneContext.sceneNumber,
    durationSec: sceneContext.durationSec,
    aspectRatio: sceneContext.aspectRatio,
    frame: sceneContext.frame,
    safeArea: sceneContext.safeArea,
    aspectLayout: sceneContext.aspectLayout,
    narration: truncateText(sceneContext.narration, 520),
    visualDirection: truncateText(sceneContext.visualDirection, 320),
    htmlSpec: compactHtmlSpecForPrompt(sceneContext.existingHtmlSpec),
    sfxPlan: (Array.isArray(sceneContext.sfxPlan) ? sceneContext.sfxPlan : []).slice(0, 3),
    srtBeats: (sceneContext.srtBeats || []).slice(0, 5).map((beat) => ({
      startSec: beat.startSec,
      endSec: beat.endSec,
      text: truncateText(beat.text, 100)
    })),
    pattern: compactPatternForModule(scene),
    runtimeDesign: compactRuntimeDesignForModule(scene)
  };
}

function buildHtmlBlueprintContext(sceneContext, scene, fullMediaCatalog = []) {
  return {
    ...buildPlanningSceneContext(sceneContext, scene),
    preferredBrandChoices: compactMediaForSelection(
      (sceneContext.media || []).filter((item) => item.role === 'brand-asset'),
      6
    ),
    mediaChoices: compactMediaForSelection(fullMediaCatalog, 80),
    escbaseBlockChoices: htmlPatternLibrary.patterns.map(compactEscbaseBlockForSelection),
    sfxCueChoices: (htmlPatternLibrary.runtimeDesign?.sfxCues || []).map(compactSfxCueForSelection),
    rules: {
      safeZone: htmlPatternLibrary.globalRules?.safeZone,
      visualFirst: htmlPatternLibrary.globalRules?.visualFirst,
      textDensity: htmlPatternLibrary.globalRules?.textDensity,
      assets: htmlPatternLibrary.globalRules?.assets,
      qualityGates: htmlPatternLibrary.qualityGates?.html || []
    }
  };
}

function compactHtmlBlueprint(value = {}) {
  return {
    sceneIdea: truncateText(value.sceneIdea || value.coreMetaphor, 160),
    selectedPattern: truncateText(value.selectedPattern || value.pattern, 80),
    mood: truncateText(value.mood, 80),
    palette: compactStringArray(value.palette || value.sceneDNA?.palette, 4, 16),
    layout: {
      frameCanvas: value.layout?.frameCanvas || null,
      safeContentBox: value.layout?.safeContentBox || value.layout?.contentBox || null,
      focalPoint: truncateText(value.layout?.focalPoint, 120),
      safeAreaStrategy: truncateText(value.layout?.safeAreaStrategy, 180),
      depthLayers: compactStringArray(value.layout?.depthLayers, 4, 80)
    },
    components: (Array.isArray(value.components) ? value.components : value.layers || [])
      .slice(0, 9)
      .map((item) => ({
        id: truncateText(item?.id, 48),
        type: truncateText(item?.type, 48),
        role: truncateText(item?.role, 120),
        text: truncateText(item?.text, 50),
        mediaId: truncateText(item?.mediaId, 80),
        box: item?.box || null,
        startSec: Number(item?.startSec ?? item?.visibleFromSec ?? item?.at ?? 0) || 0,
        endSec: Number(item?.endSec ?? item?.visibleToSec ?? 0) || 0,
        motion: truncateText(item?.motion, 120),
        style: truncateText(item?.style, 120)
      })),
    mediaDecisions: (Array.isArray(value.mediaDecisions) ? value.mediaDecisions : [])
      .slice(0, 10)
      .map((item) => ({
        mediaId: truncateText(item?.mediaId, 80),
        decision: truncateText(item?.decision || item?.use, 40),
        role: truncateText(item?.role, 100),
        startSec: Number(item?.startSec ?? 0) || 0,
        endSec: Number(item?.endSec ?? 0) || 0
      })),
    timeline: (Array.isArray(value.timeline) ? value.timeline : [])
      .slice(0, 10)
      .map((beat) => ({
        at: Number(beat?.at ?? beat?.time ?? 0) || 0,
        endSec: Number(beat?.endSec ?? 0) || 0,
        target: truncateText(beat?.target || beat?.layer, 60),
        action: truncateText(beat?.action || beat?.motion, 140),
        subtitleCue: truncateText(beat?.subtitleCue || beat?.reason, 100)
      })),
    sfx: (Array.isArray(value.sfx) ? value.sfx : [])
      .slice(0, 5)
      .map((item) => ({
        mediaId: truncateText(item?.mediaId, 80),
        startSec: Number(item?.startSec ?? 0) || 0,
        durationSec: Number(item?.durationSec ?? 0) || 0,
        volume: Math.max(0, Math.min(1, Number(item?.volume ?? 0.35) || 0.35)),
        reason: truncateText(item?.reason, 100)
      })),
    guardrails: compactStringArray(value.guardrails || value.implementationNotes, 6, 140)
  };
}

function buildHtmlBlueprintPrompt(sceneContext) {
  return `You are the visual planner for one HTML motion scene.

Return JSON only. Do not write HTML/CSS.

Create a detailed execution blueprint after voice and subtitles already exist.
All visible text components must be natural ${sceneContext.visibleTextLanguage || 'Vietnamese'} and must not mix other languages except unavoidable proper names.
Decide which media/icon/sound items to keep, when each visual appears/disappears, and how to use the selected pattern blocks.
Treat preferredBrandChoices as high-priority reusable visual characters/icons. When one reasonably matches the scene's action, emotion, subject, or metaphor, mark it "use" and include it as a visible media component. Prefer using one suitable brand asset over recreating a generic equivalent with CSS/SVG. Skip all brand assets only when none fit the scene.
The next model will only execute your blueprint, so be concrete about positions, timing, safe area, and layering.
The scene canvas is aspectLayout.frameCanvas. The blueprint must include a root/background layer whose box is exactly frameCanvas and covers it for the entire scene.
safeArea and aspectLayout.safeContentBox constrain important text, media, and focal elements only. They are not the canvas and must never define the root/background size.
Keep important text, media, and focal elements above the subtitle gap and inside safeArea. Decorative backgrounds may fill frameCanvas.
Use mediaChoices, escbaseBlockChoices, and sfxCueChoices only as short selection catalogs. Choose by id; do not copy technical file paths or rewrite catalog details.
Follow aspectLayout exactly. For 9:16, do not make a small top banner with empty lower space; the main visual must occupy the middle vertical area while leaving the subtitle gap clear.

SCENE_CONTEXT_JSON:
${JSON.stringify(sceneContext)}

Return this JSON shape:
{
  "sceneIdea": "specific visual idea for this scene",
  "selectedPattern": "pattern id to execute",
  "mood": "3-8 words",
  "palette": ["#hex", "#hex", "#hex", "#hex"],
  "layout": {
    "frameCanvas": "use aspectLayout.frameCanvas exactly for the root/background",
    "safeContentBox": "use aspectLayout.safeContentBox for important text/media only",
    "focalPoint": "main focus location",
    "safeAreaStrategy": "how overlap/truncation is avoided",
    "depthLayers": ["background", "midground", "foreground"]
  },
  "components": [
    { "id": "short-id", "type": "shape|text|media|icon|sfx-trigger", "role": "purpose", "text": "0-5 words", "mediaId": "optional exact id", "box": { "x": 80, "y": 160, "w": 400, "h": 300 }, "startSec": 0, "endSec": 4, "motion": "specific motion", "style": "specific style" }
  ],
  "mediaDecisions": [
    { "mediaId": "exact id", "decision": "use|skip", "role": "why/how", "startSec": 0, "endSec": 4 }
  ],
  "timeline": [
    { "at": 0, "endSec": 2, "target": "component id", "action": "visual change", "subtitleCue": "matching subtitle words" }
  ],
  "sfx": [
    { "mediaId": "exact sound id", "startSec": 0, "durationSec": 1, "volume": 0.35, "reason": "why it matches" }
  ],
  "guardrails": ["specific constraints to prevent overflow, overlap, bad timing"]
}`;
}

function buildHtmlModuleTextPrompt({ sceneContext, htmlBlueprint, previousModule, error, attempt, attemptLimit }) {
  const repair = error
    ? {
        error: String(error?.message || error || '').slice(0, 700),
        report: summarizeValidationReport(error?.report).slice(0, 900),
        targetedRepair: buildTargetedRepairInstructions(error)
      }
    : null;
  return `You are a senior HTML/CSS motion designer.

Return plain text blocks only. Do not return JSON, markdown, a full HTML document, or explanations.

The app will wrap your module in a fixed #stage and #content runtime. You only provide the creative module.
#stage and #content are full-frame canvases using MODULE_CONTEXT_JSON.frame.
Your first/root scene element must start at x=0, y=0 and have width/height exactly equal to MODULE_CONTEXT_JSON.frame.

MODULE_CONTEXT_JSON:
${JSON.stringify(sceneContext)}

HTML_BLUEPRINT_JSON:
${JSON.stringify(htmlBlueprint)}

${repair ? `REPAIR_CONTEXT_JSON:\n${JSON.stringify(repair)}\n\nPREVIOUS_MODULE_EXCERPT:\n${JSON.stringify(previousModule || {}).slice(0, 1800)}\n` : ''}

Return exactly this format:
<module-html>
HTML fragment for inside the full-frame #content canvas
</module-html>
<module-css>
CSS for your module classes/ids only
</module-css>
<module-js>
optional tiny JS or empty
</module-js>
<module-audio>
optional JSON array using mediaId, startSec, durationSec, volume; or []
</module-audio>

Hard rules:
- Do not include <!doctype>, html, head, body, #stage, #content, style, or script tags.
- CSS must not use @import, remote URLs, viewport units, or fixed body/stage styles.
- Prefer CSS keyframes. JS must avoid Math.random, Date.now, fetch, remote scripts, setInterval, requestAnimationFrame, and infinite loops.
- Visible text must be short ${sceneContext.visibleTextLanguage || 'Vietnamese'} labels only; never paste the full narration or mix other languages.
- Follow HTML_BLUEPRINT_JSON for layout boxes, component timing, media usage, and sfx timing.
- Follow MODULE_CONTEXT_JSON.aspectLayout for the current frame. The CSS must be designed for the exact data-width/data-height, not a generic landscape/portrait layout.
- For 9:16, avoid a single wide top card and empty lower half. Use a vertically balanced composition with focal content in the middle safe area.
- Create one root scene element with position:absolute; left:0; top:0; width and height exactly MODULE_CONTEXT_JSON.frame; overflow:hidden.
- The root scene element and background layers must cover the entire frame for the entire scene.
- Never size or position the root/background from safeArea, aspectLayout.safeContentBox, or a blueprint safe box.
- Keep important text/media/focal elements inside MODULE_CONTEXT_JSON.safeArea. Decorative backgrounds may reach the frame edges, but no module element may cross them.
- #content is the full frame. Do not redefine, inset, shrink, translate, or add padding to #content.
- Use exact media src values from MODULE_CONTEXT_JSON.media only. Do not invent paths.
- If HTML_BLUEPRINT_JSON marks a brand-asset mediaId as "use", you must render it with an <img> using its exact src from MODULE_CONTEXT_JSON.media. Make it clearly visible and meaningfully integrated into the composition, not a tiny decoration.
- When a relevant brand-asset exists in MODULE_CONTEXT_JSON.media, prefer it over drawing a generic replacement character/icon.
- For audio, use mediaId values from MODULE_CONTEXT_JSON.media; the app will resolve src.
- Make this scene visually specific to the blueprint, not a generic card.
- **Font rule**: You MUST ONLY use the font-family specified in MODULE_CONTEXT_JSON.subtitleFontFamily (e.g. \`"${sceneContext.subtitleFontFamily}"\`). Never use generic fallbacks like 'Arial Black' or 'Times New Roman' which do not support Vietnamese diacritics beautifully. Do not import external fonts.
- **Layout rule (Anti-overlap)**: Use modern CSS layout models (Flexbox, Grid, or clear margins/paddings) to let sibling elements flow naturally and prevent overlapping. Never stack separate text/button elements using hardcoded absolute coordinates that collide when text is long.
- **Contrast rule**: Any text displayed over background graphics, images, or detailed colors must have high readability. Wrap text in a card container with a dark semi-transparent blurred background (e.g., \`background: rgba(15, 23, 42, 0.75); backdrop-filter: blur(8px); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; padding: 12px 18px;\`) or use a strong text-shadow (e.g., \`text-shadow: 0 2px 4px rgba(0, 0, 0, 0.95);\`).
- **Button Contrast**: Text color on buttons must contrast sharply with the button background (e.g., light-colored buttons must use dark text like \`#0f172a\`, and dark-colored buttons must use white text).

${repair ? `Repair attempt ${attempt}/${describeAttemptLimit(attemptLimit)}. Change the module materially while preserving the creative idea.` : 'Create the first module.'}`;
}

function extractTaggedBlock(text, tagName) {
  const pattern = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*<\\/${tagName}>`, 'i');
  const match = String(text || '').match(pattern);
  return match ? match[1].trim() : '';
}

function resolveModuleAudioItems(audioItems = [], mediaCatalog = []) {
  const mediaById = new Map((Array.isArray(mediaCatalog) ? mediaCatalog : []).map((item) => [String(item.id || ''), item]));
  return (Array.isArray(audioItems) ? audioItems : [])
    .map((item) => {
      const media = mediaById.get(String(item?.mediaId || '').trim());
      return {
        src: String(item?.src || media?.src || '').trim(),
        startSec: Math.max(0, Number(item?.startSec ?? item?.start ?? 0) || 0),
        durationSec: Number(item?.durationSec ?? item?.duration ?? media?.durationSec ?? 0) || 0,
        volume: Math.max(0, Math.min(1, Number(item?.volume ?? 0.35) || 0.35))
      };
    })
    .filter((item) => item.src)
    .slice(0, 4);
}

function parseModuleTextResponse(text, mediaCatalog = []) {
  const html = extractTaggedBlock(text, 'module-html');
  const css = extractTaggedBlock(text, 'module-css');
  const js = extractTaggedBlock(text, 'module-js');
  const audioText = extractTaggedBlock(text, 'module-audio');
  let audio = [];
  if (audioText) {
    try {
      const parsed = JSON.parse(stripFence(audioText));
      audio = resolveModuleAudioItems(parsed, mediaCatalog);
    } catch {
      audio = [];
    }
  }
  if (!html && !css) {
    try {
      return normalizeModuleJson(JSON.parse(stripFence(text)), mediaCatalog);
    } catch {}
  }
  return {
    html: cleanHtmlFragment(html),
    css: cleanCssBlock(css),
    js: cleanJsBlock(js),
    audio
  };
}

function mergeMediaCatalogs(...catalogs) {
  const seen = new Set();
  const merged = [];
  for (const item of catalogs.flat()) {
    const key = String(item?.id || item?.src || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function collectBlueprintMediaIds(blueprint = {}) {
  const ids = new Set();
  const add = (value) => {
    const text = String(value || '').trim();
    if (text) ids.add(text);
  };
  (blueprint.components || []).forEach((item) => add(item.mediaId));
  (blueprint.mediaDecisions || []).forEach((item) => {
    if (String(item.decision || '').toLowerCase() !== 'skip') add(item.mediaId);
  });
  (blueprint.sfx || []).forEach((item) => add(item.mediaId));
  return ids;
}

function selectMediaForExecution(fullMediaCatalog = [], blueprint = {}, fallbackSceneMedia = []) {
  const selectedIds = collectBlueprintMediaIds(blueprint);
  const selected = fullMediaCatalog.filter((item) => selectedIds.has(String(item.id || '')));
  const fallback = fallbackSceneMedia.filter((item) => item.role !== 'sound-effect').slice(0, 4);
  return mergeMediaCatalogs(selected, fallback);
}

function findEscbasePattern(patternId) {
  const id = String(patternId || '').trim();
  return htmlPatternLibrary.patterns.find((pattern) => pattern.id === id) || null;
}

function normalizeModuleJson(value = {}, mediaCatalog = []) {
  const audio = Array.isArray(value.audio) ? value.audio : [];
  return {
    html: cleanHtmlFragment(value.html || value.fragment || value.content || ''),
    css: cleanCssBlock(value.css || value.style || ''),
    js: cleanJsBlock(value.js || value.script || ''),
    audio: resolveModuleAudioItems(audio, mediaCatalog)
  };
}

function buildHtmlDocumentFromModule({ project, scene, durationSec, moduleJson, settings = {} }) {
  const safe = getHtmlSafeArea(project, durationSec);
  const language = getVideoLanguageConfig(project.settings?.videoLanguage || settings.videoLanguage);
  const direction = language.value === 'ar' ? 'rtl' : 'ltr';
  const font = SUBTITLE_FONT_OPTIONS.find((option) => option.value === language.subtitleFontFamily);
  const fontUrl = font ? pathToFileURL(path.join(ASSETS_DIR, 'fonts', font.file)).href : '';
  const sceneId = `scene-${String(scene.sceneNumber || 'x').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const module = normalizeModuleJson(moduleJson);
  if (!module.html || module.html.length < 40) {
    throw new Error('HTML module is missing a meaningful html fragment');
  }
  const audioTags = module.audio.map((item, index) => {
    const durationAttr = item.durationSec > 0 ? ` data-duration="${item.durationSec.toFixed(3)}"` : '';
    return `<audio id="sfx-${sceneId}-${index + 1}" src="${escapeHtml(item.src)}" data-start="${item.startSec.toFixed(3)}"${durationAttr} data-volume="${item.volume.toFixed(2)}"></audio>`;
  }).join('\n');
  const js = module.js
    ? `<script>\n(function(){\n${module.js}\n})();\n</script>`
    : '';
  return `<!doctype html>
<html lang="${language.value}" dir="${direction}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=${safe.ratio.width}, height=${safe.ratio.height}">
    <title>${escapeHtml(sceneId)}</title>
    <style>
      ${fontUrl ? `@font-face { font-family: "${language.subtitleFontFamily}"; src: url("${fontUrl}"); }` : ''}
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        width: ${safe.ratio.width}px;
        height: ${safe.ratio.height}px;
        overflow: hidden;
        background: #050505;
        font-family: "${language.subtitleFontFamily}", Inter, Arial, sans-serif;
      }
      #stage {
        position: relative;
        width: ${safe.ratio.width}px;
        height: ${safe.ratio.height}px;
        overflow: hidden;
        background: #050505;
        color: #fff;
      }
      #content {
        position: absolute;
        inset: 0;
        width: ${safe.ratio.width}px;
        height: ${safe.ratio.height}px;
        overflow: hidden;
        isolation: isolate;
      }
      .module-root {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
      }
      .module-root img,
      .module-root video {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
      }
      ${module.css}
    </style>
  </head>
  <body>
    <div id="stage"
         data-vp-html-version="hyperframes-ai-v1"
         data-composition-id="${escapeHtml(sceneId)}"
         data-hf-duration-owner="root"
         data-width="${safe.ratio.width}"
         data-height="${safe.ratio.height}"
         data-start="0"
         data-duration="${safe.durationSec.toFixed(3)}">
      <div id="content">
        <div class="module-root">
${module.html}
        </div>
      </div>
${audioTags}
    </div>
${js}
  </body>
</html>`;
}

async function generateHtmlForScene({ project, scene, sceneDir, settings, onLog }) {
  const durationSec = Math.max(0.1, Number(scene.durations?.voiceSec || scene.targetDurationSec || 1));
  const subtitleText = await readTextIfExists(scene.files?.subtitle || path.join(sceneDir, 'voice.corrected.srt'));
  const fullMediaCatalog = buildHtmlMediaCatalog({ project, settings });
  const mediaCatalog = filterHtmlMediaCatalogForScene(scene, fullMediaCatalog);
  const provider = getHtmlSourceProvider(project.settings?.imageSource);
  const blueprintClient = new AiProviderClient({
    ...settings,
    apiProvider: provider
  });
  const moduleClient = new AiProviderClient({
    ...settings,
    apiProvider: provider
  });
  const legacyPrompt = buildHtmlPrompt({
    project,
    scene,
    durationSec,
    srtBeats: parseSrt(subtitleText),
    mediaCatalog,
    settings
  });
  const sceneContext = buildSceneContext({
    project,
    scene,
    durationSec,
    srtBeats: parseSrt(subtitleText),
    mediaCatalog
  });
  const htmlPath = path.join(sceneDir, 'scene.ai-html.html');
  await fs.writeFile(path.join(sceneDir, 'scene.ai-html.context.json'), JSON.stringify(sceneContext, null, 2), 'utf8');
  const blueprintContext = buildHtmlBlueprintContext(sceneContext, scene, fullMediaCatalog);
  const moduleContext = buildModuleSceneContext(sceneContext);
  await fs.writeFile(path.join(sceneDir, 'scene.ai-html.blueprint-context.json'), JSON.stringify(blueprintContext, null, 2), 'utf8');
  await fs.writeFile(path.join(sceneDir, 'scene.ai-html.module-context.base.json'), JSON.stringify(moduleContext, null, 2), 'utf8');
  onLog?.(`Generating HTML scene ${scene.sceneNumber}`, {
    provider,
    mediaCount: mediaCatalog.length,
    fullMediaCount: fullMediaCatalog.length,
    pattern: getSelectedPattern(scene).id,
    flow: 'blueprint-html'
  });

  const blueprintPrompt = buildHtmlBlueprintPrompt(blueprintContext);
  await fs.writeFile(path.join(sceneDir, 'scene.ai-html.blueprint-prompt.txt'), blueprintPrompt, 'utf8');
  const rawHtmlBlueprint = await blueprintClient.generateJson(blueprintPrompt);
  const htmlBlueprint = compactHtmlBlueprint(rawHtmlBlueprint);
  await fs.writeFile(path.join(sceneDir, 'scene.ai-html.blueprint.raw.json'), JSON.stringify(rawHtmlBlueprint, null, 2), 'utf8');
  await fs.writeFile(path.join(sceneDir, 'scene.ai-html.blueprint.json'), JSON.stringify(htmlBlueprint, null, 2), 'utf8');
  const selectedMediaCatalog = selectMediaForExecution(fullMediaCatalog, htmlBlueprint, mediaCatalog);
  const selectedPattern = findEscbasePattern(htmlBlueprint.selectedPattern) || getSelectedPattern(scene);
  const executionContext = {
    ...moduleContext,
    media: compactMediaForModule(selectedMediaCatalog, 24),
    escbaseBlock: selectedPattern ? {
      id: selectedPattern.id,
      category: selectedPattern.category,
      components: selectedPattern.components,
      requiredSlots: selectedPattern.requiredSlots,
      optionalSlots: selectedPattern.optionalSlots,
      motion: selectedPattern.motion,
      htmlHints: selectedPattern.htmlHints
    } : null,
    escbaseRuntime: {
      globalRules: htmlPatternLibrary.globalRules,
      qualityGates: htmlPatternLibrary.qualityGates?.html || [],
      sfxCues: htmlPatternLibrary.runtimeDesign?.sfxCues || []
    }
  };
  await fs.writeFile(path.join(sceneDir, 'scene.ai-html.execution-context.json'), JSON.stringify(executionContext, null, 2), 'utf8');

  let html = '';
  const attemptLimit = getHtmlGenerationAttemptLimit(settings);
  const failedAttempts = [];
  let lastModule = null;
  for (let attempt = 1; attemptLimit === Infinity || attempt <= attemptLimit; attempt += 1) {
    try {
      const modulePrompt = buildHtmlModuleTextPrompt({
        sceneContext: executionContext,
        htmlBlueprint,
        previousModule: lastModule,
        error: failedAttempts[failedAttempts.length - 1]?.error,
        attempt,
        attemptLimit
      });
      await fs.writeFile(path.join(sceneDir, `scene.ai-html.module-prompt-${attempt}.txt`), modulePrompt, 'utf8');
      const moduleResponse = await moduleClient.generateText(modulePrompt);
      await fs.writeFile(path.join(sceneDir, `scene.ai-html.module-response-${attempt}.txt`), moduleResponse, 'utf8');
      lastModule = parseModuleTextResponse(moduleResponse, executionContext.media);
      await fs.writeFile(path.join(sceneDir, `scene.ai-html.module-attempt-${attempt}.json`), JSON.stringify(lastModule, null, 2), 'utf8');
      const rawDocument = buildHtmlDocumentFromModule({
        project,
        scene,
        durationSec,
        moduleJson: lastModule,
        settings
      });
      await fs.writeFile(path.join(sceneDir, `scene.ai-html.attempt-${attempt}.raw.txt`), rawDocument, 'utf8');
      html = ensureHtmlStandard(rawDocument, {
        scene,
        durationSec,
        aspectRatio: project.settings?.aspectRatio
      });
      const qualityReport = await validateHtmlSceneQuality({
        html,
        aspectRatio: project.settings?.aspectRatio
      });
      await fs.writeFile(
        path.join(sceneDir, `scene.ai-html.quality-attempt-${attempt}.json`),
        JSON.stringify(qualityReport, null, 2),
        'utf8'
      );
      break;
    } catch (error) {
      const rawResponse = await readTextIfExists(path.join(sceneDir, `scene.ai-html.attempt-${attempt}.raw.txt`));
      failedAttempts.push({ attempt, error, rawResponse });
      if (error.report) {
        await fs.writeFile(
          path.join(sceneDir, `scene.ai-html.quality-attempt-${attempt}.json`),
          JSON.stringify(error.report, null, 2),
          'utf8'
        ).catch(() => {});
      }
      const repairable = isRepairableHtmlError(error);
      const providerErrorLimit = 3;
      const canRetry = attemptLimit === Infinity
        ? repairable || attempt < providerErrorLimit
        : attempt < attemptLimit;
      onLog?.(`HTML scene ${scene.sceneNumber} attempt ${attempt} failed`, {
        error: error.message,
        nextAttempt: canRetry,
        attemptLimit: describeAttemptLimit(attemptLimit)
      });
      if (attemptLimit !== Infinity && attempt >= attemptLimit) {
        await fs.writeFile(path.join(sceneDir, 'scene.ai-html.legacy-prompt.txt'), legacyPrompt, 'utf8').catch(() => {});
        throw new Error(`HTML module generation failed after ${attemptLimit} attempts for scene ${scene.sceneNumber}: ${error.message}`);
      }
      if (attemptLimit === Infinity && !repairable && attempt >= providerErrorLimit) {
        await fs.writeFile(path.join(sceneDir, 'scene.ai-html.legacy-prompt.txt'), legacyPrompt, 'utf8').catch(() => {});
        throw new Error(`HTML module generation failed after ${providerErrorLimit} provider/API attempts for scene ${scene.sceneNumber}: ${error.message}`);
      }
      await wait(Math.min(8000, 1200 * attempt));
    }
  }
  await fs.writeFile(htmlPath, html, 'utf8');
  scene.files = scene.files || {};
  scene.files.html = htmlPath;
  scene.metadata = scene.metadata || {};
  scene.metadata.htmlGeneration = {
    provider,
    mediaCount: mediaCatalog.length,
    fullMediaCount: fullMediaCatalog.length,
    pattern: getSelectedPattern(scene).id,
    flow: 'blueprint-html',
    attempts: failedAttempts.length + 1,
    attemptLimit: describeAttemptLimit(attemptLimit),
    updatedAt: new Date().toISOString()
  };
  return htmlPath;
}

module.exports = {
  generateHtmlForScene,
  buildHtmlMediaCatalog,
  ensureHtmlStandard
};
