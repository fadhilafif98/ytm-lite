import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(rootDir, 'src');
const distDir = path.join(rootDir, 'dist');
const testsDir = path.join(rootDir, 'tests');
const tscBin = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');

function fail(msg) {
  console.error(`\n[QA FAIL] ${msg}`);
  process.exit(1);
}

function pass(msg) {
  console.log(`[QA OK] ${msg}`);
}

function walkFiles(dir, extFilter = null) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, extFilter));
    } else if (!extFilter || extFilter.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function readPngDimensions(filePath) {
  const buf = fs.readFileSync(filePath);
  const pngSig = '89504e470d0a1a0a';
  if (buf.length < 24 || buf.subarray(0, 8).toString('hex') !== pngSig) {
    fail(`Invalid PNG file: ${path.relative(rootDir, filePath)}`);
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20)
  };
}

// 1. Source hygiene check (no leftover global boot handoff in src/**/*.ts)
const tsFiles = walkFiles(srcDir, /\.ts$/);
for (const f of tsFiles) {
  const content = fs.readFileSync(f, 'utf8');
  if (/\b__ytmLiteBoot\b|\b__ytmLiteConst\b/.test(content)) {
    fail(`Legacy global boot handoff found in ESM source file: ${path.relative(rootDir, f)}`);
  }
}
pass(`ES module source check (${tsFiles.length} TS files clean)`);

// 2. Typecheck
execFileSync(process.execPath, [tscBin, '--noEmit', '-p', path.join(rootDir, 'tsconfig.json')], {
  cwd: rootDir,
  stdio: 'inherit'
});
pass('TypeScript typecheck');

// 3. Build dist/ and dist-firefox/
execFileSync(process.execPath, [path.join(rootDir, 'scripts', 'build.mjs')], {
  cwd: rootDir,
  stdio: 'inherit'
});
execFileSync(process.execPath, [path.join(rootDir, 'scripts', 'build.mjs'), '--target=firefox'], {
  cwd: rootDir,
  stdio: 'inherit'
});
const firefoxManifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'dist-firefox', 'manifest.json'), 'utf8'));
if (firefoxManifest.minimum_chrome_version !== undefined) {
  fail('dist-firefox/manifest.json must not include minimum_chrome_version');
}
if (!firefoxManifest.browser_specific_settings?.gecko?.id || !firefoxManifest.browser_specific_settings?.gecko?.strict_min_version) {
  fail('dist-firefox/manifest.json missing browser_specific_settings.gecko.id or strict_min_version');
}
pass('Build dist/ & dist-firefox/');

// 4. Manifest V3, version sync, minimal permissions, icons & asset refs
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const distManifest = JSON.parse(fs.readFileSync(path.join(distDir, 'manifest.json'), 'utf8'));

if (distManifest.manifest_version !== 3) {
  fail(`Expected manifest_version 3, got ${distManifest.manifest_version}`);
}
if (!/^\d+\.\d+\.\d+$/.test(distManifest.version)) {
  fail(`Invalid semver in manifest.json: ${distManifest.version}`);
}
if (distManifest.version !== pkg.version) {
  fail(`Version mismatch: public/manifest.json (${distManifest.version}) !== package.json (${pkg.version})`);
}
const allowedPermissions = new Set(['storage']);
for (const perm of distManifest.permissions || []) {
  if (!allowedPermissions.has(perm)) {
    fail(`Unexpected permission in manifest.json: ${perm}`);
  }
}
if ((distManifest.host_permissions || []).length > 0) {
  fail(`Unexpected host_permissions in manifest.json: ${JSON.stringify(distManifest.host_permissions)}`);
}
for (const cs of distManifest.content_scripts || []) {
  for (const m of cs.matches || []) {
    if (m !== 'https://music.youtube.com/*') {
      fail(`Unexpected content_script match pattern: ${m}`);
    }
  }
}

// Check icon files exist AND have exact pixel dimensions
for (const iconMap of [distManifest.icons || {}, distManifest.action?.default_icon || {}]) {
  for (const [sizeStr, relPath] of Object.entries(iconMap)) {
    const expected = Number(sizeStr);
    const full = path.join(distDir, relPath);
    if (!fs.existsSync(full)) {
      fail(`Missing icon referenced in manifest.json: ${relPath}`);
    }
    const { width, height } = readPngDimensions(full);
    if (width !== expected || height !== expected) {
      fail(`Icon ${relPath} is ${width}x${height}, expected ${expected}x${expected}`);
    }
  }
}

// Check all manifest-referenced files exist
const manifestFiles = [
  distManifest.action?.default_popup,
  ...Object.values(distManifest.icons || {}),
  ...Object.values(distManifest.action?.default_icon || {}),
  ...(distManifest.content_scripts || []).flatMap((cs) => [...(cs.js || []), ...(cs.css || [])])
].filter(Boolean);
for (const rel of manifestFiles) {
  if (!fs.existsSync(path.join(distDir, rel))) {
    fail(`Missing dist manifest asset: ${rel}`);
  }
}
pass(`Manifest V3, version v${distManifest.version}, permissions, and PNG icon dimensions OK (${manifestFiles.length} refs)`);

