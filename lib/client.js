window.__ModuleLoader__.load({
 id:'dsh-literature-hub',
 factory:(require)=>{
  const React=require('react');const {createElement:h,useState,useRef,useEffect}=React;
  const PANEL='literature-hub';
  const STYLE=`
.dlh-shell{height:100%;min-height:0;min-width:0;display:flex;flex-direction:column;position:relative;overflow:hidden;color:var(--dsw-alias-label-primary,#20242c);background:var(--dsw-alias-bg-base,#f7f8fa);font-family:var(--ds-font-family-ui,-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif)}
.dlh-chrome{height:max(48px,var(--dsh-frame-top-clearance,48px));min-height:48px;flex:none;display:flex;align-items:center;gap:10px;padding:0 14px 0 max(16px,var(--dsh-frame-leading-clearance,16px));border-bottom:.5px solid var(--dsw-alias-border-l3,#dfe3eb);background:color-mix(in srgb,var(--dsw-specific-sidebar-fill,#f4f6fa) 72%,transparent);backdrop-filter:blur(22px) saturate(1.35);-webkit-app-region:drag}
.dlh-shell .dlh-top-control{display:inline-flex;position:relative;flex:none;-webkit-app-region:no-drag}.dlh-top-control:has(:hover,:focus-visible)::after{content:attr(data-tooltip);position:absolute;top:calc(100% + 6px);left:50%;transform:translateX(-50%);width:max-content;max-width:200px;white-space:nowrap;pointer-events:none;padding:5px 8px;border-radius:6px;background:var(--dsw-alias-label-primary,#232a33);color:var(--dsw-alias-bg-base,#fff);font-size:12px;z-index:100;animation:dlh-tooltip-in .12s .45s both}@keyframes dlh-tooltip-in{from{opacity:0}to{opacity:1}}.dlh-chrome{position:relative;z-index:55}.dlh-shell .dlh-top-control:last-child::after{left:auto;right:0;transform:none}
/* The panel owns its reading controls.  Keep the host panel list visible: it
   contains Workspace sections such as plugins, automations, and sessions. */
body:has(.dlh-shell) [data-shell-leading],body:has(.dlh-shell) .kB3qhq_topStrip>button,body:has(.dlh-shell) .kB3qhq_toggle,body:has(.dlh-shell) .kB3qhq_newSession{display:none!important}
.dlh-chrome-title{font-size:13px;font-weight:550;letter-spacing:.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;opacity:.9}.dlh-chrome button{-webkit-app-region:no-drag}
.dlh-workspace{display:flex;flex:1;min-width:0;min-height:0;position:relative;overflow:hidden}.dlh-reader{flex:1;min-width:0;width:0;height:100%;border:0;background:transparent}
.dlh-chat{width:var(--dlh-chat-width,340px);min-width:0;display:flex;flex-direction:column;min-height:0;flex:none;border-left:.5px solid var(--dsw-alias-border-l2,#dce1e9);background:var(--dsw-alias-bg-base,#fff)}
.dlh-chat-title{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:15px 16px;font-size:13px;font-weight:550;flex:none}.dlh-chat-title span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dlh-toggle{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:30px;height:30px;color:var(--dsw-alias-label-secondary,#525f70);background:transparent;border:0;border-radius:9px;padding:5px 8px;cursor:pointer;font:inherit;font-size:12px}.dlh-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,#e8edf5)}.dlh-toggle[aria-expanded=true]{color:var(--dsw-alias-state-business-primary,#3d6ddd);background:var(--dsw-alias-interactive-bg-hover,#e8edf5)}.dlh-toggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:2px}
.dlh-chat-body{flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden}.dlh-chat-body>[data-slot]{flex:1;display:flex;flex-direction:column;min-height:0}.dlh-chat-body [data-conversation-content]{min-height:0;flex:1}
.dlh-resize{flex:none;width:5px;cursor:col-resize;touch-action:none;background:transparent;border:0;padding:0;outline-offset:-2px}.dlh-resize:hover,.dlh-resize:focus-visible{background:var(--dsw-alias-state-business-primary,#4176e6)}
.dlh-empty{margin:auto;padding:24px;color:var(--dsw-alias-label-secondary,#526174);font-size:13px;line-height:1.7;text-align:center}.dlh-empty svg{margin:0 auto 10px;display:block;opacity:.55}.dlh-error{padding:10px 16px;color:var(--dsw-alias-state-error-primary,#b42318);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#b42318) 8%,transparent);font-size:12px;line-height:1.5;overflow-wrap:anywhere}
.dlh-shell[data-chat=hidden] .dlh-chat,.dlh-shell[data-chat=hidden] .dlh-resize{display:none}.dlh-shell[data-agent-mode=drawer] .dlh-chat{position:absolute;z-index:45;inset:8px 8px 8px auto;width:min(440px,calc(100% - 16px));border:1px solid var(--dsw-alias-border-l2,#dce1e9);border-radius:18px;box-shadow:0 18px 64px #17243b30;overflow:hidden}.dlh-shell[data-agent-mode=drawer] .dlh-resize{display:none}.dlh-scrim{position:absolute;z-index:40;inset:0;background:#131c3033;border:0;backdrop-filter:blur(3px);cursor:pointer}
@media(prefers-reduced-transparency:reduce){.dlh-chrome{background:var(--dsw-specific-sidebar-fill,#f4f6fa);backdrop-filter:none}.dlh-scrim{backdrop-filter:none}}@media(prefers-reduced-motion:reduce){.dlh-shell *{scroll-behavior:auto!important}}
`;
  async function api(path,data,signal){const response=await fetch('/literature-hub/api/'+path,{credentials:'same-origin',signal,...data===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}});const value=await response.json();if(!response.ok){const error=new Error(value.error??'请求未完成');error.status=response.status;throw error;}return value;}
  function FixedChat(props){return props.renderSlot('conversation.session',{view:'chat'});}
  function ConversationPanel({sessionId,useSession,useConversation,useSessions,renderFactorySlot}){
   const session=useSession(value=>value);const conversation=useConversation(value=>value);const blank=useSessions(state=>state.byId[sessionId]?.blank);const phase=conversation.activeTargets.size>0||!session.blank&&!session.awaitingFirstTurn||session.running?'active':session.promptAttempted?'engaging':'blank';const settling=phase==='blank'&&session.openState==='loading'&&blank!==true;const hero=phase==='blank'&&(session.openState==='open'||blank===true);
   return renderFactorySlot('conversation.content',{variant:'embedded',phase:settling?'settling':hero?'hero':'active',hero},{slots:{views:FixedChat}});
  }
  // Lucide LibraryBig / PanelLeft / MessageSquare / X (ISC), bundled locally.
  function Icon({kind='library',size=18}={}){const nodes=({"library":[["rect",{"width":"8","height":"18","x":"3","y":"3","rx":"1"}],["path",{"d":"M7 3v18"}],["path",{"d":"M20.4 18.9c.2.5-.1 1.1-.6 1.3l-1.9.7c-.5.2-1.1-.1-1.3-.6L11.1 5.1c-.2-.5.1-1.1.6-1.3l1.9-.7c.5-.2 1.1.1 1.3.6Z"}]],"workspace":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M3 9h18"}]],"panel":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M9 3v18"}]],"chat":[["path",{"d":"M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"}]],"close":[["path",{"d":"M18 6 6 18"}],["path",{"d":"m6 6 12 12"}]]})[kind]??([["rect",{"width":"8","height":"18","x":"3","y":"3","rx":"1"}],["path",{"d":"M7 3v18"}],["path",{"d":"M20.4 18.9c.2.5-.1 1.1-.6 1.3l-1.9.7c-.5.2-1.1-.1-1.3-.6L11.1 5.1c-.2-.5.1-1.1.6-1.3l1.9-.7c.5-.2 1.1.1 1.3.6Z"}]]);return h('svg',{viewBox:'0 0 24 24',width:size,height:size,fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},...nodes.map(([tag,attrs],i)=>h(tag,{...attrs,key:i})));}
  function HubPanel({sessions,SessionProvider,renderSlot,subscribeTheme,getTheme,toggleWorkspace}){
   const frame=useRef(null),current=useRef(null),pending=useRef(null),generation=useRef(0),mounted=useRef(true),aborters=useRef(new Set()),recorder=useRef(null),selectedDoc=useRef(null);
   const [active,setActive]=useState(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
   const [hidden,setHidden]=useState(()=>{try{return localStorage.getItem('dlh.chat.hidden')==='true';}catch{return false;}}),[drawerOpen,setDrawerOpen]=useState(false),[width,setWidth]=useState(1200),[directoryOpen,setDirectoryOpen]=useState(true),[workspaceOpen,setWorkspaceOpen]=useState(true);
   const [chatWidth,setChatWidth]=useState(()=>{try{return Math.max(320,Math.min(560,Number(localStorage.getItem('dlh.chat.width'))||340));}catch{return 340;}});
   const shell=useRef(null),drag=useRef(null),widthRef=useRef(chatWidth),layoutRef=useRef({width:1200,directoryMode:'inline',agentMode:'inline'});widthRef.current=chatWidth;
   const drawer=width<860;const visible=drawer?drawerOpen:!hidden;
   const resize=value=>setChatWidth(Math.max(320,Math.min(Math.min(560,Math.max(320,(shell.current?.clientWidth??1200)-((shell.current?.clientWidth??1200)>=1120?780:520))),value)));
   const finishResize=event=>{if(!drag.current)return;drag.current=null;try{event.currentTarget.releasePointerCapture(event.pointerId);}catch{}try{localStorage.setItem('dlh.chat.width',String(widthRef.current));}catch{}};
   const post=value=>frame.current?.contentWindow?.postMessage(value,location.origin);
   const showChat=()=>{setDrawerOpen(true);setHidden(false);try{localStorage.setItem('dlh.chat.hidden','false');}catch{}};
   const toggleChat=()=>{if(layoutRef.current.agentMode==='drawer'){setDrawerOpen(value=>!value);}else setHidden(value=>{try{localStorage.setItem('dlh.chat.hidden',String(!value));}catch{}return !value;});};
   const report=(err,docId)=>{if(err?.name==='AbortError')return;const message=err?.message??String(err);if(mounted.current)setError(message);post({type:'hub-error',docId,message});};
   const sendTheme=()=>{if(!shell.current)return;const theme=getTheme();const style=getComputedStyle(shell.current),tokens={};for(let i=0;i<style.length;i++){const key=style[i];if(key.startsWith('--dsw-')||key.startsWith('--ds-font')||key.startsWith('--ds-radius')||key.startsWith('--ds-transition'))tokens[key]=style.getPropertyValue(key).trim();}tokens['--host-font-family']=style.fontFamily;post({type:'hub-theme',theme:theme?.active?.colorScheme??(document.body.hasAttribute('data-ds-dark-theme')?'dark':'light'),tokens,layout:layoutRef.current});post({type:'hub-layout',...layoutRef.current});};
   async function bind(docId){if(current.current?.docId===docId&&!pending.current){setActive(current.current);return current.current;}if(pending.current?.docId===docId)return pending.current.promise;const token=++generation.current;setActive(null);setLoading(true);setError('');post({type:'hub-session',docId,state:'loading'});
    const promise=(async()=>{const doc=await api('document?id='+encodeURIComponent(docId));const data=await api('session',{id:docId});if(!mounted.current||token!==generation.current)throw new DOMException('文献已切换','AbortError');const reference=sessions.retain(data.sessionId,{source:'literatureHub'});let binding;try{binding=await reference.ready;if(binding.session.getSnapshot().openState==='error')throw new Error('文献会话打开失败，请重试');}catch(err){reference.release();throw err;}if(!mounted.current||token!==generation.current){reference.release();throw new DOMException('文献已切换','AbortError');}const previous=current.current;const resource={docId,doc,sessionId:data.sessionId,reference,binding};let wasRunning=binding.session.getSnapshot().running;resource.unsubscribe=binding.session.subscribe(()=>{const running=binding.session.getSnapshot().running;if(wasRunning&&!running&&current.current===resource)post({type:'hub-refresh',docId});wasRunning=running;});current.current=resource;setActive(resource);setLoading(false);previous?.unsubscribe?.();previous?.reference.release();post({type:'hub-session',docId,sessionId:data.sessionId,state:'ready'});return resource;})();pending.current={docId,promise};try{return await promise;}catch(err){if(token===generation.current)setLoading(false);throw err;}finally{if(pending.current?.promise===promise)pending.current=null;}
   }
   async function ask(message){showChat();const question=String(message.question??'').trim();if(!question)return;const resource=await bind(message.docId);if(current.current!==resource)throw new DOMException('文献已切换','AbortError');const controller=new AbortController();aborters.current.add(controller);const quote=String(message.selectedText??'').slice(0,12000);const page=Number.isInteger(message.page)&&message.page>0?message.page:undefined;const revision=Number(message.previewRevision)||undefined;const historical=revision!==undefined&&revision!==resource.doc.previewRevision;const readerUrl='/literature-hub/reader/?id='+encodeURIComponent(resource.docId)+(revision!==undefined?'&revision='+revision:'');const prompt=[`正在阅读《${resource.doc.title}》`,historical?'当前选文来自历史预览版本 '+revision+'；历史页码仅对应此版本。以选文为依据；调用 hub_read 时读取的是当前正文，不能沿用历史页码。':'',`[${page?'第'+page+'页原文':'打开原文'}](${readerUrl}${page?'&page='+page:''})`,message.blockId?'段落定位：'+String(message.blockId):'',message.mode==='study'?'学习模式：结合当前学习记录，通过阅读问题、回答反馈与复习帮助理解资料。':'阅读问答。',quote?`选中的原文${page?'（第'+page+'页）':''}：\n\n> ${quote.replace(/\n/g,'\n> ')}`:'','用户问题：'+question].filter(Boolean).join('\n\n');
    try{const echo=resource.binding.session.beginSubmission({mode:'queue',text:question,attachments:[]});const result=await resource.binding.session.prompt([{type:'text',text:prompt}],'queue',controller.signal,echo.requestId);if(!result.ok)throw new Error(result.error?.message??'消息提交失败');}finally{aborters.current.delete(controller);}
   }
   useEffect(()=>{mounted.current=true;let raf;const scheduleTheme=()=>{cancelAnimationFrame(raf);raf=requestAnimationFrame(sendTheme);};
    const updateWorkspace=()=>{const host=shell.current?.closest('.PIRFFq_frame,[data-rightbar-collapsed]');setWorkspaceOpen(!host?.hasAttribute('data-sidebar-collapsed'));};
    const observer=new ResizeObserver(()=>{const measured=Math.round(shell.current?.clientWidth??1200);const reading=Math.round(frame.current?.clientWidth??measured);
      const next={width:measured,directoryMode:reading<560?'drawer':'inline',agentMode:measured<860?'drawer':'inline'};
      if(JSON.stringify(next)!==JSON.stringify(layoutRef.current)){layoutRef.current=next;post({type:'hub-layout',...next});}
      setWidth(measured);updateWorkspace();scheduleTheme();});
    if(shell.current)observer.observe(shell.current);if(frame.current)observer.observe(frame.current);updateWorkspace();
    const loadRecorder=()=>recorder.current??=(import('/literature-hub/reader/recorder.js').then(({createRecorder})=>{
      if(!mounted.current)return null;
      return createRecorder({post:(path,data)=>api(path.replace(/^\//,''),data),onState:state=>post({type:'hub-voice-state',...state})});
    }).catch(error=>{recorder.current=null;throw error;}));
    loadRecorder().catch(()=>{});
    const listener=event=>{
      if(event.source!==frame.current?.contentWindow||event.origin!==location.origin)return;
      const message=event.data;if(!message||typeof message!=='object')return;
      if(message.type==='hub-ready'){scheduleTheme();recorder.current?.then(r=>{const state=r?.getState?.();if(state)post({type:'hub-voice-state',...state});}).catch(()=>{});return;}
      if(message.type==='hub-layout'){if(typeof message.directoryOpen==='boolean')setDirectoryOpen(message.directoryOpen);return;}
      if(message.type==='hub-document-meta'&&typeof message.title==='string'&&current.current?.docId===message.docId){
        current.current.doc={...current.current.doc,title:message.title};setActive({...current.current});return;
      }
      if(message.type==='hub-deselect'){
        if(selectedDoc.current!==message.docId)return;
        selectedDoc.current=null;generation.current++;pending.current=null;
        current.current?.unsubscribe?.();current.current?.reference.release();current.current=null;
        setActive(null);setLoading(false);setError('');return;
      }
      if(message.type==='hub-show-agent'){showChat();return;}
      if(message.type==='hub-voice-command'){
        if(!['start','stop','pause','resume','interrupt'].includes(message.action))return;
        if(message.action==='start'&&(!selectedDoc.current||selectedDoc.current!==message.docId))return;
        loadRecorder().then(r=>r?.[message.action]?.({docId:message.docId,title:message.title,id:message.id})).catch(error=>post({type:'hub-voice-state',state:'error',docId:message.docId,message:String(error?.message||error)}));return;
      }
      if(!['hub-select','hub-ask'].includes(message.type)||typeof message.docId!=='string')return;
      if(message.type==='hub-select')selectedDoc.current=message.docId;
      (message.type==='hub-select'?bind(message.docId):ask(message)).catch(err=>report(err,message.docId));
    };
    window.addEventListener('message',listener);const unsubscribe=subscribeTheme(scheduleTheme);
    const mutation=new MutationObserver(()=>{updateWorkspace();scheduleTheme();});mutation.observe(document.body,{attributes:true,attributeFilter:['data-ds-dark-theme','style']});
    const host=shell.current?.closest('.PIRFFq_frame,[data-rightbar-collapsed]');if(host)mutation.observe(host,{attributes:true,attributeFilter:['data-sidebar-collapsed']});
    const keyboard=e=>{if(e.key==='Escape')setDrawerOpen(false);};window.addEventListener('keydown',keyboard);
    return()=>{mounted.current=false;generation.current++;observer.disconnect();mutation.disconnect();cancelAnimationFrame(raf);window.removeEventListener('message',listener);window.removeEventListener('keydown',keyboard);unsubscribe?.();post({type:'hub-unload'});recorder.current?.then(r=>r?.destroy()).catch(()=>{});for(const a of aborters.current)a.abort();current.current?.unsubscribe?.();current.current?.reference.release();current.current=null;};},[]);
   useEffect(()=>{const listener=event=>{const anchor=event.target?.closest?.('a[href]');if(!anchor)return;let url;try{url=new URL(anchor.href,location.href);}catch{return;}if(url.origin!==location.origin||url.pathname!=='/literature-hub/reader/')return;event.preventDefault();const docId=url.searchParams.get('id');if(docId){bind(docId).catch(err=>report(err,docId));post({type:'hub-navigate',docId,page:Number(url.searchParams.get('page'))||1,revision:url.searchParams.has('revision')?Number(url.searchParams.get('revision')):undefined,q:url.searchParams.get('q')??''});}};document.addEventListener('click',listener,true);return()=>document.removeEventListener('click',listener,true);},[]);
   const actualChatWidth=Math.max(320,Math.min(chatWidth,Math.max(320,width-(width>=1120?780:520))));
   const topControl=(label,expanded,onClick,kind,caption)=>h('span',{className:'dlh-top-control','data-tooltip':label},h('button',{type:'button',className:'dlh-toggle',onClick,'aria-label':label,'aria-expanded':expanded},h(Icon,{kind}),caption));
   return h('div',{className:'dlh-shell',ref:shell,style:{'--dlh-chat-width':actualChatWidth+'px'},'data-chat':visible?'visible':'hidden','data-agent-mode':drawer?'drawer':'inline'},
    h('header',{className:'dlh-chrome'},topControl(workspaceOpen?'收起 Harness 工作区':'展开 Harness 工作区',workspaceOpen,()=>toggleWorkspace?.(),'workspace'),topControl(directoryOpen?'收起文献库目录':'展开文献库目录',directoryOpen,()=>post({type:'hub-toggle-directory'}),'panel'),h('span',{className:'dlh-chrome-title'},active?.doc.title??'文献库'),topControl(visible?'收起文献对话':'展开文献对话',visible,toggleChat,'chat','对话')),
    h('div',{className:'dlh-workspace'},h('iframe',{className:'dlh-reader',ref:frame,src:'/literature-hub/reader/',title:'文献库阅读与笔记',onLoad:sendTheme}),drawer&&visible?h('button',{className:'dlh-scrim','aria-label':'关闭对话抽屉',onClick:()=>setDrawerOpen(false)}):null,
    h('div',{className:'dlh-resize',role:'separator',tabIndex:visible&&!drawer?0:-1,'aria-label':'调整对话宽度','aria-orientation':'vertical','aria-valuenow':actualChatWidth,'aria-valuemin':320,'aria-valuemax':560,onPointerDown:event=>{if(event.button!==0)return;drag.current={x:event.clientX,width:actualChatWidth};event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();},onPointerMove:event=>{if(drag.current)resize(drag.current.width+drag.current.x-event.clientX);},onPointerUp:finishResize,onPointerCancel:finishResize,onLostPointerCapture:()=>{drag.current=null;},onKeyDown:event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();resize(widthRef.current+(event.key==='ArrowLeft'?24:-24));}}),
    h('aside',{className:'dlh-chat','aria-label':'文献原生对话','aria-hidden':!visible,...drawer&&visible?{role:'dialog','aria-modal':true}:{}},h('div',{className:'dlh-chat-title'},h('span',null,'伴读'),h('button',{className:'dlh-toggle',onClick:toggleChat,title:'收起对话','aria-label':'收起对话'},h(Icon,{kind:'close',size:16}))),error?h('div',{className:'dlh-error',role:'alert'},error):null,loading?h('div',{className:'dlh-empty'},'正在打开会话…'):null,h('div',{className:'dlh-chat-body'},active?h(SessionProvider,{session:active.reference,key:active.sessionId},renderSlot('literature-hub.conversation',{})):h('div',{className:'dlh-empty'},h(Icon,{size:28}),'选择文献开始对话')))));

  }
  const inject=['slots','sessions','layout','theme'];
  function apply(ctx){const style=document.createElement('style');style.dataset.plugin='dsh-literature-hub';style.textContent=STYLE;document.head.appendChild(style);ctx.effect(()=>()=>style.remove());
   ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:PANEL,children:{'literature-hub.conversation':{kind:'single',scope:'session'}},inject:()=>({sessions:ctx.sessions,toggleWorkspace:()=>ctx.layout.toggleSidebar(),getTheme:()=>ctx.theme.getTheme(),subscribeTheme:listener=>ctx.on('theme/change',listener)})},HubPanel));
   ctx.slots.inject('literature-hub.conversation',()=>ctx.slots.register({name:'literature-hub.conversation'},ConversationPanel));
   ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:PANEL,order:8,label:'文献库'},Icon));
  }
  return{inject,apply};
 }
});
