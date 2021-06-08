#!/usr/bin/env node
import { readFile, realpath, stat, lstat, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, relative, dirname, basename, isAbsolute, sep, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { compareRendering, incomplete, LIMITS } from '../src/index.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write('Usage: client-only-rendering-detector --root DIR --server FILE --render FILE --config FILE [--out FILE] [--human]\nAll files are exported local evidence; no browser is opened.\n');
} else {
  let root, server, render, config, out, human = false;
  try {
    for (let i = 0; i < args.length; i++) {
      const key = args[i];
      if (key === '--human') { if (human) throw new Error('duplicate'); human = true; continue; }
      if (!['--root', '--server', '--render', '--config', '--out'].includes(key) || i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error('option');
      const value = args[++i];
      if (key === '--root') { if (root) throw new Error('duplicate'); root = value; }
      if (key === '--server') { if (server) throw new Error('duplicate'); server = value; }
      if (key === '--render') { if (render) throw new Error('duplicate'); render = value; }
      if (key === '--config') { if (config) throw new Error('duplicate'); config = value; }
      if (key === '--out') { if (out) throw new Error('duplicate'); out = value; }
    }
    if (!root || !server || !render || !config || [server, render, config, out].filter(Boolean).some(isAbsolute)) throw new Error('path');
    root = await realpath(root);
    if (!(await stat(root)).isDirectory()) throw new Error('root');
  } catch { process.stderr.write('Invalid configuration. Use --help.\n'); process.exit(2); }
  const inside = path => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
  const names = [server, render, config], roles = ['@server', '@render', '@config'];
  async function readDocument(name, json) {
    const file = await realpath(resolve(root, name));
    if (!inside(file) || !(await stat(file)).isFile()) throw new Error('input-unreadable');
    if ((await stat(file)).size > LIMITS.bytes) throw new Error('byte-limit');
    const bytes = await readFile(file, { signal: AbortSignal.timeout(LIMITS.milliseconds) });
    if (bytes.length > LIMITS.bytes) throw new Error('byte-limit');
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return json ? JSON.parse(value) : value;
  }
  let result, values = [];
  for (let i = 0; i < names.length; i++) {
    try { values.push(await readDocument(names[i], i !== 0)); }
    catch (error) { result = incomplete(error.message === 'byte-limit' ? 'byte-limit' : 'input-unreadable', roles[i]); break; }
  }
  if (!result) result = compareRendering({ serverHtml: values[0], render: values[1], config: values[2] });
  const rendered = `${JSON.stringify(result, null, 2)}\n`;
  if (out) {
    try {
      const destination = resolve(root, out), parent = await realpath(dirname(destination));
      if (!inside(parent) || !inside(destination)) throw new Error('outside root');
      const actual = join(parent, basename(destination));
      for (const name of names) {
        const named = resolve(root, name);
        if (destination === named) throw new Error('output aliases named input');
        const canonical = await realpath(dirname(named)).then(p => join(p, basename(named))).catch(() => null);
        if (actual === canonical) throw new Error('output aliases named input');
      }
      let old;
      try { old = await lstat(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (old?.isSymbolicLink() || old?.isDirectory()) throw new Error('invalid output');
      if (old) for (const name of names) {
        const file = await realpath(resolve(root, name)).catch(() => null);
        if (!file || !inside(file)) continue;
        const source = await stat(file);
        if (old.dev === source.dev && old.ino === source.ino) throw new Error('output aliases input');
      }
      const temp = join(parent, `.${basename(destination)}.${randomUUID()}.tmp`);
      try { await writeFile(temp, rendered, { flag: 'wx', mode: 0o600 }); await rename(temp, destination); }
      catch (error) { await unlink(temp).catch(() => {}); throw error; }
    } catch { process.stderr.write('Output destination refused or write failed.\n'); process.exit(2); }
  }
  process.stdout.write(rendered);
  if (human) process.stderr.write(`Rendering comparison: ${result.status}; ${result.summary.checked} essentials checked; ${result.summary.errors} errors.\n`);
  process.exitCode = result.status === 'pass' ? 0 : result.status === 'fail' ? 1 : 2;
}
