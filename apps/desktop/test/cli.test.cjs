const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { existsSync } = require('node:fs');
const { mkdir, mkdtemp, readFile, rm, symlink, writeFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { tmpdir } = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..', '..');
const cli = path.join(root, 'apps', 'cli', 'jharness-cli.cjs');
const jar = path.join(root, 'apps', 'backend', 'target', 'jharness-backend.jar');
const bundledJava = path.join(root, 'runtime', 'bin', 'java.exe');

function executeCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('CLI timed out\n' + stdout + stderr));
    }, 30000);
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('CLI reuses the desktop project and session runtime', { timeout: 45000 }, async () => {
  assert.equal(existsSync(jar), true, 'build the backend JAR before CLI tests');
  const temporary = await mkdtemp(path.join(tmpdir(), 'jharness-cli-'));
  const project = path.join(temporary, 'project');
  const alias = path.join(temporary, 'desktop-project');
  const data = path.join(temporary, 'data');
  await mkdir(project);
  await symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(data);
  await writeFile(path.join(project, 'README.md'), 'CLI PROJECT');
  const projectId = randomUUID();
  await writeFile(path.join(data, 'settings.json'), JSON.stringify({
    models: [],
    projects: [{ id: projectId, directory: alias, name: 'CLI project', sessions: [] }]
  }));

  let requests = 0;
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests++;
    const toolResults = body.messages.filter(message => message.role === 'tool');
    const delta = toolResults.length
      ? { role: 'assistant', content: 'CLI-RESULT-42' }
      : { role: 'assistant', tool_calls: [{ index: 0, id: 'cli-call-0', type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) } }] };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({
      id: 'chatcmpl-' + randomUUID(),
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture',
      choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }]
    }) + '\n\ndata: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const env = {
    JHARNESS_DATA_DIR: data,
    JHARNESS_BACKEND_JAR: jar,
    JHARNESS_JAVA: existsSync(bundledJava) ? bundledJava : 'java',
    JHARNESS_API_KEY: 'fixture-key',
    JHARNESS_MODEL: 'fixture',
    JHARNESS_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/v1',
    JHARNESS_PROVIDER: 'compatible'
  };
  try {
    const run = await executeCli([
      'run', 'Read the README and report the marker',
      '--project', project, '--permission', 'full', '--effort', 'high'
    ], env);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /CLI-RESULT-42/);
    assert.match(run.stderr, /\[tool\] read_file/);
    assert.equal(requests, 2);

    const settings = JSON.parse(await readFile(path.join(data, 'settings.json'), 'utf8'));
    assert.equal(settings.projects[0].id, projectId);
    assert.equal(settings.projects[0].sessions.length, 1);
    const sessionId = settings.projects[0].sessions[0].id;
    assert.match(sessionId, /^[a-f0-9-]{36}$/);

    const doctor = await executeCli(['doctor', '--project', project], env);
    assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
    const status = JSON.parse(doctor.stdout);
    assert.equal(status.projectId, projectId);
    assert.equal(status.sessionId, sessionId);
    assert.equal(status.identitySource, 'desktop');
    assert.equal(status.backendVersion, '0.1.0');
    assert.equal(status.modelConfigured, true);

    const batch = await Promise.all(Array.from({ length: 8 }, (_, index) => executeCli(
      ['run', 'Read the marker ' + index, '--project', project, '--new-session', '--permission', 'full'], env)));
    for (const result of batch) assert.equal(result.code, 0, result.stdout + result.stderr);
    const after = JSON.parse(await readFile(path.join(data, 'settings.json'), 'utf8'));
    const ids = new Set(after.projects[0].sessions.map(session => session.id));
    assert.equal(ids.size, 9);
    assert.ok(ids.has(sessionId));
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('doctor probes Java and the JAR without registering sessions', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'jharness-doctor-test-'));
  const data = path.join(temporary, 'absent');
  const args = ['doctor', '--project', temporary, '--new-session'];
  const env = { JHARNESS_DATA_DIR: data, JHARNESS_BACKEND_JAR: jar, JHARNESS_JAVA: bundledJava };
  try {
    const ok = await executeCli(args, env);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).sessionId, null);
    const missing = await executeCli(args, { ...env, JHARNESS_JAVA: path.join(temporary, 'missing.exe') });
    assert.equal(missing.code, 1);
    const damaged = path.join(temporary, 'broken.jar');
    await writeFile(damaged, 'invalid');
    const broken = await executeCli(args, { ...env, JHARNESS_BACKEND_JAR: damaged });
    assert.equal(broken.code, 1);
    assert.equal(existsSync(data), false);
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
  }
});
