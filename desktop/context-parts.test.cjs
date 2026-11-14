const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { importAttachment, projectParts } = require('./context-parts.cjs');

test('import native file selections and find local skill and plugin instructions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jharness-parts-'));
  async function file(relative, text) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
    return target;
  }
  try {
    const txt = await file('notes.txt', '附件正文');
    const image = await file('screenshot.png', Buffer.from('iVBORw0KGgo=', 'base64'));
    const binary = await file('data.bin', Buffer.from([0, 255]));
    await file('.git/hidden.txt', 'hidden');
    await file('.agents/skills/inspect/SKILL.md', 'Inspect the project.');
    await file('plugins/example/.codex-plugin/plugin.json', JSON.stringify({ name: 'Examples', skills: './custom' }));
    await file('plugins/example/custom/summary/SKILL.md', 'Summarize the project.');
    assert.equal((await importAttachment(txt, 'file', root)).text, '附件正文');
    assert.equal((await importAttachment(image, 'file', root)).image, 'iVBORw0KGgo=');
    await assert.rejects(importAttachment(binary, 'file', root), /UTF-8/);
    const listing = await importAttachment(root, 'folder', root);
    assert.match(listing.text, /notes\.txt/);
    assert.doesNotMatch(listing.text, /hidden\.txt/);
    const parts = await projectParts(root);
    assert.deepEqual(parts.map(({ kind, name, text }) => ({ kind, name, text })), [
      { kind: 'skill', name: 'inspect', text: 'Inspect the project.' },
      { kind: 'plugin', name: 'Examples / summary', text: 'Summarize the project.' }
    ]);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});
