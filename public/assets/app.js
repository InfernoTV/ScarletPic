import {cleanTags,computedTags,filterRows,paginateRows} from './gallery_logic.js';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const icon = name => `<svg class="icon" aria-hidden="true"><use href="assets/icons.svg#${name}"/></svg>`;
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const titleCase = text => text ? text[0].toUpperCase() + text.slice(1) : '';
const niceTag = tag => tag.replaceAll('_', ' ');
const shortNumber = value => value >= 1000 ? `${Math.floor(value / 100) / 10}k` : String(value);
const paletteNames = {multicolor:'Multicolor', limited:'Limited palette', monochrome:'Monochrome'};
const swatches = {red:'#e54855',orange:'#ed8e4a',yellow:'#e4ca66',green:'#69ae84',cyan:'#67b5ba',blue:'#719cdd',purple:'#a48bd1',pink:'#d38fad',brown:'#9a735a',black:'#24232a',gray:'#92919c',white:'#eeedf1'};
const STORAGE = 'scarletpic-collection-v1';
const LEGACY_STORAGE = 'qualtz-collection-v1';
let catalogue, allImages = [], byId = new Map(), filtered = [], aiInfo = {model:null,images:{}};
let persisted = {saved:[], tags:{}, ai:{}, aiModel:null};
try { const raw = JSON.parse(localStorage.getItem(STORAGE) || localStorage.getItem(LEGACY_STORAGE) || 'null'); if (raw && typeof raw === 'object') persisted = {...persisted,...raw}; } catch {}
let saved = new Set(Array.isArray(persisted.saved) ? persisted.saved : []);
let manualTags = persisted.tags && typeof persisted.tags === 'object' ? persisted.tags : {};
let importedAi = persisted.ai && typeof persisted.ai === 'object' ? persisted.ai : {};
const params = new URLSearchParams(location.search);
const state = {view:params.get('view') === 'saved' ? 'saved':'all', query:params.get('q') || '', color:params.get('color') || '', palette:params.get('palette') || '', tag:params.get('tag') || '', sort:params.get('sort') || 'discover', density:'comfortable', seed:17, page:Number(params.get('page'))||1, pageSize:Number(params.get('size'))||96};
let pageView=paginateRows([],state.page,state.pageSize);
const viewport = $('#gallery-viewport'), grid = $('#gallery-grid');
const cards = new Map();
let layout = {columns:1,width:200,rowHeight:250,gap:16}, lenis, renderPending = false;
let tagOptions = [], openMenu = null, activeLoads = 0, queue = [], currentImage = null, viewerToken = 0;
let toastTimer = null, toastStarted = 0, toastRemaining = 3500;

function persist() {
  try { localStorage.setItem(STORAGE,JSON.stringify({saved:[...saved],tags:manualTags,ai:importedAi,aiModel:persisted.aiModel})); return true; }
  catch { toast('Kept for this session. Browser storage is full. Export a backup.'); return false; }
}
function toast(message) {
  const element = $('#toast');
  clearTimeout(toastTimer); toastRemaining = 3500;
  $('span',element).textContent = message;
  if (element.showPopover && !element.matches(':popover-open')) { try { element.showPopover(); } catch {} }
  element.classList.remove('visible'); void element.offsetWidth;
  requestAnimationFrame(() => element.classList.add('visible'));
  toastStarted = performance.now(); toastTimer = setTimeout(hideToast,toastRemaining);
}
function hideToast() { $('#toast').classList.remove('visible'); setTimeout(() => { const el=$('#toast'); if(!el.classList.contains('visible')) { try{el.hidePopover?.();}catch{} } },350); }
$('#toast').addEventListener('mouseenter',()=>{clearTimeout(toastTimer);toastRemaining=Math.max(0,toastRemaining-(performance.now()-toastStarted));});
$('#toast').addEventListener('mouseleave',()=>{toastStarted=performance.now();toastTimer=setTimeout(hideToast,toastRemaining);});
let toastX = 0; $('#toast').addEventListener('pointerdown',event=>toastX=event.clientX);
$('#toast').addEventListener('pointerup',event=>{if(Math.abs(event.clientX-toastX)>45)hideToast();});

