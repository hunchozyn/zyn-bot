/**
 * Patches @distube/yt-dlp/dist/index.js after every npm install.
 *
 * Problem: the package's `json()` helper concatenates stdout AND stderr into
 * one string before calling JSON.parse(). yt-dlp prints deprecation warnings
 * (e.g. for the removed --no-call-home flag) to stderr, which corrupts the
 * JSON and throws "Unexpected token 'D', 'Deprecated...' is not valid JSON".
 *
 * Fix: keep stdout and stderr in separate buffers; only parse stdout.
 */

const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'node_modules', '@distube', 'yt-dlp', 'dist', 'index.js');

if (!fs.existsSync(target)) {
    console.error('[patch-ytdlp] target file not found — skipping:', target);
    process.exit(0);
}

let src = fs.readFileSync(target, 'utf8');

// --- Patch 1: separate stdout/stderr buffers ---
const badJsonBlock =
`  return new Promise((resolve, reject) => {
    let output = "";
    process2.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    process2.stderr?.on("data", (chunk) => {
      output += chunk;
    });
    process2.on("close", (code) => {
      if (code === 0) resolve(JSON.parse(output));
      else reject(new Error(output));
    });
    process2.on("error", reject);
  });`;

const fixedJsonBlock =
`  return new Promise((resolve, reject) => {
    let output = "";
    let errorOutput = "";
    process2.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    process2.stderr?.on("data", (chunk) => {
      errorOutput += chunk;
    });
    process2.on("close", (code) => {
      if (code === 0) resolve(JSON.parse(output));
      else reject(new Error(errorOutput || output));
    });
    process2.on("error", reject);
  });`;

// --- Patch 2: remove deprecated --no-call-home flag ---
const badFlag  = '      noCallHome: true,\n';
const fixedFlag = '';

let patched = false;

if (src.includes(badJsonBlock)) {
    src = src.replace(badJsonBlock, fixedJsonBlock);
    patched = true;
    console.log('[patch-ytdlp] Applied: stdout/stderr separation');
} else if (src.includes(fixedJsonBlock)) {
    console.log('[patch-ytdlp] Already applied: stdout/stderr separation');
} else {
    console.warn('[patch-ytdlp] WARNING: could not find json() block — package may have been updated. Review patch.');
}

if (src.includes(badFlag)) {
    src = src.replaceAll(badFlag, fixedFlag);
    patched = true;
    console.log('[patch-ytdlp] Applied: removed deprecated noCallHome flag');
} else {
    console.log('[patch-ytdlp] Already applied (or gone): noCallHome flag');
}

if (patched) {
    fs.writeFileSync(target, src, 'utf8');
    console.log('[patch-ytdlp] Done.');
}
