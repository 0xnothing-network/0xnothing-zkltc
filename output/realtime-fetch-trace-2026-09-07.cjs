// Local diagnostic preload: only method names, counts, status and timing.
const originalFetch = globalThis.fetch;
globalThis.fetch = async function(input, init) {
  const start = performance.now();
  let methods = [];
  try {
    const body = JSON.parse(init?.body ?? 'null');
    methods = (Array.isArray(body) ? body : [body]).map(row => row?.method ?? (row?.query ? 'graphql' : 'http'));
  } catch {}
  const summary = { methods: [...new Set(methods)], count: methods.length };
  try {
    const response = await originalFetch(input, init);
    console.error('[fetch-timing]', JSON.stringify({ ...summary, ms: Math.round(performance.now() - start), status: response.status }));
    return response;
  } catch (error) {
    console.error('[fetch-timing]', JSON.stringify({ ...summary, ms: Math.round(performance.now() - start), error: error.name }));
    throw error;
  }
};
