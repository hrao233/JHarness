const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const FORMAT = 'jharness-release-v1';
const MANIFEST = 'release-manifest.json';

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function* walkFiles(root, relative = '') {
  const directory = relative ? path.join(root, relative) : root;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!relative && entry.name === MANIFEST) continue;
    const child = relative ? relative + '/' + entry.name : entry.name;
    const target = path.join(root, child);
    if (entry.isDirectory()) {
      yield* walkFiles(root, child);
    } else if (entry.isFile()) {
      yield { relative: child, target, size: (await fs.stat(target)).size };
    } else {
      throw new Error('发布包包含非普通文件：' + child);
    }
  }
}

async function manifestPath(release) {
  const file = path.join(release, MANIFEST);
  const stat = await fs.lstat(file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (stat && !stat.isFile()) throw new Error('发布清单不是普通文件。');
  return file;
}

async function createManifest(root, { version, commit = 'unknown', sourceDirty = null } = {}) {
  const release = await fs.realpath(root);
  if (!version) throw new Error('release version is required');
  const file = await manifestPath(release);
  const files = [];
  for await (const { relative, target, size } of walkFiles(release)) {
    files.push({ path: relative, size, sha256: await hashFile(target) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    format: FORMAT,
    version: String(version),
    commit: String(commit || 'unknown'),
    sourceDirty,
    createdAt: Date.now(),
    files,
    bytes: files.reduce((total, file) => total + file.size, 0)
  };
  await fs.writeFile(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { path: file, ...manifest };
}

async function verifyManifest(root) {
  const release = await fs.realpath(root);
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(await manifestPath(release), 'utf8'));
  } catch (error) {
    throw new Error('无法读取发布清单：' + error.message);
  }
  if (manifest?.format !== FORMAT || typeof manifest.version !== 'string' || !manifest.version
    || !Array.isArray(manifest.files) || !Number.isSafeInteger(manifest.bytes)) {
    throw new Error('发布清单格式或版本无效。');
  }
  const expected = new Map();
  for (const file of manifest.files) {
    const relative = file?.path;
    if (typeof relative !== 'string' || expected.has(relative)
      || !Number.isSafeInteger(file.size) || file.size < 0
      || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new Error('发布清单包含无效或重复的文件记录。');
    }
    expected.set(relative, file);
  }
  let bytes = 0;
  // Resolve paths only from the actual directory tree, never from the manifest.
  for await (const { relative, target, size } of walkFiles(release)) {
    const file = expected.get(relative);
    if (!file) throw new Error('发布清单未记录文件：' + relative);
    if (size !== file.size || await hashFile(target) !== file.sha256) {
      throw new Error('发布文件校验失败：' + relative);
    }
    bytes += size;
    expected.delete(relative);
  }
  if (expected.size > 0) throw new Error('发布包缺少文件：' + expected.keys().next().value);
  if (bytes !== manifest.bytes) throw new Error('发布清单总大小不匹配。');
  return {
    version: manifest.version,
    commit: manifest.commit,
    sourceDirty: manifest.sourceDirty ?? null,
    createdAt: manifest.createdAt,
    files: manifest.files.length,
    bytes
  };
}

module.exports = { createManifest, verifyManifest, MANIFEST, FORMAT };
