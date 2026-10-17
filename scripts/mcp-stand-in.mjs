#!/usr/bin/env node
// The stand-in MCP server for milestone 8's device check (docs/testing/device-checklist-m8.md):
// annai's own test server, never an outside service. It can also serve the test packages, so the
// phones can install a skill and a plugin from an address.
//   node scripts/mcp-stand-in.mjs --port <port> [--host 127.0.0.1] [--token <token>] [--files test/fixtures/extensions] [--sse]
import { startMcpServer } from '../test/fakes/mcp.js';

/** annai's own ports, and the ones annai.guide is served from while testing: never these. */
const TAKEN = [8765, 8790, 8791, 8792, 8796, 8797, 18010, 18011, 18012, 18013, 18014];
const arg = (/** @type {string} */ name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const port = Number(arg('--port') ?? NaN);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('Give a port: node scripts/mcp-stand-in.mjs --port <port> [--token <token>] [--files <folder>]');
  process.exit(2);
}
if (TAKEN.includes(port)) {
  console.error(`Port ${port} is annai's own (or annai.guide's while testing). Pick another one.`);
  process.exit(2);
}
const s = await startMcpServer({ port, host: arg('--host') ?? '127.0.0.1', token: arg('--token'), files: arg('--files'), sse: process.argv.includes('--sse') });
console.log(`MCP stand-in: ${s.url}`);
if (arg('--files')) console.log(`Files: ${s.origin}/files/`);
