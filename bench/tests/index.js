// Makes `node --test bench/tests` work: Node resolves a directory argument to this file,
// which loads every *.test.mjs next to it. `node --test bench/tests/*.test.mjs` works too.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  for (const name of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.mjs')).sort()) {
    await import(pathToFileURL(path.join(__dirname, name)).href);
  }
})();
