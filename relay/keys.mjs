#!/usr/bin/env node
// Makes the relay's VAPID key pair (spec §11.6) and prints it as one line of JSON, for
//   node keys.mjs | npx wrangler@4 secret put VAPID_KEY
// so the private key goes straight to Cloudflare and is never written to a file (choice 8).
import { newVapidJwk, readVapidKey } from './src/vapid.js';

const jwk = await newVapidJwk();
process.stdout.write(jwk);
console.error(`VAPID public key (phones subscribe with it): ${(await readVapidKey(jwk)).publicKey}`);
