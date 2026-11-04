#!/usr/bin/env python3
"""安装固定版本文献库；已有配置先备份，不改账号或会话。"""
from pathlib import Path
import datetime, json, os, shutil, subprocess, time, tarfile, signal, zoneinfo
root = Path(__file__).resolve().parents[1]
profile = Path.home()/'.dsh/profiles/desktop'
version=json.loads((root/'package.json').read_text())['version']
archive=root.parent/('dsh-literature-hub-'+version+'.tgz')
vault_value=os.environ.get('DSH_LITERATURE_VAULT','').strip()
if not vault_value:
    raise SystemExit('请设置 DSH_LITERATURE_VAULT 为 Obsidian 知识库的绝对路径。')
vault=Path(vault_value).expanduser().resolve()
if not archive.exists():
    raise SystemExit('未找到安装包：'+str(archive))
executable='/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
for line in subprocess.check_output(['ps','-axo','pid=,args='],text=True).splitlines():
    fields=line.strip().split(None,1)
    if len(fields)==2 and (fields[1]==executable or fields[1].startswith(executable+' ')) and '--expose-internals' not in fields[1]:
        try: os.kill(int(fields[0]),signal.SIGTERM)
        except ProcessLookupError: pass
deadline=time.monotonic()+15
while subprocess.run(['pgrep','-f',r'^/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'],capture_output=True).returncode==0:
    if time.monotonic()>deadline: raise SystemExit('Harness 尚未退出，配置未改动。请关闭应用后重试。')
    time.sleep(.2)
stamp=datetime.datetime.now(zoneinfo.ZoneInfo('Asia/Shanghai')).strftime('%Y%m%d-%H%M%S')
backup=root.parent/'备份'/('安装前配置-'+stamp)
backup.mkdir(parents=True,mode=0o700)
for name in ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','cordis.patch.yml']:
    p=profile/name
    if p.exists(): shutil.copy2(p,backup/name)
installed=profile/'node_modules/dsh-literature-hub'
if installed.exists(): shutil.copytree(installed,backup/'plugin',symlinks=False)
with tarfile.open(backup/'知识库.tar.gz','w:gz') as t: t.add(vault,arcname=vault.name)
os.chmod(backup/'知识库.tar.gz',0o600)
(backup/'manifest.json').write_text(json.dumps({'version':version,'vault':str(vault),'createdAt':stamp},ensure_ascii=False,indent=2))
meta=json.loads((profile/'package.json').read_text())
# 升级保留当前所有插件、开关偏好、配置覆盖与 pnpm 规则。
selected=list(meta.get('dsh',{}).get('profile',{}).get('bundles',[]))
had_package='dsh-literature-hub' in meta.get('dependencies',{})
if not had_package and 'dsh-literature-hub' not in selected: selected.append('dsh-literature-hub')
workspace=(profile/'pnpm-workspace.yaml').read_text()
if "'@deepseek-ai/dsh-tools': '-'" not in workspace:
    raise SystemExit('需要宿主依赖单实例规则；配置未改动。备份：'+str(backup))
runtime=Path('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs')
env=dict(os.environ); env['ELECTRON_RUN_AS_NODE']='1'
command=['/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness','--expose-internals',str(runtime)]
try:
    if 'dsh-literature-hub' in meta.get('dependencies',{}):
        subprocess.run(command+['remove','dsh-literature-hub','--config.ignore-scripts=true'],env=env,cwd=profile,check=True)
    subprocess.run(command+['add','file:'+str(archive),'--prefer-offline','--ignore-scripts'],env=env,cwd=profile,check=True)
    meta=json.loads((profile/'package.json').read_text())
    meta.setdefault('dsh',{}).setdefault('profile',{})['bundles']=selected
    (profile/'package.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n')
    installed=profile/'node_modules/dsh-literature-hub'
    if installed.resolve()==root: raise RuntimeError('旧开发链接未替换')
    with tarfile.open(archive) as bundle:
        for member in bundle.getmembers():
            if not member.isfile():
                continue
            relative=Path(member.name).relative_to('package')
            if (installed/relative).read_bytes()!=bundle.extractfile(member).read():
                raise RuntimeError('安装文件与固定版本包不一致：'+str(relative))
    if (profile/'node_modules/@deepseek-ai/dsh-tools').exists(): raise RuntimeError('检测到重复宿主工具依赖')
    migration="""const {pathToFileURL}=await import('node:url');const {writeFile}=await import('node:fs/promises');const {createStore}=await import(pathToFileURL(process.argv[1]).href);const store=await createStore({vaultPath:process.argv[2]});try{await store.init();const report=await store.migrateLayout();await writeFile(process.argv[3],JSON.stringify(report,null,2));console.log('资料迁移已核验。');}finally{await store.close?.();}"""
    subprocess.run(command[:2]+['--input-type=module','-e',migration,str(installed/'lib/store.js'),str(vault),str(backup/'migration-report.json')],env=env,check=True)
except Exception as error:
    for name in ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','cordis.patch.yml']:
        if (backup/name).exists(): shutil.copy2(backup/name,profile/name)
    if (backup/'plugin').exists():
        if installed.is_symlink(): installed.unlink()
        elif installed.exists(): shutil.rmtree(installed)
        shutil.copytree(backup/'plugin',installed)
    with tarfile.open(backup/'知识库.tar.gz') as t: t.extractall(vault.parent,filter='data')
    subprocess.Popen(['/usr/bin/open','-a','DeepSeek Harness'])
    raise SystemExit('升级未完成，已恢复原版本、配置和登记资料。原因：'+str(error))
print('文献库 '+version+' 已安装。配置与资料备份：'+str(backup))
subprocess.Popen(['/usr/bin/open','-a','DeepSeek Harness'])
