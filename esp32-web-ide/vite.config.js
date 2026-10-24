import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'));

function resolveCommit() {
  const envCommit = (process.env.ESP32_STUDIO_COMMIT || process.env.GITHUB_SHA || '').trim();
  if (/^[0-9a-f]{7,40}$/i.test(envCommit)) return envCommit.toLowerCase();
  try {
    const out = execSync('git rev-parse HEAD', { cwd: rootDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (/^[0-9a-f]{7,40}$/i.test(out)) return out.toLowerCase();
  } catch {}
  return 'dev';
}

const commit = resolveCommit();
const buildInfo = {
  version: pkg.version || '1.0.0',
  commit,
  shortCommit: commit !== 'dev' ? commit.slice(0, 7) : 'dev',
  builtAt: process.env.ESP32_STUDIO_BUILT_AT || new Date().toISOString(),
  releaseTag: 'esp32-studio-latest',
};

export default defineConfig({
  base: './',
  define: {
    __ESP32_STUDIO_BUILD__: JSON.stringify(buildInfo),
  },
  plugins: [
    {
      name: 'esp32-studio-build-info',
      closeBundle() {
        const outDir = resolve(rootDir, 'dist');
        mkdirSync(outDir, { recursive: true });
        writeFileSync(resolve(outDir, 'build-info.json'), JSON.stringify(buildInfo, null, 2));
      },
    },
  ],
  server: { host: '0.0.0.0', port: 5173, allowedHosts: true },
  preview: { host: '0.0.0.0', port: 5173, allowedHosts: true },
  build: { chunkSizeWarningLimit: 4000 },
});
