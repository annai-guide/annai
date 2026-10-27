import { h, crumb, t, plural, field } from '../dom.js';
import { platform } from '../platform.js';

/** @param {string} title @param {...any} children */
const section = (title, ...children) => h('section', { class: 'panel', 'aria-label': title }, h('h2', { class: 'section', text: title }), ...children);

/** Where to allow notifications, for this phone (spec §17 rule 3). @param {'ios' | 'android' | 'desktop'} where */
export function deniedHelp(where) {
  if (where === 'ios') return t`Notifications are turned off for annai on this iPhone. Turn them on in Settings → Notifications → annai, then come back here.`;
  if (where === 'android') return t`Notifications are blocked for annai. Touch and hold annai's icon, then App info → Notifications, and allow them; then come back here.`;
  return t`Notifications are blocked for this site. Allow them in the browser's site settings (the icon beside the address), then come back here.`;
}

/**
 * Which buttons the screen shows (spec §17 rule 3): on and well, off and a test; on but the phone took
 * notifications away, or they aren't allowed, Turn on notifications again (it asks, and subscribes
 * again) and off; off, turn on.
 * @param {{ on: boolean, supported: string, permission: string, problem: { needsYou: boolean } | null }} st
 * @returns {('on' | 'off' | 'test')[]}
 */
export function buttonsFor(st) {
  if (st.supported !== 'yes') return [];
  if (!st.on) return ['on'];
  if (st.problem?.needsYou || st.permission !== 'granted') return ['on', 'off'];
  return ['off', 'test'];
}

/** @param {{ on: boolean, waiting: number }} st */
const statusText = (st) => (st.on ? plural(st.waiting, 'On · # reminder waiting at the relay.', 'On · # reminders waiting at the relay.')
  : t`Off: reminders show only while annai is open, and none reaches you while it is closed.`);

/**
 * Settings → Notifications (spec §11.6, §11.7): reminders for a closed annai through the push relay,
 * with plain words on what the relay learns.
 * @param {any} ctx
 */
export async function renderNotifications(ctx) {
  const push = ctx.push;
  const st = await push.status();
  const where = platform();
  const status = h('p', { class: 'sub', role: 'status', text: statusText(st) });
  const alert = h('p', { class: 'error', role: 'alert', hidden: !st.problem, text: st.problem?.message ?? '' });
  /** @param {string} text */
  const fail = (text) => {
    alert.textContent = text;
    alert.hidden = false;
  };
  const address = h('input', { id: 'push-relay', type: 'url', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', value: st.relay });
  const save = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      save.disabled = true;
      try {
        await push.setRelay(address.value);
        ctx.notices.toast(t`Saved`);
        ctx.render();
      } catch (e) {
        fail(String(/** @type {any} */ (e)?.message ?? e));
      } finally {
        save.disabled = false;
      }
    },
  }, t`Save address`);
  /** @type {any[]} */
  const acts = [];
  /** @type {any} */
  let help = null;
  const show = buttonsFor(st);
  if (st.supported === 'install') {
    help = h('p', { text: t`On iPhone, notifications work only in the Home Screen app. In Safari, tap Share, then Add to Home Screen, and open annai from your Home Screen.` });
  } else if (st.supported === 'no') {
    help = h('p', { text: t`This browser can't show annai's notifications. On iPhone they need iOS 16.4 or later, in the Home Screen app.` });
  }
  if (show.includes('on')) {
    const on = h('button', {
      class: 'btn pri', type: 'button',
      onclick: () => {
        // First thing in the tap, before anything is awaited: iOS asks only during a user activation (6b choice 11).
        const asking = push.source.ask();
        on.disabled = true;
        alert.hidden = true;
        status.textContent = t`Asking…`;
        asking.then(async (/** @type {string} */ p) => {
          if (p !== 'granted') {
            status.textContent = statusText(st);
            fail(deniedHelp(where));
            on.disabled = false;
            return;
          }
          status.textContent = t`Turning them on…`;
          try {
            await push.turnOn(address.value);
            ctx.notices.toast(t`Notifications are on. A first one comes now.`);
            ctx.render();
          } catch (e) {
            status.textContent = statusText(st);
            fail(String(/** @type {any} */ (e)?.message ?? e));
            on.disabled = false;
          }
        }, () => {
          fail(deniedHelp(where));
          on.disabled = false;
        });
      },
    }, t`Turn on notifications`);
    acts.push(on);
    if (st.permission === 'denied') help = h('p', { class: 'sub', text: deniedHelp(where) });
  }
  if (show.includes('off')) {
    const off = h('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        off.disabled = true;
        try {
          await push.turnOff();
          ctx.notices.toast(t`Notifications are off.`);
          ctx.render();
        } catch (e) {
          fail(String(/** @type {any} */ (e)?.message ?? e));
          off.disabled = false;
        }
      },
    }, t`Turn off`);
    acts.push(off);
  }
  if (show.includes('test')) {
    const trial = h('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        trial.disabled = true;
        try {
          await push.test();
          ctx.notices.toast(t`A test notification comes in about 15 seconds. Lock the phone to see it arrive.`);
        } catch (e) {
          fail(String(/** @type {any} */ (e)?.message ?? e));
        } finally {
          trial.disabled = false;
        }
      },
    }, t`Send a test notification`);
    acts.push(trial);
  }
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, crumb('#/settings', t`Settings`)),
    h('h1', { class: 'title', text: t`Notifications` }),
    h('p', { class: 'sub', text: t`Shiori's reminders for a time, and the plan's "coming up" and "leave soon", reach you as notifications while annai is closed. Tapping one opens annai, and Shiori catches up.` }),
    status, alert, help,
    acts.length ? h('div', { class: 'acts' }, ...acts) : null,
    section(t`Relay`, field(t`Relay address`, address), h('div', { class: 'acts' }, save),
      h('p', { class: 'sub', text: t`Reminders go through annai's relay, ${/* en */ 'push.annai.guide'}, unless you run your own: its code is in annai's source, under ${/* en */ 'relay/'}.` })),
    section(t`What the relay learns`, h('ul', { class: 'where' },
      h('li', { text: t`annai encrypts every reminder on this phone, and makes each the same size: the relay can't read it, or tell a long one from a short one.` }),
      h('li', { text: t`It learns this phone's push address (at Apple, Google or Mozilla, whose service delivers it), when each reminder is due, and how many are waiting. Like any server, it sees the internet address the phone connects from.` }),
      h('li', { text: t`Reminders about places (arriving, leaving, nearby) never leave the phone. A "leave soon" reminder's time is worked out from where you were when annai last looked, so it tells roughly how far away you were to someone who also knew your plan; the relay doesn't.` }),
      h('li', { text: t`Each reminder is deleted at the relay once it is sent, or when you cancel it, turn notifications off, or remove its trip.` }),
      h('li', { text: t`With annai open on screen, annai says a reminder itself, and the relay's copy is called off: you never get it twice.` }))),
    h('p', { class: 'sub', text: t`Every request to the relay is in Trace, under System · This device.` }));
}
