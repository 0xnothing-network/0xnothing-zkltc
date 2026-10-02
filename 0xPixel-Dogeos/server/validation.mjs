import { isAddress } from 'viem';

export function invalid(message = 'Invalid request parameters.') {
  return Object.assign(new Error(message), { status: 400 });
}

export function tokenId(value, name = 'token ID') {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,77}$/.test(value) || BigInt(value) >= 2n ** 256n) throw invalid(`Invalid ${name}.`);
  return value;
}

export function queryParams(raw = {}, kind = 'catalog') {
  const allowed = kind === 'offers' ? ['tokenId', 'account', 'limit', 'offset', 'format'] : kind==='collections'?['owner','search','limit','offset']:['owner', 'collection', 'search', 'listed', 'sort', 'limit', 'offset'];
  for (const [name, value] of Object.entries(raw)) {
    if (!allowed.includes(name) || typeof value !== 'string') throw invalid();
  }
  const query = { ...raw };
  for (const name of ['owner', 'account']) if (query[name] && !isAddress(query[name], { strict: false })) throw invalid(`Invalid ${name} address.`);
  if (query.tokenId) tokenId(query.tokenId);
  if (query.collection && query.collection !== '0') tokenId(query.collection, 'collection ID');
  if (query.search && [...query.search].length > 100) throw invalid('Search is too long.');
  if (query.listed && !['true', 'false'].includes(query.listed)) throw invalid('Invalid listed filter.');
  if (query.sort && !['newest', 'price'].includes(query.sort)) throw invalid('Invalid sort order.');
  if(query.format&&query.format!=='page')throw invalid('Invalid response format.');
  for (const [name, fallback, maximum, minimum] of [['limit', kind==='offers'?48:24, 48, 1], ['offset', 0, 1000000, 0]]) {
    const value = query[name];
    if (value !== undefined && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum)) throw invalid(`Invalid ${name}.`);
    query[name] = value === undefined ? fallback : Number(value);
  }
  return query;
}

const rpcMethods = new Set(['eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_getBalance', 'eth_getCode', 'eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getLogs', 'eth_getTransactionCount', 'eth_gasPrice', 'eth_estimateGas', 'eth_feeHistory', 'eth_maxPriorityFeePerGas']);
const hex = value => typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);
const quantity = value => typeof value === 'string' && value.length<=66 && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value);
const block = value => ['latest', 'pending', 'safe', 'finalized', 'earliest'].includes(value) || quantity(value);
const hash = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const address = value => typeof value === 'string' && isAddress(value, { strict: false });
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

function transaction(value) {
  if (!plain(value)) return false;
  const fields = new Set(['from', 'to', 'data', 'input', 'gas', 'gasPrice', 'value', 'nonce', 'maxFeePerGas', 'maxPriorityFeePerGas', 'type', 'accessList', 'chainId']);
  if (Object.keys(value).some(key => !fields.has(key))) return false;
  if (value.from !== undefined && !address(value.from) || value.to !== undefined && !address(value.to)) return false;
  for (const field of ['data', 'input']) if (value[field] !== undefined && (!hex(value[field]) || value[field].length > 32770)) return false;
  for (const field of ['gas', 'gasPrice', 'value', 'nonce', 'maxFeePerGas', 'maxPriorityFeePerGas', 'type', 'chainId']) if (value[field] !== undefined && !quantity(value[field])) return false;
  if(value.chainId!==undefined&&BigInt(value.chainId)!==6281971n)return false;
  if (value.gas && BigInt(value.gas) > 10000000n) return false;
  if (value.accessList !== undefined && (!Array.isArray(value.accessList) || value.accessList.length > 64 || value.accessList.some(item => !plain(item) || !address(item.address) || !Array.isArray(item.storageKeys) || item.storageKeys.length > 64 || item.storageKeys.some(key => !hash(key))))) return false;
  return true;
}

function logFilter(value) {
  if (!plain(value) || Object.keys(value).some(key => !['address', 'fromBlock', 'toBlock', 'blockHash', 'topics'].includes(key))) return false;
  const addresses = Array.isArray(value.address) ? value.address : [value.address];
  if (!addresses.length || addresses.length > 10 || addresses.some(item => !address(item))) return false;
  if (value.blockHash !== undefined) {
    if (!hash(value.blockHash) || value.fromBlock !== undefined || value.toBlock !== undefined) return false;
  } else {
    if (!quantity(value.fromBlock) || !quantity(value.toBlock) || BigInt(value.toBlock) < BigInt(value.fromBlock) || BigInt(value.toBlock) - BigInt(value.fromBlock) > 1999n) return false;
  }
  if (value.topics !== undefined && (!Array.isArray(value.topics) || value.topics.length > 4 || value.topics.some(item => item !== null && (Array.isArray(item) ? !item.length || item.length > 20 || item.some(topic => !hash(topic)) : !hash(item))))) return false;
  return true;
}

export function rpcRequests(body) {
  const requests = Array.isArray(body) ? body : [body];
  if (!requests.length || requests.length > 30) throw invalid('Invalid RPC batch.');
  for (const request of requests) {
    if (!plain(request) || request.jsonrpc !== '2.0' || !rpcMethods.has(request.method) || !(request.id === null || typeof request.id === 'string' && request.id.length <= 128 || Number.isSafeInteger(request.id)) || request.params !== undefined && !Array.isArray(request.params)) throw invalid('Read-only RPC method or request not allowed.');
    const p = request.params || [];
    let valid = false;
    switch (request.method) {
      case 'eth_chainId': case 'eth_blockNumber': case 'eth_gasPrice': case 'eth_maxPriorityFeePerGas': valid = p.length === 0; break;
      case 'eth_call': valid = p.length === 2 && transaction(p[0]) && block(p[1]); break;
      case 'eth_estimateGas': valid = p.length >= 1 && p.length <= 2 && transaction(p[0]) && (p.length === 1 || block(p[1])); break;
      case 'eth_getBalance': case 'eth_getCode': case 'eth_getTransactionCount': valid = p.length === 2 && address(p[0]) && block(p[1]); break;
      case 'eth_getTransactionReceipt': case 'eth_getTransactionByHash': valid = p.length === 1 && hash(p[0]); break;
      case 'eth_getBlockByNumber': valid = p.length === 2 && block(p[0]) && p[1] === false; break;
      case 'eth_getLogs': valid = p.length === 1 && logFilter(p[0]); break;
      case 'eth_feeHistory': valid = p.length === 3 && quantity(p[0]) && BigInt(p[0]) > 0n && BigInt(p[0]) <= 256n && block(p[1]) && Array.isArray(p[2]) && p[2].length <= 100 && p[2].every((percentile, index) => Number.isFinite(percentile) && percentile >= 0 && percentile <= 100 && (index === 0 || percentile >= p[2][index - 1])); break;
    }
    if (!valid) throw invalid('Invalid or unbounded RPC parameters.');
  }
  return requests;
}
