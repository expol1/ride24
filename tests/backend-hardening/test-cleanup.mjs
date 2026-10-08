import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL("../../", import.meta.url));
const source=readFileSync(root+'/supabase/functions/cleanup-storage/index.ts','utf8');
const ast=ts.createSourceFile('cleanup.ts',source,ts.ScriptTarget.Latest,true);
const pieces=ast.statements.filter(x=>ts.isFunctionDeclaration(x)||ts.isVariableStatement(x)).map(x=>x.getText(ast));
const exported=['cleanStoragePath','normalizeVoucher','endDateExpiry','deleteVoucher','authorizeCleanupRequest'];
const prefix=`const isUuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);const requireSecret=(req)=>{if(req.headers.get('x-cron-secret')!=='fixture-cron')throw Error('INTERNAL_AUTH_FAILED');};`;
const js=ts.transpileModule(prefix+pieces.join('\n')+'\nexport {'+exported.join(',')+'}',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const m=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
globalThis.Deno={env:{get:k=>k==='SUPABASE_SERVICE_ROLE_KEY'?'fixture-service':undefined}};
const checks=[];function check(n,a,e){assert.deepEqual(a,e,n);checks.push(n);}
check('safe legacy PDF path retained',m.cleanStoragePath('RIDE24-X.pdf'),'RIDE24-X.pdf');
check('safe current PDF path retained',m.cleanStoragePath('vouchers/RIDE24-X.pdf'),'vouchers/RIDE24-X.pdf');
for(const path of ['../vehicle-images/car.jpg','vehicle-images/car.pdf','vouchers/../x.pdf','/x.pdf','vouchers/x.jpg'])check('invalid path rejected: '+path,m.cleanStoragePath(path),null);
check('invalid booking date rejected',m.endDateExpiry('2026-02-30'),null);
check('original 180-day retention unchanged',m.endDateExpiry('2026-01-01')-Date.parse('2026-01-01T23:59:59.999Z'),180*24*60*60*1000);
const voucher={id:'00000000-0000-4000-8000-000000000001',booking_id:'00000000-0000-4000-8000-000000000002',pdf_path:'vouchers/RIDE24-X.pdf'};
function adminFor(booking){const operations=[];const chain={select(){return this},eq(){return this},delete(){operations.push('delete-row');return this},async maybeSingle(){return {data:this.kind==='bookings'?booking:{id:voucher.id},error:null}}};return{operations,from(kind){return Object.assign(Object.create(chain),{kind})},storage:{from(bucket){return{async remove(paths){operations.push({bucket,paths});return{error:null}}}}}};}
let admin=adminFor({end_date:new Date().toISOString().slice(0,10)});check('recent booking voucher retained',await m.deleteVoucher(admin,voucher),'skipped');check('recent voucher causes no deletion',admin.operations.length,0);
admin=adminFor({end_date:'2020-01-01'});check('expired voucher follows original deletion rule',await m.deleteVoucher(admin,voucher),'deleted');check('only voucher bucket accessed',admin.operations[0],{bucket:'vouchers',paths:['vouchers/RIDE24-X.pdf']});
admin=adminFor({end_date:'invalid'});check('invalid date fails safely',await m.deleteVoucher(admin,voucher),'skipped');check('invalid date causes no deletion',admin.operations.length,0);
m.authorizeCleanupRequest(new Request('https://fixture.test',{headers:{Authorization:'Bearer fixture-service'}}));check('trusted scheduled bearer accepted',true,true);
m.authorizeCleanupRequest(new Request('https://fixture.test',{headers:{'x-cron-secret':'fixture-cron'}}));check('existing cron secret accepted',true,true);
let denied=false;try{m.authorizeCleanupRequest(new Request('https://fixture.test'));}catch{denied=true}check('anonymous cleanup rejected',denied,true);
const result={passed:checks.length,checks,scope:'original cleanup functions on isolated mocks; no real resources removed',completed_at:new Date().toISOString()};console.log(JSON.stringify(result));
