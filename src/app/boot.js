// The start (localization design, section 3): language and words are set before the app is imported, so words made at a module's
// top level are right. What can't be had leaves English.
import { setWords, dir, chooseTag, t } from '../core/l10n.js';
import { SHIPPED, EXPERIMENTAL } from '../core/l10n-list.js';

const html = document.documentElement;
let own;
try { own = localStorage.getItem('annai.ui'); } catch { own = 'en'; /* blocked storage is English */ }
// The device's choice, else the first of the phone's languages annai has (zh-TW is Traditional, not Simplified).
let { tag, region } = chooseTag(own, navigator.languages ?? [], [...SHIPPED, ...EXPERIMENTAL], SHIPPED);
const pseudo = ['localhost', '127.0.0.1'].includes(location.hostname) ? new URLSearchParams(location.search).get('l10n') : null;
if (pseudo === 'en-XA' || pseudo === 'ar-XB') {
  tag = pseudo;
  region = '';
  setWords(tag, null, (await import('../core/l10n-pseudo.js')).pseudoFor(tag));
} else if (tag !== 'en') {
  try {
    const got = await fetch(`/l10n/${tag}.json`);
    if (!got.ok) throw new Error(String(got.status));
    const words = await got.json();
    if (!words || typeof words !== 'object' || Array.isArray(words)) throw new Error('not a catalog');
    setWords(tag, words);
  } catch {
    html.dataset.l10nFailed = tag; // main.js says so on a card
    tag = 'en';
    region = '';
  }
}
html.lang = region ? `${tag}-${region}` : tag;
html.dir = dir();
// Shiori's mark while annai opens (index.html) says so in the screens' words.
document.querySelector('.booting')?.setAttribute('alt', t`Opening annai…`);
await import('./main.js');
