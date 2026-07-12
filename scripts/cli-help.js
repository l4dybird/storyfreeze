#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const mark = '```';

async function main() {
  const readmePath = path.join(__dirname, '../README.md');
  const readme = fs.readFileSync(readmePath, 'utf8');
  const [head, tmp] = readme.split('<!-- inject:clihelp -->');
  const [, tail] = tmp.split('<!-- endinject -->');
  const [{ generate }, { storyfreezeCommand, storyfreezeCliOptions }] = await Promise.all([
    import('gunshi/generator'),
    import('../packages/storyfreeze/dist/node/cli-command.js'),
  ]);
  const help = await generate(null, storyfreezeCommand, storyfreezeCliOptions);
  const out = `${head}<!-- inject:clihelp -->
${mark}txt
${help.trimEnd()}
${mark}
<!-- endinject -->${tail}`;

  fs.writeFileSync(readmePath, out, 'utf8');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