// 5. Popup HTML & Extension CSP / Security / Chrome 111+ CSS checks
if (distManifest.action?.default_popup) {
  const popupPath = path.join(distDir, distManifest.action.default_popup);
  const popupDir = path.dirname(popupPath);
  const html = fs.readFileSync(popupPath, 'utf8');

  // No inline <script> blocks
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  for (const [, attrs, body] of scriptTags) {
    if (!/\bsrc\s*=/i.test(attrs) || body.trim().length > 0) {
      fail('Inline <script> detected in popup.html (blocked by MV3 CSP)');
    }
  }
  // No inline event handlers (onclick=, onchange=, etc.)
  if (/\son[a-z]+\s*=/i.test(html)) {
    fail('Inline event handler (on*=) detected in popup.html (blocked by MV3 CSP)');
  }
  // Verify all local asset refs
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((x) => x[1])
    .filter((u) => !/^https?:\/\//i.test(u) && !u.startsWith('#'));
  for (const ref of refs) {
    if (!fs.existsSync(path.resolve(popupDir, ref))) {
      fail(`Missing popup asset in dist: ${ref}`);
    }
  }
  pass(`Popup HTML CSP & assets OK (${refs.length} refs)`);
}

// Check compiled JS for forbidden MV3 CSP patterns & syntax
const distJsFiles = walkFiles(distDir, /\.js$/);
for (const f of distJsFiles) {
  const code = fs.readFileSync(f, 'utf8');
  if (/\beval\s*\(|new\s+Function\s*\(|\binnerHTML\s*=/.test(code)) {
    fail(`Unsafe CSP/XSS pattern (eval/new Function/innerHTML) in ${path.relative(rootDir, f)}`);
  }
  execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
}
const testJsFiles = walkFiles(testsDir, /\.js$/);
for (const f of [...testJsFiles, path.join(rootDir, 'scripts', 'build.mjs'), path.join(rootDir, 'scripts', 'qa.mjs')]) {
  execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
}
pass(`JS syntax & CSP safety check (${distJsFiles.length} dist, ${testJsFiles.length} test files)`);

// Check CSS for Chrome >111-only features + Content CSS UX invariants
const distCssFiles = walkFiles(distDir, /\.css$/);
const unsupportedCssRe = /\blight-dark\s*\(|@starting-style\b|\bfield-sizing\s*:/i;
for (const f of distCssFiles) {
  const css = fs.readFileSync(f, 'utf8');
  const match = css.match(unsupportedCssRe);
  if (match) {
    fail(`Chrome >111 CSS feature "${match[0]}" found in ${path.relative(rootDir, f)}`);
  }
}
const contentCss = fs.readFileSync(path.join(distDir, 'styles', 'content.css'), 'utf8');
if (/ytmusic-player(?:\[video-mode\])?\[player-ui-state="PLAYER_PAGE_OPEN"\][^{]*\{[^}]*height:\s*100%/i.test(contentCss)) {
  fail('content.css must not use height: 100% on PLAYER_PAGE_OPEN (breaks 1:1 square aspect ratio in block layout)');
}
if (/ytmusic-player\[video-mode\]\[player-ui-state="PLAYER_PAGE_OPEN"\]/i.test(contentCss)) {
  fail('content.css PLAYER_PAGE_OPEN square lock must not depend on [video-mode] (otherwise #song-image stretches edge-to-edge when video-mode is stripped)');
}
if (!contentCss.includes('ytm-lite-swap-pending') || !contentCss.includes('googleusercontent.com')) {
  fail('content.css missing anti-blip ytm-lite-swap-pending rule for non-square MV thumbnails');
}
if (!contentCss.includes('[data-ytm-lite-hidden-stat="1"]')) {
  fail('content.css missing Polymer-safe [data-ytm-lite-hidden-stat="1"] rule for player-bar view/like stats');
}
if (/#song-video[^{]*\{[^}]*display:\s*none/i.test(contentCss)) {
  fail('content.css must never set display: none on #song-video (breaks <video> audio playback)');
}
if (!/PLAYER_PAGE_OPEN[^{]*\{[^}]*padding:\s*0\s*!important/i.test(contentCss)) {
  fail('content.css PLAYER_PAGE_OPEN square fallback must reset padding: 0 !important (prevents YTM padding-top: 100% from doubling #song-image height to 2x)');
}
pass(`Chrome 111+ CSS & UX layout invariants check (${distCssFiles.length} CSS files)`);

// 6. Run full unit & regression test suite
execFileSync(process.execPath, ['--test', ...testJsFiles], {
  cwd: rootDir,
  stdio: 'inherit'
});
pass('All unit & rapid-skip QA tests passed');
