import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ViteDevServer } from 'vite';
const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mock.spawn }));
import { devFeederPlugin } from './devFeederPlugin';

describe('dev feeder process lifecycle', () => {
  beforeEach(() => vi.clearAllMocks());
  function setup() {
    let handler: (req: unknown, res: unknown) => void = () => {};
    const server = {
      httpServer: new EventEmitter(),
      middlewares: {
        use: (_path: string, fn: typeof handler) => {
          handler = fn;
        },
      },
    };
    const plugin = devFeederPlugin({
      uri: 'https://maincloud.spacetimedb.com',
      database: 'test-db',
    });
    (plugin.configureServer as (server: ViteDevServer) => void)(
      server as unknown as ViteDevServer,
    );
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    mock.spawn.mockReturnValue(child);
    const request = (method: string, body?: object, origin?: string) => {
      const req = Object.assign(new EventEmitter(), {
        method,
        headers: { host: 'localhost:5173', origin },
        destroy: vi.fn(),
      });
      const res = {
        statusCode: 0,
        writableEnded: false,
        setHeader: vi.fn(),
        body: '',
        end(value: string) {
          this.body = value;
          this.writableEnded = true;
        },
      };
      handler(req, res);
      if (body) {
        req.emit('data', Buffer.from(JSON.stringify(body)));
        req.emit('end');
      }
      return res;
    };
    return { request, child, server };
  }
  const body = { scenario: 'Low-3', viewer: 'a'.repeat(64) };
  it('uses node and tsx loader, forwards the same server, and waits for spawn', () => {
    const { request, child } = setup();
    const response = request('POST', body);
    expect(response.writableEnded).toBe(false);
    expect(mock.spawn.mock.calls[0][0]).toBe(process.execPath);
    expect(mock.spawn.mock.calls[0][1]).toContain(
      'https://maincloud.spacetimedb.com',
    );
    expect(mock.spawn.mock.calls[0][1].slice(0, 2)).toEqual([
      '--import',
      'tsx',
    ]);
    child.emit('spawn');
    expect(response.statusCode).toBe(202);
    child.emit('close', 0);
    expect(JSON.parse(request('GET').body).state).toBe('completed');
  });
  it('starting another scenario ends the running one', () => {
    const { request, child } = setup();
    request('POST', body);
    child.emit('spawn');
    const next = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    mock.spawn.mockReturnValueOnce(next);
    const second = request('POST', { ...body, scenario: 'Mid-2' });
    expect(child.kill).toHaveBeenCalled();
    expect(mock.spawn).toHaveBeenCalledTimes(2);
    next.emit('spawn');
    expect(second.statusCode).toBe(202);
    // The old feeder closing late must not overwrite the new job's state.
    child.emit('close', 1);
    expect(JSON.parse(request('GET').body)).toMatchObject({
      state: 'running',
      scenario: 'Mid-2',
      running: true,
    });
  });
  it('stop from the dashboard ends the feeder and reports stopped', () => {
    const { request, child } = setup();
    request('POST', body);
    child.emit('spawn');
    expect(JSON.parse(request('DELETE').body).stopped).toBe(true);
    expect(child.kill).toHaveBeenCalled();
    child.emit('close', 1);
    expect(JSON.parse(request('GET').body).state).toBe('stopped');
  });
  it('contains launch errors and permits retry without killing Vite', () => {
    const { request, child } = setup();
    const response = request('POST', body);
    expect(() => child.emit('error', new Error('ENOENT'))).not.toThrow();
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(request('GET').body).state).toBe('failed');
    request('POST', body);
    expect(mock.spawn).toHaveBeenCalledTimes(2);
  });
  it('reports asynchronous failure and terminates child on server shutdown', () => {
    const { request, child, server } = setup();
    request('POST', body);
    child.emit('spawn');
    child.stderr.emit('data', Buffer.from('Schema mismatch'));
    child.emit('close', 1);
    expect(JSON.parse(request('GET').body)).toMatchObject({
      state: 'failed',
      running: false,
      lastLine: 'Schema mismatch',
    });
    request('POST', body);
    server.httpServer.emit('close');
    expect(child.kill).toHaveBeenCalled();
  });
  it('rejects invalid scenarios and cross-origin execution', () => {
    const { request } = setup();
    expect(request('POST', { ...body, scenario: 'bad' }).statusCode).toBe(400);
    expect(request('POST', body, 'https://unrelated.example').statusCode).toBe(
      403,
    );
    expect(mock.spawn).not.toHaveBeenCalled();
  });
});
