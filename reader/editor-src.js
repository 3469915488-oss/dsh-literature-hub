import MarkdownIt from 'markdown-it';
import {Schema, Fragment, Slice} from 'prosemirror-model';
import {EditorState, NodeSelection, TextSelection} from 'prosemirror-state';
import {EditorView} from 'prosemirror-view';
import {MarkdownParser, MarkdownSerializer, defaultMarkdownParser, defaultMarkdownSerializer} from 'prosemirror-markdown';
import {baseKeymap, chainCommands, setBlockType, toggleMark, wrapIn, lift} from 'prosemirror-commands';
import {wrapInList, sinkListItem, liftListItem, splitListItem} from 'prosemirror-schema-list';
import {history, undo, redo} from 'prosemirror-history';
import {keymap} from 'prosemirror-keymap';
import {dropCursor} from 'prosemirror-dropcursor';
import {gapCursor} from 'prosemirror-gapcursor';
import {icon} from './icons.js';

const numbered = new Set(['decimal','chinese','alpha']);
const styleOf = value => numbered.has(value) ? value : 'decimal';
const safeLink = value => {
  const s=String(value??'').trim();
  if (!s || /[\u0000-\u0020\u007f]/.test(s) || /^\/\//.test(s) || s.includes('\\')) return null;
  const scheme=s.match(/^([a-z][a-z\d+.-]*):/i)?.[1]?.toLowerCase();
  return scheme&&!['https','http','mailto','dsh-app'].includes(scheme) ? null : s;
};
const base=defaultMarkdownParser.schema;
const o=base.spec.nodes.get('ordered_list'), li=base.spec.nodes.get('list_item');
let nodes=base.spec.nodes.update('doc',{content:'(block|notebook_block)+'})
  .update('ordered_list',{...o,attrs:{...o.attrs,numbering:{default:'decimal'}},
    parseDOM:[{tag:'ol',getAttrs:dom=>({order:Number(dom.getAttribute('start'))||1,tight:dom.hasAttribute('data-tight'),numbering:styleOf(dom.dataset.numbering)})}],
    toDOM:n=>['ol',{start:n.attrs.order,'data-tight':n.attrs.tight?'true':null,'data-numbering':styleOf(n.attrs.numbering)},0]})
  .update('list_item',{...li,attrs:{checked:{default:null}},parseDOM:[{tag:'li',getAttrs:dom=>({checked:dom.hasAttribute('data-task')?dom.dataset.task==='checked':null})}],toDOM:n=>['li',{'data-task':n.attrs.checked==null?null:n.attrs.checked?'checked':'open'},0]})
  .update('image',{...base.spec.nodes.get('image'),toDOM:n=>['span',{class:'dlh-note-local-image','data-note-image':n.attrs.src},n.attrs.alt||'图片']})
  .append({
    raw_inline:{group:'inline',inline:true,atom:true,attrs:{source:{}},toDOM:n=>['span',{class:'dlh-note-literal'},n.attrs.source]},
    raw_block:{group:'block',content:'text*',marks:'',code:true,toDOM:()=>['pre',{class:'dlh-note-literal'},0]},
    cite_excerpt:{content:'inline*',defining:true,toDOM:()=>['blockquote',{class:'dlh-editor-excerpt','data-placeholder':'引文'},0]},
    cite_note:{content:'block+',defining:true,toDOM:()=>['div',{class:'dlh-editor-cite-body'},0]},
    citation:{group:'notebook_block',content:'cite_excerpt cite_note',defining:true,draggable:true,attrs:{meta:{default:{}}},toDOM:()=>['section',{class:'dlh-editor-citation'},0]},
    audio_clip:{group:'notebook_block',atom:true,selectable:true,draggable:true,attrs:{id:{default:null},assetId:{}},toDOM:n=>['article',{'data-audio-id':n.attrs.assetId},'录音']}
  });
const oldLink=base.spec.marks.get('link');
const marks=base.spec.marks.update('link',{...oldLink,parseDOM:[{tag:'a[href]',getAttrs:dom=>safeLink(dom.getAttribute('href'))?{href:dom.getAttribute('href'),title:dom.getAttribute('title')}:false}],toDOM:n=>['a',{href:safeLink(n.attrs.href),title:n.attrs.title,rel:'noreferrer noopener',target:'_blank'},0]});
export const editorSchema=new Schema({nodes,marks});
const md=new MarkdownIt('commonmark',{html:true,linkify:false}).enable('table');
md.core.ruler.after('inline','dlh_note_tokens',state=>{
  const tokens=state.tokens, lines=state.src.split('\n');
  for(let i=0;i<tokens.length;i++){
    const token=tokens[i];
    if(token.type==='html_block'){
      const match=token.content.trim().match(/^<!-- dlh-list:(chinese|alpha) -->$/);
      if(match&&tokens[i+1]?.type==='ordered_list_open'){
        tokens[i+1].attrSet('data-numbering',match[1]);tokens.splice(i--,1);
      }
    }else if(token.type==='table_open'&&token.map){
      const end=tokens.findIndex((t,j)=>j>i&&t.type==='table_close');
      if(end>i){token.type='html_block';token.nesting=0;token.content=lines.slice(...token.map).join('\n');tokens.splice(i+1,end-i);}
    }else if(token.type==='list_item_open'){
      const inner=tokens[i+1]?.type==='paragraph_open'?tokens[i+2]:null;
      const match=inner?.type==='inline'&&inner.children?.[0]?.type==='text'&&inner.children[0].content.match(/^\[([ xX])\]\s+/);
      if(match){token.attrSet('data-task',match[1]===' '?'open':'checked');inner.children[0].content=inner.children[0].content.slice(match[0].length);}
    }
  }
});
const baseTokens=defaultMarkdownParser.tokens;
const parser=new MarkdownParser(editorSchema,md,{
  ...baseTokens,
  ordered_list:{...baseTokens.ordered_list,getAttrs:(t,ts,i)=>({...baseTokens.ordered_list.getAttrs(t,ts,i),numbering:styleOf(t.attrGet('data-numbering'))})},
  list_item:{block:'list_item',getAttrs:t=>({checked:t.attrGet('data-task')?t.attrGet('data-task')==='checked':null})},
  html_block:{block:'raw_block',noCloseToken:true},
  html_inline:{node:'raw_inline',getAttrs:t=>({source:t.content})},
  link:{mark:'link',getAttrs:t=>({href:safeLink(t.attrGet('href'))||'#',title:t.attrGet('title')})}
});
const oldNodes=defaultMarkdownSerializer.nodes;
const serializer=new MarkdownSerializer({...oldNodes,
  ordered_list(state,node,parent,index){
    if(styleOf(node.attrs.numbering)!=='decimal'){state.write('<!-- dlh-list:'+node.attrs.numbering+' -->');state.ensureNewLine();state.write('\n');}
    oldNodes.ordered_list(state,node,parent,index);
  },
  list_item(state,node){if(node.attrs.checked!=null)state.write(node.attrs.checked?'[x] ':'[ ] ');state.renderContent(node);},
  raw_inline(state,node){state.write(node.attrs.source);},
  raw_block(state,node){state.text(node.textContent,false);state.closeBlock(node);}
},defaultMarkdownSerializer.marks);

const blank=()=>editorSchema.nodes.paragraph.create();
function parse(mdText){return parser.parse(String(mdText??''));}
function markdown(nodes){return nodes.length?serializer.serialize(editorSchema.topNodeType.create(null,Fragment.fromArray(nodes))):'';}
function flatten(node){const out=[];node.forEach(child=>out.push(child));return out;}
function excerpt(value){
  const content=[];String(value??'').split(/\r?\n/).forEach((line,i)=>{if(i)content.push(editorSchema.nodes.hard_break.create());if(line)content.push(editorSchema.text(line));});
  return editorSchema.nodes.cite_excerpt.create(null,content);
}
function quoteNode({quote,text,kind,...meta}){
  const {citation,cite_note}=editorSchema.nodes;
  return citation.create({meta},[excerpt(quote),cite_note.create(null,parse(text).content)]);
}
export function toEditorDocument(content=[]){
  const blocks=[];
  for(const item of Array.isArray(content)?content:[]){
    if(item?.kind==='markdown'){if(item.markdown)blocks.push(...flatten(parse(item.markdown)));}
    else if(item?.kind==='quote')blocks.push(quoteNode(item));
    else if(item?.kind==='audio'&&typeof item.assetId==='string')blocks.push(editorSchema.nodes.audio_clip.create({assetId:item.assetId,id:item.id??item.assetId}));
  }
  return editorSchema.topNodeType.create(null,blocks.length?blocks:[blank()]);
}
export function fromEditorDocument(doc){
  const ordered=[];let ordinary=[];
  const flush=()=>{if(ordinary.length){const text=markdown(ordinary);if(text.trim())ordered.push({kind:'markdown',markdown:text});ordinary=[];}};
  doc.forEach(n=>{
    if(n.type===editorSchema.nodes.citation){flush();let quote='';n.child(0).forEach(x=>{quote+=x.type===editorSchema.nodes.hard_break?'\n':x.textContent;});ordered.push({...n.attrs.meta,kind:'quote',quote,text:markdown(flatten(n.child(1)))});}
    else if(n.type===editorSchema.nodes.audio_clip){flush();ordered.push({kind:'audio',id:n.attrs.id??n.attrs.assetId,assetId:n.attrs.assetId});}
    else ordinary.push(n);
  });
  flush();return ordered;
}

function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;}
function button(label,asset,action,text){
  const b=el('button','dlh-editor-btn');b.type='button';b.title=label;b.dataset.tooltip=label;b.setAttribute('aria-label',label);
  if(asset){const mark=el('span');mark.innerHTML=icon(asset,16);mark.setAttribute('aria-hidden','true');b.append(mark);}
  if(text)b.append(document.createTextNode(text));b.addEventListener('click',action);return b;
}
const clock=value=>{const n=Math.max(0,Math.floor(Number(value)||0));return [Math.floor(n/60),n%60].map(x=>String(x).padStart(2,'0')).join(':');};
const labelOf=m=>m?.page?('原文 · 第 '+m.page+' 页'):'原文引文';

