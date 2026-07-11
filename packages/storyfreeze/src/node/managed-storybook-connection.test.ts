import { jest } from '@jest/globals';
import net from 'net';
import { Logger } from './logger.js';
import { ManagedStorybookConnection } from './managed-storybook-connection.js';

jest.setTimeout(15_000);

async function getAvailablePort() {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to allocate a test port.');
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  return address.port;
}

function isPortOpen(port: number) {
  return new Promise<boolean>(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function createServerCommand(port: number, ignoreSigterm = false) {
  const ignoreSignal = ignoreSigterm ? "process.on('SIGTERM',()=>{});" : '';
  const source = `${ignoreSignal}require('http').createServer((request,response)=>response.end('ok')).listen(${port},'127.0.0.1')`;
  return `"${process.execPath}" -e "${source}"`;
}

describe(ManagedStorybookConnection, () => {
  it('waits until the Storybook process tree has exited', async () => {
    const port = await getAvailablePort();
    const logger = new Logger('silent');
    const debug = jest.spyOn(logger, 'debug');
    const connection = new ManagedStorybookConnection(
      {
        storybookUrl: `http://127.0.0.1:${port}`,
        serverCmd: createServerCommand(port),
        serverTimeout: 5_000,
      },
      logger,
      { shutdownTimeout: 1_000 },
    );

    try {
      await connection.connect();
      expect(await isPortOpen(port)).toBe(true);
    } finally {
      await connection.disconnect();
    }

    expect(connection.status).toBe('DISCONNECTED');
    expect(debug).not.toHaveBeenCalledWith(expect.stringContaining('Force killing'));
    expect(await isPortOpen(port)).toBe(false);
  });

  const posixIt = process.platform === 'win32' ? it.skip : it;
  posixIt('force kills a process tree that ignores graceful shutdown', async () => {
    const port = await getAvailablePort();
    const logger = new Logger('silent');
    const debug = jest.spyOn(logger, 'debug');
    const connection = new ManagedStorybookConnection(
      {
        storybookUrl: `http://127.0.0.1:${port}`,
        serverCmd: createServerCommand(port, true),
        serverTimeout: 5_000,
      },
      logger,
      { shutdownTimeout: 100 },
    );

    try {
      await connection.connect();
    } finally {
      await connection.disconnect();
    }

    expect(debug).toHaveBeenCalledWith(expect.stringContaining('Force killing process group'));
    expect(await isPortOpen(port)).toBe(false);
  });
});
