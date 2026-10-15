import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('the dev server answers a malformed URL with 400 and keeps running', async () => {
  const script = fileURLToPath(new URL('../../scripts/serve.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const port = await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => {
        const m = /127\.0\.0\.1:(\d+)/.exec(String(d));
        if (m) resolve(Number(m[1]));
      });
      child.once('exit', () => reject(new Error('the dev server exited')));
    });
    assert.equal((await fetch(`http://127.0.0.1:${port}/%E0`)).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${port}/_headers`)).status, 200);
  } finally {
    child.kill();
  }
});
