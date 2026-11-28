import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(rootDir, 'src');
const publicDir = path.join(rootDir, 'public');
const distDir = path.join(rootDir, 'dist');

const args = new Set(process.argv.slice(2));
const watchMode = args.has('--watch');
const zipMode = args.has('--zip');

/** @type {esbuild.BuildOptions} */
const esbuildOptions = {
  entryPoints: {
    'content/inject': path.join(srcDir, 'content', 'inject.ts'),
    'content/content': path.join(srcDir, 'content', 'content.ts'),
    'popup/popup': path.join(srcDir, 'popup', 'popup.ts'),
    'popup/theme-init': path.join(srcDir, 'popup', 'theme-init.ts')
  },
  outdir: distDir,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome111',
  charset: 'utf8',
  legalComments: 'none',
  logLevel: 'warning'
};

function copyStaticAssets() {
  fs.cpSync(publicDir, distDir, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      return name !== '.DS_Store' && name !== 'Thumbs.db' && !name.endsWith('.map');
    }
  });

  const licensePath = path.join(rootDir, 'LICENSE');
  if (fs.existsSync(licensePath)) {
    fs.copyFileSync(licensePath, path.join(distDir, 'LICENSE'));
  }
}

async function build() {
  fs.rmSync(distDir, { recursive: true, force: true });
  await esbuild.build(esbuildOptions);
  copyStaticAssets();
}

function packageZip() {
  const manifest = JSON.parse(fs.readFileSync(path.join(distDir, 'manifest.json'), 'utf8'));
  const zipName = `ytm-lite-v${manifest.version}.zip`;
  const zipPath = path.join(rootDir, zipName);
  const stageRoot = fs.mkdtempSync(path.join(rootDir, '.zip-stage-'));
  const stageDir = path.join(stageRoot, 'ytm-lite');

  try {
    fs.rmSync(zipPath, { force: true });
    fs.cpSync(distDir, stageDir, { recursive: true });
    execFileSync('zip', ['-r', zipPath, 'ytm-lite'], {
      cwd: stageRoot,
      stdio: 'inherit'
    });
    console.log(`Created ${zipName}`);
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

if (watchMode) {
  fs.rmSync(distDir, { recursive: true, force: true });
  copyStaticAssets();

  const ctx = await esbuild.context({
    ...esbuildOptions,
    plugins: [
      {
        name: 'ytm-lite-watch-log',
        setup(buildApi) {
          let start = 0;
          buildApi.onStart(() => {
            start = Date.now();
          });
          buildApi.onEnd((result) => {
            if (result.errors.length === 0) {
              console.log(`[watch] Bundled dist/ in ${Date.now() - start}ms`);
            }
          });
        }
      }
    ]
  });

  await ctx.watch();

  let copyTimer = null;
  fs.watch(publicDir, { recursive: true }, (_eventType, filename) => {
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copyTimer = null;
      copyStaticAssets();
      console.log(`[watch] Synced public/${filename ? String(filename) : ''}`);
    }, 100);
  });

  console.log('[watch] Watching src/ (esbuild) and public/ for changes...');
} else {
  await build();
  if (zipMode) {
    packageZip();
  }
}
