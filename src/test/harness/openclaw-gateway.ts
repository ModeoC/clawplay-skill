/**
 * Test harness that spawns a real OpenClaw gateway as a child process.
 * Uses OPENCLAW_STATE_DIR to isolate test state from the real installation.
 * Auto-skips tests if `openclaw` binary is not found.
 */

import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class OpenClawTestGateway {
  private proc: ChildProcess | null = null;
  private tempDir: string;
  private _port: number;
  private _token: string;

  constructor(opts?: { port?: number; token?: string }) {
    this._port = opts?.port ?? (30000 + Math.floor(Math.random() * 10000));
    this._token = opts?.token ?? randomUUID();
    this.tempDir = mkdtempSync(join(tmpdir(), 'openclaw-test-'));
  }

  /**
   * Creates temp directory structure and spawns the gateway process.
   * Returns port and token for client connections.
   */
  async start(): Promise<{ port: number; token: string }> {
    // Create required directory structure
    const workspaceDir = join(this.tempDir, 'workspace');
    const skillsDir = join(workspaceDir, 'skills');
    const agentDir = join(this.tempDir, 'agents', 'main', 'agent');
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });

    // Write minimal config — gateway.auth.token must match the --token CLI flag
    const config = {
      gateway: {
        mode: 'local',
        auth: { mode: 'token', token: this._token },
      },
      agents: {
        defaults: {
          model: { primary: 'anthropic/claude-sonnet-4-6' },
        },
      },
    };
    writeFileSync(
      join(this.tempDir, 'openclaw.json'),
      JSON.stringify(config, null, 2),
    );

    // Spawn gateway process
    return new Promise<{ port: number; token: string }>((resolve, reject) => {
      const args = [
        'gateway', 'run',
        '--port', String(this._port),
        '--bind', 'loopback',
        '--token', this._token,
        '--force',
      ];

      this.proc = spawn('openclaw', args, {
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: this.tempDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      this.proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      this.proc.on('error', (err) => {
        reject(new Error(`Failed to spawn openclaw: ${err.message}`));
      });

      this.proc.on('exit', (code) => {
        if (!this.proc) return; // Expected stop
        reject(new Error(`Gateway exited unexpectedly (code ${code}): ${stderr}`));
      });

      // Wait for ready by polling health
      this.waitForReady(15000)
        .then(() => resolve({ port: this._port, token: this._token }))
        .catch(reject);
    });
  }

  /**
   * Stop the gateway process (SIGTERM, then SIGKILL after 5s).
   */
  async stop(): Promise<void> {
    if (!this.proc) return;

    const proc = this.proc;
    this.proc = null;

    return new Promise<void>((resolve) => {
      // If the process already exited, resolve immediately
      if (proc.exitCode !== null || proc.killed) {
        resolve();
        return;
      }

      const killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
      }, 3000);

      // Fallback: resolve after 5s even if exit event doesn't fire
      const fallback = setTimeout(() => {
        clearTimeout(killTimer);
        resolve();
      }, 5000);

      proc.on('exit', () => {
        clearTimeout(killTimer);
        clearTimeout(fallback);
        resolve();
      });

      try { proc.kill('SIGTERM'); } catch {}
    });
  }

  /**
   * Stop and restart the gateway on the same port.
   */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /**
   * Poll the gateway's WS health endpoint until it responds.
   */
  async waitForReady(timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const ok = await this.probe();
        if (ok) return;
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Gateway not ready after ${timeoutMs}ms`);
  }

  /**
   * Quick WS probe — connect, send health RPC, disconnect.
   */
  private async probe(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2000);
      try {
        const ws = new WebSocket(`ws://127.0.0.1:${this._port}`);
        let authed = false;

        ws.onmessage = (event: MessageEvent) => {
          try {
            const msg = JSON.parse(String(event.data));

            // Handle challenge
            if (msg.type === 'event' && msg.event === 'connect.challenge') {
              ws.send(JSON.stringify({
                type: 'req',
                id: 'probe-connect',
                method: 'connect',
                params: {
                  minProtocol: 3,
                  maxProtocol: 3,
                  client: { id: 'gateway-client', version: 'test', platform: process.platform, mode: 'backend' },
                  caps: [],
                  role: 'operator',
                  scopes: ['operator.admin'],
                  auth: { token: this._token },
                },
              }));
              return;
            }

            // Handle connect response
            if (msg.type === 'res' && msg.id === 'probe-connect' && msg.ok) {
              authed = true;
              // Send health check
              ws.send(JSON.stringify({
                type: 'req',
                id: 'probe-health',
                method: 'health',
                params: {},
              }));
              return;
            }

            // Handle health response
            if (msg.type === 'res' && msg.id === 'probe-health' && msg.ok) {
              clearTimeout(timer);
              ws.close();
              resolve(true);
            }
          } catch {
            // Ignore parse errors
          }
        };

        ws.onerror = () => {
          // Don't call ws.close() here — it can recurse (close triggers error
          // on an already-errored socket). onclose fires automatically after
          // onerror, which will resolve(false).
          clearTimeout(timer);
          resolve(false);
        };

        ws.onclose = () => {
          if (!authed) {
            clearTimeout(timer);
            resolve(false);
          }
        };
      } catch {
        clearTimeout(timer);
        resolve(false);
      }
    });
  }

  // ── Path getters ─────────────────────────────────────────────

  get configPath(): string {
    return join(this.tempDir, 'openclaw.json');
  }

  get workspaceDir(): string {
    return join(this.tempDir, 'workspace');
  }

  get skillsDir(): string {
    return join(this.tempDir, 'workspace', 'skills');
  }

  get port(): number {
    return this._port;
  }

  get token(): string {
    return this._token;
  }

  /**
   * Remove the temp directory entirely.
   */
  async cleanup(): Promise<void> {
    await this.stop();
    try {
      rmSync(this.tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Check if the `openclaw` binary is available on PATH.
 */
export async function hasOpenClawBinary(): Promise<boolean> {
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('which', ['openclaw'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
