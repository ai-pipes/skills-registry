import { pino } from 'pino';

export type Logger = pino.Logger;

/** `destination` defaults to stdout; tests pass one to capture log lines. */
export function createLogger(level: string, destination?: pino.DestinationStream): Logger {
  const options = {
    level,
    redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
  };
  return destination ? pino(options, destination) : pino(options);
}
