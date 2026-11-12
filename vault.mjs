// Secrets on disk and passwords for people.
// Secrets (API keys, tokens, connector values) are saved with AES-256-GCM. The key comes from the SILO_SECRET
// passphrase when it is set, otherwise from a random key file next to the data. Passwords are hashed with scrypt.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, scrypt as scryptCb, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';

const scrypt=(pass,salt,len,opts)=>new Promise((resolve,reject)=>scryptCb(pass,salt,len,opts,(e,k)=>e?reject(e):resolve(k)));
const KDF={N:16384,r:8,p:1,maxmem:64*1024*1024};

export class Vault{
  constructor(dir,passphrase=''){this.file=path.join(dir,'secrets.enc');this.keyFile=path.join(dir,'vault.key');this.passphrase=passphrase;this.key=null;this.salt=null;this.source=passphrase?'passphrase':'key file';this.saving=Promise.resolve();}
  async keyFor(salt){
    if(this.passphrase)return scrypt(this.passphrase,salt,32,KDF);
    if(!this.key){
      try{this.key=Buffer.from((await fs.readFile(this.keyFile,'utf8')).trim(),'base64');if(this.key.length!==32)throw new Error('bad key');}
      catch(e){
        if(e.code!=='ENOENT')throw new Error('The vault key file is damaged. Restore it, or delete secrets.enc and vault.key to start again.');
        this.key=randomBytes(32);await fs.writeFile(this.keyFile,this.key.toString('base64'),{mode:0o600,flag:'wx'}).catch(async err=>{if(err.code!=='EEXIST')throw err;this.key=null;return this.keyFor(salt);});
      }
    }
    return this.key;
  }
  // Returns the saved entries, or an empty object the first time.
  async load(){
    await this.saving.catch(()=>{});
    let raw;try{raw=JSON.parse(await fs.readFile(this.file,'utf8'));}catch(e){if(e.code==='ENOENT')return {};throw new Error('secrets.enc cannot be read.');}
    if(raw.kdf==='scrypt'&&!this.passphrase)throw new Error('The secrets were saved with a passphrase. Start SILO with SILO_SECRET set to it.');
    if(raw.kdf!=='scrypt'&&this.passphrase)throw new Error('The secrets were saved with a key file, but SILO_SECRET is set. Unset it, or delete secrets.enc and enter the keys again.');
    const salt=Buffer.from(raw.salt||'','base64'),key=await this.keyFor(salt);
    try{
      const d=createDecipheriv('aes-256-gcm',key,Buffer.from(raw.iv,'base64'));d.setAuthTag(Buffer.from(raw.tag,'base64'));
      return JSON.parse(Buffer.concat([d.update(Buffer.from(raw.data,'base64')),d.final()]).toString('utf8'));
    }catch{throw new Error(this.passphrase?'The SILO_SECRET passphrase does not open the saved secrets.':'The vault key does not open the saved secrets.');}
  }
  save(entries){
    const snapshot=structuredClone(entries);
    const next=this.saving.catch(()=>{}).then(async()=>{
      const salt=this.passphrase?(this.salt||=randomBytes(16)):Buffer.alloc(0),key=await this.keyFor(salt),iv=randomBytes(12);
      const c=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([c.update(JSON.stringify(snapshot),'utf8'),c.final()]);
      const out=JSON.stringify({v:1,kdf:this.passphrase?'scrypt':'keyfile',salt:salt.toString('base64'),iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),data:data.toString('base64')});
      const tmp=`${this.file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      await fs.writeFile(tmp,out,{mode:0o600});
      try{await fs.rename(tmp,this.file);}catch(e){await fs.rm(tmp,{force:true}).catch(()=>{});throw e;}
    });
    this.saving=next;
    return next;
  }
}

export async function hashPassword(password){const salt=randomBytes(16);const hash=await scrypt(password,salt,32,KDF);return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;}
export async function checkPassword(password,stored){
  const [kind,salt,hash]=String(stored||'').split('$');if(kind!=='scrypt'||!salt||!hash)return false;
  const want=Buffer.from(hash,'base64'),got=await scrypt(String(password),Buffer.from(salt,'base64'),want.length,KDF);
  return want.length===got.length&&timingSafeEqual(want,got);
}
export const ROLES={owner:'Owner',operator:'Operator',viewer:'Viewer'};
// What each role may do. Owners do everything. Operators run the silo but cannot change keys, connectors,
// channels, spending, settings or people. Viewers only look.
const OWNER_ONLY=[/^\/api\/connections/,/^\/api\/vault/,/^\/api\/mcp/,/^\/api\/channels/,/^\/api\/spending$/,/^\/api\/settings$/,/^\/api\/users/,/^\/api\/apps\/open$/,/^\/api\/oauth/,/^\/api\/grants/,/^\/api\/phone/,/^\/api\/desktop/,/^\/api\/browser/,/^\/api\/remote/,/^\/api\/services/,/^\/api\/system\//,/^\/api\/radio\/(peers|key|caps|held|lookup)/,/^\/api\/expose$/,/^\/api\/a2a\//,/^\/api\/python-tools/];
// The MCP server and the A2A agent check each method against the role and the token themselves.
const ANYONE=[/^\/api\/serve\/(mcp|a2a)$/,/^\/api\/logout$/,/^\/api\/password$/,/^\/api\/tokens(\/[a-f0-9]{24})?$/];
// Only owners may even look at these: the audit log, telemetry, single sign-on and the system.
const OWNER_READ=[/^\/api\/audit/,/^\/api\/otel/,/^\/api\/sso/,/^\/api\/system\//];
export function roleAllows(role,method,route){
  if(role==='owner')return true;
  if(ANYONE.some(r=>r.test(route)))return true;
  if(OWNER_READ.some(r=>r.test(route)))return false;
  if(role==='viewer')return method==='GET'&&route!=='/api/export';
  if(role==='operator')return !(method!=='GET'&&OWNER_ONLY.some(r=>r.test(route)));
  return false;
}
