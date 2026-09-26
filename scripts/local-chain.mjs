import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import '../src/config/load-env.mjs';

const port = Number(process.env.ANVIL_PORT || 8545);
const chainId = Number(process.env.CHAIN_ID || 31337);
const projectWindowsPath = path.resolve('tools', 'foundry', 'anvil.exe');
const knownWindowsPath = path.join(
  process.env.LOCALAPPDATA || '',
  'Microsoft',
  'WinGet',
  'Packages',
  'eddacraft.anvil_Microsoft.Winget.Source_8wekyb3d8bbwe',
  'anvil.exe',
);
const command = process.env.ANVIL_BIN || (process.platform === 'win32' && fs.existsSync(projectWindowsPath) ? projectWindowsPath : (fs.existsSync(knownWindowsPath) ? knownWindowsPath : 'anvil'));
const args = ['--host', '127.0.0.1', '--port', port.toString(), '--chain-id', chainId.toString(), '--block-time', '1'];

console.log(`Starting Anvil on http://127.0.0.1:${port} (Chain ID: ${chainId})...`);
const anvilChild = spawn(command, args, { stdio: 'inherit', windowsHide: true });

anvilChild.on('error', (error) => {
  console.error(`Unable to start Anvil from ${command}: ${error.message}`);
  console.error('Install Foundry Anvil or set ANVIL_BIN to the executable path.');
  process.exit(1);
});

anvilChild.on('exit', (code, signal) => {
  if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') process.exit(code || 1);
});