function aiTagsFor(row) {
  const values = importedAi[row.id] || aiInfo.images?.[row.id] || [];
  return Array.isArray(values) ? values.map(item=>typeof item === 'string' ? {tag:item,score:null}:item).filter(item=>item && typeof item.tag === 'string').slice(0,100) : [];
}
function indexRow(row) {
  row.postTags = catalogue.posts[row.post]?.tags || [];
  row.aiTags = aiTagsFor(row);
  row.computedTags = computedTags(row);
  row.userTags = cleanTags(manualTags[row.id]);
  row.tags = new Set([...row.postTags,...row.aiTags.map(item=>item.tag),...row.computedTags,...row.userTags]);
  row.search = `${row.name} ${row.id} ${[...row.tags].join(' ')}`.toLowerCase().replaceAll('_',' ');
}
function rebuildTagOptions() {
  const counts = new Map();
  for (const row of allImages) for(const tag of row.tags) counts.set(tag,(counts.get(tag)||0)+1);
  tagOptions = [...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([value,count])=>({value,label:niceTag(value),count}));
}
function syncURL() {
  const query = new URLSearchParams();
  for(const [key,value] of Object.entries({view:state.view==='saved'?'saved':'',q:state.query,color:state.color,palette:state.palette,tag:state.tag,sort:state.sort==='discover'?'':state.sort,page:state.page>1?state.page:'',size:state.pageSize!==96?state.pageSize:''})) if(value)query.set(key,value);
  const search=query.toString(); history.replaceState(null,'',`${location.pathname}${search?'?'+search:''}${location.hash}`);
  const canonical=$('link[rel=canonical]');
  const specialized=Boolean(state.query||state.color||state.palette||state.tag||state.view==='saved'||state.sort!=='discover'||state.pageSize!==96);
  if(canonical){const base=canonical.dataset.siteBase||canonical.href;const url=new URL(base);if(!specialized&&state.page>1)url.searchParams.set('page',state.page);canonical.href=url.href;}
  const robots=$('meta[name=robots]');if(robots)robots.content=specialized?'noindex,follow':'index,follow';
}
function applyFilters(reset=true,resetPage=reset) {
  if (!catalogue) return;
  filtered=filterRows(allImages,state,saved);
  if(resetPage)state.page=1;
  pageView=paginateRows(filtered,state.page,state.pageSize);
  state.page=pageView.page;state.pageSize=pageView.pageSize;
  syncURL(); updateHeader(); updateFilterTriggers(); renderActiveFilters();
  if(reset){if(lenis)lenis.scrollTo(0,{immediate:true});else viewport.scrollTop=0;}
  for(const card of cards.values()) destroyCard(card); cards.clear();
  calculateLayout();
  const empty=filtered.length===0; $('#empty-state').hidden=!empty; grid.hidden=empty;
  $('#empty-title').textContent=state.view==='saved'&&!saved.size?'Nothing saved yet.':'No images match.';
  $('#empty-description').textContent=state.view==='saved'&&!saved.size?'Tap the heart on any image to keep it here.':'Try another color or a shorter search.';
  $('#empty-reset').textContent=state.view==='saved'&&!saved.size?'Explore images':'Clear filters';
  renderWindow(); lenis?.resize();
}
function updateHeader() {
  $('#nav-saved-count').textContent=shortNumber(saved.size); $('#nav-saved-count').title=`${saved.size.toLocaleString()} saved images`;
  for(const button of $$('[data-view]')) {const active=button.dataset.view===state.view;button.classList.toggle('active',active);if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}
  const active=$('[data-view].active'), track=$('.nav-track');
  if(active){$('#nav-glider').style.width=`${active.offsetWidth}px`;$('#nav-glider').style.transform=`translateX(${active.offsetLeft}px)`;}
  $('#result-count').replaceChildren(); const strong=document.createElement('strong');strong.textContent=filtered.length.toLocaleString();
  $('#result-count').append(strong,` ${filtered.length===1?'image':'images'}${state.view==='saved'?' saved':''}`);
  renderPagination();
  const count=Object.keys(aiInfo.images||{}).length+Object.keys(importedAi).filter(id=>!aiInfo.images?.[id]).length;
  $('#about-ai-status').textContent=count?`AI tags available for ${count.toLocaleString()} images.`:'AI tags have not been generated.';
}
function renderPagination(){
  $('#pagination').hidden=pageView.total===0;
  $('#pagination-status').textContent=pageView.total?`Showing ${(pageView.start+1).toLocaleString()}-${pageView.end.toLocaleString()} of ${pageView.total.toLocaleString()}`:'No images';
  $('#page-size-label').textContent=`${pageView.pageSize} / page`;
  $('#page-previous').disabled=pageView.page<=1;$('#page-next').disabled=pageView.page>=pageView.pageCount;
  const container=$('#page-numbers'),glider=$('#page-glider');
  $$('button,.page-ellipsis',container).forEach(element=>element.remove());
  const radius=innerWidth<761?1:2;
  const values=new Set([1,pageView.pageCount]);
  for(let i=Math.max(1,pageView.page-radius);i<=Math.min(pageView.pageCount,pageView.page+radius);i++)values.add(i);
  let previous=0;
  for(const number of [...values].sort((a,b)=>a-b)){
    if(previous&&number-previous>1){const gap=document.createElement('span');gap.className='page-ellipsis';gap.textContent='...';gap.setAttribute('aria-hidden','true');container.append(gap);}
    const button=document.createElement('button');button.className='page-number';button.textContent=number;button.setAttribute('aria-label',`Page ${number}`);
    if(number===pageView.page)button.setAttribute('aria-current','page');
    button.addEventListener('click',()=>goToPage(number));container.append(button);previous=number;
  }
  requestAnimationFrame(()=>{const current=$('[aria-current=page]',container);if(current){glider.style.width=`${current.offsetWidth}px`;glider.style.transform=`translateX(${current.offsetLeft}px)`;}});
}
function goToPage(page){state.page=page;applyFilters(true,false);viewport.focus({preventScroll:true});}
$('#page-previous').addEventListener('click',()=>goToPage(state.page-1));
$('#page-next').addEventListener('click',()=>goToPage(state.page+1));
const pageSizeDefinition={key:'pageSize',label:'Images per page',options:()=>[48,96,192].map(value=>({value,label:`${value} images per page`}))};
$('#page-size-trigger').addEventListener('click',()=>{const trigger=$('#page-size-trigger');if(openMenu?.trigger===trigger)closeMenu();else showMenu(pageSizeDefinition,trigger);});
$('#page-size-trigger').addEventListener('keydown',event=>{if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();showMenu(pageSizeDefinition,event.currentTarget);}});
function renderActiveFilters() {
  const target=$('#active-filters');target.replaceChildren();
  for(const [key,label] of [['color',titleCase(state.color)],['palette',paletteNames[state.palette]],['tag',niceTag(state.tag)]]){
    if(!state[key])continue;const button=document.createElement('button');button.className='active-filter';button.title=`Remove ${key} filter`;button.innerHTML=`${escapeHTML(label)} ${icon('x')}`;
    button.addEventListener('click',()=>{state[key]='';applyFilters();});target.append(button);
  }
}

