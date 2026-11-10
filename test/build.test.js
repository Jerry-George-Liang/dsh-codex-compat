import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Reproduce Git core.autocrlf even on non-Windows runners, including a spaced path.
test('build accepts Windows CRLF checkout and emits a self-contained LF Host entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex Windows checkout '));
  try {
    for (const file of ['build.mjs', 'package.json', 'compat.js', 'controller.js', 'task-scope.js', 'index.js']) {
      const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
      await writeFile(join(dir, file), text.replace(/\r?\n/g, '\r\n'));
    }
    const built = spawnSync(process.execPath, ['build.mjs'], { cwd: dir, encoding: 'utf8', timeout: 5000 });
    assert.equal(built.status, 0, built.stderr);
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    const entry = join(dir, pkg.exports['.']);
    const body = await readFile(entry, 'utf8');
    assert.equal(body.includes('\r\n'), false);
    assert.doesNotMatch(body, /from ['"]\.\//);
    const checked = spawnSync(process.execPath, ['--check', entry], { encoding: 'utf8', timeout: 5000 });
    assert.equal(checked.status, 0, checked.stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
