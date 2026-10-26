import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
const read=path=>readFileSync(new URL(path,root),'utf8');
const sitemap=read('sitemap.xml');
const urls=[...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match=>match[1]).filter(url=>url.startsWith('https://ride24.pl/seo/'));
const redirects=read('_redirects');
test('all sitemap SEO pages have matching clean self-canonical and hreflang URLs',()=>{
 assert.ok(urls.length>=100, 'SEO sitemap is missing published pages');
 assert.equal(new Set(urls).size,urls.length);
 for (const url of urls) {
   const path=url.replace('https://ride24.pl/','')+'.html';
   assert.ok(existsSync(new URL(path,root)),path+' not published in repository');
   const html=read(path);
   const canonical=html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
   assert.equal(canonical,url,path+' canonical must match sitemap exactly');
   const alternates=[...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g)];
   assert.ok(alternates.some(match=>match[1]==='pl'),path+' no Polish alternate');
   assert.ok(alternates.some(match=>match[1]==='en'),path+' no English alternate');
   for(const match of alternates){
      assert.ok(match[2].startsWith('https://ride24.pl/seo/'),path+' alternate domain');
      assert.ok(!match[2].endsWith('.html'),path+' alternate must use clean URL');
   }
 }
});
test('legacy canonical redirects are explicit, SEO-only and match sitemap destinations',()=>{
 const rules=redirects.split('\n').filter(line=>line.trim()&&!line.startsWith('#'));
 assert.equal(rules.length,20);
 const from=new Set();
 for (const rule of rules){
   const chunks=rule.trim().split(/\s+/);
   assert.equal(chunks.length,3);
   const [src,target,status]=chunks;
   assert.equal(status,'301');
   assert.match(src,/^\/seo\/[a-z0-9-]+\.html$/);
   assert.equal(target,src.slice(0,-5));
   assert.ok(urls.includes('https://ride24.pl'+target));
   assert.ok(!from.has(src),'duplicate redirect '+src);
   from.add(src);
 }
});
test('Googlebot can render public styles and scripts; private pages remain blocked',()=>{
 const robots=read('robots.txt');
 assert.doesNotMatch(robots,/Disallow:\s*\/assets\//);
 assert.match(robots,/Disallow:\s*\/admin\//);
 assert.match(robots,/Disallow:\s*\/partner-dashboard\.html/);
 assert.match(robots,/Sitemap:\s*https:\/\/ride24\.pl\/sitemap\.xml/);
});
