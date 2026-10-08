import {readFile, writeFile} from 'node:fs/promises';
import {createHash,createDecipheriv} from 'node:crypto';
import {join,basename} from 'node:path';

// Offline recovery only. No network requests and no keys stored in this script.
async function restore() {
 const [folder,keyFile,option]=process.argv.slice(2);
 if(!folder||!keyFile||(option&&option!=='--check-only')) throw Error('Usage: node restore-backup.mjs BACKUP_FOLDER KEY_FILE [--check-only]');
 const manifest=JSON.parse(await readFile(join(folder,'manifest.json'),'utf8'));
 if(manifest.format!=='Ride24Recovery-v1'||manifest.algorithm!=='AES-256-GCM'||manifest.parts?.length!==5) throw Error('Unexpected backup format');
 const sha=b=>createHash('sha256').update(b).digest('hex');
 const parts=[];
 for(const part of manifest.parts) {
  if(part.name!==basename(part.name)||!/^backup\.aesgcm\.part0[1-5]$/.test(part.name)) throw Error('Invalid part name');
  const bytes=await readFile(join(folder,part.name));
  if(bytes.length!==part.bytes||sha(bytes)!==part.sha256) throw Error('Part checksum mismatch: '+part.name);
  parts.push(bytes);
 }
 const encrypted=Buffer.concat(parts);
 if(sha(encrypted)!==manifest.encrypted_sha256) throw Error('Encrypted archive checksum mismatch');
 const header=Buffer.from('Ride24Recovery-v1');
 if(!encrypted.subarray(0,header.length).equals(header)) throw Error('Invalid archive header');
 const rawKey=await readFile(keyFile);
 const key=rawKey.length===32?rawKey:Buffer.from(rawKey.toString('utf8').trim(),'base64');
 if(key.length!==32) throw Error('Key must be 32 raw bytes or the Base64 value from Vault');
 const decipher=createDecipheriv('aes-256-gcm',key,encrypted.subarray(header.length,header.length+12));
 decipher.setAAD(header);
 decipher.setAuthTag(encrypted.subarray(-16));
 const zip=Buffer.concat([decipher.update(encrypted.subarray(header.length+12,-16)),decipher.final()]);
 if(sha(zip)!==manifest.original_zip_sha256) throw Error('Restored ZIP checksum mismatch');
 if(option!=='--check-only') {
  const output=join(folder,'Ride24_Backup_Restored.zip');
  // Exclusive creation prevents overwriting an existing file.
  await writeFile(output,zip,{flag:'wx',mode:0o600});
  console.log('Restored ZIP: '+output);
 }
 console.log('Verified all 5 parts, encryption authentication and original ZIP SHA-256.');
}
try { await restore(); } catch(e) { console.error(e.message); process.exitCode=1; }
