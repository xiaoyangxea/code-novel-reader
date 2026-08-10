import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const options = {
  entryPoints: {
    extension: 'src/extension.ts',
    core: 'src/core.ts'
  },
  bundle: true,
  outdir: 'dist',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  minify: production,
  sourcemap: true,
  logLevel: 'info'
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}
