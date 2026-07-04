#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { Browser, detectBrowserPlatform, install } = require('@puppeteer/browsers');

const CHROME_VERSION = '131.0.6778.85';
const ROOT_DIR = path.resolve(__dirname, '..');
const VENDOR_DIR = path.join(ROOT_DIR, 'vendor', 'chrome');
const TARGET_PLATFORM = process.argv[2] || process.env.VIBE_VENDOR_PLATFORM || '';
const TARGET_BINARY_PLATFORM = TARGET_PLATFORM || detectBrowserPlatform();
const TARGET_CACHE_DIR_NAME = `${TARGET_BINARY_PLATFORM}-${CHROME_VERSION}`;
const BINARY_NAME = TARGET_BINARY_PLATFORM === 'win32' || TARGET_BINARY_PLATFORM === 'win64'
  ? 'chrome-headless-shell.exe'
  : 'chrome-headless-shell';

function findFirstFile(rootDir, fileName) {
  if (!rootDir || !fs.existsSync(rootDir)) return '';
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isFile() && entry.name === fileName) {
        return fullPath;
      }
      if (entry.isDirectory()) {
        stack.push(fullPath);
      }
    }
  }
  return '';
}

function pruneOtherPlatformDirs() {
  if (!TARGET_PLATFORM) return;
  const browserRoot = path.join(VENDOR_DIR, 'chrome-headless-shell');
  if (!fs.existsSync(browserRoot)) return;
  for (const entry of fs.readdirSync(browserRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === TARGET_CACHE_DIR_NAME) continue;
    fs.rmSync(path.join(browserRoot, entry.name), { recursive: true, force: true });
  }
}

fs.mkdirSync(VENDOR_DIR, { recursive: true });

const existing = findFirstFile(path.join(VENDOR_DIR, 'chrome-headless-shell', TARGET_CACHE_DIR_NAME), BINARY_NAME);
if (existing) {
  console.log(`Chrome Headless Shell already exists: ${existing}`);
  pruneOtherPlatformDirs();
  process.exit(0);
}

async function main() {
  const platform = TARGET_BINARY_PLATFORM;
  if (!platform) {
    throw new Error(`Unsupported platform: ${process.platform} ${process.arch}`);
  }

  console.log(`Downloading Chrome Headless Shell ${CHROME_VERSION}...`);
  await install({
    cacheDir: VENDOR_DIR,
    browser: Browser.CHROMEHEADLESSSHELL,
    buildId: CHROME_VERSION,
    platform
  });

  const binary = findFirstFile(VENDOR_DIR, BINARY_NAME);
  if (!binary) {
    throw new Error('Chrome Headless Shell download completed, but the executable was not found.');
  }

  try {
    fs.chmodSync(binary, 0o755);
  } catch {}

  console.log(`Chrome Headless Shell ready: ${binary}`);
  pruneOtherPlatformDirs();
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
