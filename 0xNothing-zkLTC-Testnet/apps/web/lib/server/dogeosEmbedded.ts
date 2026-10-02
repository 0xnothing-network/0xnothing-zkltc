import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type EmbeddedModule = {
  handleEmbedded: (request: Request) => Promise<Response>;
};

let modulePromise: Promise<EmbeddedModule> | undefined;

export async function dogeosEmbedded(request: Request): Promise<Response> {
  if (!modulePromise) {
    const entry = pathToFileURL(join(process.cwd(), '.dogeos', 'server', 'embedded.mjs')).href;
    modulePromise = import(/* webpackIgnore: true */ entry).catch((error: unknown) => {
      modulePromise = undefined;
      throw error;
    }) as Promise<EmbeddedModule>;
  }
  const embedded = await modulePromise;
  return embedded.handleEmbedded(request);
}
