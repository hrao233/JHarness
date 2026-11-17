const path = require('node:path');
const { verifyManifest } = require('../../apps/desktop/electron/release-manifest.cjs');

const release = process.argv[2] ?? path.join(__dirname, '..', '..', 'release', 'win-unpacked');
verifyManifest(release).then(result => {
  console.log(JSON.stringify(result, null, 2));
}).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
