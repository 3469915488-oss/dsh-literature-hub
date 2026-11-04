import {icon} from './icons.js';

const activeCapture=new Set(['requesting','recording','paused','stopping']);
const activeJob=new Set(['queued','running','downloading','verifying']);
const elapsed=value=>{
  const seconds=Math.max(0,Math.floor(Number(value)||0));
  return [Math.floor(seconds/60),seconds%60].map(part=>String(part).padStart(2,'0')).join(':');
};
const tabs=[['summary','智能总结'],['todos','待办事项'],['transcript','转写原文']];
function element(tag,cls,text){
  const el=document.createElement(tag);
  if(cls)el.className=cls;
  if(text!=null)el.textContent=text;
  return el;
}
function button(label,glyph,action,{caption=label,primary=false}={}){
  const el=element('button','dlh-voice-btn'+(primary?' dlh-voice-primary':''));
  el.type='button';el.title=label;el.dataset.tooltip=label;el.setAttribute('aria-label',label);
  if(glyph){const mark=element('span');mark.innerHTML=icon(glyph,17);mark.setAttribute('aria-hidden','true');el.append(mark);}
  if(caption)el.append(document.createTextNode(caption));
  el.addEventListener('click',action);
  return el;
}
function formatDate(value){
  const date=new Date(value);
  return Number.isFinite(+date)?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(date):'';
}
function paragraphs(root,value,onTime){
  let list=null;
  function inline(el,source){
    const re=/\[([^\]\n]+)\]\(#t=(\d+)\)|\*\*([^*\n]+)\*\*/g;
    let index=0;
    for(const m of source.matchAll(re)){
      el.append(document.createTextNode(source.slice(index,m.index)));
      if(m[3])el.append(element('strong',null,m[3]));
      else el.append(button('跳到 '+elapsed(m[2]),null,()=>onTime(Number(m[2])),{caption:m[1]}));
      index=m.index+m[0].length;
    }
    el.append(document.createTextNode(source.slice(index)));
  }
  for(const line of String(value||'').split('\n')){
    const text=line.trim();if(!text){list=null;continue;}
    const heading=/^#{1,6}\s+(.+)$/.exec(text), item=/^[-*•]\s+(.+)$/.exec(text);
    if(item){
      if(!list){list=element('ul');root.append(list);}
      const li=element('li');inline(li,item[1]);list.append(li);
    }else{
      list=null;const p=element(heading?'h4':'p');inline(p,heading?.[1]??text);root.append(p);
    }
  }
}

