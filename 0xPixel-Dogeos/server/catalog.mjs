import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { publicClient, deployment, assertDogeosChain } from '../scripts/runtime.mjs';
import { createCatalogStore } from './catalog-store.mjs';

export const dep = await deployment();
export const nft = JSON.parse(await readFile(new URL('../src/generated/DogeosPixel.json', import.meta.url), 'utf8'));
export const market = JSON.parse(await readFile(new URL('../src/generated/PixelMarket.json', import.meta.url), 'utf8'));
await assertDogeosChain();
const store = await createCatalogStore({ dep, nft, market, client: publicClient, cacheFile: fileURLToPath(new URL('../.runtime/catalog.json', import.meta.url)) });
export const { sync, token, catalog, offerList, collectionPage, status, readNFT, readMarket } = store;
