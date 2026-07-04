const fs = require('fs').promises;
const path = require('path');
const { getProject, saveProject, getProjectPaths } = require('../src/services/projectService');

async function test() {
  console.log('--- Testing saveProject merge/overwrite logic ---');
  
  // Set env var to data dir
  process.env.VIBE_TOOL_DATA_DIR = 'data';
  
  const projectId = 'project_1782060304447';
  const paths = getProjectPaths(projectId);
  
  // Load original project state
  const originalJsonStr = await fs.readFile(paths.projectFile, 'utf8');
  const originalProject = JSON.parse(originalJsonStr);
  
  try {
    // 1. Test selective merge (no options)
    console.log('Running test 1: selective merge...');
    const projectToSave = JSON.parse(originalJsonStr);
    
    // Modify some scene fields and a project-level field (title)
    projectToSave.title = 'MODIFIED TITLE THAT SHOULD BE DISCARDED';
    projectToSave.scenes[0].status = 'testing_merge';
    projectToSave.scenes[0].files.image = 'path/to/test/image.png';
    projectToSave.error = 'TEST_ERROR';
    
    await saveProject(projectToSave);
    
    // Reload from disk and verify
    let diskProject = JSON.parse(await fs.readFile(paths.projectFile, 'utf8'));
    
    if (diskProject.title === 'MODIFIED TITLE THAT SHOULD BE DISCARDED') {
      console.error('FAIL: Overwrote title when it should have been discarded');
    } else {
      console.log('SUCCESS: title was correctly preserved as original:', diskProject.title);
    }
    
    if (diskProject.scenes[0].status === 'testing_merge' && diskProject.scenes[0].files.image === 'path/to/test/image.png') {
      console.log('SUCCESS: scene status and image path were merged correctly');
    } else {
      console.error('FAIL: scene changes were not merged');
    }
    
    if (diskProject.error === 'TEST_ERROR') {
      console.log('SUCCESS: project error was merged correctly');
    } else {
      console.error('FAIL: project error was not merged');
    }
    
    // 2. Test overwrite option
    console.log('\nRunning test 2: full overwrite...');
    const projectToOverwrite = JSON.parse(originalJsonStr);
    projectToOverwrite.title = 'TEST OVERWRITE TITLE';
    
    await saveProject(projectToOverwrite, { overwrite: true });
    
    diskProject = JSON.parse(await fs.readFile(paths.projectFile, 'utf8'));
    if (diskProject.title === 'TEST OVERWRITE TITLE') {
      console.log('SUCCESS: title was overwritten correctly');
    } else {
      console.error('FAIL: title was not overwritten');
    }
    
    // 3. Test overwrite when latestProject.scenes is empty
    console.log('\nRunning test 3: empty scenes fallback...');
    // Create a temporary project file with empty scenes
    const tempFile = path.join(path.dirname(paths.projectFile), 'project_temp.json');
    const tempProject = JSON.parse(originalJsonStr);
    tempProject.id = 'project_temp';
    tempProject.scenes = [];
    tempProject.title = 'Original Temp';
    await fs.writeFile(tempFile, JSON.stringify(tempProject, null, 2), 'utf8');
    
    const incomingProject = JSON.parse(originalJsonStr);
    incomingProject.id = 'project_temp';
    incomingProject.title = 'Incoming Overwritten Title';
    
    // We mock paths for project_temp
    const originalPaths = getProjectPaths('project_temp');
    await saveProject(incomingProject);
    
    const tempDisk = JSON.parse(await fs.readFile(originalPaths.projectFile, 'utf8'));
    if (tempDisk.title === 'Incoming Overwritten Title' && tempDisk.scenes.length > 0) {
      console.log('SUCCESS: empty scenes fallback worked, overwritten completely');
    } else {
      console.error('FAIL: empty scenes fallback did not overwrite');
    }
    
    // Clean up temp project file
    await fs.unlink(tempFile).catch(() => {});
    
  } finally {
    // Restore original project JSON
    await fs.writeFile(paths.projectFile, originalJsonStr, 'utf8');
    console.log('Restored original project state on disk.');
  }
}

test().catch(console.error);
