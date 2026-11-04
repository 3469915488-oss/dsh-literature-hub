import {build} from 'esbuild';
import * as lucide from 'lucide';
import {mkdir,writeFile,readFile,copyFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const names=['folder-plus','quote','sparkles','minus','mouse-pointer-2','list-checks','library','library-big','folder','folder-open','chevron-right','chevron-down','chevron-left','panel-left','panel-right','search','plus','more-horizontal','arrow-left','move','edit','trash','upload','file-text','book-open','message-square','highlighter','underline','pen-line','sticky-note','sun','moon','x','check','refresh-cw','play','arrow-up-right','download','zoom-in','zoom-out','expand','grip-vertical','rotate-ccw','check-check','check-circle','circle','list','map','target','graduation-cap','clock','bookmark','send','settings','copy','file','file-plus','circle-help','arrow-right','maximize-2','minimize-2','chevrons-right','filter','save','alert-circle','scan-text'];
for(const file of await readdir(resolve(root,'reader'))){if(!/\.(html|js)$/.test(file)||['icons.js','editor.js'].includes(file))continue;const source=await readFile(resolve(root,'reader',file),'utf8');for(const match of source.matchAll(/[\"']([a-z][a-z0-9-]{1,30})[\"']/g)){const name=match[1],key=name.split('-').filter(Boolean).map(p=>p[0].toUpperCase()+p.slice(1)).join('');if(Array.isArray(lucide[key])&&!names.includes(name))names.push(name);}}
const data={};
for(const name of names){const key=name.split('-').map(part=>part[0].toUpperCase()+part.slice(1)).join('');const node=lucide[key];if(!node)throw new Error('Unknown Lucide icon: '+key);data[name]=node;}
const source=`// Generated from Lucide (ISC); see licenses/LUCIDE-LICENSE.\nconst icons=${JSON.stringify(data)};\nexport function icon(name,size=18){const nodes=icons[name]||icons['file-text'];const body=nodes.map(([tag,attrs])=>'<'+tag+' '+Object.entries(attrs).map(([k,v])=>k+'="'+v+'"').join(' ')+'/>').join('');return '<svg xmlns="http://www.w3.org/2000/svg" width="'+size+'" height="'+size+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+body+'</svg>';};\n`;
await writeFile(resolve(root,'reader/icons.js'),source);
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#4168b4" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'+data['library-big'].map(([tag,attrs])=>'<'+tag+' '+Object.entries(attrs).map(([k,v])=>k+'="'+v+'"').join(' ')+'/>').join('')+'</svg>\n';
await writeFile(resolve(root,'icon.svg'),svg);
await build({entryPoints:[resolve(root,'node_modules/@floating-ui/dom/dist/floating-ui.dom.mjs')],bundle:true,format:'esm',platform:'browser',minify:true,outfile:resolve(root,'reader/floating-ui.dom.mjs'),legalComments:'eof'});
await build({entryPoints:[resolve(root,'reader/editor-src.js')],bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,outfile:resolve(root,'reader/editor.js'),legalComments:'eof'});
await mkdir(resolve(root,'licenses'),{recursive:true});
const editorPackages=new Set();
async function collect(name){
 if(editorPackages.has(name))return;
 const pkg=JSON.parse(await readFile(resolve(root,'node_modules',name,'package.json'),'utf8'));
 editorPackages.add(name);
 for(const dep of Object.keys(pkg.dependencies||{}))await collect(dep);
}
for(const name of ['markdown-it','prosemirror-markdown','prosemirror-model','prosemirror-state','prosemirror-view','prosemirror-commands','prosemirror-schema-list','prosemirror-history','prosemirror-keymap','prosemirror-dropcursor','prosemirror-gapcursor'])await collect(name);
for(const [pkg,label] of [['lucide','LUCIDE'],['@floating-ui/dom','FLOATING-UI-DOM'],['@floating-ui/core','FLOATING-UI-CORE'],['@floating-ui/utils','FLOATING-UI-UTILS'],['mammoth','MAMMOTH'],['turndown','TURNDOWN'],['turndown-plugin-gfm','TURNDOWN-GFM'],['sanitize-html','SANITIZE-HTML'],['linkedom','LINKEDOM'],...Array.from(editorPackages,p=>[p,p.toUpperCase().replace(/[^A-Z0-9-]/g,'-')])]){
 const pkgRoot=resolve(root,'node_modules',pkg);let copied=false;
 for(const file of ['LICENSE','LICENSE.md','LICENSE-MIT','LICENSE-MIT.txt','LICENSE.txt','license','license.md'])try{await copyFile(resolve(pkgRoot,file),resolve(root,'licenses',label+'-LICENSE'));copied=true;break;}catch{}
 if(!copied)throw new Error('License file missing: '+pkg);
}
console.log('Built local icons, editor, floating positioner and third-party licenses.');
