const fs = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const maxBytes = 64 * 1024;
const maxImageBytes = 5 * 1024 * 1024;
const excluded = new Set(['node_modules', 'target', 'build', 'dist', 'vendor']);
const visible = entry => !entry.name.startsWith('.') && !excluded.has(entry.name.toLowerCase());

async function readBytes(file, limit, sizeError) {
  const handle = await fs.open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('请选择普通文件。');
    if (info.size > limit) throw new Error(sizeError);
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > info.size) throw new Error('文件在读取时发生变化，请重新添加。');
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

async function readText(file) {
  const buffer = await readBytes(file, maxBytes, '文本文件超过 64 KiB。');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new Error('请选择 UTF-8 文本或 PNG、JPEG 图片。'); }
  if (!text.trim() || text.includes('\u0000')) throw new Error('请选择非空 UTF-8 文本。');
  return text;
}

async function entries(directory) {
  return fs.readdir(directory, { withFileTypes: true });
}

async function folderListing(directory) {
  const lines = [];
  async function visit(current, depth) {
    const children = (await entries(current)).filter(visible)
      .filter(entry => entry.isDirectory() || entry.isFile());
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (lines.length >= 100) return;
      const target = path.join(current, child.name);
      lines.push(path.relative(directory, target) + (child.isDirectory() ? '/' : ''));
      if (child.isDirectory() && depth < 2) await visit(target, depth + 1);
    }
  }
  await visit(directory, 0);
  return '目录清单（最多三层、100 项）\n' + (lines.join('\n') || '空目录');
}

async function importAttachment(target, kind, project) {
  const name = path.basename(target) || target;
  if (kind === 'file') {
    const extension = path.extname(name).toLowerCase();
    if (['.png', '.jpg', '.jpeg'].includes(extension)) {
      const buffer = await readBytes(target, maxImageBytes, '图片超过 5 MiB。');
      const png = extension === '.png';
      const signature = Buffer.from(png ? '89504e470d0a1a0a' : 'ffd8ff', 'hex');
      if (!buffer.subarray(0, signature.length).equals(signature)) throw new Error('图片格式与扩展名不符。');
      return { name, kind: 'image', mime: png ? 'image/png' : 'image/jpeg', image: buffer.toString('base64') };
    }
    return { name, kind, text: await readText(target) };
  }
  const relative = path.relative(project, target);
  const inProject = relative === '' || (!path.isAbsolute(relative) && !relative.split(path.sep).includes('..'));
  const prefix = inProject ? '项目内目录 ' + (relative || '.') : '附件目录 ' + name;
  return { name, kind, text: prefix + '\n' + await folderListing(target) };
}

async function projectParts(root) {
  const parts = [];
  const realRoot = await fs.realpath(root);
  async function inside(target) {
    const real = await fs.realpath(target);
    const relative = path.relative(realRoot, real);
    if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) {
      throw new Error('项目资料位于项目目录之外。');
    }
    return real;
  }
  async function scan(folder, plugin) {
    let directories;
    try { directories = await entries(await inside(folder)); } catch { return; }
    for (const entry of directories.filter(value => value.isDirectory() && visible(value)).slice(0, 50)) {
      try {
        const skill = await inside(path.join(folder, entry.name, 'SKILL.md'));
        const name = plugin ? plugin + ' / ' + entry.name : entry.name;
        const text = await readText(skill);
        parts.push({ name, kind: plugin ? 'plugin' : 'skill',
          source: path.relative(realRoot, skill), text });
      } catch { /* Skip absent or unreadable skill instructions. */ }
    }
  }
  await scan(path.join(root, '.agents', 'skills'));
  await scan(path.join(root, 'skills'));
  let plugins;
  const folder = path.join(root, 'plugins');
  try { plugins = await entries(await inside(folder)); } catch { return parts; }
  for (const entry of plugins.filter(value => value.isDirectory() && visible(value)).slice(0, 30)) {
    const directory = path.join(folder, entry.name);
    try {
      const file = await inside(path.join(directory, '.codex-plugin', 'plugin.json'));
      const manifest = JSON.parse(await readText(file));
      const name = typeof manifest.name === 'string' ? manifest.name.slice(0, 80) : entry.name;
      const skillsDirectory = path.resolve(directory, typeof manifest.skills === 'string' ? manifest.skills : 'skills');
      const relative = path.relative(directory, skillsDirectory);
      if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) continue;
      await scan(skillsDirectory, name);
    } catch { /* Ignore entries without a valid local plugin manifest. */ }
  }
  return parts;
}

const label = part => ({ file: '文件', folder: '文件夹', image: '图片', skill: 'Skill', plugin: '插件 Skill' }[part.kind]
  + ' · ' + part.name);

module.exports = { importAttachment, projectParts, label };
