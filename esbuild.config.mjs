// @ts-check
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: 'node',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  logLevel: 'silent',
  plugins: [
    {
      name: 'build-log',
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length > 0) {
            console.error('Extension build failed:', result.errors);
          } else {
            console.log('[esbuild] Extension build complete');
          }
        });
      },
    },
  ],
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(extensionConfig);
    await ctx.watch();
    console.log('[esbuild] Watching for changes...');
  } else {
    await esbuild.build(extensionConfig);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
