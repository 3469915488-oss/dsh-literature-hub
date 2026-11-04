import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import vm from 'node:vm';

const runtimeModules=process.env.DSH_RUNTIME_MODULES?new URL('file://'+process.env.DSH_RUNTIME_MODULES.replace(/\/$/,'')+'/'):new URL('../../../work/app/dsh/node_modules/',import.meta.url);
registerHooks({resolve(specifier,context,next){return next(['@deepseek-ai/dsh-tools','@deepseek-ai/schemastery'].includes(specifier)?new URL(specifier+'/lib/index.'+(specifier==='@deepseek-ai/schemastery'?'mjs':'js'),runtimeModules).href:specifier,context);}});
const hostPlugin=await import('../lib/index.js');
const {apply}=hostPlugin;
const {Context}=await import(new URL('@deepseek-ai/cordis/lib/index.js',runtimeModules).href);
const {ToolRuntime}=await import('@deepseek-ai/dsh-tools');
const {createStore}=await import('../lib/store.js');
const {WebServer}=await import(new URL('@deepseek-ai/dsh-host-webserver/lib/index.js',runtimeModules).href);

test('host routes, native Session contracts, durable mirror, and bounded agent context',async t=>{
 const vault=await mkdtemp(new URL('../../../work/hub-contract-',import.meta.url).pathname);const disposers=[];const listeners=new Map(),tools=new Map();let route;let created=0;let modelSelections=0,workspaceCreates=0;const attached=[],selections=new Map();
 const ctx={tools:{register(def){tools.set(def.name,def);}},logger:{warn(){}},on(name,fn){const list=listeners.get(name)??[];list.push(fn);listeners.set(name,list);return()=>{};},effect(fn){const disposer=fn();if(disposer)disposers.push(disposer);},inject(_names,fn){fn(this);},webServer:{register(value){route=value;return()=>{};}},connection:{requestRejection(req){return req.headers['x-test-auth']==='yes'?undefined:401;}},workspaceController:{async create(opts){workspaceCreates++;assert.equal(opts.path,vault);return{workspace:{workspaceId:'fixture-workspace'}};}},workspaceRegistry:{get(id){assert.equal(id,'fixture-workspace');return{async attachSession(sessionId){attached.push(sessionId);}};}},sessionController:{async create(opts){created++;assert.equal(opts.agentPreset,'literature-hub');assert.equal(opts.workspaceId,'fixture-workspace');assert.equal('cwd' in opts,false);assert.ok(opts.sessionId.startsWith('dlh-'));return {sessionId:opts.sessionId};},async projections({sessionId}){return{kind:'sequenced',values:{modelSelection:{next:selections.get(sessionId)??null}}};},async modelCatalog(){return{default:{provider:'fixture-provider',model:'fixture-model'},groups:[{id:'fixture-provider',models:[{id:'fixture-model'}]}]};},async selectModel({sessionId,...selection}){modelSelections++;selections.set(sessionId,selection);}}};
 const server=createServer((req,res)=>{const pathname=new URL(req.url,'http://localhost').pathname;const matched=WebServer.prototype.match.call({exact:new Map(),prefixes:new Map([[route.path,route]])},pathname);if(!matched){res.writeHead(404);res.end();return;}matched.handler(req,res);});
 try{
  const store=await createStore({vaultPath:vault});const doc=await store.importFile({name:'fixture.md',base64:Buffer.from('# Public fixture\n\n'+('Signal feedback control. '.repeat(2000))).toString('base64')});
  await apply(ctx,{vaultPath:vault});assert.equal(route.path,'/literature-hub');assert.deepEqual([...tools.keys()],['hub_search','hub_read','hub_notes','hub_annotations','hub_study','hub_citation']);
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}/literature-hub/api/`;
  const request=(path,data,auth=true)=>fetch(base+path,{headers:{...(auth?{'x-test-auth':'yes'}:{}),...(data?{'content-type':'application/json'}:{})},...data?{method:'POST',body:JSON.stringify(data)}:{}});
  assert.equal((await request('status',undefined,false)).status,401);
  assert.equal((await (await request('documents')).json()).documents.length,1);
  const first=await (await request('session',{id:doc.id})).json();const second=await (await request('session',{id:doc.id})).json();assert.equal(first.sessionId,second.sessionId);assert.equal(created,1);assert.equal(first.workspaceId,'fixture-workspace');assert.equal(workspaceCreates,1);assert.deepEqual(attached,[first.sessionId]);assert.equal(modelSelections,1);assert.equal(first.modelStatus,'ready');assert.equal(second.modelStatus,'ready');assert.deepEqual(first.model,{provider:'fixture-provider',model:'fixture-model'});
  const session={id:first.sessionId};const events=[{type:'user/message',seq:5,time:123,data:{id:'user-fixture',content:[{type:'text',text:'Explain feedback.'}]}},{type:'assistant/message',seq:8,time:125,data:{message:{id:'assistant-fixture',content:[{type:'text',text:'Feedback compares the output with a target.'}]}}}];
  const runtimeContext={type:'user/message',seq:6,time:124,data:{id:'runtime-fixture',source:{kind:'runtime-context'},content:[{type:'text',text:'Current runtime context fixture must not be mirrored.'}]}};
  for(const event of [events[0],runtimeContext,events[1],events[1]])for(const fn of listeners.get('session/event')??[])fn(session,event);
  await Promise.all((listeners.get('session/flush')??[]).map(fn=>fn(session)));
  const mirrored=await store.get(doc.id);assert.equal(mirrored.sessions[0].messages.length,2);assert.equal(mirrored.sessions[0].messages[0].role,'user');assert.equal(mirrored.sessions[0].messages[1].role,'assistant');const transcript=await readFile(vault+'/'+mirrored.sessions[0].path,'utf8');assert.match(transcript,/Explain feedback\./);assert.doesNotMatch(transcript,/Current runtime context/);assert.equal(mirrored.sessions[0].messages.some(message=>message.id==='runtime-fixture'),false);
  const result=await tools.get('hub_read').execute({id:doc.id,limit:800},{agent:{id:session.id}});assert.equal(result.text.length,800);assert.equal(result.truncated,true);for(const key of ['pages','ocr','annotations','originalPath','pdfPath','sessions'])assert.equal(key in result,false);
  const implicit=await tools.get('hub_read').execute({page:1,limit:700},{agent:{id:session.id}});assert.equal(implicit.id,doc.id);
  const response=await request('notes',{id:doc.id,text:'A note',expectedRevision:0});assert.equal(response.status,200);assert.equal((await request('notes',{id:doc.id,text:'stale',expectedRevision:0})).status,409);
  const range=await fetch(base+'file?id='+doc.id+'&view=original',{headers:{'x-test-auth':'yes',range:'bytes=0-6'}});assert.equal(range.status,206);assert.equal(await range.text(),'# Publi');
  assert.equal((await request('document?id=invalid')).status,400);
  const metadata=await request('metadata',{id:doc.id,title:'Updated public fixture',tags:['fixture'],expectedRevision:0});assert.equal(metadata.status,200);assert.equal((await metadata.json()).title,'Updated public fixture');
  assert.equal((await request('papers?q=test')).status,404);assert.equal((await request('import',{url:'https://example.com'})).status,400);
  assert.equal((await request('folder',{action:'create',path:'',name:'合同资料'})).status,200);const folders=await (await request('folders?path=')).json();assert.ok(folders.folders.some(f=>f.name==='合同资料'));
  assert.equal((await request('moveDocument',{id:doc.id,destination:'合同资料'})).status,200);const files=await (await request('documents?path='+encodeURIComponent('合同资料'))).json();assert.ok(files.documents.some(d=>d.id===doc.id));
  const current=await (await request('document?id='+doc.id)).json();
  const deletion={id:doc.id,expectedRevision:current.metadataRevision,expectedHash:current.hash,expectedNotesRevision:current.notes.revision,expectedAnnotationsRevision:current.annotations.revision};
  assert.equal((await request('delete-document',deletion,false)).status,401);
  const recording=await request('voice/start',{docId:doc.id,mimeType:'audio/webm'});
  assert.equal(recording.status,200);
  const recordingId=(await recording.json()).id;
  assert.equal((await request('delete-document',deletion)).status,409);
  assert.equal((await request('voice/interrupt',{id:recordingId})).status,200);
  assert.equal((await request('delete-document',deletion)).status,200);
  assert.equal((await request('document?id='+doc.id)).status,404);
  assert.ok((await (await request('trash')).json()).documents.some(entry=>entry.id===doc.id));
  const restored=await request('restore-document',{id:doc.id});
  assert.equal(restored.status,200);
  assert.match((await restored.json()).notes.freeText,/A note/);
 }finally{server.close();for(const dispose of disposers)if(typeof dispose==='function')await dispose();await rm(vault,{recursive:true,force:true});}
});

test('client registers one main entry with a session scope and native Conversation factory',async()=>{
 const source=await readFile(new URL('../lib/client.js',import.meta.url),'utf8');let exports;const registrations=[];
 assert.doesNotMatch(source,/\.kB3qhq_panelList\{display:none!important\}/,'文献库不得隐藏 Harness 工作区的面板列表');
 const style={dataset:{},remove(){}};const document={createElement(){return style;},head:{appendChild(){}}};
 vm.runInNewContext(source,{window:{__ModuleLoader__:{load(spec){exports=spec.factory(name=>{assert.equal(name,'react');return{createElement(){},useState(){},useRef(){},useEffect(){}};});}}},document,fetch(){},URL,location:{origin:'http://localhost'}});
 const ctx={slots:{inject(_name,fn){return fn();},register(spec,component){registrations.push({spec,component});return()=>{};}},sessions:{},layout:{},theme:{getTheme(){}},on(){return()=>{};},effect(fn){fn();}};exports.apply(ctx);
 const panel=registrations.find(r=>r.spec.name==='main');assert.equal(panel.spec.key,'literature-hub');assert.equal(panel.spec.children['literature-hub.conversation'].scope,'session');
 const nav=registrations.filter(r=>r.spec.name==='sidebar.panellist');assert.equal(nav.length,1);assert.equal(nav[0].spec.label,'文献库');
 const conversation=registrations.find(r=>r.spec.name==='literature-hub.conversation');let rendered;conversation.component({sessionId:'fixture',useSession:fn=>fn({blank:false,openState:'open'}),useConversation:fn=>fn({activeTargets:new Set(['chat'])}),useSessions:fn=>fn({byId:{fixture:{blank:false}}}),renderFactorySlot(name,props,options){rendered={name,props,options};}});assert.equal(rendered.name,'conversation.content');assert.equal(rendered.props.variant,'embedded');assert.equal(typeof rendered.options.slots.views,'function');
});

 test('official WebServer prefix matcher requires no trailing slash',()=>{const route={kind:'prefix',path:'/literature-hub'};const table={exact:new Map(),prefixes:new Map([[route.path,route]])};for(const path of ['/literature-hub/api/status','/literature-hub/reader/','/literature-hub/vendor/pdf.min.mjs'])assert.equal(WebServer.prototype.match.call(table,path),route);assert.equal(WebServer.prototype.match.call(table,'/literature-hub-other/api/status'),undefined);const bad={exact:new Map(),prefixes:new Map([['/literature-hub/',{path:'/literature-hub/'}]])};assert.equal(WebServer.prototype.match.call(bad,'/literature-hub/api/status'),undefined);});

 test('real Harness tool runtime dispatches reading and search with optional fields missing',async()=>{
  const vault=await mkdtemp(new URL('../../../work/cordis-contract-',import.meta.url).pathname);const root=new Context();const routes=[];
  try{
   const store=await createStore({vaultPath:vault});
   const doc=await store.importFile({name:'read.md',base64:Buffer.from('# Fixture\n\nDistinctive quotation.').toString('base64')});
   await writeFile(new URL('loose.md',`file://${vault}/`),'Distinctive quotation in an unregistered note.');
   await store.close();
   await root.plugin(ctx=>{for(const[name,service]of Object.entries({systemPrompt:{tools(){}},webServer:{register(route){routes.push(route);return()=>{};}},connection:{requestRejection(){}},sessionController:{},workspaceController:{},workspaceRegistry:{}}))ctx.reflect.provide(name,service);});
   await root.plugin(ToolRuntime);
   await root.plugin(hostPlugin,{vaultPath:vault});assert.equal(routes.length,1);assert.equal(routes[0].path,'/literature-hub');assert.equal(root.tools.schemas().length,6);
   const execute=(name,args)=>root.tools.execute({name,arguments:args,callId:name,signal:new AbortController().signal});
   const read=await execute('hub_read',{id:doc.id});
   assert.equal(read.isError,false,read.error?.message);
   assert.match(read.value.text,/Distinctive quotation/);
   assert.deepEqual(JSON.parse(read.content[0].text),read.value);
   const search=await execute('hub_search',{q:'Distinctive quotation',scope:'vault'});
   assert.equal(search.isError,false,search.error?.message);
   assert.ok(search.value.hits.some(hit=>hit.id===doc.id&&hit.readerUrl.includes(doc.id)));
   assert.ok(search.value.hits.some(hit=>hit.path==='loose.md'&&!Object.hasOwn(hit,'readerUrl')));
   assert.deepEqual(JSON.parse(search.content[0].text),search.value);
  }finally{await root.fiber.dispose();await rm(vault,{recursive:true,force:true});}
 });
