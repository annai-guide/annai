/**
 * Settings → About's credits (the user, 2026-10-18): each data source annai contacts, what it is used
 * for, the hosts it is reached at, and the attribution its licence or policy asks for. Plain data:
 * test/unit/credits.test.js checks that every host annai's code names is credited here, or says why
 * it isn't a source, so a new source can't ship without its credit.
 * @typedef {{ href: string, text: string }} Link  text: shown as the link where the credit says it, else after it
 * @typedef {{ name: string, hosts: string[], use: string, credit: string, links: Link[] }} Source
 */

const CC_BY_SA = { href: 'https://creativecommons.org/licenses/by-sa/4.0/', text: 'CC BY-SA 4.0' };

/** @type {Source[]} */
export const SOURCES = [
  {
    name: 'OpenStreetMap',
    hosts: ['overpass-api.de', 'overpass.private.coffee'],
    use: "Places nearby and along the plan, for Shiori's nearby tool and the offline pack, found through Overpass (overpass-api.de, or private.coffee's server when that one is busy).",
    credit: 'Map data © OpenStreetMap contributors, under the Open Database License.',
    links: [{ href: 'https://www.openstreetmap.org/copyright', text: 'OpenStreetMap contributors' }],
  },
  {
    name: 'Nominatim',
    hosts: ['nominatim.openstreetmap.org'],
    use: "Finds a place by name, and names the place at a point, for Shiori's geocode and reverse tools. annai asks it once a second at most, as its usage policy asks.",
    credit: "Data © OpenStreetMap contributors, used under Nominatim's usage policy.",
    links: [{ href: 'https://operations.osmfoundation.org/policies/nominatim/', text: 'usage policy' }],
  },
  {
    name: 'Wikipedia',
    hosts: ['en.wikipedia.org'],
    use: 'Articles about places nearby, and their summaries in the offline pack. Each article Shiori reads comes with its address.',
    credit: "Text by Wikipedia's contributors, under CC BY-SA 4.0.",
    links: [{ href: 'https://en.wikipedia.org/', text: 'Wikipedia' }, CC_BY_SA],
  },
  {
    name: 'Wikivoyage',
    hosts: ['en.wikivoyage.org'],
    use: "Travel guides, for Shiori's guide tool and the offline pack.",
    credit: "Text by Wikivoyage's contributors, under CC BY-SA 4.0.",
    links: [{ href: 'https://en.wikivoyage.org/', text: 'Wikivoyage' }, CC_BY_SA],
  },
  {
    name: 'Open-Meteo',
    hosts: ['api.open-meteo.com'],
    use: "Weather forecasts, for Shiori's weather tool. Sunrise, sunset and golden hour are worked out on the phone.",
    credit: 'Weather data by Open-Meteo.com, under CC BY 4.0.',
    links: [{ href: 'https://open-meteo.com/', text: 'Weather data by Open-Meteo.com' }, { href: 'https://creativecommons.org/licenses/by/4.0/', text: 'CC BY 4.0' }],
  },
  {
    name: 'Jina Reader and Jina Search',
    hosts: ['r.jina.ai', 's.jina.ai'],
    use: "Read pages that don't let web apps read them, and search the web, for Shiori's fetch and web_search tools, as Settings → Tools chooses.",
    credit: 'A service of Jina AI, at jina.ai.',
    links: [{ href: 'https://jina.ai/', text: 'jina.ai' }],
  },
];

/**
 * The fonts annai ships (assets/fonts/), each under the SIL Open Font License 1.1, whose text is
 * shipped beside them in OFL.txt. copyright: the font's line in OFL.txt, as written there.
 * @type {{ name: string, file: string, copyright: string }[]}
 */
export const FONTS = [
  { name: 'Zen Maru Gothic', file: 'zen-maru-gothic', copyright: 'Copyright 2021 The Zen Maru Gothic Project Authors' },
  { name: 'Zen Kaku Gothic New', file: 'zen-kaku-gothic-new', copyright: 'Copyright 2022 The Zen Kaku Gothic Project Authors' },
  { name: 'IBM Plex Mono', file: 'ibm-plex-mono', copyright: 'Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"' },
];

/** Shiori's art (assets/shiori.svg, the app icons). */
export const ART = "Shiori's art: drawn for annai.";
