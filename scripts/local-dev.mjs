import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import '../src/config/load-env.mjs';

console.log('====================================================');
console.log('  PATRONAGE LOCAL DEV TOOLCHAIN (MILESTONE 1)');
console.log('====================================================\n');

// 1. Environment Validation
function validateEnvironment() {
  console.log('=== [1/6] Validating Environment & Configuration ===');
  const requiredVars = ['DATABASE_URL', 'RPC_URL', 'API_PORT', 'PATRON_EDITION_MINT_PRICE_ETH', 'CHAIN_ID'];
  const missing = requiredVars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
    console.error('Please check your .env configuration file.');
    process.exit(1);
  }
  console.log('✔ Environment validation passed (RPC:', process.env.RPC_URL, '| Chain ID:', process.env.CHAIN_ID, ')');
}

validateEnvironment();

// 2. Contract Compilation
console.log('\n=== [2/6] Compiling Smart Contracts & Generating ABIs ===');
try {
  execFileSync(process.execPath, ['scripts/compile-contracts.mjs'], { stdio: 'inherit' });
} catch (err) {
  console.error('❌ Contract compilation failed.');
  process.exit(1);
}

// 3. Database Migration
console.log('\n=== [3/6] Syncing SQLite Database Schema ===');
try {
  execFileSync(process.execPath, ['scripts/init-db.mjs'], { stdio: 'inherit' });
  console.log('✔ Database schema synchronized successfully.');
} catch (err) {
  console.error('❌ Database synchronization failed:', err.message);
  process.exit(1);
}

// Function to check if local EVM chain on RPC port is live
function checkChainLive() {
  return new Promise((resolve) => {
    const url = new URL(process.env.RPC_URL || 'http://127.0.0.1:8545');
    const req = http.request(
      {
        host: url.hostname,
        port: url.port || 8545,
        path: url.pathname || '/',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        resolve(res.statusCode === 200 || res.statusCode === 400);
      }
    );
    req.on('error', () => resolve(false));
    req.write(JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }));
    req.end();
  });
}

// Check deterministic deployer account balance
async function verifyDeterministicAccount() {
  return new Promise((resolve) => {
    const url = new URL(process.env.RPC_URL || 'http://127.0.0.1:8545');
    const req = http.request(
      {
        host: url.hostname,
        port: url.port || 8545,
        path: url.pathname || '/',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.result && BigInt(data.result) > 0n) {
              console.log(`✔ Deterministic deployer account verified (Balance: ${BigInt(data.result) / 10n**18n} ETH)`);
              resolve(true);
            } else {
              resolve(false);
            }
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on('error', () => resolve(false));
    req.write(JSON.stringify({ jsonrpc: '2.0', method: 'eth_getBalance', params: ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', 'latest'], id: 1 }));
    req.end();
  });
}

let chainChild = null;

async function waitForChainAndDeploy() {
  console.log('\n=== [4/6] Checking Local Blockchain (Anvil on 8545) ===');
  if (!(await checkChainLive())) {
    console.log('Local blockchain is not running. Launching Anvil process...');
    chainChild = spawn(process.execPath, ['scripts/local-chain.mjs'], { stdio: 'inherit', windowsHide: true });
    chainChild.on('error', (error) => console.error(`[chain] ${error.message}`));
  }
  let retries = 0;
  while (retries < 60) {
    const live = await checkChainLive();
    if (live) {
      console.log('✔ Local blockchain is active!');
      await verifyDeterministicAccount();
      console.log('Deploying smart contracts & writing deployment manifest...');
      try {
        execFileSync(process.execPath, ['scripts/deploy.mjs', '--network', 'local'], { stdio: 'inherit' });
      } catch (err) {
        console.error('❌ Contract deployment failed:', err.message);
      }
      break;
    }
    console.log('Waiting for local chain on http://127.0.0.1:8545...');
    await new Promise((res) => setTimeout(res, 1000));
    retries++;
  }
}

async function verifyApiHealth() {
  const apiPort = process.env.API_PORT || 8787;
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${apiPort}/health`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function verifyIndexerHealth() {
  const apiPort = process.env.API_PORT || 8787;
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${apiPort}/api/health/indexer`, (res) => { resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function startStack() {
  await waitForChainAndDeploy();

  console.log('\n=== [5/6] Starting Local Stack Services (API, Indexer, Web UI) ===');
  const serviceChildren = [];
  const commands = [
    ['api', process.execPath, ['api/server.mjs']],
    ['indexer', process.execPath, ['services/indexer/vendored-adapter.mjs']],
    ['web', process.execPath, [path.resolve('node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '4173', '--strictPort']],
  ];

  let shuttingDown = false;
  const children = commands.map(([name, command, args]) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, shell: false });
    child.on('error', (error) => console.error(`[${name}] ${error.message}`));
    child.on('exit', (code, signal) => {
      if (code && !shuttingDown) console.error(`[${name}] exited unexpectedly with code ${code} (${signal || 'no signal'})`);
    });
    serviceChildren.push(child);
    return child;
  });

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down all local stack processes...');
    const allChildren = [...serviceChildren, chainChild].filter(Boolean);
    allChildren.forEach((child) => {
      try {
        if (process.platform === 'win32' && child.pid) execFileSync('taskkill', ['/pid', String(child.pid), '/t'], { stdio: 'ignore' });
        else child.kill('SIGTERM');
      } catch {}
    });
    setTimeout(() => process.exit(0), 750);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);

  console.log('\n=== [6/6] Verifying Stack Health ===');
  let apiHealthy = false;
  for (let i = 0; i < 15; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    if (await verifyApiHealth()) {
      apiHealthy = true;
      break;
    }
  }

  let webHealthy = false;
  for (let i = 0; i < 15; i++) {
    await new Promise((res) => setTimeout(res, 250));
    try {
      const res = await fetch('http://127.0.0.1:4173/');
      webHealthy = res.ok;
      if (webHealthy) break;
    } catch {}
  }

  let indexerHealthy = false;
  for (let i = 0; i < 30; i++) {
    if (await verifyIndexerHealth()) { indexerHealthy = true; break; }
    await new Promise((res) => setTimeout(res, 500));
  }

  if (apiHealthy && webHealthy && indexerHealthy) {
    console.log('====================================================');
    console.log('🚀 PATRONAGE LOCAL STACK READY!');
    console.log('   Web UI:     http://127.0.0.1:4173');
    console.log('   API Server: http://127.0.0.1:8787');
    console.log('   Anvil RPC:  http://127.0.0.1:8545');
    console.log('====================================================');
  } else {
    console.error(`❌ Stack health failed (api=${apiHealthy}, indexer=${indexerHealthy}, web=${webHealthy}).`);
    shutdown();
  }
}

startStack().catch(console.error);
