import '../src/config/load-env.mjs';

const base = process.env.VITE_API_BASE_URL || 'http://127.0.0.1:8787';
const check = async (label, response, expected) => {
  if (response.status !== expected) throw new Error(`${label}: expected ${expected}, got ${response.status}`);
  console.log(`✔ ${label}: HTTP ${response.status}`);
};

await check('unauthorized upload rejected', await fetch(`${base}/api/upload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), 401);
await check('admin endpoint rejected without session', await fetch(`${base}/api/admin/users`), 401);
await check('moderation endpoint rejected without session', await fetch(`${base}/api/moderation/review`), 401);
await check('settlement endpoint rejected without session', await fetch(`${base}/api/settlement/1`, { method: 'POST' }), 401);
const health = await fetch(`${base}/health`);
if (health.headers.get('x-content-type-options') !== 'nosniff' || health.headers.get('x-frame-options') !== 'DENY' || !health.headers.get('content-security-policy')) throw new Error('Security headers missing');
console.log('✔ security headers present');
const invalid = await fetch(`${base}/api/siwe/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
await check('invalid JSON rejected', invalid, 400);
console.log('API security acceptance test passed.');
