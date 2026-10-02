import { readFile, writeFile, mkdir } from 'node:fs/promises';
await mkdir('src/generated', { recursive: true });
await mkdir('subgraph/abis', { recursive: true });
for (const name of ['DogeosPixel', 'PixelMarket']) {
  const artifact = JSON.parse(await readFile(`contracts/out/${name}.sol/${name}.json`, 'utf8'));
  await writeFile(`src/generated/${name}.json`, JSON.stringify(artifact.abi, null, 2));
  await writeFile(`subgraph/abis/${name}.json`, JSON.stringify(artifact.abi, null, 2));
}
console.log('Exported frontend + subgraph ABIs');
