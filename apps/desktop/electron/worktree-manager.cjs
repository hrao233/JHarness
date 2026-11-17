const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const execute = promisify(execFile);
const COMMAND_TIMEOUT = 30_000;
const MAX_STATUS_BYTES = 512 * 1024;

function within(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..'
    && !relative.startsWith('..' + path.sep));
}

function slug(value) {
  const normalized = String(value || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28);
  return normalized || 'task';
}

async function git(args, cwd) {
  try {
    return await execute('git', [
      '--no-pager', '-c', 'color.ui=false', '-c', 'core.fsmonitor=false', ...args
    ], {
      cwd,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: MAX_STATUS_BYTES,
      timeout: COMMAND_TIMEOUT,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
    });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('找不到 Git，请确认 Git 已安装且可从命令行运行。');
    const detail = String(error.stderr || error.stdout || '').trim();
    throw new Error(detail
      ? 'Git 操作失败：' + detail.slice(0, 800)
      : 'Git 操作失败，请检查仓库状态。');
  }
}

async function text(args, cwd) {
  return (await git(args, cwd)).stdout.trim();
}

async function requireGitMarker(start) {
  const current = path.resolve(start);
  try {
    await fs.stat(path.join(current, '.git'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('请打开 Git 仓库根目录后再创建工作树。');
    throw error;
  }
}

async function repository(projectRoot) {
  await requireGitMarker(projectRoot);
  const root = await text(['rev-parse', '--show-toplevel'], projectRoot);
  const head = await text(['rev-parse', 'HEAD'], root);
  const branch = await text(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const status = await text(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], root);
  return {
    root,
    projectRoot: path.resolve(projectRoot),
    head,
    branch,
    dirty: status.length > 0,
    changedFiles: status ? status.split('\0').filter(Boolean).length : 0
  };
}

async function resolveDirectory(directory) {
  try {
    return await fs.realpath(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // A deleted worktree directory can still have Git metadata to prune.
    return path.join(await fs.realpath(path.dirname(directory)), path.basename(directory));
  }
}

function createManager(worktreeRoot) {
  const root = path.resolve(worktreeRoot);

  async function create({ projectRoot, label = '' }) {
    const repo = await repository(projectRoot);
    const id = randomUUID();
    const branch = 'jharness/' + slug(label) + '-' + id.slice(0, 8);
    await fs.mkdir(root, { recursive: true });
    // Git records the on-disk path, which can differ from a Windows short path or junction.
    const directory = await fs.realpath(root);
    const target = path.join(directory, id);
    if (!within(directory, target)) throw new Error('工作树目标目录无效。');
    try {
      await git(['worktree', 'add', '-b', branch, target, repo.head], repo.root);
      return {
        id,
        path: target,
        branch,
        baseCommit: repo.head,
        baseBranch: repo.branch,
        repoRoot: repo.root,
        sourceDirty: repo.dirty,
        sourceChangedFiles: repo.changedFiles,
        createdAt: Date.now()
      };
    } catch (error) {
      await cleanup(repo.root, target, branch);
      throw error;
    }
  }

  async function status(record) {
    if (!record?.path) throw new Error('缺少工作树记录。');
    try {
      const stats = await fs.stat(record.path);
      if (!stats.isDirectory()) throw new Error('工作树路径不是目录。');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { exists: false, dirty: false, changedFiles: 0, ahead: 0,
          branch: record.branch || '', head: '', path: record.path };
      }
      throw error;
    }
    const branch = await text(['rev-parse', '--abbrev-ref', 'HEAD'], record.path);
    const head = await text(['rev-parse', 'HEAD'], record.path);
    const changes = await text(['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
      record.path);
    let ahead = 0;
    if (record.baseCommit) {
      try {
        ahead = Number(await text(['rev-list', '--count', record.baseCommit + '..HEAD'], record.path)) || 0;
      } catch {
        ahead = 0;
      }
    }
    return {
      exists: true,
      dirty: changes.length > 0,
      changedFiles: changes ? changes.split('\0').filter(Boolean).length : 0,
      ahead,
      branch,
      head,
      path: record.path
    };
  }

  async function source(projectRoot) {
    const repo = await repository(projectRoot);
    return {
      exists: true,
      source: true,
      dirty: repo.dirty,
      changedFiles: repo.changedFiles,
      ahead: 0,
      branch: repo.branch,
      head: repo.head,
      path: repo.root
    };
  }

  async function review(record) {
    if (!record?.path || !record?.baseCommit) throw new Error('工作树记录无效。');
    const current = await status(record);
    if (!current.exists) throw new Error('工作树目录已不存在。');
    if (current.dirty) throw new Error('工作树包含未提交修改。请先提交后再审阅合并。');
    const range = record.baseCommit + '..' + (current.branch || 'HEAD');
    const [stat, patch, commits] = await Promise.all([
      text(['diff', '--stat', record.baseCommit + '...' + (current.branch || 'HEAD')], record.path),
      text(['diff', '--no-ext-diff', '--no-textconv', record.baseCommit + '...' + (current.branch || 'HEAD')],
        record.path),
      text(['log', '--format=%h %s', range], record.path)
    ]);
    return {
      branch: current.branch,
      baseCommit: record.baseCommit,
      ahead: current.ahead,
      dirty: false,
      canMerge: current.ahead > 0,
      stat,
      patch: patch.length <= 512 * 1024 ? patch : patch.slice(0, 512 * 1024) + '\n[补丁已截断]',
      commits: commits.split(/\r?\n/).filter(Boolean).slice(0, 100)
    };
  }

  async function integrate(record, parentRoot) {
    if (!record?.path || !record?.branch) throw new Error('工作树记录无效。');
    const current = await status(record);
    if (!current.exists) throw new Error('工作树目录已不存在。');
    if (current.dirty) throw new Error('工作树包含未提交修改。请先提交后再应用。');
    if (current.ahead < 1) throw new Error('工作树没有待应用的提交。');
    const parent = await repository(parentRoot);
    const parentChanges = await text(
      ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], parent.root);
    if (parentChanges) throw new Error('主工作区包含未提交修改。请先提交或清理后再应用工作树。');
    try {
      await git(['merge', '--no-commit', '--no-ff', record.branch], parent.root);
    } catch (error) {
      await git(['merge', '--abort'], parent.root).catch(() => {});
      throw new Error('工作树合并发生冲突，已撤销主工作区中的合并。请先在隔离工作树中解决分叉。');
    }
    const [stat, staged] = await Promise.all([
      text(['diff', '--cached', '--stat'], parent.root),
      text(['diff', '--cached', '--name-only'], parent.root)
    ]);
    return {
      branch: record.branch,
      stat,
      files: staged.split(/\r?\n/).filter(Boolean),
      committed: false
    };
  }

  async function remove(record, { force = false } = {}) {
    if (!record?.path || !record?.repoRoot) {
      throw new Error('工作树记录无效。');
    }
    const saved = path.resolve(record.path);
    const [directory, parent] = await Promise.all([
      resolveDirectory(root),
      resolveDirectory(path.dirname(saved))
    ]);
    if (path.relative(directory, parent) !== '') throw new Error('工作树记录无效。');
    const target = path.join(directory, path.basename(saved));
    const current = await status({ ...record, path: target });
    if (!current.exists) {
      await pruneBranches(record.repoRoot, record.branch);
      return current;
    }
    if (path.relative(target, await fs.realpath(target)) !== '') {
      throw new Error('工作树记录无效。');
    }
    if (current.dirty && !force) {
      throw new Error('工作树包含未提交的修改。请先提交或丢弃后再移除。');
    }
    if (current.ahead > 0 && !force) {
      throw new Error('工作树包含尚未合并的提交。请先处理这些提交后再移除。');
    }
    const args = ['worktree', 'remove'];
    if (force) args.push('--force');
    args.push(target);
    try {
      await git(args, record.repoRoot);
    } catch (error) {
      if (!force) throw error;
      await fs.rm(target, { recursive: true, force: true });
      await git(['worktree', 'prune'], record.repoRoot).catch(() => {});
    }
    await pruneBranches(record.repoRoot, record.branch);
    return current;
  }

  async function list(projectRoot) {
    const repo = await repository(projectRoot);
    const output = await text(['worktree', 'list', '--porcelain'], repo.root);
    const entries = [];
    let current = {};
    for (const line of output.split(/\r?\n/)) {
      if (!line) {
        if (current.path) entries.push(current);
        current = {};
      } else if (line.startsWith('worktree ')) current.path = path.resolve(line.slice(9));
      else if (line.startsWith('HEAD ')) current.head = line.slice(5);
      else if (line.startsWith('branch ')) current.branch = line.slice(7).replace('refs/heads/', '');
      else if (line === 'detached') current.detached = true;
      else if (line.startsWith('locked')) current.locked = line.slice(7).trim();
    }
    if (current.path) entries.push(current);
    return entries;
  }

  async function cleanup(repoRoot, target, branch) {
    await git(['worktree', 'unlock', target], repoRoot).catch(() => {});
    await git(['worktree', 'remove', '--force', target], repoRoot).catch(() => {});
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    await git(['worktree', 'prune'], repoRoot).catch(() => {});
    await git(['branch', '-D', branch], repoRoot).catch(() => {});
  }

  async function pruneBranches(repoRoot, branch) {
    await git(['worktree', 'prune'], repoRoot).catch(() => {});
    if (branch && branch.startsWith('jharness/')) {
      await git(['branch', '-D', branch], repoRoot).catch(() => {});
    }
  }

  return { root, create, status, source, review, integrate, remove, list };
}

module.exports = { createManager, within };
