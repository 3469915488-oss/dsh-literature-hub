/* Coordinate and text anchors for the locally rendered PDF.js reader.
 * PDF canvas / TextLayer integration is derived from GGboya/dsh-paper-reader (MIT).
 * https://github.com/GGboya/dsh-paper-reader — original license retained in vendor notices. */
const SVG='http://www.w3.org/2000/svg';
const clip=n=>Math.max(0,Math.min(1,n));
export const uuid=()=>crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const svg=(tag,attributes={})=>{const e=document.createElementNS(SVG,tag);for(const [k,v] of Object.entries(attributes))e.setAttribute(k,String(v));return e;};
export function captureSelection(root){
  const selection=getSelection();
  if(!selection?.rangeCount||selection.isCollapsed||!selection.toString().trim())return null;
  const range=selection.getRangeAt(0);
  if(!root.contains(range.startContainer)||!root.contains(range.endContainer))return null;
  const quote=selection.toString().trim(),bounds=range.getBoundingClientRect(),anchors=[];
  const textRoot=range.startContainer.parentElement?.closest('#text-reader');
  if(textRoot&&textRoot.contains(range.endContainer)){
    const before=range.cloneRange();before.selectNodeContents(textRoot);before.setEnd(range.startContainer,range.startOffset);
    const start=before.toString().length,end=start+range.toString().length;
    anchors.push({page:null,anchor:{quote:range.toString(),start,end,prefix:textRoot.textContent.slice(Math.max(0,start-40),start),suffix:textRoot.textContent.slice(end,end+40)}});
  }else{
    for(const page of root.querySelectorAll('.pdf-page')){
      const layer=page.querySelector('.textLayer');if(!layer||!range.intersectsNode(layer))continue;
      const box=page.getBoundingClientRect(),rects=[];
      for(const r of range.getClientRects()){
        const x=Math.max(r.left,box.left),y=Math.max(r.top,box.top),right=Math.min(r.right,box.right),bottom=Math.min(r.bottom,box.bottom);
        if(right-x>1&&bottom-y>1)rects.push({x:clip((x-box.left)/box.width),y:clip((y-box.top)/box.height),width:clip((right-x)/box.width),height:clip((bottom-y)/box.height)});
      }
      if(rects.length){const partial=range.cloneRange();try{if(!layer.contains(range.startContainer))partial.setStart(layer,0);if(!layer.contains(range.endContainer))partial.setEnd(layer,layer.childNodes.length);}catch{}anchors.push({page:Number(page.dataset.page),rects,anchor:{quote:partial.toString().trim()||quote}});}
    }
  }
  return anchors.length?{text:quote,anchors,bounds:{left:bounds.left,top:bounds.top,bottom:bounds.bottom,width:bounds.width}}:null;
}
export function renderPdfMarks(page,items,onDraw){
  page.querySelector('.page-mark-layer')?.remove();
  const layer=svg('svg',{class:'page-mark-layer',viewBox:'0 0 1000 1000',preserveAspectRatio:'none','aria-hidden':'true'});
  for(const item of items.filter(a=>Number(a.page)===Number(page.dataset.page))){
    if(item.type==='draw'&&Array.isArray(item.points)){
      const path=svg('polyline',{points:item.points.map(p=>`${p.x*1000},${p.y*1000}`).join(' '),fill:'none',stroke:item.color||'#ce5938','stroke-width':2,'vector-effect':'non-scaling-stroke','stroke-linecap':'round','stroke-linejoin':'round'});layer.append(path);
    }else for(const r of item.rects||[]){
      if(item.type==='underline')layer.append(svg('line',{x1:r.x*1000,y1:(r.y+r.height)*1000,x2:(r.x+r.width)*1000,y2:(r.y+r.height)*1000,stroke:item.color||'#d09b00','stroke-width':2,'vector-effect':'non-scaling-stroke'}));
      else layer.append(svg('rect',{x:r.x*1000,y:r.y*1000,width:r.width*1000,height:r.height*1000,fill:item.color||'#e3ac00','fill-opacity':.28}));
    }
  }
  let points=[],path=null,pointerId=null;
  const position=e=>{const r=layer.getBoundingClientRect();return{x:clip((e.clientX-r.left)/r.width),y:clip((e.clientY-r.top)/r.height)};};
  layer.addEventListener('pointerdown',e=>{if(!page.closest('.drawing'))return;e.preventDefault();pointerId=e.pointerId;layer.setPointerCapture(pointerId);points=[position(e)];path=svg('polyline',{fill:'none',stroke:document.querySelector('#mark-color').value,'stroke-width':2,'vector-effect':'non-scaling-stroke','stroke-linecap':'round'});layer.append(path);});
  layer.addEventListener('pointermove',e=>{if(e.pointerId!==pointerId)return;points.push(position(e));path.setAttribute('points',points.map(p=>`${p.x*1000},${p.y*1000}`).join(' '));});
  const end=e=>{if(e.pointerId!==pointerId)return;pointerId=null;if(points.length>1)onDraw({page:Number(page.dataset.page),points:[...points]});else path?.remove();points=[];};
  layer.addEventListener('pointerup',end);layer.addEventListener('pointercancel',end);
  page.append(layer);return layer;
}
export function resolveTextAnchor(text, anchor) {
  const quote=anchor?.quote;
  if (typeof quote!=='string' || !quote) return null;
  const {start,end}=anchor;
  if (Number.isInteger(start) && Number.isInteger(end) && text.slice(start,end)===quote) {
    return {start,end};
  }
  for (let index=text.indexOf(quote); index>=0; index=text.indexOf(quote,index+1)) {
    const stop=index+quote.length;
    const prefixMatches=!anchor.prefix || text.slice(Math.max(0,index-anchor.prefix.length),index)===anchor.prefix;
    const suffixMatches=!anchor.suffix || text.slice(stop,stop+anchor.suffix.length)===anchor.suffix;
    if (prefixMatches && suffixMatches) return {start:index,end:stop};
  }
  return null;
}

