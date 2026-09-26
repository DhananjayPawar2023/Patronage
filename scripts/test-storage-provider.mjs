import { createStorageProvider, LocalStorageProvider, PinataStorageProvider } from '../src/providers/storage.mjs';

async function main() {
  console.log('Testing Storage Provider Abstraction (BLK-04)...');

  // Test 1: Factory initialization
  const provider = createStorageProvider();
  if (!provider) {
    throw new Error('createStorageProvider returned null/undefined');
  }
  console.log('✔ StorageProvider factory initialized successfully');

  // Test 2: Local storage put & metadata creation
  const localProvider = new LocalStorageProvider();
  const testBuffer = Buffer.from('test storage content', 'utf-8');
  const uploadResult = await localProvider.put(testBuffer, 'test_art.png', 'image/png');

  if (!uploadResult.publicUrl || !uploadResult.cid) {
    throw new Error('LocalStorageProvider put failed');
  }
  console.log('✔ LocalStorageProvider file upload verified:', uploadResult.publicUrl);

  const metaResult = await localProvider.createMetadata({
    title: 'Storage Test Artwork',
    description: 'Testing storage abstraction layer',
    imageUri: uploadResult.uri,
    imageUrl: uploadResult.publicUrl,
    artistName: 'Test Artist',
    artistHandle: 'testartist',
  });

  if (!metaResult.metadata || metaResult.metadata.name !== 'Storage Test Artwork') {
    throw new Error('LocalStorageProvider metadata creation failed');
  }
  console.log('✔ LocalStorageProvider metadata creation verified:', metaResult.publicUrl);

  // Test 3: Pinata fallback when JWT is absent
  const pinataProvider = new PinataStorageProvider(null);
  const fallbackResult = await pinataProvider.put(testBuffer, 'fallback_art.png', 'image/png');

  if (!fallbackResult.publicUrl) {
    throw new Error('PinataStorageProvider fallback failed');
  }
  console.log('✔ PinataStorageProvider graceful fallback to LocalStorageProvider verified!');

  console.log('\nBLK-04 Storage Provider Abstraction Test Passed Cleanly!');
}

main().catch((err) => {
  console.error('BLK-04 test failed:', err);
  process.exit(1);
});
