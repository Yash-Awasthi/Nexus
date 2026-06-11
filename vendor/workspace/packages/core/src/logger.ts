import { Logtail } from '@logtail/node';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogMeta extends Record<string, unknown> {
  agentId?: string;
  taskId?:  string;
}

export class Logger {
  private readonly agentId: string;
  private readonly logtail: Logtail | null;

  constructor(agentId: string) {
    this.agentId = agentId;
    const token = process.env['BETTER_STACK_SOURCE_TOKEN'];
    this.logtail = token ? new Logtail(token) : null;
  }

  private emit(level: LogLevel, message: string, meta?: LogMeta): void {
    const entry = {
      level,
      message,
      agentId:   this.agentId,
      timestamp: new Date().toISOString(),
      ...meta,
    };

    if (level === 'error' || level === 'warn') {
      console.error(JSON.stringify(entry));
    } else if (process.env['LOG_LEVEL'] !== 'error') {
      console.log(JSON.stringify(entry));
    }

    if (this.logtail && process.env['NODE_ENV'] === 'production') {
      void this.logtail.log(message, level, { agentId: this.agentId, ...meta });
    }
  }

  debug(msg: string, meta?: LogMeta): void  { this.emit('debug', msg, meta); }
  info(msg: string,  meta?: LogMeta): void  { this.emit('info',  msg, meta); }
  warn(msg: string,  meta?: LogMeta): void  { this.emit('warn',  msg, meta); }
  error(msg: string, meta?: LogMeta): void  { this.emit('error', msg, meta); }

  child(extra: LogMeta): Logger {
    const child = new Logger(this.agentId);
    const parent = this;
    child.emit = (level, message, meta) =>
      parent.emit(level, message, { ...extra, ...meta });
    return child;
  }
}
