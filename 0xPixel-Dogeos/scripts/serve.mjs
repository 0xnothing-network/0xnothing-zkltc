import {createConnection} from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';
import {config} from 'dotenv';
const root=fileURLToPath(new URL('../',import.meta.url));config({path:root+'.env.local',quiet:true});
const occupied=port=>new Promise(resolve=>{const socket=createConnection({host:'127.0.0.1',port});socket.setTimeout(1000);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(false);});});
let port=Number(process.env.PORT||3300);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be an integer from 1 to 65535.');
if(port===3300&&await occupied(3300)) {
 const proxy=new URL('../../0xNothing-zkLTC-Testnet/apps/web/app/DOGEOSxPIXEL/[[...path]]/route.ts',import.meta.url);
 if(!existsSync(proxy))throw new Error('Port 3300 is occupied. Stop the other server or set PORT explicitly.');
 port=3301;console.log('Workspace is on :3300. Serving through its /DOGEOSxPIXEL route from :3301.');
}
if(await occupied(port))throw new Error(`Port ${port} is already in use. The app may already be running.`);
const server=spawn(process.execPath,['server/index.mjs',...(process.argv.includes('--dev')?['--dev']:[])],{cwd:root,env:{...process.env,PORT:String(port)},stdio:'inherit',windowsHide:true});
server.on('error',error=>{console.error('Unable to start DOGEOSxPIXEL:',error.message);process.exitCode=1;});
server.on('exit',code=>{process.exitCode=code??0;});
process.on('SIGINT',()=>server.kill());process.on('SIGTERM',()=>server.kill());