const filterDefinitions = [
  {key:'color',label:'Color',icon:'palette',empty:'All colors', options:()=>[{value:'',label:'All colors',count:allImages.length},...Object.entries(catalogue?.colors||{}).map(([value,count])=>({value,label:titleCase(value),count,swatch:swatches[value]}))]},
  {key:'palette',label:'Palette',icon:'photo',empty:'All palettes',options:()=>[{value:'',label:'All palettes',count:allImages.length},...Object.entries(paletteNames).map(([value,label])=>({value,label,count:catalogue?.palettes[value]||0}))]},
  {key:'tag',label:'Tag',icon:'tag',empty:'Any tag',search:true,options:()=>[{value:'',label:'Any tag',count:allImages.length},...tagOptions]},
  {key:'sort',label:'Order',icon:'adjustments-horizontal',empty:'Discover',options:()=>[{value:'discover',label:'Discover'},{value:'newest',label:'Newest first'},{value:'oldest',label:'Oldest first'},{value:'bright',label:'Light to dark'},{value:'dark',label:'Dark to light'},{value:'name',label:'Name'}]}
];
function createFilterControls() {
  const parent=$('#filter-controls');
  for(const definition of filterDefinitions){
    const field=document.createElement('div');field.className='filter-field';
    const label=document.createElement('label');label.className='filter-label';label.textContent=definition.label;label.htmlFor=`filter-${definition.key}`;
    const trigger=document.createElement('button');trigger.className='filter-trigger';trigger.id=label.htmlFor;trigger.dataset.filter=definition.key;trigger.setAttribute('aria-haspopup','listbox');trigger.setAttribute('aria-expanded','false');
    trigger.addEventListener('click',()=>{if(openMenu?.trigger===trigger)closeMenu();else showMenu(definition,trigger);});
    trigger.addEventListener('keydown',event=>{if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();showMenu(definition,trigger);}});
    field.append(label,trigger);parent.append(field);
  } updateFilterTriggers();
}
function updateFilterTriggers() {
  for(const definition of filterDefinitions){
    const trigger=$(`#filter-${definition.key}`);if(!trigger)continue;
    const selected=definition.options().find(option=>option.value===state[definition.key]);
    const leading=selected?.swatch?`<span class="swatch" style="--swatch:${selected.swatch}"></span>`:icon(definition.icon);
    trigger.innerHTML=`${leading}<span class="trigger-text">${escapeHTML(selected?.label||definition.empty)}</span>${icon('chevron-down')}`;
  }
}
function closeMenu(returnFocus=false) {if(!openMenu)return;const {element,trigger}=openMenu;trigger.setAttribute('aria-expanded','false');element.remove();openMenu=null;if(returnFocus)trigger.focus();}
function showMenu(definition,trigger) {
  closeMenu();const element=document.createElement('div');element.className='popover';element.setAttribute('role','presentation');
  const list=document.createElement('div');list.className='popover-list';list.setAttribute('role','listbox');list.setAttribute('aria-label',definition.label);
  const glider=document.createElement('div');glider.className='menu-glider';list.append(glider);
  let search;
  if(definition.search){const wrap=document.createElement('div');wrap.className='menu-search-wrap';wrap.dataset.smoothCaret='';search=document.createElement('input');search.className='menu-search';search.placeholder='Find a tag';search.setAttribute('aria-label','Find a tag');const caret=document.createElement('span');caret.className='smooth-caret';caret.setAttribute('aria-hidden','true');wrap.append(search,caret);element.append(wrap);attachCaret(wrap);}
  function glide(button){if(!button){glider.style.opacity='0';return;}glider.style.opacity='1';glider.style.transform=`translateY(${button.offsetTop}px)`;}
  function fill(query=''){
    $$('[role=option],.menu-empty',list).forEach(option=>option.remove());
    const options=definition.options().filter(option=>!query||niceTag(option.value).includes(query.toLowerCase())).slice(0,160);
    for(const option of options){
      const button=document.createElement('button');button.className='menu-option';button.setAttribute('role','option');button.setAttribute('aria-selected',String(option.value===state[definition.key]));button.tabIndex=-1;
      button.innerHTML=`${option.swatch?`<span class="swatch" style="--swatch:${option.swatch}"></span>`:''}<span class="option-label">${escapeHTML(option.label)}</span>${option.count!==undefined?`<span class="option-count" title="${option.count.toLocaleString()}">${shortNumber(option.count)}</span>`:''}`;
      button.addEventListener('pointerenter',()=>glide(button));button.addEventListener('focus',()=>glide(button));
      button.addEventListener('click',()=>{state[definition.key]=option.value;closeMenu(true);applyFilters();});list.append(button);
    }
    if(!options.length){const p=document.createElement('p');p.className='menu-empty';p.textContent='No tags found';list.append(p);}
    requestAnimationFrame(()=>glide($('[aria-selected=true]',list)||$('[role=option]',list)));
  }
  if(search)search.addEventListener('input',()=>fill(search.value.trim()));
  element.append(list);document.body.append(element);trigger.setAttribute('aria-expanded','true');openMenu={element,trigger};
  const bounds=trigger.getBoundingClientRect();const width=Math.max(bounds.width,definition.search?255:220);element.style.width=`Math.min(width,innerWidth-24)}px`;
  element.style.left=`${Math.min(Math.max(12,bounds.left),innerWidth-width-12)}px`;
  fill();
  const menuHeight=element.getBoundingClientRect().height;
  const top=innerHeight-bounds.bottom>menuHeight+18?bounds.bottom+7:bounds.top-menuHeight-7;
  element.style.top=`${Math.max(12,Math.min(top,innerHeight-menuHeight-12))}px`;
  element.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeMenu(true);return;}
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
      event.preventDefault();const options=$$('[role=option]',list);if(!options.length)return;const index=options.indexOf(document.activeElement);let next=event.key==='Home'?0:event.key==='End'?options.length-1:event.key==='ArrowDown'?(index+1)%options.length:(index<=0?options.length-1:index-1);options[next].focus();options[next].scrollIntoView({block:'nearest'});
    }
  });
  requestAnimationFrame(()=>{if(search)search.focus();else($('[aria-selected=true]',list)||$('[role=option]',list))?.focus();});
}
document.addEventListener('pointerdown',event=>{if(openMenu&&!openMenu.element.contains(event.target)&&!openMenu.trigger.contains(event.target))closeMenu();});

