/* Literature hub UI. Reading pipeline reuses local PDF.js getDocument, canvas.render,
 * TextLayer and exact text-layer geometry from @ggboy123/dsh-paper-reader (MIT).
 * No library content is injected as HTML. Original documents and anchors stay local. */
import {captureSelection,renderPdfMarks,renderTextMarks,locateTextAnchor,uuid} from './annotation.js';
import {icon} from './icons.js';
import {glyph,hydrateIcons} from './ui.js';
import {createFolders} from './folders.js';
import {createNotes} from './notes.js';
import {createStudy} from './study.js';
import {createNoteEditor} from './editor.js';
import {createVoicePanel} from './voice.js';
const $=id=>document.getElementById(id),BASE='/literature-hub/api';
const state={documents:[],document:null,scope:'library',tab:'read',tool:'select',pdf:null,pdfLib:null,page:1,zoom:1,fit:true,selection:null,token:0,dirty:new Set(),saving:new Map(),timers:new Map(),queryToken:0,session:null,theme:'light',metadataRevision:0,metadataDirty:false,path:'文献库/未分类',writeQueue:Promise.resolve(),layout:null,notesBaseRevision:0,directoryOpen:true,themeOverride:null,previewRevision:1,previewReadOnly:false};
let retryAction=null,noticeTimer=null;
function el(tag,attrs={},...children){const node=document.createElement(tag);for(const[k,v]of Object.entries(attrs)){if(k==='class')node.className=v;else if(k.startsWith('on'))node.addEventListener(k.slice(2).toLowerCase(),v);else if(v!=null)node.setAttribute(k,v);}for(const child of children.flat())if(child!=null)node.append(child instanceof Node?child:document.createTextNode(String(child)));return node;}
async function api(route,options={}){const response=await fetch(BASE+route,{...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}});let body;const raw=await response.text();try{body=JSON.parse(raw);}catch{if(response.ok)throw new Error('服务返回了无法读取的内容');}if(!response.ok){const error=new Error(body?.error?.message||body?.error||body?.message||`请求失败（${response.status}）`);error.status=response.status;error.body=body;throw error;}return body;}
const post=(route,body)=>api(route,{method:'POST',body:JSON.stringify(body)});
function notice(message,{retry,draft=false,temporary=false,actionLabel='重试'}={}){clearTimeout(noticeTimer);$('notice-message').textContent=message;$('notice').hidden=false;retryAction=retry;$('notice-retry').hidden=!retry;$('notice-retry').textContent=actionLabel;$('notice-download').hidden=!draft;if(temporary)noticeTimer=setTimeout(()=>{$('notice').hidden=true;},6500);}
function errorNotice(error,retry){notice(error.message||String(error),{retry,draft:state.dirty.size>0});}
function saveLabel(text){$('save-status').textContent=text;}
function draftKey(kind,id=state.document?.id){return `dsh-literature-hub-draft:${id}:${kind}`;}
function storeDraft(kind,value){
  const draft={value,at:new Date().toISOString()};
  if (kind==='notes') {
    draft.baseRevision=state.notesBaseRevision;
    draft.baseAnnotationsRevision=state.notesBaseAnnotationsRevision;
  }
  try { localStorage.setItem(draftKey(kind),JSON.stringify(draft)); }
  catch { notice('浏览器草稿空间不足，请保存或导出后再继续。',{draft:true}); }
}
function readDraft(kind){try{return JSON.parse(localStorage.getItem(draftKey(kind))||'null');}catch{return null;}}
function clearDraft(kind,id=state.document?.id){try{localStorage.removeItem(draftKey(kind,id));}catch{}}
function download(content,name,type='text/plain;charset=utf-8'){const url=URL.createObjectURL(new Blob([content],{type})),a=el('a',{href:url,download:name});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);}
function exportDraft(){const d=state.document;if(!d)return;download(JSON.stringify({title:d.title,id:d.id,notes:notesValue(),annotations:d.annotations,study:d.study,metadata:readDraft('metadata')?.value},null,2),`${safeName(d.title)}-阅读草稿.json`,'application/json');}
const safeName=s=>String(s||'文献').replace(/[\\/:*?"<>|]/g,'_').slice(0,100);
const listFrom=result=>Array.isArray(result)?result:result?.documents||result?.hits||result?.results||result?.items||[];
const normalizedType=t=>['doc','docx','word','document'].includes(t)?'docx':['markdown','txt','text'].includes(t)?'md':['html','url','website'].includes(t)?'web':t;
function contentFromNotes(notes={}) {
  notes??={};
  if (Array.isArray(notes.content)) return structuredClone(notes.content);
  const markdown=typeof notes==='string'?notes:notes.freeText??notes.text??'';
  const content=markdown?[{kind:'markdown',markdown}]:[];
  for (const block of notes.blocks??[]) {
    content.push({...block,kind:'quote',id:block.id||block.noteId||uuid(),quote:block.quote??'',text:block.text??''});
  }
  return content;
}
const removedAnnotations=new Map();
let savedAnnotationIds=new Set();
function restoredAnnotations(content) {
  return [...removedAnnotations.values()].filter(entry=>entry.saved&&noteBlock(entry.annotation,content)).map(entry=>entry.annotation);
}
function notesValue(){
  const content=noteEditor.getContent(),restoreAnnotations=restoredAnnotations(content);
  return restoreAnnotations.length?{content,restoreAnnotations}:{content};
}
function valueFor(kind){
  if (kind==='notes') return notesValue();
  return structuredClone(kind==='annotations'?state.document.annotations.items:state.document.study);
}
function noteBlock(annotation,content=noteEditor.getContent()) {
  return content.find(block=>block.kind==='quote'&&(block.id===annotation.noteId||block.annotationId===annotation.id));
}
function currentAnnotations(content) {
  if (!state.document) return [];
  if (!removedAnnotations.size) return state.document.annotations.items;
  content??=noteEditor.getContent();
  const saved=state.document.notes.content;
  return [...state.document.annotations.items.filter(annotation=>!noteBlock(annotation,saved)||noteBlock(annotation,content)),...restoredAnnotations(content)];
}
function sameValue(a,b){return JSON.stringify(a)===JSON.stringify(b);}
function replaceEditorContent(content){
  if (!sameValue(noteEditor.getContent(),content)) noteEditor.setContent(content);
}
function applyReturnedNotes(incoming,{unchanged=false,notesWrite=false}={}) {
  if (!incoming) return;
  const previous=state.document.notes;
  const content=contentFromNotes(incoming);
  state.document.notes={...incoming,content};
  if (notesWrite || !state.dirty.has('notes')) {
    state.notesBaseRevision=incoming.revision;
    if (!state.dirty.has('notes') || unchanged) replaceEditorContent(content);
    return;
  }
  // While an annotation request was in flight, the editor may have gained a draft.
  // Only merge new quote blocks when the server kept every prior block unchanged.
  if (state.notesBaseRevision!==previous.revision) return;
  const oldIds=new Set(previous.content.filter(block=>block.kind==='quote').map(block=>block.id));
  const added=block=>block.kind==='quote'&&!oldIds.has(block.id);
  const comparable=blocks=>blocks.map(block=>block.kind==='markdown'?{...block,markdown:block.markdown.replace(/\n+$/,'')}:block);
  if (!sameValue(comparable(content.filter(block=>!added(block))),comparable(previous.content))) return;
  const current=noteEditor.getContent();
  const currentIds=new Set(current.filter(block=>block.kind==='quote').map(block=>block.id));
  replaceEditorContent([...current,...content.filter(block=>added(block)&&!currentIds.has(block.id))]);
  state.notesBaseRevision=incoming.revision;
  storeDraft('notes',notesValue());
}
function updateSavedDocument(returned,kind,unchanged) {
  const saved=returned?.document||returned;
  const current=state.document;
  if (!saved || saved.id!==current?.id) return;
  const marksChanged=kind==='notes'&&saved.annotations&&!sameValue(current.annotations.items.map(item=>item.id),saved.annotations.items.map(item=>item.id));
  if (kind==='notes'&&saved.annotations) {
    const ids=new Set(saved.annotations.items.map(annotation=>annotation.id));
    for (const [id,entry] of removedAnnotations) {
      if (!ids.has(id)) entry.saved=true;
      else if (entry.saved) removedAnnotations.delete(id);
    }
  }
  if (saved.annotations) {
    if (kind==='notes'||state.notesBaseAnnotationsRevision===current.annotations.revision) state.notesBaseAnnotationsRevision=saved.annotations.revision;
    if (kind==='annotations'&&unchanged || !state.dirty.has('annotations')) current.annotations=saved.annotations;
    else {
      const persisted=new Map(saved.annotations.items.map(annotation=>[annotation.id,annotation]));
      current.annotations.revision=saved.annotations.revision;
      current.annotations.items=current.annotations.items.flatMap(annotation=>{
        const latest=persisted.get(annotation.id);
        if (!latest) return savedAnnotationIds.has(annotation.id)?[]:[annotation];
        return [{...annotation,note:latest.note,noteId:latest.noteId,noteSuppressed:latest.noteSuppressed}];
      });
    }
    savedAnnotationIds=new Set(saved.annotations.items.map(annotation=>annotation.id));
  }
  if (saved.study?.revision!=null) current.study.revision=saved.study.revision;
  if (kind==='notes'||kind==='annotations') {
    applyReturnedNotes(saved.notes,{unchanged,notesWrite:kind==='notes'});
    for (const annotation of current.annotations.items) {
      const block=noteBlock(annotation,current.notes.content);
      if (block) annotation.noteId=block.id;
    }
    if (marksChanged) redrawMarks();
    else { renderAnnotations(); notes.refresh(); }
  }
}
function dirty(kind) {
  if (!state.document || state.document.readOnly) return;
  state.dirty.add(kind);
  saveLabel('未保存');
  if (kind==='notes') {
    $('notes-dot').textContent='•';
    $('note-state').textContent='保存中';
  }
  storeDraft(kind,valueFor(kind));
  clearTimeout(state.timers.get(kind));
  state.timers.set(kind,setTimeout(()=>save(kind).catch(errorNotice),900));
}
async function save(kind) {
  const id=state.document?.id;
  if (!id || !state.dirty.has(kind)) return true;
  // Save existing prose before a mark can append a quote and change its revision.
  if (kind==='annotations' && state.dirty.has('notes') && !state.saving.has(kind)) {
    if (!await save('notes')) return false;
  }
  if (state.document?.id!==id || !state.dirty.has(kind)) return true;
  if (state.saving.has(kind)) {
    const ok=await state.saving.get(kind);
    return ok&&state.dirty.has(kind)?save(kind):ok;
  }
  const work=async()=>{
    if (state.document?.id!==id || !state.dirty.has(kind)) return true;
    const doc=state.document;
    const value=valueFor(kind);
    const body=kind==='notes'?{id,...value,expectedRevision:state.notesBaseRevision,expectedAnnotationsRevision:state.notesBaseAnnotationsRevision}
      :kind==='annotations'?{id,annotations:value,expectedRevision:doc.annotations.revision,expectedNotesRevision:state.notesBaseRevision}
      :{id,study:value,expectedRevision:doc.study.revision};
    saveLabel('保存中');
    try {
      const result=await post('/'+kind,body);
      if (state.document?.id!==id) return true;
      const unchanged=sameValue(value,valueFor(kind));
      updateSavedDocument(result,kind,unchanged);
      if (unchanged) {
        state.dirty.delete(kind);
        clearDraft(kind,id);
        if (kind==='notes') {
          $('notes-dot').textContent='';
          $('note-state').textContent='已保存 · '+new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
        }
      } else storeDraft(kind,valueFor(kind));
      saveLabel(state.dirty.size?'未保存':'已保存');
      return true;
    } catch (error) {
      if (state.document?.id!==id) return false;
      saveLabel('保存失败');
      if (kind==='notes') $('note-state').textContent='草稿已保留';
      const conflict=error.status===409;
      notice(conflict?'记录已更新，当前草稿已保留。请导出草稿后合并。':`保存失败：${error.message}`,{
        retry:conflict?()=>reloadAfterConflict(kind):()=>save(kind),draft:true
      });
      return false;
    }
  };
  const pending=state.writeQueue.then(work,work);
  state.writeQueue=pending.catch(()=>{});
  state.saving.set(kind,pending);
  try { return await pending; }
  finally { state.saving.delete(kind); }
}
async function reloadAfterConflict(kind) {
  if (!confirm('将导出当前草稿并读取知识库中的最新记录。')) return;
  exportDraft();
  clearDraft(kind);
  state.dirty.clear();
  for (const timer of state.timers.values()) clearTimeout(timer);
  await openDocument(state.document.id,{force:true});
}
async function flush(){
  for (const timer of state.timers.values()) clearTimeout(timer);
  for (const kind of [...state.dirty]) if (!await save(kind)) return false;
  return !state.dirty.size;
}
async function loadStatus(){try{const s=await api('/status');$('connection-status').textContent='本地知识库';$('connection-status').title=s.vaultPath||s.root||'';}catch(e){$('connection-status').textContent='连接失败';errorNotice(e,loadStatus);}}
async function loadDocuments(){const query=$('search').value.trim(),type=$('type-filter').value,tag=$('tag-filter').value.trim(),token=++state.queryToken;$('list-title').textContent=query?'检索结果':state.path.split('/').at(-1)||'知识库';try{const params=new URLSearchParams({q:query,scope:'vault',path:state.path,type,tag}),result=(query||type||tag)?await api('/search?'+params):await api('/documents?'+params);if(token!==state.queryToken)return;state.documents=listFrom(result);renderDocuments();}catch(e){if(token!==state.queryToken)return;errorNotice(e,loadDocuments);}}
async function openItem(item) {
  try {
    if (!await flush()) return;
    const noteOwner=item.linkedDocumentId??(item.noteId?item.id:null);
    if (noteOwner) {
      if (!await openDocument(noteOwner)) return;
      setTab('notes');
      if (item.noteId) noteEditor.focusQuote(item.noteId);
      return;
    }
    let id=item.id;
    if (!id) {
      const result=await post('/register',{path:item.path||item.notePath});
      id=(result.document||result).id;
    }
    if (!await openDocument(id)) return;
    if (item.page) jumpPage(item.page);
    if (item.snippet) flashQuote(item.snippet);
  } catch (error) { errorNotice(error,()=>openItem(item)); }
}
function renderDocuments(){const root=$('documents');root.replaceChildren();$('doc-count').textContent=String(state.documents.length);if(!state.documents.length){root.append(el('p',{class:'list-empty'},$('search').value?'无匹配结果':'暂无资料'));return;}for(const item of state.documents){const d=item.document||item,type=normalizedType(d.type||d.format||'md'),copy=el('span',{class:'document-copy'},el('strong',{},d.title||d.name||d.path||'未命名资料'));const snippet=d.snippet||d.excerpt||d.summary;if(snippet)copy.append(el('p',{},String(snippet).slice(0,110)));const tags=d.tags||[];copy.append(el('small',{},[({pdf:'PDF',docx:'Word',md:'Markdown',web:'网页'})[type]||type,...tags.slice(0,2).map(t=>'#'+t),d.page?'第 '+d.page+' 页':''].filter(Boolean).join(' · ')));const card=el('button',{class:'document-card'+(d.id===state.document?.id?' selected':''),role:'listitem',onclick:()=>openItem(d),title:d.path||d.title||''},el('span',{class:'document-file-icon'},glyph(d.linkedDocumentId?'sticky-note':'file-text',21)),copy);const row=el('div',{class:'document-row'},card);if(!d.linkedDocumentId&&!d.noteId&&d.kind!=='note')row.append(el('button',{class:'document-move icon-button',title:'移动资料','aria-label':'移动资料',onclick:()=>folders.moveDocument(d).catch(errorNotice)},glyph('move',13)));root.append(row);}}
async function openDocument(id,{force=false}={}) {
  if (!force&&!await flush()) {
    notice('请先保存或导出当前草稿，再打开其他资料。',{draft:true,retry:()=>openDocument(id)});
    return false;
  }
  const token=++state.token;
  $('reader-loading').hidden=false;
  try {
    const result=await api('/document?'+new URLSearchParams({id}));
    if (token!==state.token) return false;
    await displayDocument(result?.document||result);
    return state.document?.id===id;
  } catch (error) {
    errorNotice(error,()=>openDocument(id,{force}));
    return false;
  } finally { $('reader-loading').hidden=true; }
}
function renderDocumentHeader() {
  const doc=state.document;
  const type=normalizedType(doc.type);
  $('document-title').textContent=doc.title||'未命名资料';
  $('document-meta').textContent=({pdf:'PDF',docx:'Word',md:'Markdown',web:'网页'})[type]||'资料';
  $('document-tags').replaceChildren(...(doc.tags||[]).map(tag=>tagPill(tag)));
}
async function displayDocument(d){
  const token=++state.token;
  const switched=state.document?.id!==d.id;
  if (switched) removedAnnotations.clear();
  state.document=d;
  inlineAnnotationId=null;
  state.previewRevision=Number(d.previewRevision)||1;
  state.previewReadOnly=false;
  d.notes={revision:0,...d.notes,content:contentFromNotes(d.notes)};
  d.annotations=d.annotations||{items:[],revision:0};
  d.annotations.items=d.annotations.items||[];
  savedAnnotationIds=new Set(d.annotations.items.map(annotation=>annotation.id));
  d.study=d.study||{};
  state.notesBaseRevision=d.notes.revision;
  state.notesBaseAnnotationsRevision=d.annotations.revision;
  state.dirty.clear();
  state.page=d.progress?.page||1;
  state.zoom=d.progress?.zoom||1;
  dismissSelection();
  renderPreviewVersions();
  notes.setActive(null);
  if(state.pdf){try{await state.pdf.destroy();}catch{}state.pdf=null;}
  $('pdf-pages').replaceChildren();
  $('text-reader').replaceChildren();
  let content=d.notes.content;
  for (const kind of ['notes','annotations','study']) {
    const draft=readDraft(kind);
    if (!draft) continue;
    if (kind==='notes') {
      content=contentFromNotes(draft.value);
      for (const annotation of draft.value.restoreAnnotations??[]) {
        if (!d.annotations.items.some(item=>item.id===annotation.id)) removedAnnotations.set(annotation.id,{annotation,saved:true});
      }
      for (const annotation of d.annotations.items) {
        if (noteBlock(annotation,d.notes.content)&&!noteBlock(annotation,content)) removedAnnotations.set(annotation.id,{annotation:structuredClone(annotation),saved:false});
      }
      if (Number.isInteger(draft.baseRevision)) state.notesBaseRevision=draft.baseRevision;
      if (Number.isInteger(draft.baseAnnotationsRevision)) state.notesBaseAnnotationsRevision=draft.baseAnnotationsRevision;
    } else if (kind==='annotations') d.annotations.items=draft.value;
    else d.study={...draft.value,revision:d.study.revision};
    state.dirty.add(kind);
  }
  if(switched)noteEditor.setContent(content,{reset:true});else replaceEditorContent(content);
  voice.setDocument(d);
  $('empty').hidden=true;
  $('opened').hidden=false;
  renderDocumentHeader();
  $('metadata-edit').hidden=!!d.readOnly;
  $('rename-open').hidden=!!d.readOnly;
  $('delete-open').hidden=!!d.readOnly;
  $('reparse').hidden=d.parseStatus!=='failed'&&!['font-warning','failed','partial'].includes((d.preview||d.parseDetails?.preview)?.status);
  $('citation').hidden=false;
  state.metadataDirty=!!readDraft('metadata');
  $('notes-save').disabled=!!d.readOnly;
  $('note-editor').toggleAttribute('inert',!!d.readOnly);
  $('study-start').disabled=!!d.readOnly;
  $('study-save').disabled=!!d.readOnly;
  $('notes-dot').textContent=state.dirty.has('notes')?'•':'';
  $('note-state').textContent=state.dirty.has('notes')?'草稿已恢复':'已保存';
  saveLabel(state.dirty.size?'草稿已恢复':'已保存');
  renderDocuments();
  renderAnnotations();
  renderStudy();
  setTab('read');
  if (!d.readOnly) parentMessage({type:'hub-select',docId:d.id});
  $('ask-doc').replaceChildren(glyph('message-square',13),'讨论');
  if(state.dirty.size)notice('发现上次未保存的修改，已恢复在编辑区。请检查后保存。',{draft:true,retry:()=>flush()});else if(d.parseStatus==='failed')notice('正文解析未完成。'+(d.warnings?.length?' '+d.warnings.join('；'):''),{retry:()=>reparseDocument()});else if(['font-warning','failed'].includes((d.preview||d.parseDetails?.preview)?.status))notice('Word 预览字体异常，已切换文本。',{retry:()=>reparseDocument()});else if(d.ocr?.errors?.length)notice('部分页面文字识别未完成：'+d.ocr.errors.map(e=>typeof e==='string'?e:JSON.stringify(e)).join('；'),{temporary:false});
  const preview=d.preview||d.parseDetails?.preview;const pdf=(normalizedType(d.type)==='pdf'||!!d.pdfPath)&&!['font-warning','failed'].includes(preview?.status);if(!pdf&&normalizedType(d.type)==='docx'){$('document-meta').textContent+=' · 文本预览';}$('reader-loading').hidden=false;
  try{if(pdf){$('text-reader').hidden=true;$('pdf-pages').hidden=false;await loadPdf(d.id,token);}else{$('pdf-pages').hidden=true;$('text-reader').hidden=false;renderTextMarks($('text-reader'),d.text||'（此资料没有可读取的正文）',visibleAnnotations());$('page-number').value='1';$('page-count').textContent='/ 1';$('zoom-label').textContent='100%';updateProgress();notes.refresh();}}catch(e){if(token!==state.token)return;$('pdf-pages').hidden=true;$('text-reader').hidden=false;$('text-reader').textContent=d.text||'资料无法预览，也没有可读取的正文。';errorNotice(new Error('预览失败：'+e.message),()=>openDocument(d.id,{force:true}));}finally{$('reader-loading').hidden=true;}
}
function geometric(a){return Array.isArray(a.rects)&&a.rects.length||Array.isArray(a.points)&&a.points.length;}
function visibleAnnotations(){return currentAnnotations().filter(a=>geometric(a)?Number(a.previewRevision||1)===state.previewRevision&&(state.previewReadOnly||!a.stale):!a.stale);}
function canNavigateAnnotation(a){if(!a)return false;if(!geometric(a))return !a.stale;const revision=Number(a.previewRevision||1);return revision===Number(state.document.previewRevision||1)?!a.stale:(state.document.previewHistory||[]).some(v=>Number(v.revision)===revision);}
function renderPreviewVersions(){const d=state.document,select=$('preview-version'),current=Number(d.previewRevision)||1,revisions=new Map((d.previewHistory||[]).map(v=>[Number(v.revision),v]));revisions.set(current,{revision:current,pageCount:d.pageCount||d.pages?.length});select.replaceChildren();for(const [revision,value]of [...revisions].sort((a,b)=>b[0]-a[0]))select.append(el('option',{value:revision},(revision===current?'当前':'版本 '+revision)+(value.pageCount?' · '+value.pageCount+'页':'')));select.value=String(state.previewRevision);select.hidden=revisions.size<2;for(const tool of document.querySelectorAll('[data-tool]'))tool.disabled=state.previewReadOnly;$('mark-color').disabled=state.previewReadOnly;}
async function selectPreview(revision){if(!state.document||!await flush())return false;revision=Number(revision);if(revision!==Number(state.document.previewRevision||1)&&!(state.document.previewHistory||[]).some(v=>Number(v.revision)===revision))return false;notes.setActive(null);const token=++state.token;state.previewRevision=revision;state.previewReadOnly=revision!==Number(state.document.previewRevision||1);state.tool='select';$('reader-scroll').classList.remove('drawing');for(const tool of document.querySelectorAll('[data-tool]'))tool.classList.toggle('active',tool.dataset.tool==='select');if(state.pdf){try{await state.pdf.destroy();}catch{}state.pdf=null;}$('pdf-pages').replaceChildren();renderPreviewVersions();$('reader-loading').hidden=false;try{if(!state.previewReadOnly&&!state.document.pdfPath&&normalizedType(state.document.type)!=='pdf'){$('text-reader').hidden=false;$('pdf-pages').hidden=true;renderTextMarks($('text-reader'),state.document.text||'',visibleAnnotations());updateProgress();}else{$('text-reader').hidden=true;$('pdf-pages').hidden=false;await loadPdf(state.document.id,token);}renderAnnotations();notes.refresh();return true;}catch(e){errorNotice(e,()=>selectPreview(revision));return false;}finally{$('reader-loading').hidden=true;}}
async function navigateAnnotation(annotation) {
  if (!canNavigateAnnotation(annotation)) return;
  const documentId=state.document.id;
  setTab('read');
  if (geometric(annotation)&&Number(annotation.previewRevision||1)!==state.previewRevision) {
    if (!await selectPreview(annotation.previewRevision||1)) return;
  }
  if ($('reader-area').clientWidth<760) setAnnotationsOpen(false);
  if (state.pdf) {
    jumpPage(annotation.page||1,false);
    await paintPdfPage?.(state.page);
  }
  if (state.document?.id!==documentId) return;
  $('reader-scroll').focus({preventScroll:true});
  if (!notes.locate(annotation) && state.pdf) jumpPage(annotation.page||1);
  renderAnnotations();
}
function navigateQuote(block) {
  const annotation=state.document?.annotations.items.find(item=>item.id===block.annotationId||item.noteId===block.id);
  if (annotation) return navigateAnnotation(annotation);
  if (!state.document || !block.anchor) return;
  return navigateAnnotation({
    id:block.id,page:block.page??block.anchor.page,previewRevision:block.previewRevision,
    anchor:{...block.anchor,quote:block.quote},rects:block.anchor.rects,points:block.anchor.points,
    stale:!!block.documentHash&&block.documentHash!==state.document.hash
  });
}
$('preview-version').onchange=()=>selectPreview($('preview-version').value);
function setTab(tab) {
  state.tab=tab;
  if (tab!=='read') dismissSelection();
  for (const button of document.querySelectorAll('[data-tab]')) {
    const active=button.dataset.tab===tab;
    button.classList.toggle('active',active);
    button.setAttribute('aria-pressed',String(active));
  }
  for (const key of ['read','notes','study']) $(key+'-tab').hidden=key!==tab;
  notes.refresh();
}
async function pdfLib(){if(state.pdfLib)return state.pdfLib;const m=await import('/literature-hub/vendor/pdf.min.mjs');m.GlobalWorkerOptions.workerSrc='/literature-hub/vendor/pdf.worker.min.mjs';state.pdfLib=m;return m;}
async function loadPdf(id,token){const m=await pdfLib();if(token!==state.token)return;const pdf=await m.getDocument({url:BASE+'/file?'+new URLSearchParams({id,view:'pdf',revision:state.previewRevision}),cMapUrl:'/literature-hub/vendor/cmaps/',cMapPacked:true,standardFontDataUrl:'/literature-hub/vendor/standard_fonts/',wasmUrl:'/literature-hub/vendor/wasm/'}).promise;if(token!==state.token){pdf.destroy();return;}state.pdf=pdf;$('page-count').textContent='/ '+pdf.numPages;$('page-number').max=String(pdf.numPages);state.page=Math.min(pdf.numPages,Math.max(1,state.page));await renderPdf();jumpPage(state.page);}
let renderSerial=0,rendering=[],pageObserver=null,paintPending=new Map(),paintPdfPage=null;
async function renderPdf(){
  if(!state.pdf)return;const serial=++renderSerial,pdf=state.pdf,token=state.token;
  pageObserver?.disconnect();for(const task of rendering)task.cancel?.();rendering=[];paintPending=new Map();paintPdfPage=null;
  const first=await pdf.getPage(1);if(serial!==renderSerial||token!==state.token)return;
  let zoom=state.zoom;
  if (state.fit) {
    const scroll=$('reader-scroll');
    const style=getComputedStyle(scroll);
    const padding=(parseFloat(style.paddingLeft)||0)+(parseFloat(style.paddingRight)||0);
    zoom=Math.max(.35,Math.min(3,(scroll.clientWidth-padding)/first.getViewport({scale:1}).width));
    state.zoom=zoom;
  }
  $('zoom-label').textContent=Math.round(zoom*100)+'%';const container=$('pdf-pages');container.replaceChildren();
  const initialViewport=first.getViewport({scale:zoom}),nodes=[],ready=new Set();
  // Allocate bitmap canvases only near the viewport. Long papers keep at most 12 painted pages.
  for(let i=1;i<=pdf.numPages;i++){const node=el('div',{class:'pdf-page','data-page':i});node.style.width=initialViewport.width+'px';node.style.height=initialViewport.height+'px';node.append(el('span',{class:'page-badge'},i));container.append(node);nodes.push(node);}
  async function paint(node){
    if(node.dataset.painted||serial!==renderSerial||token!==state.token)return;
    const pageNumber=Number(node.dataset.page);if(paintPending.has(pageNumber))return paintPending.get(pageNumber);
    const pending=(async()=>{const page=pageNumber===1?first:await pdf.getPage(pageNumber);if(serial!==renderSerial||token!==state.token)return;
      const viewport=page.getViewport({scale:zoom}),dpr=Math.min(devicePixelRatio||1,2),canvas=el('canvas'),layer=el('div',{class:'textLayer'});
      node.style.width=viewport.width+'px';node.style.height=viewport.height+'px';canvas.width=Math.ceil(viewport.width*dpr);canvas.height=Math.ceil(viewport.height*dpr);canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';layer.style.setProperty('--scale-factor',viewport.scale);node.prepend(canvas,layer);
      try{const task=page.render({canvasContext:canvas.getContext('2d'),viewport,transform:dpr!==1?[dpr,0,0,dpr,0,0]:null});rendering.push(task);await task.promise;rendering=rendering.filter(t=>t!==task);if(serial!==renderSerial||token!==state.token)return;
        const content=await page.getTextContent();if(serial!==renderSerial||token!==state.token)return;
        if(content.items.some(i=>i.str?.trim()))await new state.pdfLib.TextLayer({textContentSource:content,container:layer,viewport}).render();else renderOcrLayer(layer,pageNumber,viewport);
        node.dataset.painted='1';ready.add(node);paintMarks(node);notes.refresh();
        if(ready.size>12){const sorted=[...ready].filter(n=>Math.abs(Number(n.dataset.page)-state.page)>4).sort((a,b)=>Math.abs(Number(b.dataset.page)-state.page)-Math.abs(Number(a.dataset.page)-state.page));for(const old of sorted){if(ready.size<=12)break;old.querySelector('canvas')?.remove();old.querySelector('.textLayer')?.remove();old.querySelector('.page-mark-layer')?.remove();delete old.dataset.painted;ready.delete(old);}}
      }catch(e){if(e.name!=='RenderingCancelledException'&&serial===renderSerial)throw e;}
    })();paintPending.set(pageNumber,pending);try{return await pending;}finally{paintPending.delete(pageNumber);}
  }
  paintPdfPage=page=>nodes[page-1]?paint(nodes[page-1]):undefined;
  pageObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting)paint(entry.target).catch(errorNotice);},{root:$('reader-scroll'),rootMargin:'1000px 0px'});
  for(const node of nodes)pageObserver.observe(node);jumpPage(state.page);await paint(nodes[state.page-1]);updateProgress();notes.refresh();
}
function flashQuote(quote){
  if(!quote||!state.document)return;const needle=String(quote).replace(/\s+/g,' ').trim();if(!needle)return;
  if(state.pdf){const node=$('pdf-pages').querySelector(`[data-page="${state.page}"]`);if(!node)return;node.classList.add('citation-flash');setTimeout(()=>node.classList.remove('citation-flash'),5000);const retry=()=>{for(const span of node.querySelectorAll('.textLayer span'))if(needle.includes(span.textContent?.trim())&&span.textContent.trim().length>2)span.classList.add('quote-flash');};retry();paintPending.get(state.page)?.then(retry);
  }else{const text=$('text-reader').textContent,start=text.indexOf(String(quote));if(start>=0){const walker=document.createTreeWalker($('text-reader'),NodeFilter.SHOW_TEXT);let position=0,node;while((node=walker.nextNode())){if(position+node.length>start){node.parentElement?.scrollIntoView({block:'center'});break;}position+=node.length;}}$('text-reader').classList.add('citation-flash');setTimeout(()=>$('text-reader').classList.remove('citation-flash'),5000);}
}
function renderOcrLayer(layer,page,viewport){const words=(state.document?.ocr?.words||[]).filter(w=>Number(w.page)===page);if(!words.length)return;layer.classList.add('ocr-layer');for(const word of words){const span=el('span',{},word.text+' ');span.style.left=(word.x*100)+'%';span.style.top=(word.y*100)+'%';span.style.fontSize=(word.height*viewport.height*.82)+'px';span.style.width=(word.width*100)+'%';span.style.height=(word.height*100)+'%';span.style.transform='none';span.style.setProperty('--font-height',word.height*viewport.height*.82/viewport.scale);layer.append(span);}}
function paintMarks(node){renderPdfMarks(node,visibleAnnotations(),draw=>{addAnnotation({type:'draw',...draw});});}
function redrawMarks(){if(state.pdf)for(const node of $('pdf-pages').querySelectorAll('.pdf-page'))paintMarks(node);else if(state.document)renderTextMarks($('text-reader'),state.document.text||'',visibleAnnotations());renderAnnotations();notes.refresh();}
function addAnnotation(data){if(!state.document||state.document.readOnly||state.previewReadOnly)return null;const annotation={id:uuid(),color:$('mark-color').value,note:'',previewRevision:state.pdf?state.previewRevision:undefined,createdAt:new Date().toISOString(),...data};state.document.annotations.items.push(annotation);dirty('annotations');redrawMarks();return annotation;}
function dismissSelection(clearRange=false) {
  if (clearRange && state.selection) getSelection()?.removeAllRanges();
  state.selection=null;
  $('selection-menu').hidden=true;
}
function markSelection(type){const selection=state.selection;if(!selection)return;dismissSelection(true);for(const anchor of selection.anchors)addAnnotation({...anchor,type});}
function tagPill(text,kind) { return el('span',{class:'tag-pill','data-kind':kind},text); }
function noteStatus(block) { return block?.text?.trim()?'有旁注':'无旁注'; }
let inlineAnnotationId=null;
let annotationRenderKey='';
function updateAnnotationNotes() {
  const content=noteEditor.getContent();
  const byId=new Map(currentAnnotations(content).map(annotation=>[annotation.id,annotation]));
  for (const card of $('annotations-list').querySelectorAll('[data-annotation-card]')) {
    const annotation=byId.get(card.dataset.annotationCard);
    if (!annotation) continue;
    const block=noteBlock(annotation,content);
    const text=block?.text??annotation.note??'';
    const status=noteStatus({text});
    const badge=card.querySelector('[data-note-status]');
    badge.textContent=status;
    badge.dataset.kind=status==='有旁注'?'note':'empty-note';
    const preview=card.querySelector('.annotation-note-preview');
    preview.textContent=text.slice(0,180);
    preview.hidden=!text.trim()||annotation.id===inlineAnnotationId;
    const editor=card.querySelector('.annotation-note-editor');
    if (document.activeElement!==editor && editor.value!==text) editor.value=text;
  }
}
function setAnnotationsOpen(open) {
  $('annotations-panel').hidden=!open;
  $('annotations-toggle').setAttribute('aria-expanded',String(open));
}
function revealAnnotation(annotation) {
  notes.setActive(annotation.id);
  setAnnotationsOpen(true);
  renderAnnotations();
  const card=$('annotations-list').querySelector(`[data-annotation-card="${CSS.escape(annotation.id)}"]`);
  card?.scrollIntoView?.({block:'nearest'});
}
function renderAnnotations() {
  const content=noteEditor.getContent();
  const items=currentAnnotations(content);
  $('annotation-count').textContent=items.length;
  const list=$('annotations-list');
  const key=JSON.stringify([state.document?.id,state.document?.readOnly,notes.activeId,inlineAnnotationId,items.map(annotation=>[
    annotation.id,annotation.type,annotation.tags,annotation.stale,canNavigateAnnotation(annotation),annotation.page,
    annotation.anchor?.quote||noteBlock(annotation,content)?.quote
  ])]);
  if (key===annotationRenderKey) { updateAnnotationNotes(); return; }
  annotationRenderKey=key;
  const scrollTop=list.scrollTop;
  list.replaceChildren();
  if (!items.length) {
    list.append(el('p',{class:'list-empty'},'暂无批注'));
    return;
  }
  for (const annotation of items) {
    const block=noteBlock(annotation,content);
    const status=noteStatus(block);
    const type=({draw:'勾画',underline:'下划线',highlight:'高亮'})[annotation.type]??'批注';
    const statusTag=tagPill(status,status==='有旁注'?'note':'empty-note');
    statusTag.dataset.noteStatus=annotation.id;
    const badges=el('div',{class:'annotation-labels'},tagPill(type,'type'),statusTag);
    for (const tag of annotation.tags??[]) badges.append(tagPill(tag,'custom'));
    if (annotation.stale) badges.append(tagPill(canNavigateAnnotation(annotation)?'历史版':'原文已变更','location'));
    if (annotation.page&&geometric(annotation)) badges.append(tagPill(`第 ${annotation.page} 页`,'location'));
    const quote=el('button',{
      type:'button',class:'annotation-quote',
      disabled:canNavigateAnnotation(annotation)?null:'',title:'跳回原文',
      onclick:()=>navigateAnnotation(annotation).catch(errorNotice)
    },(annotation.anchor?.quote||block?.quote||'手绘批注').slice(0,600));
    const edit=el('button',{type:'button',class:'icon-button',title:'在笔记中编辑旁注','aria-label':'在笔记中编辑旁注',onclick:()=>editAnnotationNote(annotation.id).catch(errorNotice)},glyph('sticky-note',13));
    const inline=el('button',{type:'button',class:'icon-button',title:'在批注栏编辑旁注','aria-label':'在批注栏编辑旁注','aria-expanded':String(inlineAnnotationId===annotation.id),onclick:()=>{
      inlineAnnotationId=inlineAnnotationId===annotation.id?null:annotation.id;
      renderAnnotations();
      if (inlineAnnotationId) list.querySelector('.annotation-note-editor:not([hidden])')?.focus();
    }},glyph('edit',13));
    const tags=el('button',{type:'button',class:'icon-button',title:'编辑批注标签','aria-label':'编辑批注标签',onclick:()=>openAnnotationTags(annotation.id)},glyph('tag',13));
    const remove=el('button',{
      type:'button',class:'icon-button',title:'删除批注','aria-label':'删除批注',onclick:()=>{
        if (notes.activeId===annotation.id) notes.setActive(null);
        if (inlineAnnotationId===annotation.id) inlineAnnotationId=null;
        const block=noteBlock(annotation);
        if (block&&noteEditor.removeQuote(block.id)) return;
        state.document.annotations.items=state.document.annotations.items.filter(item=>item.id!==annotation.id);
        dirty('annotations');
        redrawMarks();
      }
    },glyph('trash',13));
    const card=el('article',{
      class:'annotation-card'+(annotation.id===notes.activeId?' active':''),
      'data-annotation-card':annotation.id
    },badges,quote);
    const write=event=>{
      if (event.isComposing) return;
      const current=currentAnnotations().find(item=>item.id===annotation.id);
      if (current) noteEditor.upsertQuote({...annotationQuote(current),text:event.target.value});
    };
    const editor=el('textarea',{class:'annotation-note-editor','aria-label':'旁注正文',placeholder:'写旁注',rows:3,
      hidden:inlineAnnotationId===annotation.id?null:'',oninput:write,oncompositionend:write});
    card.append(el('p',{class:'annotation-note-preview'}),editor,el('footer',{},el('div',{},inline,edit),el('div',{},tags,remove)));
    if (state.document.readOnly) for (const button of [inline,edit,tags,remove]) button.disabled=true;
    list.append(card);
  }
  updateAnnotationNotes();
  list.scrollTop=scrollTop;
}
function annotationQuote(annotation) {
  return noteBlock(annotation)??{
    kind:'quote',id:annotation.noteId||uuid(),annotationId:annotation.id,
    quote:annotation.anchor?.quote??(annotation.type==='draw'?`第 ${annotation.page||1} 页 · 勾画`:''),text:annotation.note??'',
    anchor:{...annotation.anchor,rects:annotation.rects,points:annotation.points},
    page:annotation.page,previewRevision:annotation.previewRevision,documentHash:annotation.documentHash??state.document.hash
  };
}
async function editAnnotationNote(annotationId) {
  const id=state.document?.id;
  if (!id || state.document.readOnly) return;
  if (state.dirty.has('annotations')&&!await save('annotations')) return;
  if (state.document?.id!==id) return;
  const annotation=state.document.annotations.items.find(item=>item.id===annotationId);
  if (!annotation) return;
  const block=annotationQuote(annotation);
  if (!noteBlock(annotation)) noteEditor.upsertQuote(block);
  setTab('notes');
  noteEditor.focusQuote(block.id);
}
function parentMessage(data){if(parent!==window)parent.postMessage(data,location.origin);}
async function ask(question,selectedText='',mode='read'){if(!state.document)return;const anchor=state.selection?.anchors[0],payload={type:'hub-ask',docId:state.document.id,question,selectedText,mode,...(state.pdf?{previewRevision:state.previewRevision}:{})};if(state.pdf)payload.page=anchor?.page||state.page;else if(anchor){payload.anchor=anchor.anchor;if(anchor.anchor?.blockId)payload.blockId=anchor.anchor.blockId;}parentMessage(payload);if(parent===window)notice('请在 Harness 中打开 Agent 对话。');}
function noteSelection(){
  const selection=state.selection;
  if (!selection) return;
  dismissSelection(true);
  const annotations=selection.anchors.map(anchor=>addAnnotation({...anchor,type:'highlight',noteId:uuid()}));
  if (annotations[0]) editAnnotationNote(annotations[0].id).catch(errorNotice);
}
function jumpPage(page,scroll=true){if(!state.pdf)return;state.page=Math.min(state.pdf.numPages,Math.max(1,Number(page)||1));$('page-number').value=state.page;const node=$('pdf-pages').querySelector(`[data-page="${state.page}"]`);if(scroll)node?.scrollIntoView({block:'start',behavior:'auto'});updateProgress();scheduleProgress();}
function updateProgress(){$('reading-progress').textContent=state.pdf?`第 ${state.page} / ${state.pdf.numPages} 页 · ${Math.round(state.page/state.pdf.numPages*100)}%`:'文本阅读';$('page-number').disabled=!state.pdf;}
let progressTimer=null;
function scheduleProgress(){clearTimeout(progressTimer);const id=state.document?.id,page=state.page,zoom=state.zoom;if(!id||state.document.readOnly||state.previewReadOnly)return;progressTimer=setTimeout(()=>post('/progress',{id,page,zoom}).catch(e=>errorNotice(new Error('阅读位置保存失败：'+e.message),()=>scheduleProgress())),800);}
function renderStudy(){studyView.render();}
async function startStudy(){state.document.study.enabled=true;dirty('study');renderStudy();if(await save('study'))ask('请作为文献伴读教练，先询问阅读目标，再依据这份资料制定学习计划。用 hub_read 读取文档，用 hub_study 保存知识地图、任务、复习卡和错题；教学时给出原文依据，暂不直接给出练习答案。','','study');}
function studyAsk(kind){const prompts={map:'请依据原文整理知识地图，包含概念、关系与页码，并调用 hub_study 保存 map。',task:'请根据当前掌握程度制定可执行的学习任务，并调用 hub_study 保存 tasks。',quiz:'请围绕原文提出一个理解性问题，等待回答后批改。把错题与掌握情况调用 hub_study 保存。',cards:'请从原文制作问答复习卡片，并调用 hub_study 保存 cards。'};ask(prompts[kind],'','study');}
async function importFiles(files){if(!files.length)return;const button=$('import-open');button.disabled=true;try{for(const file of files){if(file.size>64*1024*1024)throw new Error(file.name+' 超过64MB');$('import-status').textContent=`正在导入 ${file.name}…`;const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('无法读取文件'));reader.readAsDataURL(file);});const result=await post('/import',{name:file.name,base64,folder:state.path,path:state.path});await loadDocuments();await openDocument((result.document||result).id);$('import-status').textContent='已添加';}await folders.refresh();$('import-dialog').close();}catch(e){$('import-status').textContent=e.message;errorNotice(e);}finally{button.disabled=false;$('file-input').value='';}}
function citationText(){const d=state.document;if(!d)return '';const meta=d.metadata||d.bibliography||d.citation||{},authors=meta.authors||d.authors||d.author||[],names=Array.isArray(authors)?authors.map(a=>typeof a==='string'?a:[a.given,a.family].filter(Boolean).join(' ')).join(', '):String(authors),title=meta.title||d.title||'',year=meta.year||d.year||'出版年不详',journal=meta.journal||d.journal||'',doi=meta.doi||d.doi||'',url=doi?'https://doi.org/'+doi:/^https?:/.test(d.source||'')?d.source:'';if($('citation-style').value==='apa')return `${names||'作者不详'}. (${year}). ${title}.${journal?' '+journal+'.':''}${url?' '+url:''}`;if($('citation-style').value==='bibtex'){const esc=v=>String(v).replace(/[{}]/g,'');return `@misc{${esc(d.id).replace(/[^a-zA-Z0-9]/g,'').slice(0,24)},\n  title = {${esc(title)}},\n  author = {${esc(names)}},\n  year = {${esc(year)}}${doi?',\n  doi = {'+esc(doi)+'}':''}${url?',\n  url = {'+esc(url)+'}':''}\n}`;}return `${names||'作者不详'}. ${title}[${journal?'J':'EB/OL'}]. ${journal?journal+', ':''}${year}.${doi?' DOI: '+doi: url?' '+url:''}`;}
function setTheme(theme,{persist=false,tokens=null}={}){state.theme=theme==='dark'?'dark':'light';document.documentElement.dataset.theme=state.theme;document.documentElement.style.colorScheme=state.theme;if(state.appliedTokens&&(persist||state.themeOverride&&state.themeOverride!==state.hostTheme)){for(const key of state.appliedTokens)document.documentElement.style.removeProperty(key);state.appliedTokens=[];}if(tokens){state.appliedTokens=Object.keys(tokens);}if(tokens)for(const [key,value]of Object.entries(tokens))if((/^--(?:dsw|ds)-[a-zA-Z0-9-]+$/.test(key)||key==='--host-font-family')&&typeof value==='string')document.documentElement.style.setProperty(key,value);$('theme-toggle').innerHTML=icon(state.theme==='dark'?'sun':'moon',18);$('theme-toggle').title=state.theme==='dark'?'切换浅色主题':'切换深色主题';$('theme-toggle').setAttribute('aria-label',$('theme-toggle').title);$('theme-toggle').setAttribute('aria-pressed',String(state.theme==='dark'));if(persist){state.themeOverride=state.theme;try{localStorage.setItem('dsh-literature-hub-theme',state.theme);}catch{}}}
$('theme-toggle').onclick=()=>setTheme(state.theme==='dark'?'light':'dark',{persist:true,tokens:state.hostTheme===(state.theme==='dark'?'light':'dark')?state.hostTokens:null});
function tagEditor({listId,inputId,addId,onChange=()=>{}}) {
  const list=$(listId),input=$(inputId);
  let tags=[];
  function parse(text) {
    return text.split(/[,，;；\n]/).map(tag=>tag.trim().replace(/^#+/,'')).filter(Boolean);
  }
  function value() { return [...new Set([...tags,...parse(input.value)])].slice(0,100); }
  function render() {
    list.replaceChildren(...tags.map(tag=>el('span',{class:'tag-pill'},tag,el('button',{
      type:'button',class:'icon-button',title:`移除 ${tag}`,'aria-label':`移除 ${tag}`,onclick:()=>{
        tags=tags.filter(value=>value!==tag);
        render();
        onChange(value());
      }
    },glyph('x',12)))));
  }
  function add() {
    tags=value();
    input.value='';
    render();
    onChange(tags);
    input.focus();
  }
  $(addId).onclick=add;
  input.addEventListener('keydown',event=>{
    if (event.key==='Enter'&&!event.isComposing) {
      event.preventDefault();
      add();
    }
  });
  input.addEventListener('input',()=>onChange(value()));
  return {value,load(values){tags=[...values];input.value='';render();}};
}
const documentTags=tagEditor({listId:'metadata-tag-list',inputId:'metadata-tags',addId:'metadata-tag-add',onChange:tags=>{
  if (!state.document) return;
  state.metadataDirty=true;
  storeDraft('metadata',{tags});
  $('metadata-status').textContent='未保存';
}});
const annotationTags=tagEditor({listId:'annotation-tag-list',inputId:'annotation-tag-input',addId:'annotation-tag-add'});
let annotationTagTarget=null;
let renameRevision=0;
function openMetadata() {
  const doc=state.document;
  if (!doc || doc.readOnly) return;
  const draft=readDraft('metadata');
  state.metadataRevision=doc.metadataRevision??0;
  documentTags.load(draft?.value?.tags??doc.tags??[]);
  $('metadata-status').textContent=draft?'草稿已恢复':'';
  $('metadata-latest').hidden=true;
  $('metadata-dialog').showModal();
  $('metadata-tags').focus();
}
function applyMetadataResult(saved) {
  if (!saved || saved.id!==state.document?.id) return false;
  for (const field of ['title','tags','metadata','metadataRevision','originalPath','path','name','folder','source']) {
    if (Object.hasOwn(saved,field)) state.document[field]=saved[field];
  }
  applyReturnedNotes(saved.notes);
  renderDocumentHeader();
  parentMessage({type:'hub-document-meta',docId:saved.id,title:saved.title});
  return true;
}
$('metadata-edit').onclick=openMetadata;
$('metadata-save').onclick=async()=>{
  const doc=state.document;
  if (!doc) return;
  const button=$('metadata-save');
  button.disabled=true;
  try {
    if (!await flush()) return;
    const tags=documentTags.value();
    $('metadata-status').textContent='保存中';
    const result=await post('/metadata',{id:doc.id,tags,expectedRevision:state.metadataRevision});
    if (!applyMetadataResult(result.document||result)) return;
    state.metadataDirty=false;
    clearDraft('metadata',doc.id);
    $('metadata-dialog').close();
    await loadDocuments();
  } catch (error) {
    $('metadata-status').textContent=error.status===409?'标签已在其他窗口更新，请读取最新版本后核对。':error.message;
    $('metadata-latest').hidden=error.status!==409;
  } finally { button.disabled=false; }
};
$('metadata-latest').onclick=async()=>{
  try {
    const latest=await api('/document?'+new URLSearchParams({id:state.document.id}));
    const doc=latest.document||latest;
    state.metadataRevision=doc.metadataRevision??0;
    $('metadata-status').textContent=`当前标签：${(doc.tags??[]).join('、')||'无'}。草稿仍在编辑区。`;
    $('metadata-latest').hidden=true;
  } catch (error) { $('metadata-status').textContent=error.message; }
};
function fileNameParts(doc) {
  const name=doc.name??(doc.originalPath||doc.path||'').split('/').at(-1)??doc.title;
  const extension=/\.[^./]+$/.exec(name)?.[0]??'';
  return {stem:extension?name.slice(0,-extension.length):name,extension};
}
$('rename-open').onclick=()=>{
  const doc=state.document;
  if (!doc || doc.readOnly) return;
  const {stem,extension}=fileNameParts(doc);
  renameRevision=doc.metadataRevision??0;
  $('rename-name').value=stem||doc.title;
  $('rename-extension').textContent=extension;
  $('rename-status').textContent='';
  $('rename-dialog').showModal();
  $('rename-name').focus();
  $('rename-name').select?.();
};
$('rename-close').onclick=()=>$('rename-dialog').close();
$('rename-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const id=state.document?.id;
  const name=$('rename-name').value.trim();
  if (!id || !name) return;
  const button=$('rename-save');
  button.disabled=true;
  try {
    if (!await flush()) return;
    const result=await post('/rename',{id,name,expectedRevision:renameRevision});
    if (!applyMetadataResult(result.document||result)) return;
    $('rename-dialog').close();
    await loadDocuments();
  } catch (error) {
    $('rename-status').textContent=error.message;
    if (error.body?.code==='revision-conflict') {
      try {
        const result=await api('/document?'+new URLSearchParams({id}));
        const latest=result.document||result;
        renameRevision=latest.metadataRevision??0;
        $('rename-status').textContent=`${error.message}。当前文件名为「${fileNameParts(latest).stem}」。`;
      } catch {}
    }
  } finally { button.disabled=false; }
});
let deleteTarget=null;
const deleteDialog=$('delete-dialog');
const trashDialog=$('trash-dialog');
$('delete-open').onclick=()=>{
  const doc=state.document;
  if (!doc||doc.readOnly) return;
  deleteTarget=doc.id;
  $('delete-document-name').textContent=doc.name||doc.title;
  $('delete-status').textContent='';
  deleteDialog.showModal();
  $('delete-cancel').focus();
};
function closeDelete() { if (!$('delete-submit').disabled) deleteDialog.close(); }
$('delete-close').onclick=closeDelete;
$('delete-cancel').onclick=closeDelete;
deleteDialog.addEventListener('cancel',event=>{if ($('delete-submit').disabled) event.preventDefault();});
async function closeDeletedDocument(id) {
  if (state.document?.id!==id) return;
  state.token++;
  state.document=null;
  inlineAnnotationId=null;
  removedAnnotations.clear();
  savedAnnotationIds.clear();
  dismissSelection(true);
  notes.setActive(null);
  voice.setDocument(null);
  setAnnotationsOpen(false);
  parentMessage({type:'hub-deselect',docId:id});
  const pdf=state.pdf;
  state.pdf=null;
  pageObserver?.disconnect();
  $('pdf-pages').replaceChildren();
  $('text-reader').replaceChildren();
  $('opened').hidden=true;
  $('empty').hidden=false;
  $('document-title').textContent='文献库';
  $('document-meta').textContent='';
  $('document-tags').replaceChildren();
  for (const control of ['rename-open','delete-open','metadata-edit','citation','reparse']) $(control).hidden=true;
  renderDocuments();
  if (pdf) await pdf.destroy().catch(()=>{});
}
$('delete-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const button=$('delete-submit');
  const id=deleteTarget;
  if (button.disabled||!id||state.document?.id!==id) return;
  button.disabled=true;
  $('delete-status').textContent='';
  try {
    if (!await flush()) { $('delete-status').textContent='请先保存当前文档的草稿。'; return; }
    const doc=state.document;
    if (doc?.id!==id) return;
    if (voice.isRecording?.(id)) { $('delete-status').textContent='请先停止这份文档的录音。'; return; }
    await post('/delete-document',{id,expectedRevision:doc.metadataRevision??0,expectedHash:doc.hash,
      expectedNotesRevision:doc.notes.revision,expectedAnnotationsRevision:doc.annotations.revision});
    state.documents=state.documents.filter(item=>{
      const entry=item.document||item;
      return entry.id!==id&&entry.linkedDocumentId!==id&&(!doc.path||entry.path!==doc.path);
    });
    deleteDialog.close();
    await closeDeletedDocument(id);
    await loadDocuments();
    notice('文档已移到回收站。',{retry:()=>restoreDeletedDocument(id),actionLabel:'撤销删除'});
  } catch (error) {
    $('delete-status').textContent=error.message;
  } finally { button.disabled=false; }
});
async function restoreDeletedDocument(id) {
  await post('/restore-document',{id});
  await loadDocuments();
  if (trashDialog.hasAttribute('open')) await loadTrash();
  notice('文档已恢复到原文件夹。',{temporary:true});
}
async function loadTrash() {
  const list=$('trash-list'),status=$('trash-status');
  list.replaceChildren();
  status.textContent='读取中…';
  try {
    const items=listFrom(await api('/trash'));
    status.textContent=items.length?'':'回收站为空';
    for (const doc of items) {
      const restore=el('button',{type:'button',class:'subtle',onclick:async()=>{
        restore.disabled=true;
        try { await restoreDeletedDocument(doc.id); }
        catch (error) { status.textContent=error.message; restore.disabled=false; }
      }},'恢复');
      list.append(el('li',{},el('div',{},el('strong',{},doc.title||'未命名资料'),el('small',{},doc.originalPath||'')),restore));
    }
  } catch (error) { status.textContent=error.message; }
}
$('trash-open').onclick=()=>{trashDialog.showModal();loadTrash();};
function openAnnotationTags(id) {
  const annotation=state.document?.annotations.items.find(item=>item.id===id);
  if (!annotation || state.document.readOnly) return;
  annotationTagTarget=id;
  annotationTags.load(annotation.tags??[]);
  $('annotation-tag-status').textContent='';
  $('annotation-tag-dialog').showModal();
  $('annotation-tag-input').focus();
}
$('annotation-tag-save').onclick=async()=>{
  const annotation=state.document?.annotations.items.find(item=>item.id===annotationTagTarget);
  if (!annotation) return;
  annotation.tags=annotationTags.value();
  dirty('annotations');
  renderAnnotations();
  const button=$('annotation-tag-save');
  button.disabled=true;
  try {
    if (await save('annotations')) $('annotation-tag-dialog').close();
    else $('annotation-tag-status').textContent='保存失败，草稿已保留。';
  } finally { button.disabled=false; }
};
function openImport(){$('import-status').textContent='';$('import-dialog').showModal();}
$('import-open').onclick=openImport;
$('directory-actions').addEventListener('click',event=>{
  if (event.target.closest('button')) $('directory-actions').open=false;
});
$('empty-import').onclick=openImport;$('notice-close').onclick=()=>$('notice').hidden=true;$('notice-retry').onclick=()=>Promise.resolve(retryAction?.()).catch(e=>errorNotice(e));$('notice-download').onclick=exportDraft;$('refresh').onclick=()=>{folders.refresh().catch(errorNotice);loadDocuments();};
let searchTimer;for(const id of ['search','tag-filter'])$(id).addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(loadDocuments,250);});$('type-filter').onchange=loadDocuments;
for(const button of document.querySelectorAll('[data-tab]'))button.onclick=()=>setTab(button.dataset.tab);
for(const button of document.querySelectorAll('[data-tool]'))button.onclick=()=>{if(state.previewReadOnly)return;state.tool=button.dataset.tool;document.querySelectorAll('[data-tool]').forEach(b=>b.classList.toggle('active',b===button));$('reader-scroll').classList.toggle('drawing',state.tool==='draw');if(!state.pdf&&state.tool==='draw')notice('自由勾画适用于 PDF 和 Word 阅读视图；文本资料可以选取原文做高亮和下划线。',{temporary:true});};
$('annotations-toggle').onclick=()=>setAnnotationsOpen($('annotations-panel').hidden);
$('annotations-close').onclick=()=>setAnnotationsOpen(false);
const selectionReader=$('reader-scroll');
const selectionMenu=$('selection-menu');
let selectionPointer=null;
let selectionFrame=0;
function syncSelection(autoMark=false) {
  if (selectionPointer!==null) return;
  const selection=state.document && state.tab==='read' && state.tool!=='draw'
    ? captureSelection(selectionReader) : null;
  if (!selection) { dismissSelection(); return; }
  if (!state.pdf) for (const anchor of selection.anchors) anchor.anchor=locateTextAnchor(anchor.anchor,state.document.blocks);
  state.selection=selection;
  if (autoMark&&['highlight','underline'].includes(state.tool)) { markSelection(state.tool); return; }
  selectionMenu.hidden=false;
  selectionMenu.style.left=Math.max(8,Math.min(selection.bounds.left,innerWidth-selectionMenu.offsetWidth-8))+'px';
  selectionMenu.style.top=Math.max(8,selection.bounds.top-44)+'px';
}
document.addEventListener('selectionchange',()=>syncSelection());
document.addEventListener('pointerdown',event=>{
  if (event.button!==0||!event.isPrimary) return;
  if (selectionMenu.contains(event.target)) { event.preventDefault(); return; }
  cancelAnimationFrame(selectionFrame);
  selectionPointer=null;
  if (selectionReader.contains(event.target)) {
    selectionPointer=event.pointerId;
    dismissSelection();
  } else dismissSelection(true);
});
document.addEventListener('pointerup',event=>{
  if (selectionPointer!==event.pointerId) return;
  selectionPointer=null;
  selectionFrame=requestAnimationFrame(()=>syncSelection(true));
});
document.addEventListener('pointercancel',event=>{
  if (selectionPointer!==event.pointerId) return;
  selectionPointer=null;
  dismissSelection();
});
document.addEventListener('keydown',event=>{
  if (event.key==='Escape' && state.selection) dismissSelection(true);
});
for (const button of selectionMenu.querySelectorAll('[data-selection]')) button.onclick=()=>{
  syncSelection();
  if (!state.selection) return;
  const action=button.dataset.selection;
  if (action==='ask') {
    ask('请结合上下文解释这段原文，并标明出处。',state.selection.text);
    dismissSelection(true);
  } else if (action==='note') noteSelection();
  else markSelection(action);
};
$('notes-save').onclick=()=>save('notes');
$('notes-export').onclick=()=>exportNotes().catch(errorNotice);
async function exportNotes() {
  const content=noteEditor.getContent();
  const chunks=await Promise.all(content.map(async block=>{
    if (block.kind==='markdown') return block.markdown;
    if (block.kind==='quote') return `> ${block.quote.replace(/\n/g,'\n> ')}\n\n${block.text||''}`;
    if (block.kind==='audio') {
      const asset=await fetchAudioInfo(block.assetId);
      return asset.mediaLink||`[${asset.title||'录音'}](${asset.fileUrl})`;
    }
    return '';
  }));
  download(chunks.join('\n\n'),`${safeName(state.document?.title)}-笔记.md`);
}
$('ask-doc').onclick=()=>ask('请围绕这份资料与我讨论，先给出主要论点及原文出处。');$('study-start').onclick=startStudy;$('study-save').onclick=()=>{dirty('study');save('study');};$('mastery').onchange=()=>{state.document.study.mastery=Number($('mastery').value);dirty('study');};for(const b of document.querySelectorAll('[data-study]'))b.onclick=()=>studyAsk(b.dataset.study);
$('prev-page').onclick=()=>jumpPage(state.page-1);$('next-page').onclick=()=>jumpPage(state.page+1);$('page-number').onchange=()=>jumpPage($('page-number').value);$('zoom-in').onclick=()=>changeZoom(.15);$('zoom-out').onclick=()=>changeZoom(-.15);$('fit-width').onclick=()=>{state.fit=true;renderPdf().catch(errorNotice);};
function changeZoom(delta){if(!state.pdf)return;state.fit=false;state.zoom=Math.max(.35,Math.min(3,state.zoom+delta));renderPdf().then(scheduleProgress).catch(errorNotice);}
let scrollingTimer;$('reader-scroll').addEventListener('scroll',()=>{if(!state.pdf)return;clearTimeout(scrollingTimer);scrollingTimer=setTimeout(()=>{const bounds=$('reader-scroll').getBoundingClientRect(),nodes=[...$('pdf-pages').children];let best=null,area=0;for(const node of nodes){const r=node.getBoundingClientRect(),visible=Math.max(0,Math.min(r.bottom,bounds.bottom)-Math.max(r.top,bounds.top));if(visible>area){area=visible;best=node;}}if(best){state.page=Number(best.dataset.page);$('page-number').value=state.page;updateProgress();scheduleProgress();}},150);});
$('file-input').onchange=()=>importFiles([...$('file-input').files]);const drop=$('drop-zone');drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('dragover');});drop.addEventListener('dragleave',()=>drop.classList.remove('dragover'));drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('dragover');importFiles([...e.dataTransfer.files]);});
async function reparseDocument(){if(!state.document||!await flush())return;const button=$('reparse');button.disabled=true;notice('正在重新解析原件，扫描件会进行本地文字识别。');try{const result=await post('/reparse',{id:state.document.id});await displayDocument(result?.document||result);await loadDocuments();if(state.document.parseStatus!=='failed')notice('正文解析已完成。',{temporary:true});}catch(e){errorNotice(e,reparseDocument);}finally{button.disabled=false;}}$('reparse').onclick=reparseDocument;
$('citation').onclick=()=>{$('citation-text').textContent=citationText();$('citation-dialog').showModal();};$('citation-style').onchange=()=>$('citation-text').textContent=citationText();$('citation-copy').onclick=async()=>{try{await navigator.clipboard.writeText($('citation-text').textContent);$('citation-copy').textContent='已复制';setTimeout(()=>$('citation-copy').textContent='复制引用',1500);}catch{download($('citation-text').textContent,'文献引用.txt');}};
const directoryStorageKey='dsh-literature-hub-directory-open';
const directoryWidthKey='dsh-literature-hub-directory-width';
let lastDirectoryReport;
function applyDirectory({report=false}={}) {
  // The iframe already excludes the host Agent/workspace panels.
  const drawer=(document.documentElement.clientWidth||innerWidth)<540;
  document.body.dataset.directoryMode=drawer?'drawer':'inline';
  document.body.classList.toggle('directory-collapsed',!state.directoryOpen);
  $('library').hidden=!state.directoryOpen;
  $('resize').hidden=drawer||!state.directoryOpen;
  $('expand').hidden=state.directoryOpen;
  if (report || state.directoryOpen!==lastDirectoryReport) {
    lastDirectoryReport=state.directoryOpen;
    parentMessage({type:'hub-layout',directoryOpen:state.directoryOpen});
  }
  notes.refresh();
}
function setDirectoryOpen(open) {
  state.directoryOpen=open;
  try { localStorage.setItem(directoryStorageKey,String(open)); } catch {}
  applyDirectory();
}
$('collapse').onclick=()=>setDirectoryOpen(false);
$('expand').onclick=()=>setDirectoryOpen(true);
let resizeStart=null;
let directoryWidth=240;
function setDirectoryWidth(width,persist=false) {
  directoryWidth=Math.max(200,Math.min(360,width));
  document.documentElement.style.setProperty('--sidebar',`${directoryWidth}px`);
  if (persist) try { localStorage.setItem(directoryWidthKey,String(directoryWidth)); } catch {}
}
$('resize').addEventListener('pointerdown',event=>{
  resizeStart={x:event.clientX,width:$('library').getBoundingClientRect().width};
  $('resize').setPointerCapture(event.pointerId);
});
$('resize').addEventListener('pointermove',event=>{
  if (resizeStart) setDirectoryWidth(resizeStart.width+event.clientX-resizeStart.x);
});
function finishDirectoryResize() {
  if (!resizeStart) return;
  resizeStart=null;
  setDirectoryWidth(directoryWidth,true);
  fitAfterResize();
}
$('resize').addEventListener('pointerup',finishDirectoryResize);
$('resize').addEventListener('pointercancel',finishDirectoryResize);
$('resize').addEventListener('keydown',event=>{
  if (event.key!=='ArrowLeft'&&event.key!=='ArrowRight') return;
  event.preventDefault();
  setDirectoryWidth($('library').getBoundingClientRect().width+(event.key==='ArrowLeft'?-10:10),true);
  fitAfterResize();
});
window.addEventListener('message',event=>{
  if (event.source!==parent || event.origin!==location.origin || !event.data || typeof event.data!=='object') return;
  const data=event.data;
  voice.receive(data);
  if (data.type==='hub-session'&&data.docId===state.document?.id) {
    state.session=data.sessionId;
    $('ask-doc').replaceChildren(glyph('message-square',13),data.state==='loading'?'连接中':'讨论');
  }
  if (data.type==='hub-error'&&(!data.docId||data.docId===state.document?.id)) notice(data.message||'Agent 暂时不可用');
  if (data.type==='hub-theme') {
    const theme=data.theme==='dark'?'dark':'light';
    state.hostTheme=theme;
    state.hostTokens=data.tokens;
    document.documentElement.dataset.hostTheme=theme;
    setTheme(state.themeOverride||theme,{tokens:state.themeOverride&&state.themeOverride!==theme?null:data.tokens});
    if (data.layout) receiveLayout(data.layout);
  }
  if (data.type==='hub-layout'&&typeof data.width==='number') receiveLayout(data);
  if (data.type==='hub-toggle-directory') setDirectoryOpen(!state.directoryOpen);
  if (data.type==='hub-unload') preserveDrafts();
  if (data.type==='hub-refresh'&&data.docId===state.document?.id&&!state.dirty.size) openDocument(data.docId,{force:true});
  if (data.type==='hub-navigate'&&data.docId) navigateDocument(data).catch(errorNotice);
});
async function navigateDocument(data){await openDocument(data.docId);if(state.document?.id!==data.docId)return;if(data.revision&&Number(data.revision)!==state.previewRevision){if(!await selectPreview(data.revision))return;}if(data.page)jumpPage(data.page);if(data.q)flashQuote(data.q);}
function receiveLayout(layout) {
  const first=!state.layout;
  state.layout=layout;
  applyDirectory({report:first});
}
function preserveDrafts(){for(const kind of state.dirty)storeDraft(kind,valueFor(kind));}
window.addEventListener('beforeunload',e=>{if(state.dirty.size||state.metadataDirty){preserveDrafts();e.preventDefault();e.returnValue='阅读草稿尚未保存';}});document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){preserveDrafts();flush();}});window.addEventListener('pagehide',preserveDrafts);
let resizeTimer;
function fitAfterResize() {
  clearTimeout(resizeTimer);
  resizeTimer=setTimeout(()=>{
    if (state.pdf&&state.fit) renderPdf().catch(errorNotice);
    notes.refresh();
  },180);
}
new ResizeObserver(fitAfterResize).observe($('reader-scroll'));
window.addEventListener('resize',()=>{applyDirectory();fitAfterResize();});
const notes=createNotes({state,visibleAnnotations,onActivate:revealAnnotation,onGroup:items=>revealAnnotation(items[0])});
function fetchAudioInfo(assetId){return api('/voice/detail?'+new URLSearchParams({id:assetId,docId:state.document?.id||''}));}
const noteEditor=createNoteEditor({
  mount:$('note-editor'),onChange:(content,previous)=>{
    if (previous&&state.document) for (const annotation of state.document.annotations.items) {
      const removed=noteBlock(annotation,previous);
      if (removed&&!noteBlock(annotation,content)) removedAnnotations.set(annotation.id,{annotation:{...structuredClone(annotation),noteId:removed.id},saved:false});
    }
    dirty('notes');
    if (previous&&currentAnnotations(previous).length!==currentAnnotations(content).length) redrawMarks();
    else renderAnnotations();
  },
  onNavigateQuote:block=>navigateQuote(block).catch(errorNotice),
  onOpenAudio:id=>voice.openRecording(id),fetchAudioInfo
});
const voice=createVoicePanel({
  root:$('voice-panel'),api,post,parentMessage,getDocument:()=>state.document,notice,
  onAddToNote({kind,assetId,recordingId,text,title,todos,automatic=false}) {
    if (!state.document || state.document.readOnly) return;
    if(!automatic)setTab('notes');
    if (kind==='audio') noteEditor.insertAudio(assetId||recordingId,{focus:!automatic});
    else if (text) {
      const heading=kind==='summary'?'录音摘要':'录音转写';
      const tasks=Array.isArray(todos)?todos.map(item=>typeof item==='string'?item:item?.text??item?.title).filter(Boolean):[];
      noteEditor.insertMarkdown([`### ${title||heading}`,text,...(tasks.length?['#### 待办',tasks.map(task=>`- [ ] ${task}`).join('\n')]:[])].join('\n\n'));
    }
  }
});
const studyView=createStudy({state,dirty,ask});
try{state.path=localStorage.getItem('dsh-literature-hub-folder')??state.path;}catch{}
const folders=createFolders({api,post,initial:state.path,onSelect:async path=>{state.path=path;try{localStorage.setItem('dsh-literature-hub-folder',path);}catch{}await loadDocuments();},onChange:async()=>{if(state.document&&!state.dirty.size)await openDocument(state.document.id,{force:true});},error:errorNotice});
function installTooltips() {
  const tooltip=$('reader-tooltip');
  let timer;
  let target;
  function hide() {
    clearTimeout(timer);
    target=null;
    tooltip.hidden=true;
  }
  function show(event) {
    const button=event.target.closest?.('button[title],button[data-tooltip],summary[title],summary[data-tooltip]');
    if (!button || button===target || button.disabled) return;
    hide();
    const label=button.getAttribute('title')||button.dataset.tooltip;
    if (!label) return;
    button.dataset.tooltip=label;
    button.removeAttribute('title');
    target=button;
    timer=setTimeout(()=>{
      if (!button.isConnected || button.hidden) return;
      tooltip.textContent=label;
      tooltip.hidden=false;
      const bounds=button.getBoundingClientRect();
      tooltip.style.left=`${Math.max(6,Math.min(innerWidth-tooltip.offsetWidth-6,bounds.left))}px`;
      const below=bounds.bottom+6;
      tooltip.style.top=`${below+tooltip.offsetHeight>innerHeight?Math.max(6,bounds.top-tooltip.offsetHeight-6):below}px`;
    },380);
  }
  function leave(event) { if (target?.contains(event.target)&&!target.contains(event.relatedTarget)) hide(); }
  document.addEventListener('pointerover',show);
  document.addEventListener('focusin',show);
  document.addEventListener('pointerout',leave);
  document.addEventListener('focusout',leave);
  document.addEventListener('pointerdown',hide);
  document.addEventListener('scroll',hide,true);
}
hydrateIcons();
installTooltips();
document.body.dataset.embedded=String(parent!==window);
try {
  state.themeOverride=localStorage.getItem('dsh-literature-hub-theme')||null;
  state.directoryOpen=localStorage.getItem(directoryStorageKey)!=='false';
  const width=Number(localStorage.getItem(directoryWidthKey));
  if (Number.isFinite(width)&&width>0) setDirectoryWidth(width);
} catch {}
setTheme(state.themeOverride||'light');
applyDirectory();
Promise.all([loadStatus(),folders.init()]).then(()=>{parentMessage({type:'hub-ready'});const params=new URLSearchParams(location.search);if(params.get('id'))navigateDocument({docId:params.get('id'),page:params.get('page'),q:params.get('q'),revision:params.get('revision')}).catch(errorNotice);}).catch(errorNotice);
