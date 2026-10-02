import {createConnection} from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';
import {config} from 'dotenv';
const root=fileURLToPath(new URL('../',import.meta.url));config({path:root+'.env.local',quiet:true});
const host=process.env.HOST||'127.0.0.1';if(host.length>253||!/^[a-zA-Z0-9.:-]+$/.test(host))throw new Error('HOST must be an IP address or hostname.');
const probeHost=host==='0.0.0.0'?'127.0.0.1':host==='::'?'::1':host;
const occupied=port=>new Promise(resolve=>{const socket=createConnection({host:probeHost,port});socket.setTimeout(1000);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(false);});});
let port=Number(process.env.PORT||3300);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be an integer from 1 to 65535.');
if(port===3300&&await occupied(3300)) {
 if(process.env.NODE_ENV==='production')throw new Error('Configured PORT 3300 is already in use. Production must use its assigned port.');
 const proxy=new URL('../../0xNothing-zkLTC-Testnet/apps/web/app/DOGEOSxPIXEL/[[...path]]/route.ts',import.meta.url);
 if(!existsSync(proxy))throw new Error('Port 3300 is occupied. Stop the other server or set PORT explicitly.');
 port=3301;console.log('Workspace is on :3300. Serving through its /DOGEOSxPIXEL route from :3301.');
}
if(await occupied(port))throw new Error(`Port ${port} is already in use. The app may already be running.`);
const server=spawn(process.execPath,['server/index.mjs',...(process.argv.includes('--dev')?['--dev']:[])],{cwd:root,env:{...process.env,PORT:String(port),HOST:host},stdio:'inherit',windowsHide:true});
server.on('error',error=>{console.error('Unable to start DOGEOSxPIXEL:',error.message);process.exitCode=1;});
server.on('exit',code=>{process.exitCode=code??0;});
process.on('SIGINT',()=>server.kill());process.on('SIGTERM',()=>server.kill());
