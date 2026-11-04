import {element as el,glyph} from './ui.js';
import {pdfAnnotationRect,textAnnotationRect} from './annotation.js';

// Keep nearby markers separate until the visible lane reaches its capacity.
export function layoutMarkerRows(points, height, spacing=28) {
  const inset=5;
  const capacity=Math.floor((height-inset*2)/spacing);
  if (capacity<1) return [];
  const ordered=[...points].sort((a,b)=>a.y-b.y);
  if (ordered.length>capacity) {
    const groups=new Map();
    for (const point of ordered) {
      const row=Math.max(0,Math.min(capacity-1,Math.floor((point.y-inset)/spacing)));
      const group=groups.get(row)??[];
      group.push(point.annotation);
      groups.set(row,group);
    }
    return [...groups].map(([row,items])=>({top:inset+row*spacing,items}));
  }
  const rows=[];
  for (const point of ordered) {
    const top=Math.max(inset,point.y,(rows.at(-1)?.top??inset-spacing)+spacing);
    rows.push({top,items:[point.annotation]});
  }
  let limit=height-inset-spacing;
  for (let i=rows.length-1;i>=0;i--) {
    rows[i].top=Math.min(limit,rows[i].top);
    limit=rows[i].top-spacing;
  }
  return rows;
}

export function createNotes({state,visibleAnnotations,onActivate,onGroup}) {
  const gutter=document.getElementById('note-gutter');
  const pages=document.getElementById('pdf-pages');
  const textReader=document.getElementById('text-reader');
  const scroll=document.getElementById('reader-scroll');
  const markers=new Map();
  let frame=0;
  let activeId=null;

  function sourceRect(annotation) {
    if (!state.pdf) return textAnnotationRect(textReader,annotation);
    const page=pages.children[(Number(annotation.page)||1)-1];
    return page ? pdfAnnotationRect(annotation,page.getBoundingClientRect()) : null;
  }

  function refresh() {
    cancelAnimationFrame(frame);
    frame=requestAnimationFrame(()=>{
      if (state.tab!=='read') return;
      const bounds=gutter.getBoundingClientRect();
      const points=[];
      for (const annotation of visibleAnnotations()) {
        const rect=sourceRect(annotation);
        if (!rect || rect.bottom<bounds.top || rect.top>=bounds.bottom) continue;
        points.push({annotation,y:rect.top-bounds.top});
      }
      const used=new Set();
      for (const row of layoutMarkerRows(points,bounds.height)) {
        const ids=row.items.map(annotation=>annotation.id);
        const key=JSON.stringify(ids);
        used.add(key);
        let button=markers.get(key);
        if (!button) {
          const label=row.items.length===1?'查看原文批注':`查看 ${row.items.length} 条批注`;
          button=el('button',{type:'button',class:'note-marker',title:label,'aria-label':label},glyph('message-circle-more',15));
          if (row.items.length>1) button.append(el('span',{class:'marker-count','aria-hidden':'true'},row.items.length));
          button.addEventListener('click',()=>{
            const current=visibleAnnotations().filter(annotation=>ids.includes(annotation.id));
            if (current.length===1) onActivate(current[0]);
            else if (current.length) onGroup(current);
          });
          markers.set(key,button);
          gutter.append(button);
        }
        button.style.top=`${row.top}px`;
        button.classList.toggle('active',ids.includes(activeId));
      }
      for (const [key,button] of markers) {
        if (!used.has(key)) {
          button.remove();
          markers.delete(key);
        }
      }
    });
  }

  function locate(annotation) {
    const rect=sourceRect(annotation);
    if (!rect) return false;
    const viewport=scroll.getBoundingClientRect();
    scroll.scrollTop+=rect.top-viewport.top-Math.max(0,(viewport.height-rect.height)*.38);
    if (rect.left<viewport.left+12 || rect.right>viewport.right-12) {
      scroll.scrollLeft+=rect.left-viewport.left-36;
    }
    activeId=annotation.id;
    refresh();
    return true;
  }

  scroll.addEventListener('scroll',refresh,{passive:true});
  new ResizeObserver(refresh).observe(gutter);
  return {refresh,locate,setActive(id){activeId=id;refresh();},get activeId(){return activeId;}};
}
