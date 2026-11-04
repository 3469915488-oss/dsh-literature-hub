import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStore} from '../lib/store.js';
import {createAudioLibrary} from '../lib/audio.js';
import {run} from '../lib/process.js';
import {summarizeFullTranscript,readHarnessText} from '../lib/voice-summary.js';
import {fromEditorDocument,toEditorDocument} from '../reader/editor-src.js';

test('voice attachments recover, seek, and survive a document rename with their note', {timeout:150000}, async t=>{
 const vaultPath=await mkdtemp(join(tmpdir(),'dsh-voice-test-'));
 t.after(()=>rm(vaultPath,{recursive:true,force:true}));
 let audio;
 const store=await createStore({vaultPath,resolveAudioAsset:async ({id,assetId})=>{
  const asset=await audio.assetMetadata(assetId,{docId:id});
  return {path:asset.mediaLink,title:asset.title};
 }});
 t.after(()=>store.close());
 await store.init();
 const doc=await store.importFile({name:'课程.md',base64:Buffer.from('课程资料').toString('base64')});
 const other=await store.importFile({name:'另一份.md',base64:Buffer.from('另一份资料').toString('base64')});
 const input=join(vaultPath,'synthetic.webm');
 await run('/opt/homebrew/bin/ffmpeg',['-loglevel','error','-f','lavfi','-i','sine=frequency=320:sample_rate=48000','-t','6025','-c:a','libopus','-b:a','8k','-frame_duration','60',input],{timeout:90000});
 const bytes=await readFile(input);
 const open=()=>createAudioLibrary({vaultPath,getDocument:id=>store.get(id)});
 audio=await open();
 const record=await audio.start({docId:doc.id,title:'长录音测试',mimeType:'audio/webm;codecs=opus'});
 for(let i=0,offset=0;offset<bytes.length;i++,offset+=1024*1024){
  await audio.chunk({id:record.id,seq:i,base64:bytes.subarray(offset,offset+1024*1024).toString('base64')});
 }
 await audio.close();
 audio=await open();
 try{
  const list=await audio.list({docId:doc.id});
  assert.equal(list[0].status,'interrupted');
  const saved=await audio.recover({id:record.id});
  assert.equal(saved.status,'saved');
  assert.ok(Math.abs(saved.durationSeconds-6025)<1);
  assert.equal(saved.waveform.length,160);
  assert.ok(saved.waveform.some(n=>n>0));
  const file=await audio.file(record.id,{docId:doc.id});
  assert.equal(file.mimeType,'audio/webm');
  assert.ok((await stat(file.path)).size>1_000_000);
  await assert.rejects(audio.file(record.id,{docId:other.id}),/不属于/);
  const {stdout}=await run('/opt/homebrew/bin/ffmpeg',['-loglevel','error','-ss','6010','-i',file.path,'-t','1','-f','s16le','pipe:1'],{maxBuffer:200_000});
  assert.ok(stdout.length>1000);
  const notes=await store.saveNote({id:doc.id,expectedRevision:doc.notes.revision,content:[{kind:'audio',assetId:record.id,id:record.id}]});
  assert.match(notes.notes.text,/长录音测试/);
  assert.match(notes.notes.text,/audio\.webm/);
  const renamed=await store.renameDocument({id:doc.id,name:'课程第二讲',expectedRevision:notes.metadataRevision});
  assert.match(renamed.notes.text,/audio\.webm/);
  assert.equal(renamed.notes.content[0].assetId,record.id);
  assert.equal((await audio.list({docId:doc.id}))[0].id,record.id);
 }finally{await audio.close();}
});

test('full-transcript summary visits every byte and preserves valid timestamp citations', async()=>{
 const pieces=['起始结论','中间论点','结尾待办'];
 const transcript=pieces.map(x=>x+'。'+(x+' 内容。').repeat(700)).join('\n\n');
 const parts=transcript.split('\n\n').map((text,i)=>({start:i*90,text}));
 const seen=new Set(),sectionInputs=[];
 const result=await summarizeFullTranscript({transcript,parts,contextWindow:5800,generate:async ({text})=>{
  const request=text.slice(0,text.indexOf('\n\n')),payload=text.slice(text.indexOf('\n\n')+2);
  if(request.startsWith('提炼')){
   sectionInputs.push(payload.replace(/ ?⟦\d+秒⟧ /g,''));
   for(const term of pieces)if(payload.includes(term))seen.add(term);
  }
  const time=Number(payload.match(/⟦(\d+)秒⟧/)?.[1]??0);
  return JSON.stringify({summary:'章节要点 [[t:'+time+']] [[t:99999]]',todos:payload.includes('结尾待办')?[{text:'核对结尾',at:180}]:[]});
 }});
 assert.deepEqual([...seen],pieces);
 assert.equal(sectionInputs.join(''),transcript);
 assert.match(result.text,/整体概览/);
 assert.match(result.text,/#t=180/);
 assert.doesNotMatch(result.text,/99999/);
 assert.ok(result.todos.some(todo=>todo.text==='核对结尾'));
});

test('Harness streaming rejects an interrupted answer rather than storing it as a summary',async()=>{
 async function* interrupted(){
  yield {type:'text-delta',index:0,text:'部分结果'};
  yield {type:'finish',reason:{kind:'length'}};
 }
 await assert.rejects(readHarnessText(interrupted()),/未完成/);
});

test('rich notes round-trip nested tasks and citation and recording order',()=>{
 const content=[
  {kind:'markdown',markdown:'# 第一讲\n\n<!-- dlh-list:chinese -->\n\n1. **原理**\n   - [x] 核对\n\n| 一 | 二 |\n| --- | --- |\n| 甲 | 乙 |'},
  {kind:'quote',id:'q',annotationId:'mark',quote:'第一句\n第二句',text:'**笔记**',page:7,previewRevision:2},
  {kind:'audio',id:'a',assetId:'record'},
  {kind:'markdown',markdown:'末尾随记'}
 ];
 const doc=toEditorDocument(content),round=fromEditorDocument(doc);
 assert.deepEqual(round.map(x=>x.kind),content.map(x=>x.kind));
 assert.equal(round[1].page,7);
 assert.equal(round[1].quote,'第一句\n第二句');
 assert.equal(round[2].assetId,'record');
 assert.match(round[0].markdown,/dlh-list:chinese/);
 assert.match(round[0].markdown,/\[x\] 核对/);
 assert.match(round[0].markdown,/\| 甲 \| 乙 \|/);
 assert.ok(toEditorDocument(round).eq(doc));
});
