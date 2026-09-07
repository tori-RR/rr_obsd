'use strict';
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

// This protocol carries relative paths and status only, never note contents.
class NativeBridge extends EventEmitter {
  constructor({ root, helperPath, spawnProcess = spawn, readFile = fs.readFile, env = process.env,
    platform = process.platform, restartDelayMs = 1000, maxRestartDelayMs = 30000 }) {
    super();
    Object.assign(this, { root, helperPath, spawnProcess, readFile, env, platform, restartDelayMs, maxRestartDelayMs });
    this.stopped = true;
    this.generation = 0;
    this.failures = 0;
    this.child = null;
    this.restartTimer = null;
    this.healthTimer = null;
  }

  async start() {
    if (!this.stopped) return;
    if (this.platform !== 'win32') throw new Error('Native vault notifications require Windows.');
    this.stopped = false;
    const generation = ++this.generation;
    await this.readAndLaunch(generation, true);
  }

  async readAndLaunch(generation, throwOnInvalid = false) {
    if (this.stopped || generation !== this.generation) return;
    let script;
    try {
      script = await this.readFile(this.helperPath, 'utf8');
    } catch (error) {
      if (this.stopped || generation !== this.generation) return;
      this.emit('message', { type: 'offline', reason: 'helper-read-failed' });
      this.emit('diagnostic', { code: error.code || 'HELPER_READ_FAILED' });
      this.scheduleRestart(generation);
      return;
    }
    if (this.stopped || generation !== this.generation) return;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    if (encoded.length > 30000) {
      this.stopped = true;
      const error = new Error('Native helper exceeds the Windows command-line limit.');
      if (throwOnInvalid) throw error;
      this.emit('message', { type: 'error', message: error.message });
      this.emit('diagnostic', { code: 'HELPER_TOO_LARGE' });
      return;
    }
    this.encodedScript = encoded;
    this.launch(generation);
  }

  launch(generation) {
    if (this.stopped || generation !== this.generation) return;
    const executable = path.win32.join(this.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let child;
    try {
      child = this.spawnProcess(executable,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', this.encodedScript], {
          shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...this.env, OVW_ROOT: this.root, OVW_PARENT_PID: String(process.pid) }
        });
    } catch (error) {
      this.emit('message', { type: 'offline', reason: 'helper-start-failed' });
      this.emit('diagnostic', { code: error.code || 'SPAWN_FAILED' });
      this.scheduleRestart(generation);
      return;
    }
    this.child = child;
    let buffer = '';
    let finished = false;
    let lastMessageAt = Date.now();
    const current = () => !this.stopped && generation === this.generation && this.child === child;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(this.healthTimer);
      this.healthTimer = null;
      if (this.child === child) this.child = null;
      if (!this.stopped && generation === this.generation) {
        this.emit('message', { type: 'offline', reason: 'helper-exited' });
        this.scheduleRestart(generation);
      }
    };
    child.once('error', error => {
      if (current()) this.emit('diagnostic', { code: error.code || 'HELPER_ERROR' });
      finish();
    });
    child.once('exit', finish);
    child.stdin.on('error', () => {}); // Parent stopping a just-exited helper is harmless.
    child.stderr.on('data', () => {
      // PowerShell error text can contain private paths; expose only a generic code.
      if (current()) this.emit('diagnostic', { code: 'HELPER_STDERR' });
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (!current()) return;
      buffer += chunk;
      if (buffer.length > 1024 * 1024) {
        this.emit('message', { type: 'offline', reason: 'invalid-helper-output' });
        child.kill();
        return;
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (!message || !['ready', 'change', 'rescan', 'offline', 'error', 'heartbeat'].includes(message.type)) continue;
          lastMessageAt = Date.now();
          if (message.type === 'ready') this.failures = 0;
          if (message.type !== 'heartbeat') this.emit('message', message);
        } catch {
          this.emit('diagnostic', { code: 'INVALID_HELPER_JSON' });
        }
      }
    });
    this.healthTimer = setInterval(() => {
      if (current() && Date.now() - lastMessageAt > 30000) {
        this.emit('message', { type: 'offline', reason: 'helper-unresponsive' });
        child.kill();
      }
    }, 5000);
    this.healthTimer.unref?.();
  }

  scheduleRestart(generation) {
    if (this.stopped || generation !== this.generation || this.restartTimer) return;
    const delay = Math.min(this.maxRestartDelayMs, this.restartDelayMs * 2 ** Math.min(this.failures++, 5));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.encodedScript) this.launch(generation);
      else void this.readAndLaunch(generation);
    }, delay);
    this.restartTimer.unref?.();
  }

  async stop() {
    this.stopped = true;
    ++this.generation;
    clearTimeout(this.restartTimer);
    clearInterval(this.healthTimer);
    this.restartTimer = this.healthTimer = null;
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  }
}

module.exports = { NativeBridge };
