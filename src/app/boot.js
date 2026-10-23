// The start (localization design, section 3): the language and its words are set before the app is imported, so a message made at
// a module's top level is in the right language. What can't be had leaves English.
import { setWords, dir } from '../core/l10n.js';
import { SHIPPED } from '../core/l10n-list.js';

const html = document.documentElement;
let tag = 'en';
let region = '';
let own;
try { own = localStorage.getItem('annai.ui'); } catch { own = 'en'; /* blocked storage is English */ }
if (own && SHIPPED.includes(own)) tag = own;
else if (!own) {
  // The first of the phone's languages annai has, by language and script: zh-TW is Traditional, not Simplified.
  for (const wanted of navigator.languages ?? []) {
    try {
      const a = new Intl.Locale(wanted).maximize();
      const found = SHIPPED.find((s) => { const b = new Intl.Locale(s).maximize(); return b.language === a.language && b.script === a.script; });
      if (found) { tag = found; region = new Intl.Locale(wanted).region ?? ''; break; }
    } catch { /* not a language tag */ }
  }
}
const pseudo = ['localhost', '127.0.0.1'].includes(location.hostname) ? new URLSearchParams(location.search).get('l10n') : null;
if (pseudo === 'en-XA' || pseudo === 'ar-XB') {
  tag = pseudo;
  region = '';
  setWords(tag, null, (await import('../core/l10n-pseudo.js')).pseudoFor(tag));
} else if (tag !== 'en') {
  try {
    const got = await fetch(`/l10n/${tag}.json`);
    if (!got.ok) throw new Error(String(got.status));
    setWords(tag, await got.json());
  } catch {
    html.dataset.l10nFailed = tag; // main.js says so on a card; the screens are English
    tag = 'en';
    region = '';
  }
}
html.lang = region ? `${tag}-${region}` : tag;
html.dir = dir();
await import('./main.js');
