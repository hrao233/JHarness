const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdir, mkdtemp, rm, symlink, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createManifest, verifyManifest, MANIFEST } = require('../electron/release-manifest.cjs');

async function bundle(t) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'jharness-release-'));
  t.after(() => rm(temporary, { recursive: true, force: true, maxRetries: 5 }));
  await mkdir(path.join(temporary, 'resources'));
  await writeFile(path.join(temporary, 'JHarness.exe'), 'executable');
  await writeFile(path.join(temporary, 'resources', 'backend.jar'), 'java');
  const manifest = await createManifest(temporary,
    { version: '9.8.7', commit: 'abc123', sourceDirty: true });
  return { temporary, manifest };
}

test('verifies source metadata and detects same-size file corruption', async t => {
  const { temporary, manifest } = await bundle(t);
  assert.deepEqual(await verifyManifest(temporary), {
    version: '9.8.7', commit: 'abc123', sourceDirty: true, createdAt: manifest.createdAt,
    files: 2, bytes: 14
  });
  await writeFile(path.join(temporary, 'resources', 'backend.jar'), 'fake');
  await assert.rejects(verifyManifest(temporary), /校验失败：resources\/backend.jar/);
});

test('detects extra and missing release files', async t => {
  const { temporary } = await bundle(t);
  const extra = path.join(temporary, 'unexpected.dll');
  await writeFile(extra, 'extra');
  await assert.rejects(verifyManifest(temporary), /未记录文件：unexpected.dll/);
  await rm(extra);
  await rm(path.join(temporary, 'JHarness.exe'));
  await assert.rejects(verifyManifest(temporary), /缺少文件：JHarness.exe/);
});

test('rejects omitted and duplicate manifest paths even when byte totals agree', async t => {
  const { temporary, manifest } = await bundle(t);
  const manifestFile = path.join(temporary, MANIFEST);
  const [entry] = manifest.files;
  await writeFile(manifestFile, JSON.stringify({ ...manifest, files: [entry], bytes: entry.size }));
  await assert.rejects(verifyManifest(temporary), /未记录文件/);
  await writeFile(manifestFile, JSON.stringify({
    ...manifest, files: [entry, entry], bytes: entry.size * 2
  }));
  await assert.rejects(verifyManifest(temporary), /重复的文件记录/);
});

test('does not treat a linked directory as part of a portable release', async t => {
  const { temporary } = await bundle(t);
  const source = path.join(temporary, 'resources');
  await symlink(source, path.join(temporary, 'linked-resources'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyManifest(temporary), /非普通文件：linked-resources/);
});
