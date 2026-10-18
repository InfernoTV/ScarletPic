import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {cleanTags,computedTags,filterRows,paginateRows} from '../public/assets/gallery_logic.js';
import {generateSeo} from './build-site.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>fs.readFile(path.join(root,file),'utf8');
const catalogue=JSON.parse(await read('public/data/catalogue.json'));
assert.equal(catalogue.brand,'ScarletPic');
assert.equal(catalogue.images.length,8170);
assert.equal(new Set(catalogue.images.map(row=>row.id)).size,8170);
assert.equal(Object.keys(catalogue.posts).length,396);
for(const [field,totals] of [['color',catalogue.colors],['palette',catalogue.palettes]]){
  const actual={};
  for(const row of catalogue.images)actual[row[field]]=(actual[row[field]]||0)+1;
  assert.deepEqual(actual,totals);
}
const rows=catalogue.images.map(row=>{
  const tags=new Set([...(catalogue.posts[row.post]?.tags||[]),...computedTags(row)]);
  return {...row,tags,search:`${row.name} ${row.id} ${[...tags].join(' ')}`.toLowerCase().replaceAll('_',' ')};
});
const base={view:'all',query:'',color:'',palette:'',tag:'',sort:'discover',seed:17};
const discover=filterRows(rows,base);
assert.deepEqual(discover.map(row=>row.id),filterRows(rows,base).map(row=>row.id));
assert.notDeepEqual(discover.map(row=>row.id),filterRows(rows,{...base,seed:33}).map(row=>row.id));
const blueMulti=filterRows(rows,{...base,color:'blue',palette:'multicolor'});
assert.equal(blueMulti.length,126);
assert.ok(blueMulti.every(row=>row.color==='blue'&&row.palette==='multicolor'));
const searchMatches=filterRows(rows,{...base,query:'blue multicolor'});
assert.deepEqual(new Set(searchMatches.map(row=>row.id)),new Set(rows.filter(row=>row.search.includes('blue')&&row.search.includes('multicolor')).map(row=>row.id)));
assert.equal(filterRows(rows,{...base,tag:'anime'}).length,1708);
const saved=new Set([rows[0].id,rows[100].id]);
assert.equal(filterRows(rows,{...base,view:'saved'},saved).length,2);
assert.equal(filterRows(rows,{...base,view:'saved'},new Set()).length,0);
assert.deepEqual(cleanTags([' Blue sky ','blue_sky',null,7,'',' ANIME ']),['blue_sky','anime']);
for(const size of [48,96,192]){
  const expected=Math.ceil(rows.length/size),ids=[];
  for(let page=1;page<=expected;page++){
    const result=paginateRows(discover,page,size);
    assert.equal(result.pageCount,expected);
    assert.equal(result.start,(page-1)*size);
    assert.equal(result.end,Math.min(page*size,rows.length));
    ids.push(...result.items.map(row=>row.id));
  }
  assert.deepEqual(ids,discover.map(row=>row.id));
}
assert.equal(paginateRows(rows,86).items.length,10);
assert.equal(paginateRows(rows,999).page,86);
assert.equal(paginateRows(rows,-3).page,1);
assert.equal(paginateRows(rows,'bad',12).pageSize,96);
assert.equal(paginateRows([],9).page,1);
assert.equal(paginateRows([],9).items.length,0);

const seo=generateSeo(catalogue,'https://scarletpic.example');
assert.equal(seo.pageCount,86);
assert.equal((seo.sitemap.match(/<url>/g)||[]).length,86);
assert.equal((seo.sitemap.match(/<image:loc>/g)||[]).length,8170);
assert.ok(seo.robots.includes('Sitemap: https://scarletpic.example/sitemap.xml'));
const imageIds=[...seo.sitemap.matchAll(/<image:loc>https:\/\/scarletpic\.example\/media\/images\/([^<]+)\.webp<\/image:loc>/g)].map(match=>match[1]);
assert.deepEqual(imageIds,discover.map(row=>row.id));
assert.ok(seo.sitemap.includes('<loc>https://scarletpic.example/?page=86</loc>'));
assert.equal(generateSeo(catalogue,'').pageCount,0);
assert.ok(!generateSeo(catalogue,'').sitemap.includes('<url>'));
for(const invalid of ['file:///tmp','https://name:password@example.com','https://example.com/path','https://example.com/?q=1'])assert.throws(()=>generateSeo(catalogue,invalid));

let mediaBytes=0,mediaFiles=0;
for(const directory of ['thumbs','images']){
  const mediaDir=path.join(root,'public/media',directory);
  assert.equal((await fs.readdir(mediaDir)).length,8170);
  // Limit filesystem concurrency to keep the check usable on slower disks.
  for(let start=0;start<rows.length;start+=64){
    const results=await Promise.all(rows.slice(start,start+64).map(row=>fs.stat(path.join(mediaDir,row.id+'.webp'))));
    for(const stat of results){assert.ok(stat.isFile()&&stat.size>12);mediaBytes+=stat.size;mediaFiles++;}
  }
}
const html=await read('public/index.html'),app=await read('public/assets/app.js');
const css=await read('public/assets/style.css'),config=await read('netlify.toml');
const served=[html,app,css,await read('public/data/catalogue.json'),await read('public/404.html')].join('\n');
assert.ok(html.includes('<title>ScarletPic'));
assert.ok(!/tiktok|imqualtz|source-credit|viewer-source/i.test(served));
assert.ok(!/<img\b[^>]*\bsrc\s*=/i.test(html));
assert.ok(/rootMargin:'0px',threshold:\.01/.test(app));
assert.ok(app.includes('while(activeLoads<4&&queue.length)'));
assert.ok(app.includes("button.dataset.visible!=='true'"));
assert.ok(!/\[\[redirects\]\]|http-equiv=["']refresh|location\.(assign|replace)\(/i.test(config+'\n'+served));
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
assert.equal(ids.length,new Set(ids).size);
const idSet=new Set(ids);
for(const match of app.matchAll(/\$\('#([\w-]+)'\)/g))assert.ok(idSet.has(match[1]),`Missing static element #${match[1]}`);
for(const match of html.matchAll(/(?:href|src)="([^"#]+)"/g)){
  const value=match[1].split('#')[0];
  if(!value||value==='./'||/^(https?:|data:)/.test(value))continue;
  await fs.access(path.join(root,'public',value));
}
for(const file of ['rules.txt','robots.txt','sitemap.xml','404.html','_headers'])await fs.access(path.join(root,'public',file));
const ai=JSON.parse(await read('public/data/ai-tags.json'));
assert.equal(typeof ai.images,'object');
console.log(JSON.stringify({passed:true,images:rows.length,mediaFiles,mediaBytes,pages:86,lastPageImages:10,pageSizes:[48,96,192],animeCaptionTagImages:1708,blueMulticolorImages:126,sitemapImageEntries:8170,browserQa:'Not performed: browser tool URL policy blocked observation.',aiInference:Object.keys(ai.images).length?'Tags present':'Not run; optional tool included.'},null,2));
