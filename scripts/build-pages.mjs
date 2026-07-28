#!/usr/bin/env node
// Wrap the artifact-format prototype (no doctype/html/head skeleton) into a
// standalone page for GitHub Pages. Run after editing prototype/planovac.html:
//   node scripts/build-pages.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let src = readFileSync(join(root, 'prototype/planovac.html'), 'utf8');
const m = src.match(/<title>(.*?)<\/title>\s*/);
const title = m ? m[1] : 'Plánovač večeří';
src = src.replace(/<title>.*?<\/title>\s*/, '');

mkdirSync(join(root, 'docs'), { recursive: true });
writeFileSync(join(root, 'docs/index.html'), `<!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
</head>
<body>
${src}
</body>
</html>
`);
console.log('docs/index.html built');
