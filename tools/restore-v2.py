#!/usr/bin/env python3
"""恢复升级前的 2.0.0 及知识库，同时留存当前资料。"""

import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import signal
import subprocess
import tarfile
import tempfile
import time
from zoneinfo import ZoneInfo


OUTPUT = Path(__file__).resolve().parents[2]
PROFILE = Path.home() / '.dsh/profiles/desktop'
vault_value = os.environ.get('DSH_LITERATURE_VAULT', '').strip()
if not vault_value:
    raise SystemExit('请设置 DSH_LITERATURE_VAULT 为 Obsidian 知识库的绝对路径。')
VAULT = Path(vault_value).expanduser().resolve()
APP = Path('/Applications/DeepSeek Harness.app')
EXECUTABLE = APP / 'Contents/MacOS/DeepSeek Harness'
PNPM = APP / 'Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'
PACKAGE = 'dsh-literature-hub'
VERSION = '2.0.0'
CONFIG = ('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml')


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def file_sha256(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def verify_package(archive, installed):
    with tarfile.open(archive) as tar:
        files = [member for member in tar.getmembers() if member.isfile()]
        if not files or read_json(installed / 'package.json').get('version') != VERSION:
            raise RuntimeError('文献库版本校验失败。')
        for member in files:
            name = PurePosixPath(member.name).relative_to('package')
            if '..' in name.parts or (installed / name).read_bytes() != tar.extractfile(member).read():
                raise RuntimeError('文献库文件校验失败：' + str(name))


def find_snapshot(outputs, vault):
    for candidate in sorted((outputs / '备份').glob('安装前配置-*'), reverse=True):
        try:
            if (read_json(candidate / 'plugin/package.json').get('version') == VERSION
                    and Path(read_json(candidate / 'manifest.json')['vault']) == vault
                    and (candidate / '知识库.tar.gz').is_file()):
                return candidate
        except (OSError, ValueError, KeyError):
            continue
    raise RuntimeError('未找到本知识库的 2.0.0 安装前备份。')


def extract_vault(archive, target, vault_name):
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        if not members:
            raise RuntimeError('知识库备份为空。')
        for member in members:
            name = PurePosixPath(member.name)
            if not name.parts or name.parts[0] != vault_name or '..' in name.parts:
                raise RuntimeError('知识库备份目录校验失败。')
        tar.extractall(target, members=members, filter='data')
    restored = target / vault_name
    if not restored.is_dir() or restored.is_symlink():
        raise RuntimeError('知识库备份缺少根目录。')
    return restored


def app_running(pattern):
    return subprocess.run(['/usr/bin/pgrep', '-f', pattern], capture_output=True).returncode == 0


def stop_harness():
    for line in subprocess.check_output(['/bin/ps', '-axo', 'pid=,args='], text=True).splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) == 2 and (fields[1] == str(EXECUTABLE) or fields[1].startswith(str(EXECUTABLE) + ' ')):
            if '--expose-internals' not in fields[1]:
                try:
                    os.kill(int(fields[0]), signal.SIGTERM)
                except ProcessLookupError:
                    pass
    deadline = time.monotonic() + 20
    while app_running(r'^/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness( |$)'):
        if time.monotonic() >= deadline:
            raise RuntimeError('Harness 尚未退出，恢复未开始。')
        time.sleep(.2)


