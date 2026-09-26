import http from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from '../src/auth/siwe.mjs';

const API_BASE = 'http://127.0.0.1:8787';

function post(url, data, customHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = JSON.stringify(data);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...customHeaders,
      },
    }, (res) => {
      let resBody = '';
      res.on('data', (chunk) => { resBody += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(resBody) });
        } catch {
          resolve({ status: res.statusCode, raw: resBody });
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname }, (res) => {
      let resBody = '';
      res.on('data', (chunk) => { resBody += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(resBody) });
        } catch {
          resolve({ status: res.statusCode, raw: resBody });
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('Testing Upload Endpoint Security (HIGH-2)...');

  // 1. Test Path Traversal in Static Server
  const pathTraversalRes = await get(`${API_BASE}/uploads/..%2F..%2Fpackage.json`);
  if (pathTraversalRes.status !== 404) {
    throw new Error(`Path traversal vulnerability! Expected 404, got status ${pathTraversalRes.status}`);
  }
  console.log('Path traversal protection verified (returned HTTP 404 as expected)');

  // 2. Test Unauthenticated Upload Rejection
  const unauthRes = await post(`${API_BASE}/api/upload`, { title: 'Test' });
  if (unauthRes.status !== 401) {
    throw new Error(`Unauthenticated upload should return 401, got ${unauthRes.status}`);
  }
  console.log('Unauthenticated upload protection verified (returned HTTP 401)');

  // Authenticate via SIWE
  const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  const nonceRes = await get(`${API_BASE}/api/siwe/nonce`);
  const nonce = nonceRes.data?.nonce;
  const message = createSiweMessage({ address: account.address, chainId: 31337, nonce, uri: API_BASE });
  const signature = await account.signMessage({ message });
  const verifyRes = await post(`${API_BASE}/api/siwe/verify`, { address: account.address, message, signature, nonce });
  const sessionToken = verifyRes.data?.session?.token;
  if (!sessionToken) throw new Error('Failed to obtain SIWE session token');
  const authHeader = { Authorization: `Bearer ${sessionToken}` };

  // 3. Test Invalid MIME Type (Authenticated)
  const invalidMimeRes = await post(`${API_BASE}/api/upload`, {
    title: 'Malicious Upload Test',
    imageBase64: 'data:text/javascript;base64,YWxlcnQoMSk=', // JS payload
    filename: '../../hacked.js',
  }, authHeader);

  if (invalidMimeRes.status !== 400) {
    throw new Error(`Invalid MIME type protection failed! Expected HTTP 400, got ${invalidMimeRes.status}`);
  }
  console.log('Disallowed MIME type protection verified (returned HTTP 400 as expected)');

  // 4. Test Valid PNG Upload (Authenticated)
  const validPngBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const validRes = await post(`${API_BASE}/api/upload`, {
    title: 'Security verification artwork',
    description: 'First 1/1 artwork drop',
    imageBase64: validPngBase64,
    filename: '../../../artwork.png', // path traversal in filename should be sanitized to artwork.png
    artistName: 'Security verification artist',
    artistHandle: 'security-verification-artist',
  }, authHeader);

  if (validRes.status !== 201 || !validRes.data?.data?.imageUrl) {
    throw new Error(`Valid upload failed: ${JSON.stringify(validRes)}`);
  }
  console.log('Valid sanitized image upload successful:', validRes.data.data.imageUrl);

  console.log('HIGH-2 Security Verification Passed Cleanly!');
}

main().catch((err) => {
  console.error('HIGH-2 Upload security test failed:', err);
  process.exit(1);
});
