import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Check if forge is in PATH (e.g. in GitHub Actions ubuntu-latest)
// Otherwise use local Windows binary tools/foundry/forge.exe
let forgeCmd = 'forge';
const localWinForge = path.resolve('tools/foundry/forge.exe');

try {
  const probe = spawnSync('forge', ['--version'], { stdio: 'ignore' });
  if (probe.status !== 0) {
    if (fs.existsSync(localWinForge)) {
      forgeCmd = localWinForge;
    }
  }
} catch {
  if (fs.existsSync(localWinForge)) {
    forgeCmd = localWinForge;
  }
}

const args = process.argv.slice(2);
const result = spawnSync(forgeCmd, args, { stdio: 'inherit', shell: true });
process.exit(result.status ?? 0);
