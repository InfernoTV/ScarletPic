import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {discoveryHash} from '../public/assets/gallery_logic.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const xmlEscape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

export function generateSeo(catalogue,siteUrl,pageSize=96){
  let origin='';
  if(siteUrl){
    const url=new URL(siteUrl);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('SITE_URL must be a public HTTP(S) origin without credentials.');
    if(url.pathname!=='/'||url.search||url.hash)throw new Error('SITE_URL must be the site root, without a path, query or hash.');
    origin=url.origin+'/';
  }
  const robots=['# ScarletPic','User-agent: *','Allow: /',...(origin?['',`Sitemap: ${origin}sitemap.xml`]:['','# Sitemap URL is added automatically during the Netlify build.']),''].join('\n');
  const opening='<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">';
  if(!origin)return {origin,robots,sitemap:opening+'\n  <!-- Public origin not assigned yet. The Netlify build populates this sitemap using its URL environment variable. -->\n</urlset>\n',pageCount:0};
  const size=[48,96,192].includes(Number(pageSize))?Number(pageSize):96;
  const scores=new Map(catalogue.images.map(row=>[row.id,discoveryHash(row.id,17)]));
  const ordered=[...catalogue.images].sort((a,b)=>scores.get(a.id)-scores.get(b.id));
  const pages=Math.max(1,Math.ceil(ordered.length/size));
  const entries=[];
  for(let page=1;page<=pages;page++){
    const url=new URL(origin);if(page>1)url.searchParams.set('page',String(page));
    const images=ordered.slice((page-1)*size,page*size).map(row=>`    <image:image><image:loc>${xmlEscape(origin+'media/images/'+row.id+'.webp')}</image:loc></image:image>`).join('\n');
    entries.push(`  <url>\n    <loc>${xmlEscape(url.href)}</loc>\n${images}\n  </url>`);
  }
  return {origin,robots,sitemap:opening+'\n'+entries.join('\n')+'\n</urlset>\n',pageCount:pages};
}

async function main(){
  const config=JSON.parse(await fs.readFile(path.join(root,'site.config.json'),'utf8'));
  const catalogue=JSON.parse(await fs.readFile(path.join(root,'public/data/catalogue.json'),'utf8'));
  const index=process.argv.indexOf('--site-url');
  const siteUrl=index>=0?process.argv[index+1]:process.env.SITE_URL||process.env.URL||config.siteUrl;
  if(index>=0&&!siteUrl)throw new Error('--site-url requires a URL.');
  if(process.env.NETLIFY==='true'&&!siteUrl)throw new Error('Netlify did not provide URL. Set SITE_URL to the production origin.');
  const output=generateSeo(catalogue,siteUrl,96);
  const publicDir=path.join(root,'public');
  await fs.writeFile(path.join(publicDir,'robots.txt'),output.robots);
  await fs.writeFile(path.join(publicDir,'sitemap.xml'),output.sitemap);
  const indexPath=path.join(publicDir,'index.html');
  let html=await fs.readFile(indexPath,'utf8');
  html=html.replace(/\n\s*<link rel="canonical"[^>]*>/g,'').replace(/\n\s*<meta property="og:url"[^>]*>/g,'');
  if(output.origin)html=html.replace('</head>',`  <link rel="canonical" href="${xmlEscape(output.origin)}" data-site-base="${xmlEscape(output.origin)}">\n  <meta property="og:url" content="${xmlEscape(output.origin)}">\n</head>`);
  await fs.writeFile(indexPath,html);
  console.log(output.origin?`ScarletPic ready: sitemap for ${output.pageCount} pages at ${output.origin}`:'ScarletPic ready. Canonical sitemap URLs will be added when Netlify provides the production URL.');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
