const { getDefaultVerticalPrompt, getProject } = require('../src/services/projectService');

async function test() {
  console.log('--- Testing getDefaultVerticalPrompt ---');
  const horizontalPrompt = 'realistic Wyckoff trading education visual, vintage 1920s-1930s market chart poster style, full 16:9 horizontal frame. Safe video thumbnail layout...';
  const title = 'Giải mã volume';
  const vertical = getDefaultVerticalPrompt(horizontalPrompt, title);
  console.log('Horizontal:', horizontalPrompt);
  console.log('Vertical:  ', vertical);

  if (vertical.includes('16:9')) {
    console.error('FAIL: Still contains 16:9');
  } else {
    console.log('SUCCESS: replaced 16:9');
  }

  if (vertical.includes('horizontal')) {
    console.error('FAIL: Still contains horizontal');
  } else {
    console.log('SUCCESS: replaced horizontal');
  }

  console.log('\n--- Testing getProject loading migration ---');
  // Load the latest project
  const projectId = 'project_1782060304447';
  const project = await getProject(projectId);
  if (project) {
    console.log('Project loaded successfully:', project.id);
    console.log('Project thumbnailPromptVertical:', project.thumbnailPromptVertical);
  } else {
    console.log('Project not found, skipping project load test.');
  }
}

test().catch(console.error);
