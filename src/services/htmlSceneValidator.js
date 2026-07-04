const fs = require('fs/promises');
const puppeteer = require('puppeteer-core');
const { getAspectRatioConfig } = require('../config/constants');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.HYPERFRAMES_BROWSER_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'
].filter(Boolean);

async function getChromeExecutablePath() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error('Chrome executable not found. Set CHROME_PATH or install Google Chrome.');
}

function formatIssue(issue) {
  const detail = issue.detail ? `: ${issue.detail}` : '';
  return `${issue.code}${detail}`;
}

async function validateHtmlSceneQuality({ html, aspectRatio = '9:16', timeoutMs = 15000 }) {
  const ratio = getAspectRatioConfig(aspectRatio);
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
  const safeTolerance = 12;
  const executablePath = await getChromeExecutablePath();
  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: ratio.width, height: ratio.height, deviceScaleFactor: 1 });
    page.setDefaultTimeout(timeoutMs);
    await page.setContent(html, { waitUntil: 'load', timeout: timeoutMs });
    await new Promise(resolve => setTimeout(resolve, 350));
    const report = await page.evaluate(
      ({ aspectRatioValue, expectedWidth, expectedHeight, safeTop, safeSide, safeBottom, safeBottomGap, safeTolerance }) => {
        const issues = [];
        const stage = document.querySelector('#stage');
        const content = document.querySelector('#content');
        const isVisible = (element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && Number(style.opacity || 1) > 0.03
            && rect.width > 1
            && rect.height > 1;
        };
        const relRect = (element, baseRect) => {
          const rect = element.getBoundingClientRect();
          return {
            top: rect.top - baseRect.top,
            bottom: rect.bottom - baseRect.top,
            left: rect.left - baseRect.left,
            right: rect.right - baseRect.left,
            width: rect.width,
            height: rect.height
          };
        };
        const union = (rects) => {
          if (!rects.length) return null;
          const top = Math.min(...rects.map(rect => rect.top));
          const bottom = Math.max(...rects.map(rect => rect.bottom));
          const left = Math.min(...rects.map(rect => rect.left));
          const right = Math.max(...rects.map(rect => rect.right));
          return { top, bottom, left, right, width: right - left, height: bottom - top };
        };
        const textOf = (element) => String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
        const isDecorative = (element) => {
          const raw = `${element.className || ''} ${element.id || ''} ${element.getAttribute('role') || ''} ${element.getAttribute('aria-hidden') || ''} ${element.getAttribute('data-decorative') || ''}`.toLowerCase();
          return raw.includes('bg') || raw.includes('background') || raw.includes('decor') || raw.includes('vignette') || raw.includes('aria-hidden true');
        };

        if (!stage) {
          issues.push({ code: 'missing-stage' });
          return { ok: false, issues };
        }
        if (!content) {
          issues.push({ code: 'missing-content' });
          return { ok: false, issues };
        }

        const stageRect = stage.getBoundingClientRect();
        if (Math.abs(stageRect.width - expectedWidth) > 2 || Math.abs(stageRect.height - expectedHeight) > 2) {
          issues.push({
            code: 'stage-size-mismatch',
            detail: `${Math.round(stageRect.width)}x${Math.round(stageRect.height)} expected ${expectedWidth}x${expectedHeight}`
          });
        }
        const contentBoxRect = relRect(content, stageRect);
        if (
          Math.abs(contentBoxRect.left) > 2
          || Math.abs(contentBoxRect.top) > 2
          || Math.abs(contentBoxRect.width - expectedWidth) > 2
          || Math.abs(contentBoxRect.height - expectedHeight) > 2
        ) {
          issues.push({
            code: 'content-size-mismatch',
            detail: `content x=${Math.round(contentBoxRect.left)} y=${Math.round(contentBoxRect.top)} ${Math.round(contentBoxRect.width)}x${Math.round(contentBoxRect.height)} expected full-frame ${expectedWidth}x${expectedHeight}`
          });
        }

        const textElements = Array.from(content.querySelectorAll('*'))
          .filter(element => isVisible(element))
          .map(element => ({ element, text: textOf(element) }))
          .filter(({ element, text }) => text.length > 0 && !Array.from(element.children || []).some(child => textOf(child).length > 0))
          .map(({ element, text }) => ({
            text,
            rect: relRect(element, stageRect),
            fontSize: parseFloat(window.getComputedStyle(element).fontSize) || 0
          }));

        const mediaElements = Array.from(content.querySelectorAll('img, video'))
          .filter(element => isVisible(element) && !isDecorative(element))
          .map(element => ({ tag: element.tagName.toLowerCase(), rect: relRect(element, stageRect) }));

        const svgCanvasElements = Array.from(content.querySelectorAll('svg, canvas'))
          .filter(element => isVisible(element) && !isDecorative(element))
          .map(element => ({ tag: element.tagName.toLowerCase(), rect: relRect(element, stageRect) }));

        const visualElements = Array.from(content.querySelectorAll('div, span, i'))
          .filter(element => isVisible(element) && !isDecorative(element) && textOf(element).length === 0)
          .filter((element) => {
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            const hasPaint = style.backgroundImage !== 'none'
              || !['rgba(0, 0, 0, 0)', 'transparent'].includes(style.backgroundColor)
              || style.borderTopWidth !== '0px'
              || style.boxShadow !== 'none';
            return hasPaint && rect.width * rect.height > 500;
          })
          .map(element => ({ tag: element.tagName.toLowerCase(), rect: relRect(element, stageRect) }));

        const checkedRects = [
          ...textElements.map(item => ({ kind: 'text', text: item.text, rect: item.rect })),
          ...mediaElements.map(item => ({ kind: item.tag, rect: item.rect }))
        ];
        const contentRect = union([
          ...checkedRects.map(item => item.rect),
          ...svgCanvasElements.map(item => item.rect),
          ...visualElements.map(item => item.rect)
        ]);

        if (!contentRect || contentRect.width * contentRect.height < expectedWidth * expectedHeight * 0.02) {
          issues.push({ code: 'content-too-sparse', detail: 'visible text/media/vector area is too small' });
        }

        // A scene MUST have at least one visible text label or media element
        if (textElements.length === 0 && mediaElements.length === 0 && svgCanvasElements.length === 0) {
          issues.push({
            code: 'no-visible-content',
            detail: `Scene has no visible text or media elements (only ${visualElements.length} background/visual div(s)). Add text labels, data visualizations, or images.`
          });
        }
        if (aspectRatioValue === '9:16' && contentRect) {
          const safeHeight = safeBottom - safeTop;
          if (contentRect.bottom < safeTop + safeHeight * 0.58) {
            issues.push({
              code: 'composition-bunched-top',
              detail: `content ends at y=${Math.round(contentRect.bottom)}; use the middle vertical safe area, not only the top`
            });
          }
          if (contentRect.height < safeHeight * 0.24) {
            issues.push({
              code: 'composition-too-short',
              detail: `content height=${Math.round(contentRect.height)}; expand visual hierarchy vertically for 9:16`
            });
          }
        }

        for (const item of checkedRects) {
          const rect = item.rect;
          if (rect.top < safeTop - safeTolerance) {
            issues.push({ code: 'safezone-top', detail: `${item.kind} starts at y=${Math.round(rect.top)} (< ${safeTop})` });
          }
          if (rect.bottom > safeBottom + safeTolerance) {
            issues.push({ code: 'safezone-bottom', detail: `${item.kind} ends at y=${Math.round(rect.bottom)}; keep bottom gap >= ${safeBottomGap}` });
          }
          if (rect.left < safeSide - safeTolerance || rect.right > expectedWidth - safeSide + safeTolerance) {
            issues.push({ code: 'safezone-side', detail: `${item.kind} x=${Math.round(rect.left)}..${Math.round(rect.right)}` });
          }
        }

        // Check for layout overlaps (text-text, text-media)
        // Uses rect containment instead of DOM .contains() since element refs are not serialised
        const isContained = (inner, outer) => (
          inner.top >= outer.top - 2 &&
          inner.bottom <= outer.bottom + 2 &&
          inner.left >= outer.left - 2 &&
          inner.right <= outer.right + 2
        );

        const overlapCandidates = [
          ...textElements.map(t => ({ rect: t.rect, text: t.text, kind: 'text' })),
          ...mediaElements.map(m => ({ rect: m.rect, text: '', kind: m.tag }))
        ];

        for (let i = 0; i < overlapCandidates.length; i++) {
          const a = overlapCandidates[i];
          for (let j = i + 1; j < overlapCandidates.length; j++) {
            const b = overlapCandidates[j];

            // Skip if one rect is entirely contained within the other (parent-child layout)
            if (isContained(a.rect, b.rect) || isContained(b.rect, a.rect)) continue;

            const overlapX = Math.max(0, Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left));
            const overlapY = Math.max(0, Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top));

            // Flag as overlap only if intersection is greater than 5px on both axes
            if (overlapX > 5 && overlapY > 5) {
              const descA = a.text ? `text "${a.text.slice(0, 30)}"` : a.kind;
              const descB = b.text ? `text "${b.text.slice(0, 30)}"` : b.kind;
              issues.push({
                code: 'layout-overlap',
                detail: `Overlap between ${descA} and ${descB} (${Math.round(overlapX)}x${Math.round(overlapY)}px). Use Flexbox/Grid instead of overlapping absolute positions.`
              });
            }
          }
        }

        const totalTextChars = textElements.reduce((sum, item) => sum + item.text.length, 0);
        const longText = textElements.find(item => item.text.length > 110);
        const tinyText = textElements.find(item => item.fontSize > 0 && item.fontSize < 15);
        if (totalTextChars > 320) {
          issues.push({ code: 'text-too-dense', detail: `${totalTextChars} visible characters; keep canvas text short` });
        }
        if (longText) {
          issues.push({ code: 'text-block-too-long', detail: longText.text.slice(0, 120) });
        }
        if (tinyText) {
          issues.push({ code: 'text-too-small', detail: `${Math.round(tinyText.fontSize)}px: ${tinyText.text.slice(0, 80)}` });
        }

        return {
          ok: issues.length === 0,
          issues,
          metrics: {
            stage: { width: stageRect.width, height: stageRect.height },
            content: contentBoxRect,
            safeZone: { top: safeTop, side: safeSide, bottom: safeBottom, bottomGap: safeBottomGap, tolerance: safeTolerance },
            visibleTextElements: textElements.length,
            visibleMediaElements: mediaElements.length,
            visibleVectorElements: svgCanvasElements.length,
            visibleVisualElements: visualElements.length,
            totalTextChars,
            contentRect
          }
        };
      },
      {
        aspectRatioValue: ratio.value,
        expectedWidth: ratio.width,
        expectedHeight: ratio.height,
        safeTop,
        safeSide,
        safeBottom,
        safeBottomGap,
        safeTolerance
      }
    );

    if (!report.ok) {
      const message = report.issues.slice(0, 5).map(formatIssue).join('; ');
      const error = new Error(`HTML quality validation failed: ${message}`);
      error.report = report;
      throw error;
    }
    return report;
  } finally {
    await browser.close();
  }
}

module.exports = {
  validateHtmlSceneQuality
};
