import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { connectionManager } from '../manager/connectionManager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function startHttpServer(): Promise<void> {
  const app = Fastify({ logger: false });

  await app.register(fastifyStatic, {
    root: join(__dirname, 'public'),
    prefix: '/',
  });

  app.get('/api/status', async () => connectionManager.getState());

  app.post<{ Body: { phoneNumber?: string } }>('/api/connect', async (req) => {
    const phoneNumber = req.body?.phoneNumber;
    const state = await connectionManager.connect(phoneNumber);
    return { ok: true, state };
  });

  app.post('/api/disconnect', async () => {
    await connectionManager.disconnect();
    return { ok: true };
  });

  await app.listen({ port: env.port, host: '0.0.0.0' });
  logger.info(`🌐 Setup UI:  http://localhost:${env.port}`);
}