export function pdfAnnotationRect(annotation, pageRect) {
  const position=annotation.rects?.[0] ?? annotation.points?.[0];
  if (!position || !pageRect) return null;
  const left=pageRect.left+position.x*pageRect.width;
  const top=pageRect.top+position.y*pageRect.height;
  const width=(position.width??0)*pageRect.width;
  const height=(position.height??0)*pageRect.height;
  return {left,top,right:left+width,bottom:top+height,width,height};
}

export function textAnnotationRect(root, annotation) {
  const existing=root.querySelector(`[data-annotations~="${CSS.escape(annotation.id)}"]`);
  if (existing) return existing.getClientRects?.()[0] ?? existing.getBoundingClientRect();
  const match=resolveTextAnchor(root.textContent??'',annotation.anchor);
  if (!match || !document.createTreeWalker || !document.createRange) return null;
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  let offset=0;
  let range=null;
  for (let node=walker.nextNode();node;node=walker.nextNode()) {
    const next=offset+node.textContent.length;
    if (!range && match.start<next) {
      range=document.createRange();
      range.setStart(node,match.start-offset);
    }
    if (range && match.end<=next) {
      range.setEnd(node,match.end-offset);
      return range.getClientRects()[0] ?? range.getBoundingClientRect();
    }
    offset=next;
  }
  return null;
}

export function renderTextMarks(root,text,items){
  const usable=items.filter(a=>a.type!=='draw'&&a.anchor).flatMap(a=>{
    const position=resolveTextAnchor(text,a.anchor);
    return position ? [{...a,...position}] : [];
  });
  // Render disjoint text segments to preserve overlapping annotations without HTML injection.
  const positions=[...new Set([0,text.length,...usable.flatMap(a=>[a.start,a.end])])].filter(n=>n>=0&&n<=text.length).sort((a,b)=>a-b),fragment=document.createDocumentFragment();
  for(let i=0;i<positions.length-1;i++){
    const start=positions[i],end=positions[i+1],marks=usable.filter(a=>a.start<=start&&a.end>=end),content=text.slice(start,end);
    if(!marks.length){fragment.append(document.createTextNode(content));continue;}
    const node=document.createElement('mark');node.textContent=content;node.dataset.annotation=marks.at(-1).id;node.dataset.annotations=marks.map(mark=>mark.id).join(' ');
    const high=marks.find(a=>a.type==='highlight'),under=marks.find(a=>a.type==='underline');
    node.style.background=high?`${high.color||'#e3ac00'}55`:'transparent';
    if(under){node.classList.add('underline-mark');node.style.textDecorationColor=under.color||'#b18100';}
    node.title=marks.map(a=>a.note||'已保存批注').join('\n');fragment.append(node);
  }
  root.replaceChildren(fragment);
}

/** Attach deterministic paragraph IDs to a selection in blocks joined with two newlines. */
export function locateTextAnchor(anchor,blocks=[]){
  if(!anchor||!Array.isArray(blocks)||!blocks.length)return anchor;
  const start=Number(anchor.start),end=Number(anchor.end);if(!Number.isFinite(start)||!Number.isFinite(end))return anchor;
  let position=0;const ids=[];for(const block of blocks){const text=String(block.text??''),next=position+text.length;if(end>position&&start<next){const id=block.blockId||block.id;if(id)ids.push(id);}position=next+2;}
  return ids.length?{...anchor,blockId:ids[0],...(ids.length>1?{blockIds:ids}:{})}:anchor;
}
