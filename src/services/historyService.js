const path = require('path');
const { HISTORY_FILE, PROJECTS_DIR } = require('../config/constants');
const { readJson, writeJson, removePath } = require('../lib/fs');

async function listHistory() {
  const history = await readJson(HISTORY_FILE, { projects: [] });
  return history.projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function upsertHistory(projectMeta) {
  const history = await readJson(HISTORY_FILE, { projects: [] });
  const index = history.projects.findIndex((item) => item.id === projectMeta.id);
  if (index >= 0) {
    history.projects[index] = projectMeta;
  } else {
    history.projects.push(projectMeta);
  }
  await writeJson(HISTORY_FILE, history);
}

async function deleteProject(projectId) {
  const history = await readJson(HISTORY_FILE, { projects: [] });
  history.projects = history.projects.filter((item) => item.id !== projectId);
  await writeJson(HISTORY_FILE, history);
  await removePath(path.join(PROJECTS_DIR, projectId));
}

async function deleteAllProjects() {
  const history = await readJson(HISTORY_FILE, { projects: [] });
  await Promise.all(history.projects.map((item) => removePath(path.join(PROJECTS_DIR, item.id))));
  await writeJson(HISTORY_FILE, { projects: [], groups: history.groups || [] });
}

async function listGroups() {
  const history = await readJson(HISTORY_FILE, { projects: [], groups: [] });
  return history.groups || [];
}

async function createGroup(name) {
  const history = await readJson(HISTORY_FILE, { projects: [], groups: [] });
  if (!history.groups) history.groups = [];
  const group = {
    id: `group_${Date.now()}`,
    name: String(name || '').trim(),
    createdAt: new Date().toISOString()
  };
  history.groups.push(group);
  await writeJson(HISTORY_FILE, history);
  return group;
}

async function deleteGroup(groupId) {
  const history = await readJson(HISTORY_FILE, { projects: [], groups: [] });
  if (history.groups) {
    history.groups = history.groups.filter((g) => g.id !== groupId);
  }
  if (history.projects) {
    history.projects = history.projects.map((p) => {
      if (p.groupId === groupId) {
        p.groupId = null;
      }
      return p;
    });
  }
  await writeJson(HISTORY_FILE, history);
}

module.exports = {
  listHistory,
  upsertHistory,
  deleteProject,
  deleteAllProjects,
  listGroups,
  createGroup,
  deleteGroup
};
