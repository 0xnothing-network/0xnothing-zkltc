import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lstat,mkdir,mkdtemp,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {assembleDogeosArtifacts} from './prepare-dogeos.mjs';

const esbuild=await import(new URL('../../../../0xPixel-Dogeos/node_modules/esbuild/lib/main.js',import.meta.url));
async function fixture() {
  const root=await mkdtemp(path.join(os.tmpdir(),'dogeos-package-test-'));
  const sourceRoot=path.join(root,'source'),appRoot=path.join(root,'next');
  for(const folder of ['dist/assets','server','deployments','src/generated','node_modules/fixture-cjs','.runtime','output','contracts','subgraph'])await mkdir(path.join(sourceRoot,folder),{recursive:true});
  await mkdir(appRoot,{recursive:true});
  await writeFile(path.join(sourceRoot,'dist/index.html'),'<!doctype html><title>DogeOS</title>');
  await writeFile(path.join(sourceRoot,'dist/assets/main.js'),'console.log("public pixels")');
  await writeFile(path.join(sourceRoot,'deployments/chikyu.json'),JSON.stringify({chainId:6281971}));
  for(const name of ['DogeosPixel','PixelMarket'])await writeFile(path.join(sourceRoot,`src/generated/${name}.json`),JSON.stringify({abi:[],name}));
  await writeFile(path.join(sourceRoot,'node_modules/fixture-cjs/package.json'),JSON.stringify({name:'fixture-cjs',main:'index.cjs'}));
  await writeFile(path.join(sourceRoot,'node_modules/fixture-cjs/index.cjs'),"const fs=require('node:fs');module.exports=()=>typeof fs.readFileSync==='function';");
  await writeFile(path.join(sourceRoot,'server/embedded.mjs'),"import cjs from 'fixture-cjs';const fs=require('node:fs');export function handleEmbedded(){return {cjs:cjs(),deployment:JSON.parse(fs.readFileSync(new URL('../deployments/chikyu.json',import.meta.url),'utf8')),nft:JSON.parse(fs.readFileSync(new URL('../src/generated/DogeosPixel.json',import.meta.url),'utf8')),market:JSON.parse(fs.readFileSync(new URL('../src/generated/PixelMarket.json',import.meta.url),'utf8'))};}");
  for(const privateFile of ['.env.local','.runtime/private.txt','output/private.txt','contracts/private.txt','subgraph/private.txt','deployments/private.json'])await writeFile(path.join(sourceRoot,privateFile),'DO_NOT_COPY_SOURCE_PRIVATE_FIXTURE');
  return {root,sourceRoot,appRoot};
}
async function cleanup(root) {
  const resolved=path.resolve(root);
  if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('dogeos-package-test-'))throw new Error('Unsafe fixture cleanup path.');
  await rm(resolved,{recursive:true,force:true});
}
async function filesIn(root,prefix='') {
  const files=[];
  for(const entry of await readdir(path.join(root,prefix),{withFileTypes:true})) {
    const relative=path.posix.join(prefix,entry.name);
    if(entry.isDirectory())files.push(...await filesIn(root,relative));else files.push(relative);
  }
  return files.sort();
}

test('packaging bundles CJS dependencies, preserves import.meta.url depth and copies only public artifacts',async()=>{
  const state=await fixture();
  try {
    await mkdir(path.join(state.appRoot,'.dogeos'));await writeFile(path.join(state.appRoot,'.dogeos','stale.txt'),'stale');
    const result=await assembleDogeosArtifacts({...state,build:esbuild.build});
    assert.deepEqual(await filesIn(result.artifactRoot),[
      'deployments/chikyu.json','dist/assets/main.js','dist/index.html','server/embedded.mjs','src/generated/DogeosPixel.json','src/generated/PixelMarket.json',
    ]);
    assert.equal(result.files,6);
    const module=await import(pathToFileURL(path.join(result.artifactRoot,'server/embedded.mjs')).href);
    assert.deepEqual(module.handleEmbedded(),{cjs:true,deployment:{chainId:6281971},nft:{abi:[],name:'DogeosPixel'},market:{abi:[],name:'PixelMarket'}});
    for(const file of await filesIn(result.artifactRoot))assert.ok(!(await readFile(path.join(result.artifactRoot,file),'utf8')).includes('DO_NOT_COPY_SOURCE_PRIVATE_FIXTURE'));
  } finally {await cleanup(state.root);}
});

test('packaging rejects a private frontend file instead of copying it',async()=>{
  const state=await fixture();
  try {
    await writeFile(path.join(state.sourceRoot,'dist/assets/.env.production'),'DO_NOT_COPY_SOURCE_PRIVATE_FIXTURE');
    await assert.rejects(assembleDogeosArtifacts({...state,build:esbuild.build}),/Refusing private/);
    await assert.rejects(lstat(path.join(state.appRoot,'.dogeos/dist/assets/.env.production')),{code:'ENOENT'});
  } finally {await cleanup(state.root);}
});

test('packaging refuses an artifact junction before recursive replacement',async context=>{
  const state=await fixture();
  try {
    const elsewhere=path.join(state.root,'keep');await mkdir(elsewhere);await writeFile(path.join(elsewhere,'keep.txt'),'keep');
    try{await symlink(elsewhere,path.join(state.appRoot,'.dogeos'),process.platform==='win32'?'junction':'dir');}
    catch(error){if(['EPERM','EACCES'].includes(error.code)){context.skip('Filesystem does not allow test symlinks.');return;}throw error;}
    await assert.rejects(assembleDogeosArtifacts({...state,build:esbuild.build}),/Refusing to replace a linked/);
    assert.equal(await readFile(path.join(elsewhere,'keep.txt'),'utf8'),'keep');
  } finally {await cleanup(state.root);}
});