function calculateLayout() {
  const width=Math.max(100,viewport.clientWidth-5), gap=innerWidth<761?11:17;
  const target=state.density==='compact'?(innerWidth<761?115:160):(innerWidth<761?170:216);
  const columns=Math.max(2,Math.floor((width+gap)/(target+gap)));
  const cardWidth=(width-gap*(columns-1))/columns;
  layout={columns,width:cardWidth,rowHeight:cardWidth+(innerWidth<761?46:52),gap};
  const rows=Math.ceil(pageView.items.length/columns);
  grid.style.height=`${Math.max(0,rows*layout.rowHeight)}px`;
}
function scheduleRender(){if(renderPending)return;renderPending=true;requestAnimationFrame(()=>{renderPending=false;renderWindow();});}
viewport.addEventListener('scroll',scheduleRender,{passive:true});
function renderWindow() {
  if(!catalogue)return;
  const firstRow=Math.max(0,Math.floor(viewport.scrollTop/layout.rowHeight)-1);
  const lastRow=Math.min(Math.ceil(pageView.items.length/layout.columns),Math.ceil((viewport.scrollTop+viewport.clientHeight)/layout.rowHeight)+1);
  const first=firstRow*layout.columns,last=Math.min(pageView.items.length,lastRow*layout.columns),needed=new Set();
  for(let index=first;index<last;index++){
    const row=pageView.items[index];needed.add(row.id);let card=cards.get(row.id);
    if(!card){card=createCard(row);cards.set(row.id,card);grid.append(card);imageObserver.observe($('.image-open',card));}
    card.style.setProperty('--card-width',`${layout.width}px`);card.style.setProperty('--card-height',`${layout.rowHeight}px`);
    card.style.setProperty('--x',`${(index%layout.columns)*(layout.width+layout.gap)}px`);card.style.setProperty('--y',`${Math.floor(index/layout.columns)*layout.rowHeight}px`);
    card.setAttribute('aria-posinset',pageView.start+index+1);card.setAttribute('aria-setsize',filtered.length);
  }
  for(const [id,card] of cards)if(!needed.has(id)){destroyCard(card);cards.delete(id);}
  viewport.dataset.rendered=String(cards.size);
}
function createCard(row) {
  const card=document.createElement('article');card.className='image-card';card.dataset.id=row.id;card.setAttribute('role','listitem');
  card.innerHTML=`<button class="image-open" aria-label="Open ${escapeHTML(row.name)}" data-id="${row.id}"><span class="skeleton" aria-hidden="true"></span><img width="320" height="320" alt="${escapeHTML(row.name)}" decoding="async"><span class="card-error">${icon('refresh')} Retry image</span></button><div class="card-caption"><div class="caption-meta"><span class="card-name">${escapeHTML(row.name)}</span><span class="card-palette">${paletteNames[row.palette]}</span></div><button class="card-save ${saved.has(row.id)?'saved':''}" aria-label="${saved.has(row.id)?'Unsave':'Save'} ${escapeHTML(row.name)}" aria-pressed="${saved.has(row.id)}">${icon('heart')}</button></div>`;
  $('.image-open',card).addEventListener('click',event=>{if(event.currentTarget.classList.contains('failed'))enqueueThumb(event.currentTarget,true);else openViewer(row);});
  $('.card-save',card).addEventListener('click',()=>toggleSaved(row.id));
  return card;
}
function destroyCard(card){const button=$('.image-open',card);imageObserver.unobserve(button);button._release?.();const image=$('img',button);image.onload=image.onerror=null;image.removeAttribute('src');card.remove();}
const imageObserver=new IntersectionObserver(entries=>{
  for(const entry of entries){entry.target.dataset.visible=String(entry.isIntersecting);if(entry.isIntersecting)enqueueThumb(entry.target);}
},{root:viewport,rootMargin:'0px',threshold:.01});
function enqueueThumb(button,retry=false){
  if(button.dataset.fetching==='true'||button.classList.contains('loaded')||(!retry&&button.classList.contains('failed')))return;
  if(button.dataset.queued==='true')return;button.dataset.queued='true';queue.push({button,retry});pumpImages();
}
function pumpImages(){
  while(activeLoads<4&&queue.length){
    const {button,retry}=queue.shift();button.dataset.queued='false';
    if(!button.isConnected||button.dataset.visible!=='true')continue;
    const bounds=button.getBoundingClientRect(), visible=viewport.getBoundingClientRect();
    if(bounds.bottom<=visible.top||bounds.top>=visible.bottom||bounds.right<=visible.left||bounds.left>=visible.right)continue;
    const image=$('img',button);let released=false;activeLoads++;button.dataset.fetching='true';button.classList.remove('failed');
    const release=()=>{if(released)return;released=true;activeLoads--;button.dataset.fetching='false';button._release=null;queueMicrotask(pumpImages);};button._release=release;
    image.onload=async()=>{try{await image.decode();}catch{}if(button.isConnected){button.classList.add('loaded');button.dataset.loaded='true';imageObserver.unobserve(button);}release();};
    image.onerror=()=>{button.classList.add('failed');release();};
    button.dataset.requestedWhileVisible='true';image.src=`media/thumbs/${button.dataset.id}.webp${retry?'?retry='+Date.now():''}`;
  }
}
new ResizeObserver(()=>{if(!catalogue)return;closeMenu();calculateLayout();renderWindow();lenis?.resize();updateHeader();}).observe(viewport);

