// @ts-check
'use strict';

/**
 * Prepare build launcher shims (all platforms).
 *
 * Theia's application-manager spawns `webpack` (and `electron`) from specific
 * per-package `node_modules/.bin` directories rather than from PATH. Under
 * Yarn 4's node-modules linker those binaries are hoisted to the repository
 * root, so the nested launchers Theia expects do not exist and the build fails
 * with "webpack: not found" (POSIX) or "The system cannot find the path
 * specified" (Windows).
 *
 * This script creates the missing launcher shims pointing at the hoisted
 * binaries: `.cmd` shims on Windows, executable shell shims on Linux/macOS. It
 * is idempotent, so it is safe to run before every build.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';

/**
 * @param {string} request
 * @returns {string | null}
 */
function tryResolve(request) {
  try {
    return require.resolve(request, { paths: [repoRoot] });
  } catch {
    return null;
  }
}

const binaries = [
  { name: 'webpack', target: tryResolve('webpack/bin/webpack.js') },
  { name: 'electron', target: tryResolve('electron/cli.js') },
];

// Directories where Theia looks for the launchers.
const binDirs = [
  path.join(repoRoot, 'electron-app', 'node_modules', '.bin'),
  path.join(
    repoRoot,
    'node_modules',
    '@theia',
    'application-manager',
    'node_modules',
    '.bin'
  ),
];

let created = 0;
for (const dir of binDirs) {
  for (const { name, target } of binaries) {
    if (!target) {
      continue;
    }
    fs.mkdirSync(dir, { recursive: true });

    if (isWindows) {
      const shim = path.join(dir, `${name}.cmd`);
      if (fs.existsSync(shim)) {
        continue;
      }
      fs.writeFileSync(shim, `@ECHO off\r\nnode "${target}" %*\r\n`);
      created++;
      console.log(`[prepare-build-shims] created ${shim}`);
    } else {
      const shim = path.join(dir, name);
      if (fs.existsSync(shim)) {
        continue;
      }
      fs.writeFileSync(shim, `#!/bin/sh\nexec node "${target}" "$@"\n`);
      fs.chmodSync(shim, 0o755);
      created++;
      console.log(`[prepare-build-shims] created ${shim}`);
    }
  }
}

console.log(
  created > 0
    ? `[prepare-build-shims] Done - created ${created} launcher shim(s).`
    : '[prepare-build-shims] Done - all launcher shims already present.'
);
