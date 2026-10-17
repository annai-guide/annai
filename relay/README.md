# annai's push relay

Reminders reach a closed annai as notifications through this relay (spec §11.6). annai encrypts
each reminder on the phone (RFC 8291) and pads it to one size; the relay keeps it until its time,
sends it to the phone's push service (Apple's, Google's, Mozilla's or Microsoft's) signed with its
VAPID key (RFC 8292), and deletes it. It learns only the phone's push endpoint, when each reminder
is due, and how many there are. It keeps no logs.

It is a Cloudflare Worker with one Durable Object per push subscription: the object keeps that
phone's reminders and wakes with its alarm at the next one's time. It has no dependencies.

- `GET /v1/vapid`: the relay's public key, which phones subscribe with.
- `POST /v1/schedule`: a reminder, `Authorization: Bearer <cancel token>` and JSON `{ endpoint, key, sendAt, ttl?, urgency?, payload, id? }`. Answers `201 { id, sendAt }`. A reminder due now is sent in the same request: `201 { id, sendAt, sent: true }`, or 410 when the phone's subscription no longer exists.
- `DELETE /v1/schedule/:id`, with the same `Authorization`. Answers 204.

Limits:
- an encrypted reminder: up to 4 KB;
- 200 waiting per phone, up to 30 days ahead;
- until a phone has had one notification through the relay, it may keep only 3 reminders, due within
  10 minutes (annai sends a "notifications are on" one first). So an endpoint someone made up costs at
  most three small reminders, and only until its push service refuses it at the first send;
- 300 requests a minute from one address;
- a request body of 8 KB, read no further.

Errors are `{ error, message }`.

**The worst case.** From one address, made-up endpoints can hold at most about 3,000 reminders
(300 a minute for 10 minutes, about 10 MB), each deleted at its first send; an hour's worth if the
push services themselves are failing. A phone that really receives notifications holds at most 200
(about 800 KB) for up to 30 days, and the relay remembers that it received one for 60 days after the
last. On the Free plan, a flood from many addresses can use up the day's 100,000 Durable Object
requests: the relay then fails until the next day, and Cloudflare bills nothing.

## Deploy it to your Cloudflare account

You need a Cloudflare account (the Free plan is enough) and Node 22 or later. These steps run
wrangler, Cloudflare's tool, with `npx`; it isn't one of annai's dependencies.

1. **Sign in**, from this folder (`relay/`):

   ```bash
   cd relay
   npx wrangler@4 login
   ```

2. **The address.** `wrangler.toml` puts the relay at `push.annai.guide` as a custom domain. That
   works when annai.guide's DNS is on Cloudflare (the domain added to your account, whatever the
   registrar). If it isn't:
   - delete the `routes = …` line, and set `workers_dev = true`. The relay is then at
     `https://annai-push.<your-subdomain>.workers.dev` (wrangler prints it);
   - in annai, Settings → Notifications → Relay address, enter that address.

3. **Deploy.** The first deploy also creates the Durable Object class (the `v1` migration):

   ```bash
   npx wrangler@4 deploy
   ```

4. **The VAPID key.** Make a key pair and give it to Cloudflare as a secret in one step, so the
   private key is never written to a file:

   ```bash
   node keys.mjs | npx wrangler@4 secret put VAPID_KEY
   ```

   It prints the public key. Until this step, the relay answers 503 "has no VAPID key yet".

5. **Check it:**

   ```bash
   curl https://push.annai.guide/v1/vapid
   ```

   It answers `{"key":"B…"}`, the public key from step 4.

6. **annai's address.** `ORIGINS` in `wrangler.toml` is `https://annai.guide`. If you serve annai
   from somewhere else, put that address there (comma-separated for several) and deploy again.

### The rate limit

`wrangler.toml` declares Cloudflare's rate-limit binding (`[[ratelimits]]`, which needs Wrangler 4.36
or later). If your account can't have it, the relay still limits each address itself, counted in
each Worker instance rather than at each Cloudflare location: it never runs without a limit.

### Changing the key

Put a new one with step 4. Phones subscribed with the old key are told so the next time annai
sends them a reminder (409 "key"), and subscribe again by themselves. Nothing else is needed, so
there is no need to keep a copy of the key.

### Costs

On the Free plan, Durable Objects allow 100,000 requests a day. Each reminder costs about three
(sent, scheduled, and the alarm that sends it), and a cancelled one about three. One person's trips
use a few hundred a day at most.

### Self-hosting

Change `name`, the route and `ORIGINS`, and `VAPID_SUBJECT` to a URL or `mailto:` address of yours.
Apple refuses a subject that is neither, and has been seen refusing `mailto:` addresses at
`localhost`.

## A device test before deploying

`serve.mjs` runs the same code in Node, with the reminders in memory (a restart forgets them). Its
VAPID key is a file only you can read, by default `~/.config/annai-relay/vapid.json`, so phones stay
subscribed across restarts. Phones need it over https; on a tailnet, `tailscale serve` gives that:

```bash
node relay/serve.mjs --port 8796 --origin https://your-machine.your-tailnet.ts.net:8792
tailscale serve --bg --https=8797 http://127.0.0.1:8796
```

`--origin` is the address annai is served from (more than one `--origin` is fine). Then in annai on
the phone: Settings → Notifications → Relay address `https://your-machine.your-tailnet.ts.net:8797`,
Save, and turn notifications on. The machine must reach the internet: it sends to Apple's and
Google's push services. Ports 8765 and 8790–8792 are refused (annai's own).