export function createNoteEditor({mount,onChange,onNavigateQuote,onOpenAudio,fetchAudioInfo}){
  const toolbar=el('div','dlh-editor-toolbar');toolbar.setAttribute('role','toolbar');toolbar.setAttribute('aria-label','笔记编辑工具');
  const surface=el('div','dlh-editor-surface');mount.classList.add('dlh-note-editor');mount.append(toolbar,surface);
  const n=editorSchema.nodes, m=editorSchema.marks;
  let view;
  function command(cmd){const ok=cmd(view.state,view.dispatch,view);view.focus();return ok;}
  function ancestor(type){
    const p=view.state.selection.$from;
    for(let d=p.depth;d>0;d--)if(p.node(d).type===type)return {node:p.node(d),pos:p.before(d)};
    return null;
  }
  function list(type,numbering='decimal'){
    const current=ancestor(type);
    if(current&&type===n.ordered_list){view.dispatch(view.state.tr.setNodeMarkup(current.pos,type,{...current.node.attrs,numbering}));view.focus();return;}
    if(current){command(liftListItem(n.list_item));return;}
    command(wrapInList(type,type===n.ordered_list?{numbering}:null));
  }
  const controls=[];
  function control(label,asset,fn,pressed){
    const b=button(label,asset,fn);b.addEventListener('mousedown',e=>e.preventDefault());toolbar.append(b);
    if(pressed)controls.push([b,pressed]);return b;
  }
  function select(label,options,change){
    const s=el('select','dlh-editor-select');s.title=label;s.dataset.tooltip=label;s.setAttribute('aria-label',label);
    for(const [value,name] of options){const o=el('option',null,name);o.value=value;s.append(o);}
    s.addEventListener('change',()=>change(s.value));toolbar.append(s);return s;
  }
  const headings=select('段落样式',[['p','正文'],['1','标题 1'],['2','标题 2'],['3','标题 3'],['4','标题 4']],v=>command(v==='p'?setBlockType(n.paragraph):setBlockType(n.heading,{level:Number(v)})));
  const activeMark=mark=>view.state.selection.empty?!!mark.isInSet(view.state.storedMarks??view.state.selection.$from.marks()):view.state.doc.rangeHasMark(view.state.selection.from,view.state.selection.to,mark);
  control('加粗','bold',()=>command(toggleMark(m.strong)),()=>activeMark(m.strong));
  control('斜体','italic',()=>command(toggleMark(m.em)),()=>activeMark(m.em));
  const link=control('插入链接','link',()=>{
    if(dialog.open)return;
    selection=view.state.selection.getBookmark();linkValue.value='';linkName.value=view.state.doc.textBetween(view.state.selection.from,view.state.selection.to,' ');linkError.textContent='';
    dialog.showModal();linkValue.focus();
  });
  control('引用段落','quote',()=>command(ancestor(n.blockquote)?lift:wrapIn(n.blockquote)),()=>!!ancestor(n.blockquote));
  control('项目符号','list',()=>list(n.bullet_list),()=>!!ancestor(n.bullet_list));
  const order=select('有序列表编号',[['','编号'],['decimal','1. 数字'],['chinese','一、中文'],['alpha','a. 字母']],v=>{if(v)list(n.ordered_list,v);});
  control('待办清单','list-checks',()=>{
    let current=ancestor(n.list_item);
    if(!current){if(!command(wrapInList(n.bullet_list)))return;current=ancestor(n.list_item);}
    if(current)view.dispatch(view.state.tr.setNodeMarkup(current.pos,null,{...current.node.attrs,checked:current.node.attrs.checked==null?false:null}));
    view.focus();
  },()=>ancestor(n.list_item)?.node.attrs.checked!=null);
  control('增加层级','indent-increase',()=>command(sinkListItem(n.list_item)));
  control('减少层级','indent-decrease',()=>command(liftListItem(n.list_item)));
  control('撤销','undo-2',()=>command(undo));
  control('重做','redo-2',()=>command(redo));

  const dialog=el('dialog','dlh-editor-link'),form=el('form');form.method='dialog';
  const linkName=el('input'),linkValue=el('input'),linkError=el('p','dlh-editor-link-error');
  let selection;
  linkName.setAttribute('aria-label','链接文字');linkName.placeholder='链接文字';linkValue.setAttribute('aria-label','链接地址');linkValue.placeholder='https://…';linkValue.required=true;
  const cancel=button('取消',null,()=>dialog.close(),'取消'),apply=el('button','dlh-editor-btn','插入');apply.type='submit';
  form.append(el('h3',null,'插入链接'),linkName,linkValue,linkError,el('div','dlh-editor-link-actions'));form.lastElementChild.append(cancel,apply);dialog.append(form);mount.append(dialog);
  form.addEventListener('submit',e=>{
    e.preventDefault();const href=safeLink(linkValue.value);if(!href){linkError.textContent='请输入有效的链接地址';return;}
    const state=view.state;let range;try{range=selection.resolve(state.doc);}catch{range=state.selection;}
    const mark=m.link.create({href});const tr=state.tr.setSelection(range);
    if(linkName.value&&linkName.value!==state.doc.textBetween(range.from,range.to,' ')||range.empty)tr.replaceSelectionWith(editorSchema.text(linkName.value||href,[mark]),false);
    else tr.addMark(range.from,range.to,mark);
    view.dispatch(tr);dialog.close();view.focus();
  });
  dialog.addEventListener('close',()=>{if(!view.hasFocus())link.focus();});

  const plugins=[history(),dropCursor({color:'#3689a5'}),gapCursor(),keymap({
    'Mod-b':toggleMark(m.strong),'Mod-i':toggleMark(m.em),'Mod-z':undo,'Shift-Mod-z':redo,'Mod-y':redo,
    Enter:(state,dispatch,editor)=>{const $from=state.selection.$from;if($from.parent.type===n.cite_excerpt){const end=$from.after($from.depth);dispatch?.(state.tr.setSelection(TextSelection.near(state.doc.resolve(end),1)));return true;}return splitListItem(n.list_item)(state,dispatch,editor);},
    Tab:sinkListItem(n.list_item),'Shift-Tab':liftListItem(n.list_item)
  }),keymap(baseKeymap)];
  function syncTools(){
    const cur=view.state.selection.$from.parent;headings.value=cur.type===n.heading&&cur.attrs.level<=4?String(cur.attrs.level):'p';
    const list=ancestor(n.ordered_list);order.value=list?styleOf(list.node.attrs.numbering):'';
    for(const [b,pressed] of controls)b.setAttribute('aria-pressed',String(!!pressed()));
  }
  function blockGrip(label,editor,getPos){
    function select(){
      const pos=getPos();
      if(typeof pos==='number')editor.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc,pos)));
    }
    const handle=button(label,'grip-vertical',select);
    handle.classList.add('dlh-editor-block-grip');
    handle.draggable=true;
    handle.addEventListener('dragstart',select);
    handle.addEventListener('keydown',event=>{
      if(!['ArrowUp','ArrowDown'].includes(event.key))return;
      const pos=getPos();
      if(typeof pos!=='number')return;
      const {doc,tr}=editor.state, index=doc.resolve(pos).index();
      const direction=event.key==='ArrowUp'?-1:1, adjacent=index+direction;
      if(adjacent<0||adjacent>=doc.childCount)return;
      event.preventDefault();
      const node=doc.child(index),other=doc.child(adjacent);
      const destination=pos+direction*other.nodeSize;
      editor.dispatch(tr.delete(pos,pos+node.nodeSize).insert(destination,node).setMeta('uiEvent','drop'));
      editor.nodeDOM(destination)?.querySelector('.dlh-editor-block-grip')?.focus();
    });
    return handle;
  }
  const nodeViews={
    citation(node,editor,getPos){
      const dom=el('section','dlh-editor-citation'),header=el('header','dlh-editor-citation-head'),contentDOM=el('div');
      header.contentEditable='false';let meta=node.attrs.meta;
      const handle=blockGrip('拖动批注调整顺序',editor,getPos);
      const jump=button('跳回原文','arrow-up-right',()=>onNavigateQuote?.(meta),labelOf(meta));
      const remove=button('删除批注引用','trash',()=>{
        const pos=getPos();
        const current=typeof pos==='number'?editor.state.doc.nodeAt(pos):null;
        if(current?.type===n.citation)editor.dispatch(editor.state.tr.delete(pos,pos+current.nodeSize));
      });
      header.append(handle,jump,remove);dom.append(header,contentDOM);
      return {dom,contentDOM,update(next){if(next.type!==n.citation)return false;meta=next.attrs.meta;jump.lastChild.textContent=labelOf(meta);return true;},
        stopEvent:event=>header.contains(event.target)&&!event.type.startsWith('drag')&&event.type!=='drop',
        ignoreMutation:event=>header.contains(event.target)};
    },
    list_item(node,editor,getPos){
      const dom=el('li'),body=el('div','dlh-editor-list-body');let checkbox=null,current=node;
      function sync(){
        if(current.attrs.checked==null){dom.removeAttribute('data-task');checkbox?.remove();checkbox=null;return;}
        dom.dataset.task=current.attrs.checked?'checked':'open';
        if(!checkbox){checkbox=el('input','dlh-editor-check');checkbox.type='checkbox';checkbox.contentEditable='false';checkbox.setAttribute('aria-label','完成待办');checkbox.addEventListener('change',()=>{const pos=getPos();if(typeof pos==='number')editor.dispatch(editor.state.tr.setNodeMarkup(pos,null,{...current.attrs,checked:checkbox.checked}));});dom.prepend(checkbox);}
        checkbox.checked=current.attrs.checked;
      }
      dom.append(body);sync();return{dom,contentDOM:body,update(next){if(next.type!==n.list_item)return false;current=next;sync();return true;},stopEvent:e=>e.target===checkbox,ignoreMutation:e=>e.type!=='selection'&&!body.contains(e.target)};
    },
    audio_clip(node,editor,getPos){
      const assetId=node.attrs.assetId, dom=el('article','dlh-editor-audio'),copy=el('div','dlh-editor-audio-copy'),title=el('strong',null,'录音'),meta=el('small',null,'正在读取录音');
      const handle=blockGrip('拖动录音卡调整顺序',editor,getPos);
      const mic=el('span','dlh-editor-audio-icon');mic.innerHTML=icon('mic',21);mic.setAttribute('aria-hidden','true');
      const details=button('查看录音详情','chevron-right',()=>onOpenAudio?.(assetId),'查看详情');
      dom.contentEditable='false';copy.append(title,meta);dom.append(handle,mic,copy,details);
      const load=()=>Promise.resolve(fetchAudioInfo?.(assetId)).then(v=>{
        const info=v?.recording??v;
        if(!info){meta.textContent='录音附件未就绪';return;}
        title.textContent=info.title||'录音';
        const date=new Date(info.createdAt??info.startedAt??'');
        const time=Number.isNaN(+date)?'':new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Shanghai'}).format(date);
        meta.textContent=[time,'时长 '+clock(info.durationSeconds??(Number(info.durationMs??info.elapsedMs)||0)/1000)].filter(Boolean).join('　');
      }).catch(()=>{meta.textContent='录音附件暂不可读取';});
      load();
      return{dom,stopEvent:e=>!['dragstart','dragend','drop','dragover','dragenter','dragleave','mousedown'].includes(e.type),ignoreMutation:()=>true};
    }
  };
  const makeState=doc=>EditorState.create({doc,plugins});
  view=new EditorView(surface,{state:makeState(toEditorDocument()),nodeViews,attributes:{'aria-label':'文献笔记编辑器',role:'textbox','aria-multiline':'true',spellcheck:'false','data-placeholder':'写下阅读想法…'},
    dragCopies(event){if(event.target?.closest?.('.dlh-editor-citation .dlh-editor-block-grip')||view.dragging?.slice.content.firstChild?.type===n.citation)return false;},
    dispatchTransaction(tr){const previous=view.state.doc;view.updateState(view.state.apply(tr));syncTools();if(tr.docChanged&&!tr.getMeta('dlh-sync'))onChange?.(fromEditorDocument(view.state.doc),fromEditorDocument(previous));}});
  syncTools();
  function insertTop(blocks,focus=true){
    const s=view.state,range=s.selection;
    const insideRoot=range.$from.depth===1&&range.$from.parent.isTextblock;
    if(insideRoot&&s.doc.canReplace(range.$from.index(0),range.$from.index(0),Fragment.fromArray(blocks))){
      const t=s.tr.replaceSelection(new Slice(Fragment.fromArray(blocks),0,0));
      view.dispatch(focus?t.scrollIntoView():t);if(focus)view.focus();return;
    }
    const pos=range.$from.depth?range.$from.after(1):range.to;
    const tr=s.tr.insert(pos,Fragment.fromArray(blocks));view.dispatch(focus?tr.scrollIntoView():tr);if(focus)view.focus();
  }
  function findQuote(...ids){
    let match;
    view.state.doc.forEach((node,pos)=>{
      if(node.type!==n.citation)return;
      const {id,annotationId}=node.attrs.meta;
      if(!match&&ids.some(value=>value&&(value===id||value===annotationId)))match={node,pos};
    });
    return match;
  }
  return{
    setContent(content,{reset=false}={}){const doc=toEditorDocument(content);if(reset)view.updateState(makeState(doc));else if(!doc.eq(view.state.doc))view.dispatch(view.state.tr.replaceWith(0,view.state.doc.content.size,doc.content).setMeta('addToHistory',false).setMeta('dlh-sync',true));syncTools();},
    getContent:()=>fromEditorDocument(view.state.doc),
    focus:()=>view.focus(),
    focusQuote(id){const found=findQuote(id);if(!found)return false;
      const pos=found.pos+2+found.node.child(0).nodeSize;
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos),1)).scrollIntoView());view.focus();return true;},
    upsertQuote(block){
      const {doc,tr}=view.state;
      const found=findQuote(block.id,block.annotationId);
      if(!found){view.dispatch(tr.insert(doc.content.size,quoteNode(block)));return true;}
      const body=found.node.child(1).content,next=parse(block.text).content;
      if(body.eq(next))return false;
      const start=found.pos+2+found.node.child(0).nodeSize;
      view.dispatch(tr.replaceWith(start,start+body.size,next));return true;
    },
    removeQuote(id){
      const found=findQuote(id);if(!found)return false;
      view.dispatch(view.state.tr.delete(found.pos,found.pos+found.node.nodeSize));return true;
    },
    insertAudio(assetId,{focus=true}={}){
      if(typeof assetId!=='string'||fromEditorDocument(view.state.doc).some(item=>item.kind==='audio'&&item.assetId===assetId))return false;
      const node=n.audio_clip.create({assetId,id:assetId});
      if(focus)insertTop([node]);
      else view.dispatch(view.state.tr.insert(view.state.doc.content.size,node));
      return true;
    },
    insertMarkdown(value){const parsed=flatten(parse(value));if(parsed.length)insertTop(parsed);},
    destroy(){view.destroy();toolbar.remove();surface.remove();dialog.remove();}
  };
}
