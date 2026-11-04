import { spawn } from 'node:child_process';
import { basename } from 'node:path';

const active = new Set();
export function abortError(reason) { const error = new Error(typeof reason === 'string' ? reason : '文档处理已取消'); error.name = 'AbortError'; error.code = 'ABORT_ERR'; error.status = 499; return error; }
export function throwIfAborted(signal) { if (signal?.aborted) throw abortError(signal.reason); }
export function isAbort(error) { return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'; }

// A separate POSIX process group includes the converter's helper processes. Cancellation
// waits for close before callers remove temporary profiles and images.
export function run(command, args, { signal, timeout = 180_000, maxBuffer = 64 * 1024 * 1024, env, cwd } = {}) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const detached = process.platform !== 'win32';
    const child = spawn(command, args, { cwd, env: env ? { ...process.env, ...env } : process.env, detached, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, failure = null, escalation;
    function kill(sig) { try { if (detached && child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch {} }
    function stop(error) { if (failure) return; failure = error; kill('SIGTERM'); escalation = setTimeout(() => kill('SIGKILL'), 1500); escalation.unref?.(); }
    const onAbort = () => stop(abortError(signal?.reason));
    const timer = setTimeout(() => { const error = new Error(`本地处理超时：${basename(command)}`); error.code = 'parse-timeout'; error.status = 422; stop(error); }, timeout);
    timer.unref?.();
    const task = { cancel: reason => stop(abortError(reason)) }; active.add(task);
    signal?.addEventListener('abort', onAbort, { once: true });
    const append = name => chunk => { bytes += chunk.length; if (bytes > maxBuffer) { const e = new Error('本地处理结果超过内存限制'); e.code = 'parse-output-limit'; e.status = 413; stop(e); return; } if (name === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8'); };
    // setEncoding preserves multibyte characters split across process output chunks.
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', append('stdout')); child.stderr.on('data', append('stderr'));
    child.once('error', error => { failure = failure || Object.assign(new Error(error.code === 'ENOENT' ? `缺少本地转换工具：${basename(command)}` : `本地工具无法启动：${basename(command)}`), { code: error.code === 'ENOENT' ? 'converter-missing' : 'parse-failed', status: error.code === 'ENOENT' ? 503 : 422 }); });
    child.once('close', (code, exitSignal) => { clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener('abort', onAbort); active.delete(task);
      if (failure) return reject(failure);
      if (code !== 0) { const e = new Error(`本地文档处理失败（${basename(command)}）：${String(stderr || stdout || exitSignal || code).slice(0, 450)}`); e.code = 'parse-failed'; e.status = 422; e.stderr = stderr; e.stdout = stdout; return reject(e); }
      resolve({ stdout, stderr });
    });
    if (signal?.aborted) onAbort();
  });
}
export function cancelProcessing(reason = '插件已停用') { for (const task of active) task.cancel(reason); }
export function activeProcessCount() { return active.size; }
