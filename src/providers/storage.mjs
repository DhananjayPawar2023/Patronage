import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';

export class LocalStorageProvider {
  constructor(root = process.env.LOCAL_UPLOAD_DIR || './uploads', publicBaseUrl = process.env.VITE_API_BASE_URL || 'http://127.0.0.1:8787') {
    this.root = resolve(root);
    this.publicBaseUrl = publicBaseUrl;
  }

  async init() {
    await mkdir(this.root, { recursive: true });
  }

  async put(buffer, filename, contentType) {
    await this.init();
    const digest = createHash('sha256').update(buffer).digest('hex');
    const id = `${randomUUID()}-${digest.substring(0, 12)}`;
    const safeName = basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const storedFilename = `${id}-${safeName}`;
    const filePath = join(this.root, storedFilename);

    await writeFile(filePath, buffer, { flag: 'w' });

    const publicUrl = `${this.publicBaseUrl}/uploads/${storedFilename}`;
    const uri = `local://${storedFilename}`;

    return {
      uri,
      publicUrl,
      cid: `local-${digest.substring(0, 16)}`,
      filePath,
      filename: storedFilename,
      contentType,
    };
  }

  async createMetadata({ title, description, imageUri, imageUrl, artistName, artistHandle, attributes = [] }) {
    await this.init();
    const metadata = {
      name: title,
      description,
      image: imageUrl || imageUri,
      image_uri: imageUri,
      properties: {
        artist: {
          name: artistName,
          handle: artistHandle,
        },
      },
      attributes,
      created_at: new Date().toISOString(),
    };

    const buffer = Buffer.from(JSON.stringify(metadata, null, 2), 'utf-8');
    const result = await this.put(buffer, `${title.toLowerCase().replace(/[^a-z0-9]/g, '_')}_metadata.json`, 'application/json');

    return {
      ...result,
      metadata,
    };
  }

  async get(storedFilename) {
    const filePath = join(this.root, basename(storedFilename));
    return readFile(filePath);
  }
}

export class PinataStorageProvider {
  constructor(jwt = process.env.PINATA_JWT, gateway = process.env.IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs') {
    this.jwt = jwt;
    this.gateway = gateway;
    this.localFallback = new LocalStorageProvider();
  }

  async put(buffer, filename, contentType) {
    const isFailHard = process.env.NODE_ENV === 'production' || process.env.STORAGE_FAIL_HARD === 'true';
    if (!this.jwt) {
      if (isFailHard) {
        throw new Error('Pinata JWT is unconfigured. Cannot pin artwork to decentralized IPFS. Aborting to prevent silent centralization.');
      }
      return this.localFallback.put(buffer, filename, contentType);
    }
    try {
      const formData = new FormData();
      const blob = new Blob([buffer], { type: contentType });
      formData.append('file', blob, filename);

      const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.jwt}` },
        body: formData,
      });

      if (!res.ok) throw new Error(`Pinata upload failed with status ${res.status}`);
      const data = await res.json();
      const cid = data.IpfsHash;
      const uri = `ipfs://${cid}`;
      const publicUrl = `${this.gateway}/${cid}`;

      return { uri, publicUrl, cid, filename, contentType };
    } catch (err) {
      if (isFailHard) {
        throw new Error(`Decentralized IPFS pin failed: ${err.message}. Aborting to prevent silent centralization.`);
      }
      console.warn(`[storage] Pinata upload failed: ${err.message}. Falling back to local storage in development mode.`);
      return this.localFallback.put(buffer, filename, contentType);
    }
  }

  async createMetadata({ title, description, imageUri, imageUrl, artistName, artistHandle, attributes = [] }) {
    const metadata = {
      name: title,
      description,
      image: imageUrl || imageUri,
      image_uri: imageUri,
      properties: {
        artist: {
          name: artistName,
          handle: artistHandle,
        },
      },
      attributes,
      created_at: new Date().toISOString(),
    };

    const buffer = Buffer.from(JSON.stringify(metadata, null, 2), 'utf-8');
    const result = await this.put(buffer, `${title.toLowerCase().replace(/[^a-z0-9]/g, '_')}_metadata.json`, 'application/json');

    return {
      ...result,
      metadata,
    };
  }
}

export function createStorageProvider() {
  const isProd = process.env.NODE_ENV === 'production';
  const provider = (process.env.STORAGE_PROVIDER || '').toLowerCase();

  if (isProd && (!provider || provider === 'local')) {
    throw new Error('FATAL CONFIGURATION: Running in production mode with LocalStorageProvider is forbidden. You must configure a decentralized storage provider (e.g. STORAGE_PROVIDER=pinata).');
  }

  if (provider === 'pinata') {
    return new PinataStorageProvider();
  }
  return new LocalStorageProvider();
}
