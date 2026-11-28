import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(rootDir, 'src');
const publicDir = path.join(rootDir, 'public');

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const watchMode = args.has('--watch');
const zipMode = args.has('--zip');
const targetArg = rawArgs.find((a) => a.startsWith('--target='));
const target = targetArg ? targetArg.slice('--target='.length) : 'chrome';

if (target !== 'chrome' && target !== 'firefox') {
  console.error(`Unsupported --target="${target}". Expected "chrome" or "firefox".`);
  process.exit(1);
}

const isFirefox = target === 'firefox';
const distDir = path.join(rootDir, isFirefox ? 'dist-firefox' : 'dist');

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
  target: isFirefox ? 'firefox128' : 'chrome111',
  charset: 'utf8',
  legalComments: 'none',
  logLevel: 'warning'
};

function transformManifestForFirefox() {
  const manifestPath = path.join(distDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  delete manifest.minimum_chrome_version;
  manifest.browser_specific_settings = {
    gecko: {
      id: 'ytm-lite@fadhilafif98.github.io',
      strict_min_version: '128.0'
    }
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function copyStaticAssets() {
  fs.cpSync(publicDir, distDir, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      return name !== '.DS_Store' && name !== 'Thumbs.db' && !name.endsWith('.map');
    }
  });

  if (isFirefox) {
    transformManifestForFirefox();
  }

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
  const zipName = isFirefox
    ? `ytm-lite-firefox-v${manifest.version}.zip`
    : `ytm-lite-v${manifest.version}.zip`;
  const zipPath = path.join(rootDir, zipName);

  fs.rmSync(zipPath, { force: true });

  if (isFirefox) {
    // Firefox AMO and about:debugging require manifest.json at the zip root
    execFileSync('zip', ['-r', zipPath, '.'], {
      cwd: distDir,
      stdio: 'inherit'
    });
    console.log(`Created ${zipName}`);
    return;
  }

  const stageRoot = fs.mkdtempSync(path.join(rootDir, '.zip-stage-'));
  const stageDir = path.join(stageRoot, 'ytm-lite');

  try {
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
