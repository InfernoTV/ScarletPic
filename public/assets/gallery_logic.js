// Pure gallery logic, also exercised by the package validation.
export const cleanTags = tags => Array.isArray(tags)
  ? [...new Set(tags.filter(tag=>typeof tag==='string').map(tag=>tag.trim().toLowerCase().replace(/\s+/g,'_').slice(0,50)).filter(Boolean))].slice(0,100)
  : [];

export function computedTags(row) {
  const ratio=row.width/row.height;
  const shape=ratio>1.12?'landscape':ratio<.89?'portrait':'square';
  return [row.color,row.palette,shape,...(row.brightness<.2?['dark']:row.brightness>.8?['bright']:[])];
}

export function discoveryHash(text,seed=17) {
  let value=2166136261^seed;
  for(let i=0;i<text.length;i++)value=Math.imul(value^text.charCodeAt(i),16777619);
  return value>>>0;
}

export function filterRows(rows,state,saved=new Set()) {
  const terms=state.query.trim().toLowerCase().replaceAll('_',' ').split(/\s+/).filter(Boolean);
  const result=rows.filter(row=>(state.view!=='saved'||saved.has(row.id))&&(!state.color||row.color===state.color)&&(!state.palette||row.palette===state.palette)&&(!state.tag||row.tags.has(state.tag))&&terms.every(term=>row.search.includes(term)));
  switch(state.sort){
    case 'newest':result.sort((a,b)=>b.id.localeCompare(a.id));break;
    case 'oldest':result.sort((a,b)=>a.id.localeCompare(b.id));break;
    case 'bright':result.sort((a,b)=>b.brightness-a.brightness);break;
    case 'dark':result.sort((a,b)=>a.brightness-b.brightness);break;
    case 'name':result.sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));break;
    default:{const scores=new Map(result.map(row=>[row.id,discoveryHash(row.id,state.seed)]));result.sort((a,b)=>scores.get(a.id)-scores.get(b.id));}
  }
  return result;
}

export function paginateRows(rows,page=1,pageSize=96) {
  const size=[48,96,192].includes(Number(pageSize))?Number(pageSize):96;
  const total=rows.length,pageCount=Math.max(1,Math.ceil(total/size));
  const current=Math.max(1,Math.min(pageCount,Math.floor(Number(page))||1));
  const start=(current-1)*size,end=Math.min(total,start+size);
  return {items:rows.slice(start,end),page:current,pageSize:size,pageCount,total,start,end};
}
