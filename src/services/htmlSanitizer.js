function stripInvalidInlineScripts(html = '') {
  let out = String(html || '');
  let cursor = 0;
  const removals = [];
  while (cursor < out.length) {
    const openMatch = out.slice(cursor).match(/<script\b[^>]*>/i);
    if (!openMatch) break;
    const openStart = cursor + openMatch.index;
    const contentStart = openStart + openMatch[0].length;
    const closeMatch = out.slice(contentStart).match(/<\/script\s*>/i);
    if (!closeMatch) {
      removals.push([openStart, out.length]);
      break;
    }
    const closeStart = contentStart + closeMatch.index;
    const closeEnd = closeStart + closeMatch[0].length;
    const body = out.slice(contentStart, closeStart);
    try {
      // Syntax check only. Browser globals such as window/document are fine here.
      // eslint-disable-next-line no-new-func
      new Function(body);
    } catch {
      removals.push([openStart, closeEnd]);
    }
    cursor = closeEnd;
  }
  for (let i = removals.length - 1; i >= 0; i -= 1) {
    const [start, end] = removals[i];
    out = `${out.slice(0, start)}${out.slice(end)}`;
  }
  return out;
}

function getAttr(tag, name) {
  const match = String(tag || '').match(new RegExp(`\\s${name}=(["'])(.*?)\\1`, 'i'));
  return match ? match[2] : '';
}

function hasAttr(tag, name) {
  return new RegExp(`\\s${name}(?:=|\\s|>)`, 'i').test(String(tag || ''));
}

function addAttrBeforeEnd(tag, attr) {
  return String(tag || '').replace(/\s*\/?>$/, (end) => ` ${attr}${end}`);
}

function normalizeAudioTiming(html = '', options = {}) {
  let autoAudioIndex = 0;
  const defaultVolume = Number.isFinite(Number(options.sfxVolume)) ? Math.max(0, Math.min(1, Number(options.sfxVolume))) : null;
  return String(html || '').replace(/<audio\b[^>]*>/gi, (tag) => {
    if (!hasAttr(tag, 'src')) return tag;
    let out = tag;
    const isVoiceover = /\sid=(["'])voiceover\1/i.test(out);
    const hfStart = getAttr(out, 'data-hf-start');
    const hfVolume = getAttr(out, 'data-hf-volume');
    const hfDuration = getAttr(out, 'data-hf-duration');
    if (!hasAttr(out, 'id')) {
      autoAudioIndex += 1;
      out = addAttrBeforeEnd(out, `id="sfx-auto-${autoAudioIndex}"`);
    }
    if (!hasAttr(out, 'data-start')) {
      out = addAttrBeforeEnd(out, `data-start="${hfStart || '0'}"`);
    }
    if (!hasAttr(out, 'data-duration') && hfDuration) {
      out = addAttrBeforeEnd(out, `data-duration="${hfDuration}"`);
    }
    if (!hasAttr(out, 'data-volume') && hfVolume) {
      out = addAttrBeforeEnd(out, `data-volume="${hfVolume}"`);
    }
    if (!isVoiceover && defaultVolume !== null) {
      if (hasAttr(out, 'data-volume')) {
        out = out.replace(/\sdata-volume=(["'])(.*?)\1/i, ` data-volume="${defaultVolume}"`);
      } else {
        out = addAttrBeforeEnd(out, `data-volume="${defaultVolume}"`);
      }
    }
    return out;
  });
}

function ensureClosingDocumentTags(html = '') {
  let out = String(html || '').trim();
  if (!/<\/body\s*>/i.test(out)) out += '\n</body>';
  if (!/<\/html\s*>/i.test(out)) out += '\n</html>';
  return out;
}

function compactLargeHtml(html = '') {
  const lines = String(html || '').split(/\r?\n/);
  if (lines.length <= 520) return String(html || '');
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
}

function sanitizeHtmlForHyperframes(html = '', options = {}) {
  return compactLargeHtml(ensureClosingDocumentTags(normalizeAudioTiming(stripInvalidInlineScripts(html), options)));
}

module.exports = {
  sanitizeHtmlForHyperframes
};
