// Loaded before every unit test (npm test's --import): the tests' phone speaks American English whatever LANG the machine has, so
// the formats they read (annai's Intl helpers follow navigator.language) are the same under LANG=de_DE. A test that wants another
// phone sets its own (format.test.js).
Object.defineProperty(globalThis.navigator, 'language', { value: 'en-US', configurable: true });
Object.defineProperty(globalThis.navigator, 'languages', { value: ['en-US', 'en'], configurable: true });
