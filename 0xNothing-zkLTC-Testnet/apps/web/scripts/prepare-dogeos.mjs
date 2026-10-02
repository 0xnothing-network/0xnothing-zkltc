import {spawn} from 'node:child_process';
import {copyFile,lstat,mkdir,readdir,readFile,realpath,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const publicJSON=[
  'deployments/chikyu.json',
  'src/generated/DogeosPixel.json',
  'src/generated/PixelMarket.json',
];
const forbiddenNames=new Set(['.runtime','output','contracts','subgraph','graft','node_modules','private','secrets']);
const samePath=(left,right)=>process.platform==='win32'
  ? path.resolve(left).toLowerCase()===path.resolve(right).toLowerCase()
  : path.resolve(left)===path.resolve(right);

async function exists(file) {try{await stat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}

async function resetArtifacts(appRoot) {
  const resolvedApp=await realpath(appRoot),artifactRoot=path.resolve(resolvedApp,'.dogeos');
  if(path.dirname(artifactRoot)!==resolvedApp||path.basename(artifactRoot)!=='.dogeos')throw new Error('Invalid DogeOS artifact directory.');
  try {
    const info=await lstat(artifactRoot);
    if(info.isSymbolicLink()||!samePath(await realpath(artifactRoot),artifactRoot))throw new Error('Refusing to replace a linked DogeOS artifact directory.');
  } catch(error) {if(error.code!=='ENOENT')throw error;}
  // This absolute target is the verified, generated child of this Next app.
  await rm(artifactRoot,{recursive:true,force:true});
  await mkdir(artifactRoot,{recursive:true});
  return artifactRoot;
}

async function copyFrontend(from,to) {
  const sourceInfo=await lstat(from);if(!sourceInfo.isDirectory()||sourceInfo.isSymbolicLink())throw new Error('Expected an ordinary DogeOS dist directory.');
  await mkdir(to,{recursive:true});let files=0;
  for(const entry of await readdir(from,{withFileTypes:true})) {
    const name=entry.name.toLowerCase();
    if(entry.isSymbolicLink()||forbiddenNames.has(name)||/^\.env(?:\.|$)/.test(name)||/\.(?:pem|key|secret|private)$/.test(name))throw new Error(`Refusing private or linked frontend artifact: ${entry.name}`);
    const source=path.join(from,entry.name),target=path.join(to,entry.name);
    if(entry.isDirectory())files+=await copyFrontend(source,target);
    else if(entry.isFile()){await copyFile(source,target);files++;}
    else throw new Error(`Unsupported frontend artifact: ${entry.name}`);
  }
  return files;
}

export async function assembleDogeosArtifacts({sourceRoot,appRoot,build}) {
  const artifactRoot=await resetArtifacts(appRoot);
  let files=await copyFrontend(path.join(sourceRoot,'dist'),path.join(artifactRoot,'dist'));
  for(const relative of publicJSON) {
    const source=path.join(sourceRoot,relative),target=path.join(artifactRoot,relative);
    if((await lstat(source)).isSymbolicLink()||!samePath(await realpath(source),source))throw new Error(`Refusing linked public JSON: ${relative}`);
    await mkdir(path.dirname(target),{recursive:true});await copyFile(source,target);files++;
  }
  const handler=path.join(artifactRoot,'server','embedded.mjs');await mkdir(path.dirname(handler),{recursive:true});
  const result=await build({
    entryPoints:[path.join(sourceRoot,'server','embedded.mjs')],outfile:handler,
    bundle:true,packages:'bundle',platform:'node',format:'esm',target:'node22',
    sourcemap:false,minify:false,legalComments:'inline',metafile:true,logLevel:'info',
    banner:{js:"import { createRequire as __dogeosCreateRequire } from 'node:module'; const require = __dogeosCreateRequire(import.meta.url);"},
  });
  return {artifactRoot,files:files+1,bundleBytes:(await stat(handler)).size,bundledInputs:Object.keys(result.metafile?.inputs||{}).length};
}

async function runNpm(args,cwd) {
  const cli=process.env.npm_execpath;
  const useNodeCLI=cli&&path.basename(cli)==='npm-cli.js';
  const command=useNodeCLI?process.execPath:process.platform==='win32'?'npm.cmd':'npm';
  const commandArgs=useNodeCLI?[cli,...args]:args;
  await new Promise((resolve,reject)=>{
    // The fallback shell receives only fixed npm actions; source paths are cwd.
    const child=spawn(command,commandArgs,{cwd,stdio:'inherit',shell:!useNodeCLI&&process.platform==='win32'});
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`npm ${args.join(' ')} failed with exit code ${code}.`)));
  });
}

export async function prepareDogeos() {
  const appRoot=await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
  const requestedSource=path.resolve(process.env.DOGEOS_SOURCE_DIR?.trim()||path.resolve(appRoot,'../../..','0xPixel-Dogeos'));
  let sourceRoot;
  try {sourceRoot=await realpath(requestedSource);}catch(error){
    if(error.code!=='ENOENT')throw error;
    throw new Error(`DogeOS source directory is missing: ${requestedSource}. Include source files outside the Next Root Directory on Vercel, or set DOGEOS_SOURCE_DIR to the available source directory.`);
  }
  const sourcePackage=JSON.parse(await readFile(path.join(sourceRoot,'package.json'),'utf8'));
  if(!sourcePackage.scripts?.build)throw new Error('The DogeOS source needs its frontend build script.');
  if(!await exists(path.join(sourceRoot,'server','embedded.mjs')))throw new Error('The DogeOS embedded handler is missing. Complete server/embedded.mjs before building Next.');
  const required=['node_modules/vite/bin/vite.js','node_modules/vite/client.d.ts','node_modules/typescript/bin/tsc','node_modules/esbuild/lib/main.js'];
  // Hosting sets NODE_ENV=production (or npm_config_omit=dev). Build tools must
  // still be installed before compiling the frontend and embedded backend.
  if(!(await Promise.all(required.map(file=>exists(path.join(sourceRoot,file))))).every(Boolean))await runNpm(['ci','--include=dev'],sourceRoot);
  if(!(await Promise.all(required.map(file=>exists(path.join(sourceRoot,file))))).every(Boolean))throw new Error('DogeOS build dependencies are missing after npm ci --include=dev.');
  await runNpm(['run','build'],sourceRoot);
  const esbuild=await import(pathToFileURL(path.join(sourceRoot,'node_modules/esbuild/lib/main.js')).href);
  const result=await assembleDogeosArtifacts({sourceRoot,appRoot,build:esbuild.build||esbuild.default.build});
  console.log(`Prepared DogeOS frontend and embedded Node handler: ${result.files} files, ${result.bundledInputs} bundled modules, ${result.bundleBytes} handler bytes.`);
  return result;
}

if(process.argv[1]&&samePath(process.argv[1],fileURLToPath(import.meta.url)))await prepareDogeos();