export function createVoicePanel({root,api,post,parentMessage,getDocument,notice,onAddToNote}){
  const controls=element('div','dlh-voice-controls'),library=element('div','dlh-voice-library');
  const stateLabel=element('span','dlh-voice-state');stateLabel.setAttribute('role','status');
  root.append(controls,library);
  let doc=null,capture={state:'idle'},details=null,list=[],model=null,activeTab='summary';
  let listOpen=false,timer,edited=null,drag=null,pending=false,seekPending=null,operationError='';
  const inserted=new Set();
  function command(action){parentMessage({type:'hub-voice-command',action,docId:doc?.id,title:doc?.title?doc.title+' · 录音':'录音'});}
  function error(cause){operationError=cause?.message||'录音操作未完成';if(!panel.hidden)renderDetails();else notice?.(operationError);}
  function refresh(){clearTimeout(timer);if(doc&&(listOpen||!panel.hidden||activeCapture.has(capture.state)))timer=setTimeout(poll,1200);}
  async function poll(){
    const id=doc?.id, asset=details?.id;
    if(!id)return;
    try{
      const requests=[];
      if(listOpen)requests.push(api('/voice/list?'+new URLSearchParams({docId:id})).then(rows=>{if(doc?.id===id){list=Array.isArray(rows)?rows:rows.recordings||[];renderLibrary();}}));
      if(!panel.hidden&&!edited&&asset){
        requests.push(api('/voice/detail?'+new URLSearchParams({id:asset,docId:id})).then(value=>{
          if(doc?.id===id&&details?.id===asset&&!edited){
            const before=JSON.stringify(details);details=value;
            if(JSON.stringify(details)!==before)renderDetails(true);
          }
        }));
      }
      if(!panel.hidden)requests.push(api('/voice/status').then(value=>{
        const next=value.model;if(JSON.stringify(model)!==JSON.stringify(next)){model=next;if(!edited)renderDetails(true);}
      }));
      await Promise.all(requests);
    }catch(e){if(!panel.hidden&&!edited)error(e);}
    refresh();
  }
  function renderControls(){
    controls.replaceChildren();
    if(!doc||doc.readOnly)return;
    const local=capture.docId===doc.id;
    if(!activeCapture.has(capture.state)){
      controls.append(button('开始录音','mic',()=>command('start'),{caption:'录音',primary:true}));
    }else{
      const recording=element('span','dlh-voice-indicator');
      recording.dataset.state=capture.state;
      recording.append(element('i'),document.createTextNode(capture.state==='requesting'?'等待麦克风':capture.state==='stopping'?'保存录音…':(local?'':'另一份资料 · ')+elapsed(capture.elapsedMs/1000)));
      controls.append(recording);
      if(capture.state==='recording'||capture.state==='paused')controls.append(button(capture.state==='paused'?'继续录音':'暂停录音',capture.state==='paused'?'play':'pause',()=>command(capture.state==='paused'?'resume':'pause')));
      if(capture.state!=='stopping')controls.append(button('停止录音','square',()=>command('stop')));
    }
    const toggle=button(listOpen?'收起录音列表':'展开录音列表','list-music',()=>{listOpen=!listOpen;renderControls();renderLibrary();poll();},{caption:'录音列表'});
    toggle.setAttribute('aria-expanded',String(listOpen));controls.append(toggle,stateLabel);
    stateLabel.textContent=local&&capture.state==='error'?capture.message||'录音未开始':'';
  }
  function renderLibrary(){
    library.replaceChildren();library.hidden=!listOpen;if(!listOpen)return;
    if(!list.length){library.append(element('p','dlh-voice-muted','当前文档暂无录音'));return;}
    for(const item of list){
      const row=element('div','dlh-voice-row');
      row.append(button(item.title||'录音','audio-lines',()=>openRecording(item.id),{caption:item.title||'录音'}),
        element('span','dlh-voice-muted',item.status==='interrupted'?'可恢复':elapsed(item.durationSeconds)));
      if(item.status==='saved')row.append(button('插入笔记录音卡','plus',()=>onAddToNote?.({kind:'audio',assetId:item.id}),{caption:''}));
      library.append(row);
    }
  }

  const panel=element('aside','dlh-voice-detail');panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label','录音详情');
  const header=element('header','dlh-voice-header');header.tabIndex=0;header.title='拖动录音详情';header.setAttribute('aria-label','拖动录音详情');
  const title=element('h3',null,'录音详情'),tabbar=element('nav','dlh-voice-tabs');tabbar.setAttribute('aria-label','录音详情选项');
  const body=element('div','dlh-voice-body'),footer=element('footer','dlh-voice-footer');
  const player=element('audio');player.preload='metadata';player.hidden=true;
  const wave=element('div','dlh-voice-wave'),canvas=element('canvas'),slider=element('input');
  slider.type='range';slider.min='0';slider.max='1';slider.step='.1';slider.value='0';slider.setAttribute('aria-label','录音播放进度');
  const times=element('div','dlh-voice-times'),playhead=element('span',null,'00:00'),total=element('span',null,'00:00');
  times.append(playhead,total);wave.append(canvas,slider);
  const playerControls=element('div','dlh-voice-player');
  const play=button('播放','play',()=>{if(player.paused)player.play().catch(error);else player.pause();},{caption:''});
  const updatePlay=()=>{play.title=play.dataset.tooltip=player.paused?'播放':'暂停';play.setAttribute('aria-label',play.title);play.firstChild.innerHTML=icon(player.paused?'play':'pause',22);};
  play.classList.add('dlh-voice-play');
  playerControls.append(button('后退 5 秒','rotate-ccw',()=>seek(player.currentTime-5),{caption:'5'}),play,button('前进 5 秒','rotate-cw',()=>seek(player.currentTime+5),{caption:'5'}));
  footer.append(wave,times,playerControls,player);
  const close=button('关闭录音详情','x',closePanel,{caption:''});
  header.append(title,button('还原详情位置','panel-right',()=>{panel.style.left='';panel.style.top='';},{caption:''}),close);
  panel.append(header,tabbar,body,footer);document.body.append(panel);

  function seek(seconds){
    const duration=Number(details?.durationSeconds)||player.duration||0;
    const target=Math.max(0,Math.min(duration,Number(seconds)||0));
    if(!Number.isFinite(player.duration)){seekPending=target;return;}
    player.currentTime=target;timeUpdate();
  }
  function draw(){
    if(panel.hidden)return;
    const w=canvas.clientWidth,h=canvas.clientHeight,dpr=window.devicePixelRatio||1;
    if(!w||!h)return;
    if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
    const ctx=canvas.getContext('2d');if(!ctx)return;
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
    const waveform=details?.waveform||[],fraction=player.currentTime/(Number(details?.durationSeconds)||1);
    const count=Math.min(waveform.length,Math.max(1,Math.floor(w/3)));
    for(let i=0;i<count;i++){
      const x=i*w/count,m=Math.max(2,Math.min(1,Number(waveform[Math.floor(i*waveform.length/count)])||0)*(h-3));
      ctx.fillStyle=i/count<=fraction?'#13959c':'#9bbdc080';ctx.fillRect(x,(h-m)/2,Math.max(1,w/count-1),m);
    }
  }
  function timeUpdate(){
    const duration=Number(details?.durationSeconds)||0;
    slider.max=String(Math.max(.1,duration));slider.value=String(player.currentTime||0);
    playhead.textContent=elapsed(player.currentTime);total.textContent=elapsed(duration);draw();
  }
  slider.addEventListener('input',()=>seek(slider.value));
  player.addEventListener('timeupdate',timeUpdate);
  player.addEventListener('loadedmetadata',()=>{if(seekPending!==null){seek(seekPending);seekPending=null;}timeUpdate();});
  player.addEventListener('play',updatePlay);player.addEventListener('pause',updatePlay);
  player.addEventListener('ended',updatePlay);
  function clamp(left,top){
    const bounds=panel.getBoundingClientRect();
    panel.style.left=Math.max(8,Math.min(Math.max(8,innerWidth-bounds.width-8),left))+'px';
    panel.style.top=Math.max(8,Math.min(Math.max(8,innerHeight-bounds.height-8),top))+'px';
  }
  header.addEventListener('pointerdown',e=>{
    if(e.button!==0||e.target.closest('button'))return;
    const box=panel.getBoundingClientRect();drag={left:box.left,top:box.top,x:e.clientX,y:e.clientY};
    header.setPointerCapture(e.pointerId);e.preventDefault();
  });
  header.addEventListener('pointermove',e=>{if(drag)clamp(drag.left+e.clientX-drag.x,drag.top+e.clientY-drag.y);});
  for(const ev of ['pointerup','pointercancel','lostpointercapture'])header.addEventListener(ev,()=>{drag=null;});
  header.addEventListener('keydown',e=>{
    if(!e.altKey||!e.key.startsWith('Arrow'))return;
    const box=panel.getBoundingClientRect();e.preventDefault();
    clamp(box.left+(e.key==='ArrowLeft'?-16:e.key==='ArrowRight'?16:0),box.top+(e.key==='ArrowUp'?-16:e.key==='ArrowDown'?16:0));
  });
  panel.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();closePanel();}});
  window.addEventListener('resize',()=>{if(!panel.hidden&&panel.style.left){const box=panel.getBoundingClientRect();clamp(box.left,box.top);}draw();});
  if(typeof ResizeObserver==='function')new ResizeObserver(draw).observe(canvas);

  function closePanel(){
    player.pause();panel.hidden=true;edited=null;operationError='';refresh();
  }
  async function openRecording(id){
    if(!doc)return;
    const docId=doc.id;
    try{
      const record=await api('/voice/detail?'+new URLSearchParams({id,docId}));
      if(doc?.id!==docId)return;
      if(details?.id!==id){activeTab='summary';edited=null;operationError='';seekPending=null;}
      details=record;panel.hidden=false;renderDetails();refresh();poll();
    }catch(e){notice?.(e?.message||'读取录音失败');}
  }
  async function perform(op,payload={}){
    if(pending||!details)return;
    const id=details.id;pending=true;operationError='';
    try{
      const result=await post('/voice/'+op,{id,...payload});
      if(details?.id!==id)return;
      if(result?.model)model=result.model;
      else if(result?.id===id)details=result;
      if(op==='recover'&&result?.status==='saved'&&doc?.id===result.docId&&!inserted.has(id)){
        inserted.add(id);onAddToNote?.({kind:'audio',assetId:id,recordingId:id,automatic:true});
      }
      if(op==='edit')edited=null;
      renderDetails();refresh();
    }catch(e){error(e);}
    finally{pending=false;}
  }
  function insert(kind){
    const recordingId=details.id;
    onAddToNote?.({kind,recordingId,assetId:recordingId,title:details.title+(kind==='summary'?' · 智能总结':' · 转写'),text:kind==='summary'?details.summary?.text:details.transcript?.text,todos:kind==='summary'?details.summary?.todos:[]});
  }
  function actions(...children){const row=element('div','dlh-voice-actions');row.append(...children);body.append(row);}
  function hint(message){body.append(element('p','dlh-voice-muted',message));}
  function renderDetails(keepScroll=false){
    if(panel.hidden||!details)return;
    const scroll=keepScroll?body.scrollTop:0;
    title.textContent=details.title||'录音详情';
    tabbar.replaceChildren();
    for(const [id,label] of tabs){
      const b=button(label,null,()=>{activeTab=id;operationError='';renderDetails();});
      b.setAttribute('aria-pressed',String(id===activeTab));tabbar.append(b);
    }
    const src=details.fileUrl||'';
    if(src&&player.getAttribute('src')!==src)player.setAttribute('src',src);
    if(!src&&player.hasAttribute('src')){player.pause();player.removeAttribute('src');}
    footer.hidden=!src;timeUpdate();
    body.replaceChildren();
    if(operationError)body.append(element('p','dlh-voice-error',operationError));
    if(details.status!=='saved'){
      hint(details.status==='interrupted'?'录音已中断，已写入的音频可以恢复。':'录音尚未保存。');
      if(details.status==='interrupted')actions(button('恢复录音','refresh-cw',()=>perform('recover'),{primary:true}));
      return;
    }
    const transcript=details.transcript||{},summary=details.summary||{};
    if(activeTab==='summary'){
      if(summary.text)paragraphs(body,summary.text,seek);
      if(summary.status==='stale')hint('转写稿已更新，可重新生成总结。');
      if(summary.error)hint(summary.error);
      if(activeJob.has(summary.status)){
        const progress=summary.progress;
        hint(progress?.stage==='sections'?'正在整理全文第 '+(progress.done+1)+' / '+progress.total+' 段…':'正在总结完整转写…');
        actions(button('取消总结','x',()=>perform('cancel',{kind:'summary'})));
      }else if(transcript.status==='ready'){
        actions(button(summary.text?'重新总结全文':'智能总结','sparkles',()=>perform('summary'),{primary:true}),
          ...(summary.text?[button('复制总结','copy',()=>navigator.clipboard.writeText(summary.text).catch(error)),button('插入笔记','file-plus',()=>insert('summary'))]:[]));
        hint('使用当前 Harness 模型总结整条录音的转写文字。');
      }else hint('完成转写后可总结整条录音。');
    }else if(activeTab==='todos'){
      if(!summary.todos?.length)hint('暂无从转写中提取的待办事项。');
      for(const item of summary.todos||[]){
        const row=element('div','dlh-voice-todo'),label=element('label'),check=element('input');
        check.type='checkbox';check.checked=item.done;
        check.addEventListener('change',()=>perform('edit',{expectedRevision:details.revision,todos:details.summary.todos.map(todo=>todo.id===item.id?{...todo,done:check.checked}:todo)}));
        label.append(check,document.createTextNode(item.text));row.append(label);
        if(Number.isFinite(item.at))row.append(button('跳到 '+elapsed(item.at),null,()=>seek(item.at),{caption:elapsed(item.at)}));
        body.append(row);
      }
    }else if(edited){
      for(const part of edited){
        const label=element('label','dlh-voice-transcript-edit',elapsed(part.start));
        const input=element('textarea');input.value=part.text;input.setAttribute('aria-label',elapsed(part.start)+' 转写');input.addEventListener('input',()=>{part.text=input.value;});
        label.append(input);body.append(label);
      }
      actions(button('保存校订','check',()=>perform('edit',{expectedRevision:details.revision,transcriptParts:edited.map(({index,text})=>({index,text}))}),{primary:true}),button('取消校订','x',()=>{edited=null;renderDetails();}));
    }else{
      if(activeJob.has(transcript.status)){
        hint('本机 Whisper 正在转写 '+(transcript.done||0)+' / '+(transcript.total||0)+' 段。');
        actions(button('取消转写','x',()=>perform('cancel',{kind:'transcribe'})));
      }else if(transcript.status==='ready'){
        for(const part of transcript.parts||[]){
          if(!part.text?.trim())continue;
          const row=element('section','dlh-voice-transcript');
          const segments=(part.segments||[]).filter(s=>s.text);
          if(segments.length&&segments.every(s=>part.text.includes(s.text))){
            for(const segment of segments){
              const p=element('p');
              p.append(button('跳到 '+elapsed(segment.start),null,()=>seek(segment.start),{caption:elapsed(segment.start)}),document.createTextNode(segment.text));
              row.append(p);
            }
          }else{
            const p=element('p');
            p.append(button('跳到 '+elapsed(part.start),null,()=>seek(part.start),{caption:elapsed(part.start)}),document.createTextNode(part.text));
            row.append(p);
          }
          body.append(row);
        }
        if(!transcript.parts?.length)paragraphs(body,transcript.text,seek);
        actions(button('校订转写','pencil',()=>{edited=(transcript.parts||[]).map(p=>({...p}));renderDetails();}),button('插入转写到笔记','file-plus',()=>insert('transcript')));
      }else{
        if(transcript.error)hint(transcript.error);
        if(model?.status==='ready')actions(button(transcript.status==='interrupted'?'继续转写':'开始本地转写','audio-lines',()=>perform('transcribe',{language:'auto'}),{primary:true}));
        else if(activeJob.has(model?.status)){
          const mb=Math.floor((model.receivedBytes||0)/1048576),total=Math.floor((model.totalBytes||0)/1048576);
          hint(model.status==='verifying'?'正在校验 Whisper 权重…':'正在准备 Whisper '+mb+(total?' / '+total:'')+' MB');
          actions(button('取消准备','x',()=>perform('cancel',{kind:'setup'})));
        }else if(model?.status==='unavailable')hint(model.message||'本机 Whisper 尚不可用。');
        else if(model){
          if(model.error)hint(model.error);
          actions(button('准备 Whisper 模型','download',()=>perform('setup'),{primary:true}));
          hint('一次性下载多语种权重。准备完成后在本机转写。');
        }else hint('正在检查本机 Whisper…');
      }
    }
    body.scrollTop=scroll;
  }

  return {
    isRecording(id){return capture.docId===id&&activeCapture.has(capture.state);},
    setDocument(next){
      if(doc?.id!==next?.id){closePanel();details=null;model=null;list=[];listOpen=false;}
      doc=next;renderControls();renderLibrary();refresh();
    },
    receive(message){
      if(message?.type!=='hub-voice-state')return;
      const rebuild=['state','docId','id','message'].some(key=>capture[key]!==message[key]);
      capture=message;
      if(rebuild)renderControls();
      else if(activeCapture.has(capture.state)){
        const label=controls.querySelector('.dlh-voice-indicator');
        if(label&&capture.state==='recording')label.lastChild.textContent=(capture.docId===doc?.id?'':'另一份资料 · ')+elapsed(capture.elapsedMs/1000);
      }
      const item=message.recording;
      if(doc?.id===message.docId&&item?.id){
        if(message.state==='saved'&&!inserted.has(item.id)){
          inserted.add(item.id);onAddToNote?.({kind:'audio',assetId:item.id,recordingId:item.id,automatic:true});
        }
        if(message.state==='interrupted'&&message.message)notice?.(message.message);
        if(listOpen)poll();
      }
      refresh();
    },
    openRecording
  };
}