function toggleSaved(id) {
  const wasSaved=saved.has(id);if(wasSaved)saved.delete(id);else saved.add(id);const stored=persist();
  if(stored)toast(wasSaved?'Removed from saved':'Saved to your collection');
  if(state.view==='saved')applyFilters(false);else{const card=cards.get(id);if(card){const button=$('.card-save',card);button.classList.toggle('saved',!wasSaved);button.setAttribute('aria-pressed',String(!wasSaved));button.setAttribute('aria-label',`${!wasSaved?'Unsave':'Save'} ${byId.get(id).name}`);}updateHeader();}
  if(currentImage?.id===id)updateViewerSave();
}
function setFilterTag(tag){state.tag=tag;closeViewer();applyFilters();}
function addTagButton(parent,tag,source,remove=false){
  const outer=document.createElement('span');outer.className='tag'+(remove?' user-tag':'');
  const button=document.createElement('button');button.textContent=niceTag(tag);button.style.padding='0';button.title=source;button.addEventListener('click',()=>setFilterTag(tag));outer.append(button);
  if(remove){const cross=document.createElement('button');cross.className='remove-tag';cross.innerHTML=icon('x');cross.setAttribute('aria-label',`Remove tag ${niceTag(tag)}`);cross.addEventListener('click',()=>{
    manualTags[currentImage.id]=cleanTags(manualTags[currentImage.id]).filter(value=>value!==tag);indexRow(currentImage);persist();rebuildTagOptions();updateViewerTags();applyFilters(false);
  });outer.append(cross);}
  parent.append(outer);
}
function updateViewerTags(){
  if(!currentImage)return;const row=currentImage;
  for(const name of ['computed','ai','post','manual'])$(`#viewer-${name}-tags`).replaceChildren();
  for(const tag of row.computedTags)addTagButton($('#viewer-computed-tags'),tag,'Measured image attribute');
  for(const item of row.aiTags)addTagButton($('#viewer-ai-tags'),item.tag,`AI prediction${typeof item.score==='number'?' ('+Math.round(item.score*100)+'%)':''}`);
  $('#ai-tag-note').hidden=row.aiTags.length>0;$('#ai-source-label').textContent=row.aiTags.length?'predicted':'';
  for(const tag of row.postTags)addTagButton($('#viewer-post-tags'),tag,'Original post hashtag');
  if(!row.postTags.length){const span=document.createElement('span');span.className='detail-note';span.textContent='No post hashtags.';$('#viewer-post-tags').append(span);}
  for(const tag of row.userTags)addTagButton($('#viewer-manual-tags'),tag,'Your tag',true);
}
function updateViewerSave(){if(!currentImage)return;const button=$('#viewer-save');const active=saved.has(currentImage.id);$('span',button).textContent=active?'Saved':'Save';button.setAttribute('aria-pressed',String(active));}
function openViewer(row,updateHistory=true){
  if(!row)return;closeMenu();currentImage=row;viewerToken++;const token=viewerToken;
  const viewer=$('#viewer'),stage=$('#viewer-stage'),image=$('#viewer-image');
  stage.classList.remove('loaded');$('#viewer-image-error').hidden=true;image.alt=row.name;image.onload=async()=>{try{await image.decode();}catch{}if(token===viewerToken)stage.classList.add('loaded');};image.onerror=()=>{if(token===viewerToken)$('#viewer-image-error').hidden=false;};image.src=`media/images/${row.id}.webp`;
  $('#viewer-title').textContent=row.name;$('#viewer-dimensions').textContent=`${(row.displayWidth||row.width).toLocaleString()} × ${(row.displayHeight||row.height).toLocaleString()} px`;
  const download=$('#viewer-download');download.href=image.src;download.download=`${row.name}.webp`;

  const palette=$('#viewer-palette');palette.replaceChildren();
  const names=row.paletteColors.length?row.paletteColors:[row.color];
  for(const color of names){const button=document.createElement('button');button.className='palette-token';button.innerHTML=`<span class="swatch" style="--swatch:${swatches[color]}"></span>${escapeHTML(titleCase(color))}`;button.title=`Filter average color: ${color}`;button.addEventListener('click',()=>{state.color=color;closeViewer();applyFilters();});palette.append(button);}
  $('#viewer-average-swatch').style.setProperty('--swatch',row.hex);$('#copy-color').textContent=row.hex.toUpperCase();
  updateViewerSave();updateViewerTags();$('#tag-input').value='';
  if(!viewer.open){viewer.showModal();lenis?.stop();}
  const position=filtered.findIndex(image=>image.id===row.id);$('#previous-image').disabled=position<=0;$('#next-image').disabled=position<0||position>=filtered.length-1;
  if(updateHistory)history.replaceState(null,'',`${location.pathname}${location.search}#image=${encodeURIComponent(row.id)}`);
}
function closeViewer(){if($('#viewer').open)$('#viewer').close();}
$('#viewer').addEventListener('close',()=>{currentImage=null;viewerToken++;const image=$('#viewer-image');image.onload=image.onerror=null;image.removeAttribute('src');lenis?.start();if(location.hash.startsWith('#image='))history.replaceState(null,'',location.pathname+location.search);});
function navigateViewer(direction){if(!currentImage)return;const index=filtered.findIndex(row=>row.id===currentImage.id);const next=filtered[index+direction];if(next)openViewer(next);}
$('#close-viewer').addEventListener('click',closeViewer);$('#previous-image').addEventListener('click',()=>navigateViewer(-1));$('#next-image').addEventListener('click',()=>navigateViewer(1));
$('#viewer-save').addEventListener('click',()=>currentImage&&toggleSaved(currentImage.id));
$('#retry-viewer-image').addEventListener('click',()=>{if(!currentImage)return;$('#viewer-image-error').hidden=true;$('#viewer-image').src=`media/images/${currentImage.id}.webp?retry=${Date.now()}`;});
$('#viewer').addEventListener('click',event=>{if(event.target===$('#viewer'))closeViewer();});
$('#copy-color').addEventListener('click',async()=>{if(!currentImage)return;try{await navigator.clipboard.writeText(currentImage.hex);toast(`Copied ${currentImage.hex.toUpperCase()}`);}catch{toast(`Color: ${currentImage.hex.toUpperCase()}`);}});
$('#add-tag-form').addEventListener('submit',event=>{event.preventDefault();if(!currentImage)return;const tags=cleanTags([$('#tag-input').value]);if(!tags.length)return;manualTags[currentImage.id]=cleanTags([...currentImage.userTags,...tags]);indexRow(currentImage);const stored=persist();rebuildTagOptions();updateViewerTags();applyFilters(false);$('#tag-input').value='';$('#tag-input').dispatchEvent(new Event('input'));if(stored)toast('Tag added');});

