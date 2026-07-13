// @ts-check
'use strict';

/**
 * Prepare a Windows build environment.
 *
 * Theia's application-manager spawns `webpack` (and `electron`) from specific
 * per-package `node_modules/.bin` directories rather than from PATH. Under
 * Yarn 4's node-modules linker those binaries are hoisted to the repository
 * root, so the nested `.bin/*.cmd` launchers Theia expects do not exist and the
 * build fails with "The system cannot find the path specified."
 *
 * This script creates the missing `.cmd` shims that point at the hoisted
 * binaries. It is idempotent and a no-op on non-Windows platforms, so it is safe
 * to run unconditionally (e.g. from a `prepare` script or by hand after
 * `yarn install`).
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

if (process.platform !== 'win32') {
  console.log('[prepare-windows-build] Not Windows - nothing to do.');
  process.exit(0);
}

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
    const shim = path.join(dir, `${name}.cmd`);
    if (fs.existsSync(shim)) {
      continue;
    }
    fs.writeFileSync(shim, `@ECHO off\r\nnode "${target}" %*\r\n`);
    console.log(`[prepare-windows-build] created ${shim}`);
    created++;
  }
}

console.log(
  created > 0
    ? `[prepare-windows-build] Done - created ${created} launcher shim(s).`
    : '[prepare-windows-build] Done - all launcher shims already present.'
);
