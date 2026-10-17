import { utf8 } from '../../src/core/bytes.js';

/** A package's files from texts, by name. @param {Record<string, string>} o */
export const files = (o) => new Map(Object.entries(o).map(([k, v]) => [k, utf8(v)]));

/** A third party's skill, as its SKILL.md. */
export const SKILL = '---\nname: tide-pools\ndescription: Tide pools: when they are safe to visit.\nmetadata:\n  author: Example Trails\n  version: "1.2"\n---\n# Tide pools\nSee [safety](references/safety.md).\n';