let searchTimer;
$('#search').value=state.query;
$('#search').addEventListener('input',()=>{clearTimeout(searchTimer);$('#clear-search').hidden=!$('#search').value;searchTimer=setTimeout(()=>{state.query=$('#search').value;applyFilters();},100);});
$('#clear-search').hidden=!state.query;$('#clear-search').addEventListener('click',()=>{$('#search').value='';state.query='';$('#clear-search').hidden=true;applyFilters();$('#search').focus();$('#search').dispatchEvent(new Event('input'));});
function reset(){state.query=state.color=state.palette=state.tag='';$('#search').value='';$('#clear-search').hidden=true;applyFilters();}
$('#reset-filters').addEventListener('click',reset);$('#empty-reset').addEventListener('click',()=>{if(state.view==='saved'&&!saved.size)state.view='all';reset();});
let navHoverTimer;
for(const button of $$('[data-view]')){
  button.addEventListener('click',()=>{state.view=button.dataset.view;applyFilters();});
  button.addEventListener('pointerenter',()=>{clearTimeout(navHoverTimer);navHoverTimer=setTimeout(()=>{$('#nav-glider').style.width=`${button.offsetWidth}px`;$('#nav-glider').style.transform=`translateX(${button.offsetLeft}px)`;},90);});
}
$('.nav-track').addEventListener('pointerleave',()=>{clearTimeout(navHoverTimer);navHoverTimer=setTimeout(updateHeader,240);});
for(const button of $$('[data-density]'))button.addEventListener('click',()=>{state.density=button.dataset.density;for(const option of $$('[data-density]')){const active=option===button;option.classList.toggle('active',active);option.setAttribute('aria-pressed',String(active));}calculateLayout();renderWindow();lenis?.resize();});
$('#shuffle-button').addEventListener('click',()=>{state.sort='discover';state.seed=Math.floor(Math.random()*2147483646)+1;applyFilters();});
function setSidebar(open){$('#sidebar').classList.toggle('open',open);$('#sidebar-scrim').hidden=!open;if(!open)closeMenu();}
$('#mobile-filters').addEventListener('click',()=>setSidebar(true));$('#close-filters').addEventListener('click',()=>setSidebar(false));$('#sidebar-scrim').addEventListener('click',()=>setSidebar(false));
$('#about-button').addEventListener('click',()=>{closeMenu();$('#about-dialog').showModal();lenis?.stop();});$('#close-about').addEventListener('click',()=>$('#about-dialog').close());$('#about-dialog').addEventListener('close',()=>lenis?.start());$('#about-dialog').addEventListener('click',event=>{if(event.target===$('#about-dialog'))$('#about-dialog').close();});
$('#export-data').addEventListener('click',()=>{
  const payload={schema:'scarletpic-user-data-v1',exportedAt:new Date().toISOString(),saved:[...saved],tags:manualTags,ai:importedAi,aiModel:persisted.aiModel};const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='ScarletPic-my-collection.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Collection backup exported');
});
$('#import-data').addEventListener('click',()=>$('#import-file').click());
$('#import-file').addEventListener('change',async event=>{
  const file=event.target.files[0];if(!file)return;try{
    if(file.size>25*1024*1024)throw new Error('Choose a JSON file under 25 MB.');
    const data=JSON.parse(await file.text());
    if(['scarletpic-user-data-v1','qualtz-user-data-v1'].includes(data.schema)){
      for(const id of Array.isArray(data.saved)?data.saved:[])if(byId.has(id))saved.add(id);
      for(const [id,tags] of Object.entries(data.tags||{}))if(byId.has(id))manualTags[id]=cleanTags([...cleanTags(manualTags[id]),...cleanTags(tags)]);
      for(const [id,tags] of Object.entries(data.ai||{}))if(byId.has(id))importedAi[id]=cleanTags(tags);
      if(typeof data.aiModel==='string')persisted.aiModel=data.aiModel;
    }else if(data.images&&typeof data.images==='object'){
      let count=0;for(const [id,values] of Object.entries(data.images)){if(!byId.has(id)||!Array.isArray(values))continue;importedAi[id]=cleanTags(values.map(value=>typeof value==='string'?value:value?.tag));count++;}
      if(!count)throw new Error('No matching image IDs were found in that AI tags file.');persisted.aiModel=typeof data.model==='string'?data.model:'Imported AI tags';
    }else throw new Error('Use a collection backup or an AI tags JSON file from the included tagger.');
    allImages.forEach(indexRow);rebuildTagOptions();const stored=persist();applyFilters();if(currentImage)updateViewerTags();if(stored)toast('Tags and saved images imported');
  }catch(error){toast(error instanceof SyntaxError?'That file is not valid JSON.':error.message);}finally{event.target.value='';}
});
document.addEventListener('keydown',event=>{
  const typing=event.target instanceof HTMLInputElement||event.target instanceof HTMLTextAreaElement||event.target.isContentEditable;
  if(event.key==='Escape'&&openMenu){event.preventDefault();closeMenu(true);return;}
  if(typing)return;
  if(event.key==='/'&&!$('#viewer').open&&!$('#about-dialog').open){event.preventDefault();$('#search').focus();}
  if($('#viewer').open){if(event.key==='ArrowLeft'){event.preventDefault();navigateViewer(-1);}if(event.key==='ArrowRight'){event.preventDefault();navigateViewer(1);}if(event.key.toLowerCase()==='s'&&currentImage){event.preventDefault();toggleSaved(currentImage.id);}}
});
window.addEventListener('hashchange',()=>{if(!catalogue)return;const id=new URLSearchParams(location.hash.slice(1)).get('image');if(id&&byId.has(id))openViewer(byId.get(id),false);else closeViewer();});

