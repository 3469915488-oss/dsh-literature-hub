import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import fs from 'node:fs/promises';
import {parseHTML} from 'linkedom';

// LinkeDOM cannot run contenteditable editing or MediaRecorder. Exercise the
// reader's integration against the two modules' public interfaces instead.
const editorStub=`
export function createNoteEditor({mount,onChange}) {
  const input=document.createElement('textarea');
  input.dataset.testEditor='true';
  let content=[];
  function set(next,emit=false){const prior=content;content=next;input.value=JSON.stringify(content);if(emit)onChange(content,prior);}
  set([]);
  mount.append(input);
  input.addEventListener('input',()=>set(JSON.parse(input.value),true));
  return {
    setContent(next){set(next);},
    getContent(){return content;},
    upsertQuote(block){const exists=content.some(item=>item.id===block.id);set(exists?content.map(item=>item.id===block.id?block:item):[...content,block],true);},
    removeQuote(id){set(content.filter(item=>item.id!==id),true);return true;},
    focusQuote(id){mount.dataset.focusedQuote=id;}
  };
}`;
const voiceStub=`export function createVoicePanel(){return {setDocument(){},receive(){},openRecording(){}};}`;

test('reader preserves ordered notes and the directory preference through annotation and metadata edits',async t=>{
  const hooks=registerHooks({resolve(specifier,context,nextResolve){
    if (context.parentURL?.includes('/reader/hub.js?') && ['./editor.js','./voice.js'].includes(specifier)) {
      const source=specifier==='./editor.js'?editorStub:voiceStub;
      return {url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true};
    }
    return nextResolve(specifier,context);
  }});
  t.after(()=>hooks.deregister());
  const html=await fs.readFile(new URL('../reader/index.html',import.meta.url),'utf8');
  const {window}=parseHTML(html);
  const document=window.document;
  const stored=new Map();
  const requests=[];
  Object.assign(globalThis,{
    window,document,Node:window.Node,Element:window.Element,HTMLElement:window.HTMLElement,
    parent:window,location:{origin:'http://reader.test',search:'?id=paper'},innerWidth:1280,
    ResizeObserver:class{observe(){}disconnect(){}},
    requestAnimationFrame:fn=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,
    CSS:{escape:s=>String(s).replace(/["\\]/g,'\\$&')},
    localStorage:{getItem:k=>stored.get(k)??null,setItem:(k,v)=>stored.set(k,v),removeItem:k=>stored.delete(k)}
  });
  Object.defineProperty(window.HTMLSelectElement.prototype,'value',{
    configurable:true,
    get(){return this.querySelector('option[selected]')?.getAttribute('value')??this.querySelector('option')?.getAttribute('value')??'';},
    set(value){for(const option of this.querySelectorAll('option'))option.toggleAttribute('selected',option.getAttribute('value')===String(value));}
  });
  window.HTMLElement.prototype.getBoundingClientRect=function(){
    return this.tagName==='MARK'
      ?{left:100,top:620,right:270,bottom:640,width:170,height:20}
      :{left:0,top:0,right:800,bottom:700,width:800,height:700};
  };
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.showModal=()=>dialog.setAttribute('open','');
    dialog.close=()=>dialog.removeAttribute('open');
  }
  const quote='阅读时区分原文与个人判断。';
  const doc={
    id:'paper',title:'临时测试资料',name:'测试.md',originalPath:'文献库/未分类/测试.md',type:'markdown',
    text:'方法\n\n'+quote+'\n\n记录原文出处。',folder:'文献库/未分类',parseStatus:'ready',tags:[],metadataRevision:0,hash:'fixture-hash',
    notes:{revision:0,freeText:'自由笔记',text:'',blocks:[{id:'note-1',noteId:'note-1',annotationId:'mark-1',quote,text:'原有旁注'}]},
    annotations:{revision:0,items:[{id:'mark-1',noteId:'note-1',type:'highlight',page:null,anchor:{quote},note:'原有旁注'}]},
    study:{revision:0,enabled:true,tasks:[{title:'核对原文出处',done:false}],cards:[{front:'问题',back:'答案'}]}
  };
  const folders={
    '':[{name:'文献库',path:'文献库',hasChildren:true},{name:'研究资料',path:'研究资料',hasChildren:true}],
    '文献库':[{name:'未分类',path:'文献库/未分类',hasChildren:false}],
    '研究资料':[{name:'子目录',path:'研究资料/子目录',hasChildren:false}]
  };
  let failNotes=false;
  let trashed=false;
  globalThis.fetch=async(route,options={})=>{
    const url=new URL(route,'http://reader.test');
    const action=url.pathname.split('/').at(-1);
    const path=url.searchParams.get('path');
    const data=options.body?JSON.parse(options.body):null;
    requests.push({action,path,data});
    let result={ok:true};
    if (action==='status') result={vaultPath:'in-memory'};
    if (action==='folders') result={path,folders:folders[path||'']||[]};
    if (action==='documents'||action==='search') result={documents:!trashed&&path==='文献库/未分类'?[{id:'paper',title:doc.title,path:doc.originalPath,type:'markdown'}]:[]};
    if (action==='document'||action==='register') result=doc;
    if (action==='annotations') {
      doc.annotations.items=data.annotations;
      doc.annotations.revision++;
      result=doc;
    }
    if (action==='notes') {
      if (failNotes) return {ok:false,status:409,text:async()=>JSON.stringify({error:'revision conflict'})};
      const previous=doc.notes.content??doc.notes.blocks;
      const deleted=previous.filter(block=>block.annotationId&&!data.content.some(item=>item.id===block.id));
      if (deleted.length||data.restoreAnnotations?.length) {
        doc.annotations.items=doc.annotations.items.filter(item=>!deleted.some(block=>block.annotationId===item.id));
        doc.annotations.items.push(...(data.restoreAnnotations??[]));
        doc.annotations.revision++;
      }
      doc.notes.content=data.content;
      doc.notes.revision++;
      result=doc;
    }
    if (action==='metadata') {
      doc.tags=data.tags;
      doc.metadataRevision++;
      result=doc;
    }
    if (action==='rename') {
      doc.name=data.name+'.md';
      doc.originalPath=doc.folder+'/'+doc.name;
      doc.title=data.name;
      doc.metadataRevision++;
      result=doc;
    }
    if (action==='study') {
      doc.study={...data.study,revision:doc.study.revision+1};
      result=doc;
    }
    if (action==='delete-document') trashed=true;
    if (action==='restore-document') trashed=false;
    if (action==='trash') result={documents:trashed?[{id:doc.id,title:doc.title,originalPath:doc.originalPath}]:[]};
    return {ok:true,status:200,text:async()=>JSON.stringify(result)};
  };
  const $=id=>document.getElementById(id);
  const wait=async predicate=>{
    for(let i=0;i<100;i++) {
      if(predicate())return;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.fail('reader did not reach expected state');
  };
  const input=(node,value)=>{node.value=value;node.dispatchEvent(new window.Event('input'));};
  const message=data=>{
    const event=new window.Event('message');
    Object.assign(event,{source:window,origin:'http://reader.test',data});
    window.dispatchEvent(event);
  };
  await import('../reader/hub.js?reader-v2-dom-test');
  await wait(()=>document.querySelector('.current-task'));
  assert.equal($('documents').querySelectorAll('.document-card').length,1);
  const selectedNode=$('text-reader').querySelector('mark').firstChild;
  const range={
    startContainer:selectedNode,endContainer:selectedNode,startOffset:0,
    getBoundingClientRect:()=>({left:100,top:620,bottom:640,width:170}),
    cloneRange:()=>({selectNodeContents(){},setEnd(){},toString:()=>doc.text.split(quote)[0]}),
    toString:()=>quote
  };
  let selected=true;
  globalThis.getSelection=()=>({
    rangeCount:1,isCollapsed:!selected,getRangeAt:()=>range,
    toString:()=>selected?quote:'',removeAllRanges:()=>{selected=false;}
  });
  const changeSelection=()=>document.dispatchEvent(new window.Event('selectionchange'));
  const pointer=(node,type)=>{
    const event=new window.Event(type,{bubbles:true,cancelable:true});
    Object.assign(event,{button:0,pointerId:1,isPrimary:true});
    node.dispatchEvent(event);
    return event;
  };
  changeSelection();
  assert.equal($('selection-menu').hidden,false,'a keyboard or programmatic selection opens the toolbar');
  selected=false;
  changeSelection();
  assert.equal($('selection-menu').hidden,true,'deselecting text immediately closes the toolbar');
  selected=true;
  changeSelection();
  pointer($('text-reader'),'pointerdown');
  selected=false;
  changeSelection();
  pointer($('text-reader'),'pointerup');
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal($('selection-menu').hidden,true,'a plain click inside the reader cannot reopen a stale toolbar');
  selected=true;
  changeSelection();
  const askSelection=$('selection-menu').querySelector('[data-selection="ask"]');
  assert.equal(pointer(askSelection,'pointerdown').defaultPrevented,true,'the toolbar preserves the range for its actions');
  askSelection.click();
  assert.equal(selected,false);
  assert.equal($('selection-menu').hidden,true);
  assert.ok(requests.some(r=>r.action==='documents'&&r.path==='文献库/未分类'));
  assert.ok(!requests.some(r=>r.action==='folders'&&r.path==='研究资料'),'closed folders are not traversed');
  document.querySelector('[aria-label="展开 研究资料"]').click();
  await wait(()=>document.querySelector('[data-folder="研究资料/子目录"]'));

  globalThis.innerWidth=510;
  window.dispatchEvent(new window.Event('resize'));
  message({type:'hub-layout',width:800,directoryMode:'drawer',agentMode:'drawer'});
  message({type:'hub-close-directory'});
  assert.equal(document.body.dataset.directoryMode,'drawer');
  assert.equal($('library').hidden,false,'opening another pane does not fold the directory');
  message({type:'hub-toggle-directory'});
  assert.equal($('library').hidden,true);
  assert.equal(stored.get('dsh-literature-hub-directory-open'),'false');
  globalThis.innerWidth=1280;
  window.dispatchEvent(new window.Event('resize'));
  assert.equal($('library').hidden,true,'resizing does not reverse a manual fold');
  message({type:'hub-toggle-directory'});
  assert.equal($('library').hidden,false);

  $('annotations-toggle').click();
  assert.deepEqual([...document.querySelectorAll('.annotation-labels .tag-pill')].map(node=>node.textContent),['高亮','有旁注']);
  $('reader-scroll').scrollTop=0;
  $('reader-scroll').scrollLeft=0;
  document.querySelector('.annotation-quote').click();
  assert.ok($('reader-scroll').scrollTop>0,'clicking the quote scrolls to its source position');
  await wait(()=>$('note-gutter').querySelector('.note-marker'));
  document.querySelector('[aria-label="编辑批注标签"]').click();
  input($('annotation-tag-input'),'论证');
  $('annotation-tag-save').click();
  await wait(()=>doc.annotations.items[0].tags?.includes('论证'));
  await wait(()=>!$('annotation-tag-dialog').hasAttribute('open'));
  assert.ok([...document.querySelectorAll('.annotation-labels .tag-pill')].some(node=>node.textContent==='论证'));

  document.querySelector('[aria-label="在批注栏编辑旁注"]').click();
  const inline=document.querySelector('.annotation-note-editor');
  assert.equal(inline.hidden,false);
  input(inline,'批注栏写入的旁注');
  assert.equal(document.querySelector('[data-test-editor]').value.includes('批注栏写入的旁注'),true);

  $('rename-open').click();
  assert.equal($('rename-extension').textContent,'.md');
  input($('rename-name'),'改名.版本');
  $('rename-form').dispatchEvent(new window.Event('submit',{cancelable:true}));
  await wait(()=>$('document-title').textContent==='改名.版本');
  assert.deepEqual(requests.find(r=>r.action==='rename').data,{id:'paper',name:'改名.版本',expectedRevision:0});
  assert.equal(doc.name,'改名.版本.md');
  $('metadata-edit').click();
  input($('metadata-tags'),'资料标签');
  $('metadata-save').click();
  await wait(()=>$('document-tags').textContent==='资料标签');

  document.querySelector('[data-tab="notes"]').click();
  const editor=document.querySelector('[data-test-editor]');
  const content=JSON.parse(editor.value);
  const initialRevision=doc.notes.revision;
  assert.equal(content[0].markdown,'自由笔记');
  assert.equal(content[1].id,'note-1');
  content[1].text='更新后的 **Markdown** 旁注';
  content.push({kind:'markdown',markdown:'引文后的段落'});
  input(editor,JSON.stringify(content));
  $('notes-save').click();
  await wait(()=>doc.notes.revision===initialRevision+1 && $('save-status').textContent==='已保存');
  assert.deepEqual(requests.findLast(r=>r.action==='notes').data,{id:'paper',content,expectedRevision:initialRevision,expectedAnnotationsRevision:1});
  assert.equal(document.querySelector('.annotation-note-preview').textContent,content[1].text);

  input(editor,JSON.stringify(content.filter(item=>item.kind!=='quote')));
  assert.equal($('annotation-count').textContent,'0','deleting the quote immediately hides its mark');
  $('notes-save').click();
  await wait(()=>doc.annotations.items.length===0 && $('save-status').textContent==='已保存');
  input(editor,JSON.stringify(content));
  assert.equal($('annotation-count').textContent,'1','undo restores the matching mark');
  $('notes-save').click();
  await wait(()=>doc.annotations.items.length===1 && $('save-status').textContent==='已保存');
  document.querySelector('[aria-label="删除批注"]').click();
  assert.ok(!JSON.parse(editor.value).some(item=>item.kind==='quote'));
  $('notes-save').click();
  await wait(()=>doc.annotations.items.length===0 && $('save-status').textContent==='已保存');

  document.querySelector('[data-tab="study"]').click();
  assert.equal(document.querySelector('.current-task h4').textContent,'核对原文出处');
  [...document.querySelectorAll('.task-actions button')].find(n=>n.textContent==='完成').click();
  $('study-save').click();
  await wait(()=>doc.study.tasks[0].done===true);

  document.querySelector('[data-tab="notes"]').click();
  failNotes=true;
  const draftRevision=doc.notes.revision;
  content[1].text='未保存草稿';
  input(editor,JSON.stringify(content));
  $('notes-save').click();
  await wait(()=>$('save-status').textContent==='保存失败');
  message({type:'hub-unload'});
  const draft=JSON.parse(stored.get('dsh-literature-hub-draft:paper:notes'));
  assert.equal(draft.baseRevision,draftRevision);
  assert.deepEqual(draft.value.content,content);

  failNotes=false;
  $('notes-save').click();
  await wait(()=>$('save-status').textContent==='已保存');
  assert.equal($('rename-open').nextElementSibling,$('delete-open'));
  $('delete-open').click();
  assert.equal($('delete-document-name').textContent,'改名.版本.md');
  $('delete-cancel').click();
  assert.equal($('delete-dialog').hasAttribute('open'),false);
  assert.ok(!requests.some(request=>request.action==='delete-document'));
  $('delete-open').click();
  $('delete-form').dispatchEvent(new window.Event('submit',{cancelable:true}));
  await wait(()=>$('opened').hidden&&$('notice-retry').textContent==='撤销删除');
  assert.equal($('delete-open').hidden,true);
  assert.equal($('documents').querySelectorAll('.document-card').length,0);
  assert.equal(requests.find(request=>request.action==='delete-document').data.expectedHash,'fixture-hash');
  $('trash-open').click();
  await wait(()=>$('trash-list').querySelector('button'));
  assert.match($('trash-list').textContent,/改名\.版本/);
  $('trash-list').querySelector('button').click();
  await wait(()=>$('trash-status').textContent==='回收站为空'&&$('documents').querySelectorAll('.document-card').length===1);
  assert.ok(!html.includes('online-dialog'));
  assert.ok(!requests.some(r=>r.action==='papers'));
});
