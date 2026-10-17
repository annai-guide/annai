// The Worker's entry (wrangler.toml main): the relay on Cloudflare's own clock and fetch.
import { makeRelay } from './relay.js';

const relay = makeRelay();

/** The Durable Object class wrangler.toml binds as RELAY: one object per push subscription. */
export class PushRelay extends relay.PushRelay {}

export default relay.worker;
