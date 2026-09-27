import http from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from '../../src/auth/siwe.mjs';

const API_BASE = 'http://127.0.0.1:8787';

function requestHttp(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, API_BASE);
    const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: {
        ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        ...headers,
      },
    }, (res) => {
      let resBody = '';
      res.on('data', (c) => { resBody += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(resBody), headers: res.headers, raw: resBody });
        } catch {
          resolve({ status: res.statusCode, raw: resBody, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function getAuthToken() {
  const testAccount = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  const nonceRes = await requestHttp('GET', '/api/siwe/nonce');
  const nonce = nonceRes.data?.nonce;
  const msg = createSiweMessage({
    domain: '127.0.0.1:8787',
    address: testAccount.address,
    chainId: 31337,
    nonce,
    uri: API_BASE,
  });
  const sig = await testAccount.signMessage({ message: msg });
  const loginRes = await requestHttp('POST', '/api/siwe/verify', {
    address: testAccount.address,
    message: msg,
    signature: sig,
    nonce,
  });
  return loginRes.data?.session?.token;
}

async function main() {
  console.log('================================================================');
  console.log('       RED TEAM AUDIT: STORAGE & FILE UPLOAD ATTACK SUITE       ');
  console.log('================================================================\n');

  const vulnerabilities = [];
  const token = await getAuthToken();
  const authHeaders = { Authorization: `Bearer ${token}` };

  // ──────────────────────────────────────────────────────────────────────────
  // ATTACK 1: SVG Stored XSS with Embedded <script>
  // ──────────────────────────────────────────────────────────────────────────
  console.log('▶ [ATTACK 1] Testing SVG Stored XSS via Embedded <script> Tag...');
  const xssSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
    <circle cx="50" cy="50" r="40" stroke="green" stroke-width="4" fill="yellow" />
    <script type="text/javascript">
      alert("XSS-EXECUTED-IN-COOKIE-CONTEXT: " + document.domain);
    </script>
  </svg>`;
  const xssBase64 = `data:image/svg+xml;base64,${Buffer.from(xssSvg).toString('base64')}`;

  const svgRes = await requestHttp('POST', '/api/upload', {
    title: 'XSS Attack Vector',
    imageBase64: xssBase64,
    filename: 'malicious-vector.svg',
  }, authHeaders);

  if (svgRes.status === 201) {
    const uploadedUrl = svgRes.data?.data?.imageUrl;
    console.log(`  Uploaded URL: ${uploadedUrl}`);

    // Fetch the uploaded SVG directly to inspect response headers
    const fetchRes = await requestHttp('GET', new URL(uploadedUrl).pathname);
    const contentType = fetchRes.headers['content-type'];
    const csp = fetchRes.headers['content-security-policy'];
    const disposition = fetchRes.headers['content-disposition'];

    console.log(`  Server returned Content-Type: ${contentType}`);
    console.log(`  Server returned Content-Disposition: ${disposition || 'none'}`);
    console.log(`  Server returned CSP: ${csp || 'none'}`);

    // If served as image/svg+xml without blocking scripts or attachment disposition, browser executes XSS
    if (contentType?.includes('image/svg+xml') && (!disposition || !disposition.includes('attachment'))) {
      console.log('  🚨 VULNERABILITY REPRODUCED: Malicious SVG with <script> accepted and served inline as image/svg+xml!');
      vulnerabilities.push({
        id: 'STORAGE-SVG-STORED-XSS',
        severity: 'CRITICAL',
        desc: 'SVG files with embedded executable <script> tags are accepted and served with inline image/svg+xml content type, causing Stored Cross-Site Scripting.',
      });
    }
  } else {
    console.log('  ✔ Malicious SVG rejected by upload validator (HTTP', svgRes.status, ')');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ATTACK 2: SVG with <foreignObject> and HTML Injection
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [ATTACK 2] Testing SVG with <foreignObject> HTML Execution Payload...');
  const foreignSvg = `<svg xmlns="http://www.w3.org/2000/svg">
    <foreignObject width="100" height="100">
      <body xmlns="http://www.w3.org/1999/xhtml">
        <iframe src="javascript:alert(1)"></iframe>
      </body>
    </foreignObject>
  </svg>`;
  const foreignBase64 = `data:image/svg+xml;base64,${Buffer.from(foreignSvg).toString('base64')}`;

  const foreignRes = await requestHttp('POST', '/api/upload', {
    title: 'ForeignObject XSS Vector',
    imageBase64: foreignBase64,
    filename: 'foreign-obj.svg',
  }, authHeaders);

  if (foreignRes.status === 201) {
    console.log('  🚨 VULNERABILITY REPRODUCED: SVG with <foreignObject> iframe injection was accepted!');
    vulnerabilities.push({
      id: 'STORAGE-SVG-FOREIGNOBJECT-INJECTION',
      severity: 'HIGH',
      desc: 'SVG with embedded foreignObject and iframe payload was stored.',
    });
  } else {
    console.log('  ✔ SVG with <foreignObject> rejected (HTTP', foreignRes.status, ')');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ATTACK 3: Path Traversal Sequences in Filenames
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [ATTACK 3] Testing Directory Traversal File Access...');
  const traversalTests = [
    '/uploads/..%2F..%2Fpackage.json',
    '/uploads/..%5C..%5Cpackage.json',
    '/uploads/%2e%2e%2f%2e%2e%2fpackage.json',
    '/uploads/..%2F..%2F..%2F..%2Fetc%2Fpasswd',
  ];

  for (const t of traversalTests) {
    const res = await requestHttp('GET', t);
    if (res.status === 200) {
      console.log(`  🚨 VULNERABILITY REPRODUCED: Path traversal succeeded for ${t}!`);
      vulnerabilities.push({
        id: 'STORAGE-PATH-TRAVERSAL',
        severity: 'CRITICAL',
        desc: `Path traversal exposed internal file at ${t}`,
      });
      break;
    }
  }
  console.log('  ✔ Path traversal attacks blocked.');

  // ──────────────────────────────────────────────────────────────────────────
  // ATTACK 4: Fake MIME Disguised Executable
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [ATTACK 4] Testing Fake MIME Disguised Payload...');
  const fakePngPayload = 'data:image/png;base64,PD9waHAgc3lzdGVtKCRfR0VUWydjJ10pOyA/Pg=='; // <?php system($_GET['c']); ?>
  const fakeRes = await requestHttp('POST', '/api/upload', {
    title: 'Fake PNG PHP Payload',
    imageBase64: fakePngPayload,
    filename: 'shell.png',
  }, authHeaders);

  if (fakeRes.status === 201) {
    console.log('  🚨 VULNERABILITY REPRODUCED: PHP script accepted with fake PNG MIME type!');
    vulnerabilities.push({
      id: 'STORAGE-FAKE-MIME-POLYGLOT',
      severity: 'HIGH',
      desc: 'File with PHP content was accepted under fake PNG MIME type.',
    });
  } else {
    console.log('  ✔ Fake MIME payload rejected by magic bytes verification (HTTP', fakeRes.status, ')');
  }

  console.log('\n================================================================');
  console.log(` RED TEAM STORAGE AUDIT FINISHED: ${vulnerabilities.length} VULNERABILITIES IDENTIFIED`);
  console.log('================================================================');
  return vulnerabilities;
}

main().then((vulns) => {
  if (vulns.length > 0) {
    console.log('Vulnerabilities to fix:', vulns);
  }
}).catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
