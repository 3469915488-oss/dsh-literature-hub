import {createReadStream} from 'node:fs';
import {readFile, stat, realpath} from 'node:fs/promises';
import {dirname, extname, join, resolve, sep} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {defineTool} from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import {createStore} from './store.js';
import {createAudioLibrary} from './audio.js';
import {summarizeFullTranscript,readHarnessText} from './voice-summary.js';

export const name = 'dsh-literature-hub';
export const inject = ['tools'];
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BASE = '/literature-hub';
const MAX_BODY = 96 * 1024 * 1024;
const defaultVaultPath=process.env.DSH_LITERATURE_VAULT||join(homedir(),'Documents','Obsidian');
export const Config = z.object({vaultPath:z.string().default(defaultVaultPath)});
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.pdf':'application/pdf','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.wasm':'application/wasm','.md':'text/plain; charset=utf-8'};
function json(res, status, body) {const b=Buffer.from(JSON.stringify(body));res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':b.length,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(b);}
async function body(req,maxBytes=MAX_BODY) {const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>maxBytes)throw Object.assign(new Error(maxBytes===MAX_BODY?'文件超过单次导入上限（64 MB）':'录音分段超过大小限制'),{status:413});chunks.push(chunk);}try{const value=JSON.parse(Buffer.concat(chunks).toString()||'{}');if(!value||typeof value!=='object'||Array.isArray(value))throw 0;return value;}catch{throw Object.assign(new Error('请求必须是 JSON 对象'),{status:400});}}
function requireId(id){if(typeof id!=='string'||!id||id.length>160)throw Object.assign(new Error('缺少文献标识'),{status:400});return id;}
function asArray(result,key){return Array.isArray(result)?result:result?.[key]??[];}
function readUrl(id,page,revision){return `${BASE}/reader/?id=${encodeURIComponent(id)}${page?'&page='+Number(page):''}${revision!==undefined?'&revision='+Number(revision):''}`;}
function parseSummary(doc){const details=doc.parseDetails??{};const body=details.body??doc.body??{},preview=details.preview??doc.preview??{};const pages=Array.isArray(details.ocr)?details.ocr:[];return{body:{status:body.status,engine:body.engine,pageMapping:body.pageMapping},preview:{status:preview.status,pageCount:preview.pageCount,quality:preview.quality},ocr:{pages:pages.length,failed:pages.filter(p=>p.status==='failed').length,lowConfidence:pages.filter(p=>p.quality==='low').length}};}
async function serveFile(req,res,path,contentType){const info=await stat(path);if(!info.isFile())throw Object.assign(new Error('文件不存在'),{status:404});let start=0,end=info.size-1,status=200;const range=req.headers.range;if(range){const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m||(!m[1]&&!m[2])){res.writeHead(416,{'content-range':`bytes */${info.size}`});res.end();return;}if(m[1]){start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),end):end;}else start=Math.max(0,info.size-Number(m[2]));if(start>end||start>=info.size){res.writeHead(416,{'content-range':`bytes */${info.size}`});res.end();return;}status=206;}
  const headers={'content-type':contentType??mime[extname(path)]??'application/octet-stream','content-length':end-start+1,'accept-ranges':'bytes','cache-control':'no-store','x-content-type-options':'nosniff'};if(status===206)headers['content-range']=`bytes ${start}-${end}/${info.size}`;res.writeHead(status,headers);if(req.method==='HEAD'||!info.size){res.end();return;}const stream=createReadStream(path,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
}
async function staticFile(req,res,base,relative){const root=await realpath(base);const path=await realpath(resolve(base,relative));if(path!==root&&!path.startsWith(root+sep))throw Object.assign(new Error('文件不可访问'),{status:403});return serveFile(req,res,path);}
export function citation(doc,style='gbt'){
 const metadata=doc.metadata??{};const rawAuthors=metadata.authors??metadata.author??[];const authorNames=(Array.isArray(rawAuthors)?rawAuthors:[rawAuthors]).filter(Boolean).map(a=>typeof a==='string'?a:[a.given,a.family].filter(Boolean).join(' '));
 const authors=authorNames.join(', '),year=metadata.year??'',doi=metadata.doi??'',journal=metadata.journal??'';const url=doi?'https://doi.org/'+doi:metadata.url??(typeof doc.source==='string'&&/^https?:/.test(doc.source)?doc.source:'');const title=String(metadata.title??doc.title??'未命名文献').replace(/[\r\n]/g,' ');const missing=[...(!authors?['author']:[]),...(!year?['year']:[])];let text;
 if(style==='bibtex'){const esc=value=>String(value).replace(/[{}\r\n]/g,' ');text=`@${journal?'article':'misc'}{${esc(doc.id)},\n  title = {${esc(title)}},\n  author = {${esc(authorNames.join(' and '))}},\n  year = {${esc(year)}}${journal?',\n  journal = {'+esc(journal)+'}':''}${doi?',\n  doi = {'+esc(doi)+'}':''}${url?',\n  url = {'+esc(url)+'}':''}\n}`;}
 else if(style==='apa')text=`${authors||'作者不详'}. (${year||'出版年不详'}). ${title}.${journal?' '+journal+'.':''}${url?' '+url:''}`;
 else text=`${authors||'作者不详'}. ${title}[${journal?'J':'EB/OL'}]. ${journal?journal+', ':''}${year||'出版年不详'}.${doi?' DOI: '+doi:url?' '+url:''}`;
 return{style,text,incomplete:missing.length>0,missing};
}

