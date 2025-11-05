// Dev bootstrap: load TypeScript server code when running with `node index.js`.
// This file intentionally delegates to the TypeScript implementation during
// development by using the ts-node require hook. DO NOT use this file in
// production; compile to JS and run the compiled output instead.

// If NODE_ENV=production and a compiled bundle exists, require it from dist.
if (process.env.NODE_ENV === 'production') {
  // Attempt to load the compiled server entry. This file is expected to be
  // produced by `npm run build` (tsc) into `server/dist`.
  try {
    module.exports = require('./dist/signaling-server.js');
  } catch (err) {
    console.error('Failed to load compiled server from dist/. Have you run `npm run build`?');
    throw err;
  }
} else {
  // Development: use ts-node to run TypeScript files directly.
  try {
    // Register ts-node so we can require .ts files below.
    require('ts-node/register');
  } catch (err) {
    console.error('ts-node/register not available. Install devDependencies (ts-node) or run using `npm run dev` with ts-node.');
    throw err;
  }

  // Require the TypeScript signaling server. The module is expected to start
  // listening when required (current repo pattern), or export a factory.
  require('./signaling-server.ts');
}