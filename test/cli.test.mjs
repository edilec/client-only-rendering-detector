import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, link, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LIMITS } from '../src/index.mjs';

const bin = new URL('../bin/client-only-rendering-detector.mjs', import.meta.url).pathname;
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'render-report-'));
  await writeFile(join(root, 'server.html'), '<h1>Welcome</h1>');
  await writeFile(join(root, 'render.json'), JSON.stringify({ schemaVersion: '1', complete: true, headings: ['Welcome'], text: [], links: [] }));
  await writeFile(join(root, 'config.json'), JSON.stringify({ schemaVersion: '1', essentials: [{ id: 'heading', kind: 'heading', text: 'Welcome' }], exclusions: [] }));
  return root;
};
const run = (root, extra = []) => spawnSync(process.execPath, [bin, '--root', root, '--server', 'server.html', '--render', 'render.json', '--config', 'config.json', ...extra], { encoding: 'utf8' });
const rules = runResult => JSON.parse(runResult.stdout).findings.map(f => f.ruleId);

test('passing exported evidence exits zero and writes only a report when requested', async () => {
  const root = await fixture();
  const result = run(root, ['--out', 'report.json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'pass');
  assert.equal(await readFile(join(root, 'report.json'), 'utf8'), result.stdout);
});
test('render-only essential is an evaluated failure and never echoes content', async () => {
  const root = await fixture();
  await writeFile(join(root, 'server.html'), '<main></main>');
  const result = run(root);
  assert.equal(result.status, 1);
  assert.deepEqual(rules(result), ['client-only-essential']);
  assert.ok(!result.stdout.includes('Welcome'));
});
test('unreadable and malformed evidence is incomplete with logical provenance', async () => {
  const root = await fixture();
  await writeFile(join(root, 'render.json'), Buffer.from([0xff]));
  const result = run(root);
  assert.equal(result.status, 2);
  assert.deepEqual(rules(result), ['input-unreadable']);
  assert.equal(JSON.parse(result.stdout).findings[0].location.file, '@render');
  assert.ok(!result.stdout.includes(root));
});
test('every input byte bound accepts N and rejects N+1', async () => {
  for (const name of ['server.html', 'render.json', 'config.json']) {
    const root = await fixture(), original = await readFile(join(root, name));
    await writeFile(join(root, name), Buffer.concat([original, Buffer.alloc(LIMITS.bytes - original.length, 0x20)]));
    assert.equal(run(root).status, 0, name);
    await writeFile(join(root, name), Buffer.concat([original, Buffer.alloc(LIMITS.bytes + 1 - original.length, 0x20)]));
    const result = run(root);
    assert.equal(result.status, 2, name);
    assert.deepEqual(rules(result), ['byte-limit']);
  }
});
test('symlinked read escape is refused', async () => {
  const root = await fixture(), outside = await mkdtemp(join(tmpdir(), 'render-outside-'));
  await writeFile(join(outside, 'evidence.json'), '{}');
  await symlink(join(outside, 'evidence.json'), join(root, 'outside.json'));
  const result = spawnSync(process.execPath, [bin, '--root', root, '--server', 'server.html', '--render', 'outside.json', '--config', 'config.json'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.deepEqual(rules(result), ['input-unreadable']);
});
test('output aliases, destination symlinks, and symlinked parent escape are refused without writes', async () => {
  const root = await fixture(), outside = await mkdtemp(join(tmpdir(), 'render-outside-'));
  await writeFile(join(outside, 'sentinel'), 'preserve');
  await symlink(join(outside, 'sentinel'), join(root, 'linked-out'));
  await symlink(outside, join(root, 'escape'));
  await link(join(root, 'render.json'), join(root, 'hard'));
  for (const out of ['render.json', 'hard', 'linked-out', 'escape/new.json']) {
    const result = run(root, ['--out', out]);
    assert.equal(result.status, 2, out);
    assert.equal(result.stdout, '', out);
  }
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'preserve');
  const missing = run(root, ['--server', 'missing.html', '--out', 'missing.html']);
  assert.equal(missing.status, 2); assert.equal(missing.stdout, '');
  await symlink(root, join(root, 'alias'));
  const hidden = run(root, ['--server', 'missing.html', '--out', 'alias/missing.html']);
  assert.equal(hidden.status, 2); assert.equal(hidden.stdout, '');
  await assert.rejects(stat(join(root, 'missing.html')));
});
test('bad CLI options refuse without report', async () => {
  const root = await fixture();
  const result = run(root, ['--unknown']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
});
