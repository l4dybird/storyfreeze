const { version } = require('../packages/storyfreeze/package.json');
const hit = version.match(/-(.+)\.\d+$/);
console.log(hit ? 'next' : 'latest');
