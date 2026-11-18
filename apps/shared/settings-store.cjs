const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function readSettings(directory) {
  return readJson(path.join(directory, 'settings.json'), { projects: [] });
}

function updateSettings(directory, change) {
  // The OS releases SQLite's writer lock even when a process is killed.
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(directory, { recursive: true });
  const lock = new DatabaseSync(path.join(directory, 'settings-lock.sqlite'));
  try {
    lock.exec('PRAGMA busy_timeout=5000');
    lock.exec('BEGIN IMMEDIATE');
    const settings = readSettings(directory);
    const before = JSON.stringify(settings);
    const result = change(settings);
    if (JSON.stringify(settings) !== before) {
      const file = path.join(directory, 'settings.json');
      const temporary = file + '.' + randomUUID() + '.tmp';
      try {
        fs.writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', 'utf8');
        fs.renameSync(temporary, file);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    }
    return result;
  } finally {
    lock.close();
  }
}

function pathKey(directory) {
  try { directory = fs.realpathSync.native(directory); }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  return process.platform === 'win32' ? directory.toLowerCase() : directory;
}

function findProject(settings, directory) {
  const key = pathKey(directory);
  return settings.projects.find(item => typeof item.directory === 'string' && pathKey(item.directory) === key);
}

function legacyProject(data, directory) {
  return readJson(path.join(data, 'cli-projects.json'), {}).projects?.[fs.realpathSync.native(directory).toLowerCase()];
}

function addProject(settings, directory, legacy) {
  const project = { id: legacy?.projectId || randomUUID(), directory,
    name: path.basename(directory) || directory, sessions: [] };
  if (legacy?.sessionId) project.sessions.push({ id: legacy.sessionId, title: 'CLI 会话' });
  settings.projects.unshift(project);
  return project;
}

module.exports = { readSettings, updateSettings, findProject, legacyProject, addProject };