function attachCaret(wrapper){
  const input=$('input',wrapper),caret=$('.smooth-caret',wrapper);if(!input||!caret)return;
  const canvas=document.createElement('canvas'),context=canvas.getContext('2d');
  function move(){requestAnimationFrame(()=>{if(!wrapper.isConnected)return;const style=getComputedStyle(input);context.font=`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;let selection;try{selection=input.selectionStart;}catch{}if(selection===null||selection===undefined)selection=input.value.length;const offset=input.offsetLeft+parseFloat(style.paddingLeft||0)+context.measureText(input.value.slice(0,selection)).width-input.scrollLeft;caret.style.transform=`translateX(${Math.min(wrapper.clientWidth-9,Math.max(input.offsetLeft,offset))}px)`;});}
  for(const event of ['input','keyup','click','focus','select','scroll'])input.addEventListener(event,move);document.addEventListener('selectionchange',()=>{if(document.activeElement===input)move();});move();
}
$$('[data-smooth-caret]').forEach(attachCaret);

function startBackground(){
  const canvas=$('#waves'),gl=canvas.getContext('webgl',{alpha:false,antialias:false,powerPreference:'low-power'});if(!gl)return Promise.resolve();
  const vertex=`attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}`;
  const fragment=`precision mediump float;uniform vec2 size;uniform float time;uniform vec2 pointer;void main(){vec2 uv=gl_FragCoord.xy/size;vec2 q=uv-pointer;float bend=exp(-dot(q,q)*13.);float wave=sin(uv.x*8.+uv.y*5.+time*.24+bend*1.7)+sin(uv.y*12.-uv.x*3.-time*.18)*.6;float veil=smoothstep(.1,1.8,wave)*(.45+uv.y*.3);vec2 cell=floor(gl_FragCoord.xy/2.);float d=fract(sin(dot(cell,vec2(12.9898,78.233)))*43758.5453);float tone=floor((veil+d*.13)*11.)/11.;vec3 col=vec3(.021,.019,.027)+tone*vec3(.16,.004,.014);gl_FragColor=vec4(col,1.);}`;
  function shader(type,source){const item=gl.createShader(type);gl.shaderSource(item,source);gl.compileShader(item);if(!gl.getShaderParameter(item,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(item));return item;}
  try{
    const program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,vertex));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);gl.useProgram(program);
    const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);const location=gl.getAttribLocation(program,'p');gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,2,gl.FLOAT,false,0,0);
    const size=gl.getUniformLocation(program,'size'),time=gl.getUniformLocation(program,'time'),pointer=gl.getUniformLocation(program,'pointer');let target=[.5,.5],current=[.5,.5],last=0;
    function resize(){canvas.width=Math.min(1440,Math.round(innerWidth*.8));canvas.height=Math.round(innerHeight*canvas.width/innerWidth);gl.viewport(0,0,canvas.width,canvas.height);}resize();window.addEventListener('resize',resize,{passive:true});
    window.addEventListener('pointermove',event=>{target=[event.clientX/innerWidth,1-event.clientY/innerHeight];},{passive:true});
    return new Promise(resolve=>{let first=true;function frame(timestamp){requestAnimationFrame(frame);if(document.hidden||timestamp-last<42)return;last=timestamp;current=current.map((value,index)=>value+(target[index]-value)*.035);gl.uniform2f(size,canvas.width,canvas.height);gl.uniform1f(time,timestamp/1000);gl.uniform2f(pointer,...current);gl.drawArrays(gl.TRIANGLES,0,6);if(first){first=false;resolve();}}requestAnimationFrame(frame);});
  }catch{canvas.hidden=true;return Promise.resolve();}
}
const backgroundReady=startBackground();
function progress(value){$('#loading-progress').style.transform=`scaleX(${value})`;}
async function boot(){
  progress(.12);$('#boot-retry').hidden=true;
  try{
    const [response, aiResponse]=await Promise.all([fetch('data/catalogue.json'),fetch('data/ai-tags.json').catch(()=>null)]);if(!response.ok)throw new Error('The image catalogue could not load.');progress(.45);
    catalogue=await response.json();if(!Array.isArray(catalogue.images)||!catalogue.images.length)throw new Error('The image catalogue is empty.');
    if(aiResponse?.ok){const ai=await aiResponse.json();if(ai&&typeof ai.images==='object')aiInfo=ai;}
    progress(.68);allImages=catalogue.images;byId=new Map(allImages.map(row=>[row.id,row]));saved=new Set([...saved].filter(id=>byId.has(id)));allImages.forEach(indexRow);rebuildTagOptions();
    if(!filterDefinitions.some(def=>def.key==='color'&&def.options().some(option=>option.value===state.color)))state.color='';
    if(!['','limited','multicolor','monochrome'].includes(state.palette))state.palette='';
    $('#filter-controls').replaceChildren();createFilterControls();$('#collection-count').textContent=shortNumber(allImages.length);$('#collection-count').title=`${allImages.length.toLocaleString()} images`;
    applyFilters(true,false);progress(.9);
    if(window.Lenis&&!lenis)lenis=new window.Lenis({wrapper:viewport,content:grid,lerp:.075,smoothWheel:true,autoRaf:true,gestureOrientation:'vertical'});
    await Promise.all([backgroundReady,Promise.race([document.fonts.ready,new Promise(resolve=>setTimeout(resolve,1000))])]);updateHeader();progress(1);
    requestAnimationFrame(()=>requestAnimationFrame(()=>{$('#loading-cover').classList.add('leaving');document.body.dataset.ready='true';}));
    const requested=new URLSearchParams(location.hash.slice(1)).get('image');if(requested&&byId.has(requested))openViewer(byId.get(requested),false);
  }catch(error){$('#loading-message').textContent=`${error.message} Serve the public folder over HTTP, or retry.`;$('#boot-retry').hidden=false;progress(.2);}
}
$('#boot-retry').addEventListener('click',boot);boot();
