import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../../src/core/html-text.js';
import { cpuMs } from './cpu.js';

test('readable text from a page: no scripts, styles or comments; the main part; blocks on their own lines; links kept', () => {
  const html = `<!doctype html><html><head><title>Nepenthe &amp; Café</title><style>p{}</style><script>alert(1)</script></head>
<body><nav>Home | Menu</nav><main><h1>Dinner</h1><!-- hidden --><p>Open&nbsp;daily till <b>10&#160;pm</b>.</p>
<ul><li>Ambrosia burger</li><li>Tide&#x2019;s soup</li></ul><p>See <a href="/menu">the menu</a> or <a href="https://x.test/map">map</a>.</p></main>
<footer>© 2026</footer></body></html>`;
  const r = htmlToText(html, 'https://www.nepenthe.com/');
  assert.equal(r.title, 'Nepenthe & Café');
  assert.equal(r.text, 'Dinner\n\nOpen daily till 10 pm.\n\n- Ambrosia burger\n- Tide’s soup\n\nSee the menu (https://www.nepenthe.com/menu) or map (https://x.test/map).');
});

test('a page without main or article keeps its body', () => {
  assert.equal(htmlToText('<body><div>One</div><div>Two</div></body>').text, 'One\n\nTwo');
});

test('a hostile or huge page is read in linear time: unclosed links, scripts and comments, many tags', () => {
  const started = cpuMs();
  const nasty = [
    '<a href="x">'.repeat(100_000),
    '<script>'.repeat(50_000),
    '<!--'.repeat(50_000),
    `<a${' x'.repeat(200_000)}`,
    `<title>${'<'.repeat(100_000)}`,
    `<main><p>Kept</p></main>${'<p>'.repeat(200_000)}`,
  ];
  for (const html of nasty) htmlToText(html, 'https://x.test/');
  assert.ok(cpuMs() - started < 1500, `took ${Math.round(cpuMs() - started)} ms of CPU`);
  assert.equal(htmlToText('<p>a</p><script>never closed <p>b</p>').text, 'a');
  assert.equal(htmlToText('<p>One</p><!-- never closed <p>Two</p>').text, 'One');
});
