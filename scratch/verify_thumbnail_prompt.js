const { buildThumbnailImagePrompt } = require('../src/services/imageService');

function test() {
  console.log('--- Testing buildThumbnailImagePrompt conversion ---');

  const basePrompt = 'realistic Wyckoff trading education visual, vintage 1920s-1930s market chart poster style, full 9:16 vertical frame. Safe video thumbnail layout...';
  const project = {
    title: 'Giải mã volume',
    settings: {
      videoLanguage: 'vi',
      aspectRatio: '9:16',
      imageStyle: 'custom:richard-wyckoff',
      // Style detail containing horizontal cues
      imageStylePrompt: 'realistic Wyckoff trading education visual, vintage 1920s–1930s market chart poster style, full 16:9 horizontal frame. Chart-only means poster fills the whole frame.'
    }
  };

  const finalPrompt = buildThumbnailImagePrompt(
    basePrompt,
    project,
    project.settings.imageStyle,
    '9:16',
    project.settings.imageStylePrompt
  );

  console.log('Generated Final Prompt:\n', finalPrompt);

  if (finalPrompt.includes('16:9')) {
    console.error('FAIL: Final prompt still contains "16:9" in style detail!');
  } else {
    console.log('SUCCESS: No "16:9" remains in final prompt.');
  }

  if (finalPrompt.includes('horizontal')) {
    console.error('FAIL: Final prompt still contains "horizontal" in style detail!');
  } else {
    console.log('SUCCESS: No "horizontal" remains in final prompt.');
  }
}

test();
