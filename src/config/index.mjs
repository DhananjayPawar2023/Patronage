export const config = {
  chainId: Number(process.env.CHAIN_ID || 31337),
  rpcUrl: process.env.RPC_URL || 'http://127.0.0.1:8545',
  apiPort: Number(process.env.API_PORT || 8787),
  apiBaseUrl: process.env.VITE_API_BASE_URL || 'http://127.0.0.1:8787',
  uploadDir: process.env.LOCAL_UPLOAD_DIR || './uploads',
  databaseUrl: process.env.DATABASE_URL || 'file:./dev.db',
  maxUploadSizeBytes: 10 * 1024 * 1024, // 10MB limit
  supportedMimeTypes: [
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/gif',
    'image/svg+xml',
  ],
};
