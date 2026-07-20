import http from 'node:http';
import net from 'node:net';
import { describe, expect, it } from 'vite-plus/test';
import { Logger } from './logger.js';
import { ManagedStorybookConnection } from './managed-storybook-connection.js';

async function getAvailablePort() {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to allocate a test port.');
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  return address.port;
}

describe(ManagedStorybookConnection, () => {
  it('connects to an externally managed server without owning its lifecycle', async () => {
    const port = await getAvailablePort();
    const server = http.createServer((_request, response) => response.end('ok'));
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    const connection = new ManagedStorybookConnection(
      { storybookUrl: `http://127.0.0.1:${port}` },
      new Logger('silent'),
    );

    try {
      await expect(connection.connect()).resolves.toBe(connection);
      expect(connection.status).toBe('CONNECTED');
      await connection.disconnect();
      expect(connection.status).toBe('DISCONNECTED');
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }
  });

  it('does not start connecting when already cancelled', async () => {
    const controller = new AbortController();
    const reason = new Error('already cancelled');
    controller.abort(reason);
    const connection = new ManagedStorybookConnection({ storybookUrl: 'http://127.0.0.1:1' }, new Logger('silent'));

    await expect(connection.connect(controller.signal)).rejects.toBe(reason);
    expect(connection.status).toBe('DISCONNECTED');
  });

  it('cancels an in-flight wait without leaving the connection active', async () => {
    const port = await getAvailablePort();
    const connection = new ManagedStorybookConnection(
      { storybookUrl: `http://127.0.0.1:${port}` },
      new Logger('silent'),
    );
    const controller = new AbortController();
    const reason = new Error('cancelled by peer startup failure');

    const connecting = connection.connect(controller.signal);
    controller.abort(reason);

    await expect(connecting).rejects.toBe(reason);
    expect(connection.status).toBe('DISCONNECTED');
  });

  it('cancels an in-flight wait when disconnected', async () => {
    const port = await getAvailablePort();
    const connection = new ManagedStorybookConnection(
      { storybookUrl: `http://127.0.0.1:${port}` },
      new Logger('silent'),
    );

    const connecting = connection.connect();
    const rejection = expect(connecting).rejects.toThrow('Storybook connection was disconnected.');
    await connection.disconnect();

    await rejection;
    expect(connection.status).toBe('DISCONNECTED');
  });
});