def snapshot_current(directory, profile, vault, previous_version):
    directory.mkdir(mode=0o700)
    for name in CONFIG:
        if (profile / name).is_file():
            shutil.copy2(profile / name, directory / name)
    shutil.copytree(profile / 'node_modules' / PACKAGE, directory / 'plugin', symlinks=True)
    archive = directory / '当前知识库.tar.gz'
    with tarfile.open(archive, 'w:gz') as tar:
        tar.add(vault, arcname=vault.name)
    archive.chmod(0o600)
    (directory / 'manifest.json').write_text(json.dumps({
        'version': previous_version, 'vault': str(vault)
    }, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def stage_package(stage, profile, archive):
    for name in CONFIG[:3]:
        shutil.copy2(profile / name, stage / name)
    # APFS 支持写入时复制。文件系统不支持克隆时，cp 会复制完整目录。
    subprocess.run(['/bin/cp', '-cRp', str(profile / 'node_modules'), str(stage / 'node_modules')], check=True)
    original = read_json(profile / 'package.json')
    env = {**os.environ, 'ELECTRON_RUN_AS_NODE': '1'}
    command = [str(EXECUTABLE), '--expose-internals', str(PNPM)]
    subprocess.run(command + ['add', 'file:' + str(archive), '--offline', '--ignore-scripts'],
                   cwd=stage, env=env, check=True)
    staged = read_json(stage / 'package.json')
    dependencies = original['dependencies'].copy()
    dependencies[PACKAGE] = 'file:' + str(archive)
    if staged['dependencies'] != dependencies or staged.get('dsh') != original.get('dsh'):
        raise RuntimeError('暂存的插件清单与当前工作区不一致。')
    if (stage / 'node_modules/@deepseek-ai/dsh-tools').exists():
        raise RuntimeError('暂存中存在重复宿主工具依赖。')
    verify_package(archive, stage / 'node_modules' / PACKAGE)


class RestoreUndoError(RuntimeError):
    pass


def replace_staged(entries):
    moved = []
    try:
        for live, incoming, previous in entries:
            moved.append((live, incoming, previous))
            live.rename(previous)
            incoming.rename(live)
    except BaseException:
        failures = []
        for live, incoming, previous in reversed(moved):
            try:
                if not previous.exists() and not previous.is_symlink():
                    continue
                if live.exists() or live.is_symlink():
                    live.rename(incoming)
                previous.rename(live)
            except OSError as error:
                failures.append(str(error))
        if failures:
            raise RestoreUndoError('恢复中断，自动复原遇到错误。' + '；'.join(failures)) from None
        raise


def main():
    if not hasattr(tarfile, 'data_filter'):
        raise RuntimeError('需要支持安全解包的 Python 3.12 或更高版本。')
    if app_running(r'^/Applications/Obsidian.app/Contents/MacOS/Obsidian( |$)'):
        raise RuntimeError('请退出 Obsidian 后再运行恢复脚本，避免并发写入知识库。')
    if not VAULT.is_dir() or VAULT.is_symlink() or not PROFILE.is_dir():
        raise RuntimeError('未找到当前知识库或 Harness 桌面配置。')
    archive = OUTPUT / f'{PACKAGE}-{VERSION}.tgz'
    checksums = read_json(OUTPUT / 'SHA256-2.0.0.json')
    if file_sha256(archive) != checksums[archive.name]:
        raise RuntimeError('2.0.0 安装包的 SHA-256 校验失败。')
    source = find_snapshot(OUTPUT, VAULT)
    verify_package(archive, source / 'plugin')
    previous_version = read_json(PROFILE / 'node_modules' / PACKAGE / 'package.json')['version']
    if previous_version == VERSION:
        print('文献库当前已是 2.0.0，知识库保持原样。')
        return
    vault_stage = Path(tempfile.mkdtemp(prefix='.literature-restore-', dir=VAULT.parent))
    profile_stage = Path(tempfile.mkdtemp(prefix='.literature-restore-', dir=PROFILE.parent))
    keep_stages = False
    stopped = False
    restored = False
    stamp = datetime.datetime.now(ZoneInfo('Asia/Shanghai')).strftime('%Y%m%d-%H%M%S-%f')
    current = OUTPUT / '备份' / ('回退前-' + stamp)
    try:
        incoming_vault = extract_vault(source / '知识库.tar.gz', vault_stage, VAULT.name)
        stop_harness()
        stopped = True
        snapshot_current(current, PROFILE, VAULT, previous_version)
        stage_package(profile_stage, PROFILE, archive)
        entries = [
            (PROFILE / name, profile_stage / name, profile_stage / ('previous-' + name))
            for name in ('node_modules', 'package.json', 'pnpm-lock.yaml')
        ]
        entries.append((VAULT, incoming_vault, vault_stage / ('previous-' + VAULT.name)))
        replace_staged(entries)
        restored = True
    except RestoreUndoError as error:
        keep_stages = True
        raise RuntimeError(f'{error}\n完整资料备份：{current}\n暂存目录：{profile_stage}\n知识库暂存目录：{vault_stage}') from error
    finally:
        if not keep_stages:
            shutil.rmtree(vault_stage)
            shutil.rmtree(profile_stage)
        if stopped and not keep_stages:
            subprocess.Popen(['/usr/bin/open', '-a', str(APP)])
    if restored:
        print(f'文献库已恢复到 {VERSION}。当前知识库恢复为升级前状态。')
        print('回退前的笔记、录音及配置另存于：' + str(current))


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        raise SystemExit('已取消恢复。')
    except (OSError, RuntimeError, KeyError, ValueError, tarfile.TarError, subprocess.SubprocessError) as error:
        raise SystemExit('恢复未完成：' + str(error))