export async function apply(ctx,config={}){
 const vaultPath=config.vaultPath||defaultVaultPath;
 let audio,summarizeVoice;
 const store=await createStore({vaultPath,resolveAudioAsset:async({id,assetId})=>{
  const recording=await audio?.assetMetadata(assetId,{docId:id});
  if(!recording||recording.docId!==id||!recording.mediaLink||recording.status!=='saved')return null;
  return {path:recording.mediaLink,title:recording.title,transcriptPath:recording.transcriptPath};
 }});await store.init();ctx.effect(()=>()=>store.close?.());
 audio=await createAudioLibrary({vaultPath,getDocument:id=>store.get(id),summarize:payload=>{
  if(!summarizeVoice)throw Object.assign(new Error('当前 Harness 模型不可用'),{status:503});
  return summarizeVoice(payload);
 }});ctx.effect(()=>()=>audio.close());
 const sessionDocs=new Map(),creating=new Map(),mirrorQueues=new Map(),mirrorBuffers=new Map();
 for(const doc of asArray(await store.list(),'documents'))for(const s of doc.sessions??[])if(s.sessionId)sessionDocs.set(s.sessionId,doc.id);
 const inferredId=(args,exec)=>requireId(args.id??sessionDocs.get(exec?.agent?.id)??(/^dlh-(.+)$/.exec(exec?.agent?.id??'')?.[1]));
 const getDoc=async id=>{const doc=await store.get(requireId(id));if(!doc)throw Object.assign(new Error('文献不存在'),{status:404});return doc;};
 function registerTool(toolName,description,parameters,execute){
  ctx.tools.register(defineTool({
   name:toolName,description,parameters,
   output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
   // Harness validates the raw value before rendering. Omit absent fields as the JSON response does.
   async execute(args,exec){return JSON.parse(JSON.stringify(await execute(args,exec)));}
  }));
 }
 const idParam={id:{type:'string',description:'文献标识；省略时使用当前文献会话绑定的资料。'}};
 registerTool('hub_search','检索本地知识库正文、笔记和批注。默认当前文献所在目录当前层；scope=vault可检索整个知识库。结果保留来源和原文定位。',{q:{type:'string',required:true},scope:{type:'string'},path:{type:'string'},type:{type:'string'},tag:{type:'string'}},async(args,exec)=>{let path=args.path;if(path===undefined&&args.scope!=='vault'){try{path=(await getDoc(inferredId(args,exec))).folder??'';}catch{path='';}}const result=await store.search({...args,...path!==undefined?{path}:{},limit:12});return{hits:asArray(result,'hits').slice(0,12).map(hit=>({...hit,readerUrl:hit.id?readUrl(hit.id,hit.page):undefined}))};});
 registerTool('hub_read','读取当前或指定文献的正文片段，可按可靠页码或段落blockId定位。笔记与学习档案分别使用hub_notes和hub_study。',{...idParam,page:{type:'integer'},blockId:{type:'string'},limit:{type:'integer'}},async(args,exec)=>{const doc=await getDoc(inferredId(args,exec));const limit=Math.max(500,Math.min(args.limit??18000,40000));let text=doc.text??'';let location=null;if(args.blockId){const block=doc.blocks?.find(b=>b.id===args.blockId||b.blockId===args.blockId);if(!block)throw new Error('此段落不存在');text=block.text??block.markdown??'';location={blockId:args.blockId,page:block.page??null};}else if(args.page&&Array.isArray(doc.pages)&&doc.pages.length){const page=doc.pages.find((p,i)=>(p.page??i+1)===args.page);if(!page)throw new Error('此页不存在');text=page.text??String(page);location={page:args.page};}return{id:doc.id,title:doc.title,type:doc.type,source:doc.source,tags:doc.tags,parseStatus:doc.parseStatus??'ok',parseDetails:parseSummary(doc),warnings:doc.warnings??[],location,page:location?.page??null,pageCount:doc.pages?.length||null,text:text.slice(0,limit),truncated:text.length>limit,readerUrl:readUrl(doc.id,location?.page)};});
 registerTool('hub_notes','读取或保存文献笔记。用 content 保留段落、引用和录音顺序；兼容旧的 blocks 与 freeText。写入需 expectedRevision。',{...idParam,text:{type:'string'},freeText:{type:'string'},blocks:{type:'json'},content:{type:'json'},expectedRevision:{type:'integer'}},async(args,exec)=>{if(args.text===undefined&&args.freeText===undefined&&args.blocks===undefined&&args.content===undefined)return(await getDoc(inferredId(args,exec))).notes;const saved=await store.saveNote({...args,id:inferredId(args,exec)});return{id:saved.id,saved:true,notes:saved.notes};});
 registerTool('hub_annotations','读取或保存文献高亮、勾画与批注。写入前先读取revision；items是完整批注数组。',{...idParam,items:{type:'json'},expectedRevision:{type:'integer'}},async(args,exec)=>{if(args.items===undefined)return(await getDoc(inferredId(args,exec))).annotations;const saved=await store.saveAnnotations({id:inferredId(args,exec),items:args.items,expectedRevision:args.expectedRevision});return{id:saved.id,saved:true,revision:saved.annotations.revision,count:saved.annotations.items.length};});
 registerTool('hub_study','读取或保存学习计划、理解问题、测验反馈和复习日期。保存前先读取revision；study保留已有字段。',{...idParam,study:{type:'json'},expectedRevision:{type:'integer'}},async(args,exec)=>{if(args.study===undefined)return(await getDoc(inferredId(args,exec))).study;const saved=await store.saveStudy({id:inferredId(args,exec),study:args.study,expectedRevision:args.expectedRevision});return{id:saved.id,saved:true,study:saved.study};});
 registerTool('hub_citation','按已保存的元数据导出文献引用；缺少作者或年份时返回incomplete。',{...idParam,style:{type:'string'}},async(args,exec)=>citation(await getDoc(inferredId(args,exec)),args.style));

 function drainMirror(sessionId){const prior=mirrorQueues.get(sessionId)??Promise.resolve();const next=prior.catch(()=>{}).then(async()=>{const pending=mirrorBuffers.get(sessionId);if(!pending?.messages.length)return;const batch=pending.messages.slice();await store.saveSession(pending.docId,{sessionId,messages:batch,updatedAt:Date.now()});pending.messages.splice(0,batch.length);});mirrorQueues.set(sessionId,next);next.catch(error=>ctx.logger?.warn?.(`文献库会话镜像保存失败，原生会话日志保留：${error.code??error.name??'保存错误'}`));return next;}
 function mirror(session,event){const docId=sessionDocs.get(session.id)??/^dlh-(.+)$/.exec(session.id)?.[1];if(!docId||!['user/message','assistant/message'].includes(event.type))return;
  const message=event.type==='user/message'?event.data:event.data?.message;if(message?.source?.kind==='runtime-context')return;const text=(message?.content??[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');if(!text)return;
  if(!mirrorBuffers.has(session.id))mirrorBuffers.set(session.id,{docId,messages:[]});mirrorBuffers.get(session.id).messages.push({id:message.id??`${session.id}:${event.seq}`,seq:event.seq,role:event.type==='user/message'?'user':'assistant',text,time:event.time});drainMirror(session.id);
 }
 ctx.on('session/event',mirror);
 ctx.on('session/flush',session=>mirrorBuffers.has(session.id)?drainMirror(session.id).catch(()=>{}):undefined);
 ctx.effect(()=>async()=>{await Promise.allSettled([...mirrorBuffers.keys()].map(drainMirror));});

 ctx.inject(['webServer','connection','sessionController','workspaceController','workspaceRegistry'],rctx=>{
  let workspacePromise;
  const ensureWorkspace=async()=>{
   if(!workspacePromise)workspacePromise=rctx.workspaceController.create({path:vaultPath}).then(({workspace})=>workspace.workspaceId).catch(error=>{workspacePromise=undefined;throw error;});
   return workspacePromise;
  };
  const ensureModel=async sessionId=>{
   try{
    const projection=await rctx.sessionController.projections({sessionId},AbortSignal.timeout(15000));
    const existing=projection?.values?.modelSelection?.next;
    if(existing?.provider&&existing?.model)return{model:existing,modelStatus:'ready'};
    const catalog=await rctx.sessionController.modelCatalog();const selected=catalog.default;
    if(!selected?.provider||!selected?.model||!catalog.groups?.some(group=>group.id===selected.provider&&group.models.some(model=>model.id===selected.model)))return{modelStatus:'unavailable',modelError:'当前默认模型不可用，请在对话的模型菜单中选择已连接的模型。'};
    await rctx.sessionController.selectModel({sessionId,...selected});return{model:selected,modelStatus:'ready'};
   }catch{return{modelStatus:'unavailable',modelError:'暂时无法读取模型设置，请在对话的模型菜单中重试。'};}
  };
  const ensureSession=async(id,mode='read')=>{
   if(creating.has(id))return creating.get(id);
   const task=(async()=>{
    const doc=await getDoc(id);const workspaceId=await ensureWorkspace();const workspace=rctx.workspaceRegistry.get(workspaceId);
    if(!workspace)throw Object.assign(new Error('文献库工作区不可用，请重新打开应用'),{status:503});
    const existing=(doc.sessions??[]).find(s=>s.sessionId);let sessionId;
    if(existing){sessionId=existing.sessionId;await workspace.attachSession(sessionId);}
    else{const created=await rctx.sessionController.create({sessionId:`dlh-${id}`,workspaceId,agentPreset:'literature-hub'});sessionId=created.sessionId;await store.saveSession(id,{sessionId,mode,messages:[],updatedAt:Date.now()});}
    sessionDocs.set(sessionId,id);return{docId:id,sessionId,workspaceId,title:doc.title,...await ensureModel(sessionId)};
   })();creating.set(id,task);try{return await task;}finally{creating.delete(id);}
  };
  summarizeVoice=async ({docId,transcript,parts,signal,onProgress})=>{
   const llm=rctx.get?.('llm')??ctx.get?.('llm')??rctx.llm;
   if(typeof llm?.stream!=='function')throw new Error('当前 Harness 模型不可用');
   const bound=await ensureSession(docId);
   if(!bound.model?.provider||!bound.model.model)throw new Error(bound.modelError||'请先选择一个可用的 Harness 模型');
   const catalog=await rctx.sessionController.modelCatalog();
   const limits=catalog.groups?.find(g=>g.id===bound.model.provider)?.models?.find(m=>m.id===bound.model.model);
   return summarizeFullTranscript({transcript,parts,signal,onProgress,contextWindow:limits?.contextWindow,maxOutputTokens:limits?.maxTokens,
    generate:async({system,text,signal,maxTokens})=>{
     try{return await readHarnessText(llm.stream({provider:bound.model.provider,model:bound.model.model,
      system,messages:[{role:'user',content:[{type:'text',text}]}],signal,maxTokens}),signal);}
     catch(error){if(signal?.aborted)signal.throwIfAborted();throw new Error('当前 Harness 模型未完成总结，请检查模型连接后重试。',{cause:error});}
    }});
  };
  const voiceOperations=new Set(['start','chunk','stop','interrupt','recover','setup','transcribe','summary','edit','cancel']);
  async function voiceRequest(req,res,action,params){
   const op=action.slice('voice/'.length);
   if(req.method==='GET'||req.method==='HEAD'){
    if(op==='status')return json(res,200,await audio.status());
    if(op==='list')return json(res,200,await audio.list({docId:requireId(params.docId)}));
    if(op==='detail'||op==='file'){
     const id=requireId(params.id),ownership={docId:requireId(params.docId)};
     if(op==='detail')return json(res,200,await audio.get(id,ownership));
     const file=await audio.file(id,ownership);return serveFile(req,res,file.path,file.mimeType);
    }
   }else if(req.method==='POST'&&voiceOperations.has(op)&&typeof audio[op]==='function'){
    const data=await body(req,op==='chunk'?3*1024*1024:5*1024*1024);
    return json(res,200,await audio[op](data));
   }
   return json(res,404,{error:'录音接口不存在'});
  }
  async function dispatch(req,res,url){const route=url.pathname;const method=req.method??'GET';if(!['GET','HEAD','POST'].includes(method)){res.setHeader('allow','GET, HEAD, POST');return json(res,405,{error:'不支持此请求方法'});}if(route===BASE+'/reader'||route===BASE+'/reader/')return staticFile(req,res,resolve(ROOT,'reader'),'index.html');if(route.startsWith(BASE+'/reader/'))return staticFile(req,res,resolve(ROOT,'reader'),decodeURIComponent(route.slice((BASE+'/reader/').length)));if(route.startsWith(BASE+'/vendor/'))return staticFile(req,res,resolve(ROOT,'vendor'),decodeURIComponent(route.slice((BASE+'/vendor/').length)));
   if(!route.startsWith(BASE+'/api/'))return json(res,404,{error:'接口不存在'});const action=route.slice((BASE+'/api/').length);const params=Object.fromEntries(url.searchParams);if(action.startsWith('voice/'))return voiceRequest(req,res,action,params);if(method==='GET'||method==='HEAD'){
    if(action==='status')return json(res,200,await store.status());
    if(action==='documents'||action==='files'){if(params.path!==undefined)return json(res,200,await store.files(params));return json(res,200,{documents:asArray(await store.list(),'documents')});}
    if(action==='folders')return json(res,200,await store.folders(params));
    if(action==='trash')return json(res,200,await store.listDeletedDocuments());
    if(action==='document')return json(res,200,await getDoc(params.id));
    if(action==='search')return json(res,200,{hits:asArray(await store.search(params),'hits')});
    if(action==='note')return json(res,200,await store.readNote(params.path));
    if(action==='citation')return json(res,200,citation(await getDoc(params.id),params.style));
    if(action==='session'){const doc=await getDoc(params.id);return json(res,200,{sessions:doc.sessions??[]});}
    if(action==='file'){const doc=await getDoc(params.id);const path=await store.filePath(doc.id,params.view??'original',{revision:params.revision});if(!path)throw Object.assign(new Error('当前文件没有可用的PDF预览'),{status:404});const actual=typeof path==='string'?path:path.path;return serveFile(req,res,actual,params.view==='pdf'?'application/pdf':undefined);}
   }else if(method==='POST'){const data=await body(req);
    if(action==='import'){if(data.url)throw Object.assign(new Error('文献库仅导入本地文件'),{status:400});if(typeof data.base64!=='string'||typeof data.name!=='string')throw Object.assign(new Error('请选择本地文件'),{status:400});return json(res,200,await store.importFile(data));}
    if(action==='register')return json(res,200,await store.register(data));
    if(action==='folder')return json(res,200,await store.folder(data));
    if(action==='moveDocument')return json(res,200,await store.moveDocument(data));
    if(action==='reparse')return json(res,200,await store.reparse(requireId(data.id),{page:data.page}));
    if(action==='rename')return json(res,200,await store.renameDocument(data));
    if(action==='delete-document')return json(res,200,await audio.withoutActiveRecording(requireId(data.id),()=>store.deleteDocument(data)));
    if(action==='restore-document')return json(res,200,await store.restoreDocument({id:requireId(data.id)}));
    if(action==='metadata')return json(res,200,await store.updateMetadata(data));
    if(action==='notes')return json(res,200,await store.saveNote(data));
    if(action==='annotations')return json(res,200,await store.saveAnnotations(data));
    if(action==='progress')return json(res,200,await store.saveProgress(data));
    if(action==='study')return json(res,200,await store.saveStudy(data));
    if(action==='session')return json(res,200,await ensureSession(requireId(data.id??data.docId),data.mode));
   }return json(res,404,{error:'接口不存在'});
  }
  rctx.effect(()=>{return rctx.webServer.register({kind:'prefix',path:BASE,handler:(req,res)=>{const rejection=rctx.connection.requestRejection(req);if(rejection!==undefined)return json(res,rejection,{error:'此请求未通过本机应用身份验证'});const origin=req.headers.origin;if(req.method==='POST'&&origin){const host=req.headers.host;let valid=false;try{const parsed=new URL(origin);valid=parsed.host===host||parsed.protocol==='dsh-app:';}catch{}if(!valid)return json(res,403,{error:'请求来源不可访问'});}dispatch(req,res,new URL(req.url??'/','http://localhost')).catch(error=>{if(res.headersSent){res.end();return;}const denied=error.code==='EACCES'||error.code==='EPERM';const status=error.status??error.statusCode??(denied?403:error.code==='ENOENT'?404:500);const message=denied?'文献库缺少此文件或文件夹的访问权限':status===500?'操作未完成，请重试或查看应用日志':error.message;json(res,status,{error:message,code:error.code??'operation-failed',...(error.current?{current:error.current}:{})});if(status===500)ctx.logger?.warn?.(`文献库请求失败：${error.code??error.name}`);});}});});
 });
}
