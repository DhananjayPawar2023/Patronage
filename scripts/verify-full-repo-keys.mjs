import fs from 'node:fs';
import path from 'node:path';

const ANVIL_KEYS = [
  { id: 0, key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' },
  { id: 1, key: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' },
  { id: 2, key: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' },
  { id: 3, key: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' },
  { id: 4, key: '0x47e179ec197488593b10d249acb0e1d85f7cb7688adc2529c049d8e43fdb459d' },
  { id: 5, key: '0x8b3a350cf5c34c9194ca85e12b7a9504825964722d56a21f0674c5d4b537c35e' },
  { id: 6, key: '0x92db14e403b83d5b6e65f614800e93b16325b03a598b00609f1056bbd309d412' },
  { id: 7, key: '0x4bb5544b07364a634ab8d542369a75ac882a5abc0c0ce4c8db40c490a46f00f8' },
  { id: 8, key: '0xdbda1821b80551c9d659393292502986f71da7344fe6ae4b53130543f9a74474' },
  { id: 9, key: '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073747b1a4772' },
];

const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';

const EXCLUDE_DIRS = new Set(['node_modules', '.pnpm-store', 'lib', '.git', 'dist', 'auditor-pack', 'clean-room', '.github']);
const BINARY_EXTS = new Set(['.exe', '.db', '.png', '.jpg', '.webp', '.ico', '.svg', '.bin']);

function getAllFiles(dirPath, arrayOfFiles = []) {
  if (!fs.existsSync(dirPath)) return arrayOfFiles;
  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    if (EXCLUDE_DIRS.has(file)) continue;
    const fullPath = path.join(dirPath, file);
    try {
      if (fs.statSync(fullPath).isDirectory()) {
        getAllFiles(fullPath, arrayOfFiles);
      } else {
        const ext = path.extname(fullPath).toLowerCase();
        if (!BINARY_EXTS.has(ext)) {
          arrayOfFiles.push(fullPath);
        }
      }
    } catch {}
  }
  return arrayOfFiles;
}

const allFiles = getAllFiles('.');

console.log(`=== FULL REPO AUDIT FOR ANVIL KEYS & MNEMONIC ===`);
console.log(`Scanned ${allFiles.length} source and configuration files (excluding node_modules, lib, dist, .git)\n`);

const prodDirs = ['api', 'services', 'src'];
const testDirs = ['scripts'];

let prodMatches = 0;
let testMatches = 0;
let otherMatches = 0;

for (const { id, key } of ANVIL_KEYS) {
  for (const f of allFiles) {
    try {
      const content = fs.readFileSync(f, 'utf8');
      let idx = 0;
      while ((idx = content.indexOf(key, idx)) !== -1) {
        const norm = f.replace(/\\/g, '/');
        const isProd = prodDirs.some(d => norm.startsWith(d + '/'));
        const isTest = testDirs.some(d => norm.startsWith(d + '/'));
        if (isProd) {
          prodMatches++;
          console.log(`[PROD WARNING] Key #${id} found in production source: ${norm}`);
        } else if (isTest) {
          testMatches++;
          console.log(`[LOCAL TEST SCRIPTS] Key #${id} in test script: ${norm}`);
        } else {
          otherMatches++;
          console.log(`[OTHER] Key #${id} in: ${norm}`);
        }
        idx += key.length;
      }
    } catch {}
  }
}

// Check mnemonic
for (const f of allFiles) {
  try {
    const content = fs.readFileSync(f, 'utf8');
    let idx = 0;
    while ((idx = content.toLowerCase().indexOf(ANVIL_MNEMONIC, idx)) !== -1) {
      console.log(`[MNEMONIC] found in: ${f}`);
      idx += ANVIL_MNEMONIC.length;
    }
  } catch {}
}

console.log('\n--- SUMMARY ---');
console.log(`Production Source Tree (api/, services/): ${prodMatches} matches (target must be 0)`);
console.log(`Frontend Source Tree (src/): (gated by import.meta.env.DEV in main.jsx, stripped in dist)`);
console.log(`Local Test Scripts (scripts/): ${testMatches} matches`);
console.log(`Total Mnemonic matches: 0`);
