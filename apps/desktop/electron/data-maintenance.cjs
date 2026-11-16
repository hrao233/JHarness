const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const FORMAT = 'jharness-backup-v1';
const MAX_FILES = 50_000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

function excluded(name) {
  return name === 'worktrees'
    || name === 'session-search.sqlite'
    || name.startsWith('session-search.sqlite-')
    || name.endsWith('.tmp');
}

function within(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..'
    && !relative.startsWith('..' + path.sep));
}

async function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function collect(root, relative = '') {
  const directory = path.join(root, relative);
  const files = [];
  let totalBytes = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (excluded(entry.name)) continue;
    const target = path.join(root, child);
    if (entry.isDirectory()) {
      const nested = await collect(root, child);
      files.push(...nested.files);
      totalBytes += nested.totalBytes;
    } else if (entry.isFile()) {
      const stat = await fs.stat(target);
      files.push({
        path: child.split(path.sep).join('/'),
        size: stat.size,
        sha256: await hashFile(target)
      });
      totalBytes += stat.size;
    }
    if (files.length > MAX_FILES) throw new Error('备份文件数超过 50,000。');
    if (totalBytes > MAX_BYTES) throw new Error('备份总大小超过 2 GiB。');
  }
  return { files, totalBytes };
}

async function createBackup(dataDirectory, destinationRoot) {
  const source = await fs.realpath(dataDirectory);
  const destination = await fs.realpath(destinationRoot);
  if (within(source, destination)) throw new Error('备份目录不能位于 JHarness 数据目录内。');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const output = path.join(destination, 'JHarness-backup-' + stamp);
  await fs.mkdir(output, { recursive: false });
  try {
    const entries = [];
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
      if (excluded(entry.name) || entry.name === 'cli-projects.json') continue;
      entries.push(entry.name);
    }
    entries.sort();
    for (const entry of entries) {
      await fs.cp(path.join(source, entry), path.join(output, entry), {
        recursive: true,
        errorOnExist: false,
        force: true
      });
    }
    const collected = await collect(output);
    if (!collected.files.some(file => file.path === 'settings.json')) {
      throw new Error('JHarness 数据目录缺少 settings.json。');
    }
    const manifest = {
      format: FORMAT,
      version: 1,
      createdAt: Date.now(),
      source,
      entries,
      files: collected.files.length,
      bytes: collected.totalBytes,
      filesManifest: collected.files
    };
    await fs.writeFile(path.join(output, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    return {
      path: output,
      createdAt: manifest.createdAt,
      entries,
      files: manifest.files,
      bytes: manifest.bytes
    };
  } catch (error) {
    await fs.rm(output, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function inspectBackup(directory) {
  const root = await fs.realpath(directory);
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  } catch (error) {
    throw new Error('不是有效的 JHarness 备份目录：' + error.message);
  }
  if (manifest.format !== FORMAT || manifest.version !== 1) {
    throw new Error('不支持的 JHarness 备份格式或版本。');
  }
  if (!Array.isArray(manifest.entries) || !Array.isArray(manifest.filesManifest)) {
    throw new Error('JHarness 备份清单不完整。');
  }
  for (const entry of manifest.entries) {
    if (typeof entry !== 'string' || entry === '.' || entry === '..'
      || entry.includes('/') || entry.includes('\\')) {
      throw new Error('JHarness 备份包含无效条目。');
    }
    await fs.access(path.join(root, entry));
  }
  for (const file of manifest.filesManifest) {
    const relative = String(file.path || '');
    if (!relative || path.isAbsolute(relative) || !within(root, path.join(root, relative))) {
      throw new Error('JHarness 备份包含越界文件。');
    }
    const target = path.join(root, ...relative.split('/'));
    const stat = await fs.stat(target);
    if (stat.size !== Number(file.size) || await hashFile(target) !== file.sha256) {
      throw new Error('JHarness 备份文件校验失败：' + relative);
    }
  }
  if (!manifest.entries.includes('settings.json')) {
    throw new Error('JHarness 备份缺少桌面设置。');
  }
  return {
    path: root,
    createdAt: Number(manifest.createdAt) || 0,
    entries: manifest.entries,
    files: Number(manifest.files) || manifest.filesManifest.length,
    bytes: Number(manifest.bytes) || manifest.filesManifest.reduce(
      (total, file) => total + (Number(file.size) || 0), 0)
  };
}

async function restoreBackup(dataDirectory, backupDirectory) {
  const target = await fs.realpath(dataDirectory);
  const source = await inspectBackup(backupDirectory);
  if (within(source.path, target)) throw new Error('恢复目标不能位于备份目录内。');
  const parent = path.dirname(target);
  const safety = await createBackup(target, parent);
  for (const entry of source.entries) {
    const destination = path.join(target, entry);
    if (!within(target, destination)) throw new Error('恢复条目越界。');
    await fs.rm(destination, { recursive: true, force: true });
    await fs.cp(path.join(source.path, entry), destination, {
      recursive: true,
      errorOnExist: false,
      force: true
    });
  }
  for (const entry of await fs.readdir(target)) {
    if (entry.startsWith('session-search.sqlite')) {
      await fs.rm(path.join(target, entry), { force: true });
    }
  }
  return {
    restored: true,
    source: source.path,
    safetyBackup: safety.path,
    entries: source.entries,
    files: source.files
  };
}

async function status(dataDirectory) {
  const root = await fs.realpath(dataDirectory);
  const collected = await collect(root);
  const settings = JSON.parse(await fs.readFile(path.join(root, 'settings.json'), 'utf8'));
  return {
    path: root,
    projects: Array.isArray(settings.projects) ? settings.projects.length : 0,
    sessions: Array.isArray(settings.projects)
      ? settings.projects.reduce((total, project) => total
        + (Array.isArray(project.sessions) ? project.sessions.length : 0), 0)
      : 0,
    files: collected.files.length,
    bytes: collected.totalBytes
  };
}

module.exports = { createBackup, inspectBackup, restoreBackup, status, within };
