/** The SDK owns this host; the host owns a process group containing MCP and its browsers. */
export const processHost = `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, process.argv.slice(2), { stdio: ['pipe','pipe','pipe'], detached: process.platform !== 'win32' });
process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
child.stdin.on('error', () => {});
const kill = signal => { try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); } catch {} };
let stopping = false;
const stop = () => {
  if (stopping) return; stopping = true;
  child.stdin.end();
  setTimeout(() => kill('SIGTERM'), 500).unref();
  setTimeout(() => kill('SIGKILL'), 1500).unref();
};
process.stdin.on('end', stop); process.on('SIGTERM', stop); process.on('SIGINT', stop);
child.on('error', () => process.exit(1));
child.on('close', code => { kill('SIGKILL'); process.exit(code || 0); });
`;
