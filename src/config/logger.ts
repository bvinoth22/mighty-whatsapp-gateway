import pino from 'pino';
import { env } from './env.js';

export const logger = pino({
  level: env.logLevel,
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
  },
});
