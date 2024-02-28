import { readFile, writeFile } from 'node:fs/promises';
import { minify } from "terser";

// read our CommonJS handler
const code = await readFile('./handlers/index.cjs', { encoding: 'utf8' });
console.log(`read in ${code.length} bytes from handler`);

// to minify in a non-mangling way
const result = await minify(code, {
  ecma: '2016',
  compress: {
    collapse_vars: false,
    dead_code: false,
    drop_console: false,
    keep_classnames: true,
    keep_fargs: true,
    keep_fnames: true,
    unused: false,
  },
  mangle: false,
  module: false,
  keep_classnames: true,
  keep_fnames: true,
  format: {
    beautify: true, // deprecated, may be removed in terser@6
  },
});
console.log(`minified from ${code.length} to ${result.code.length}`);

// read our input CF template (with some sort of placeholder for the inline ZipFile content)
const template = await readFile('./templates/main.yaml', { encoding: 'utf8' });
console.log(`read in ${template.length} bytes from input template`);

// indent multi-line minified code, as necessary
if (result.code.match('\n')) {
  const { groups: { indent } } = template.match(/\n[ \t]+ZipFile:[ \t]+[|]\n(?<indent>[ \t]+)__REPLACE_WITH_MINIFIED_HANDLER__/);
  result.code = result.code.replace(/(\n)/g, `$1${indent}`);
}

// minimal CF template cleanup
const replaced = template
  // first, remove any comment-only lines from yaml
  .replace(/(\n)(?:[ \t]*[#][^\n]*\n)+/g, '$1')
  // next, inject our minified code
  .replace('__REPLACE_WITH_MINIFIED_HANDLER__', result.code)
;
await writeFile('./main.yaml', replaced);
console.log(`wrote out ${replaced.length} bytes to output template`);
