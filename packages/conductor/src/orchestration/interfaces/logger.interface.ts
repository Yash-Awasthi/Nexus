export interface ILogger {
  info(message: string, context?: any): void;
  warn(message: string, context?: any): void;
  error(message: string, error?: any, context?: any): void;
  debug(message: string, context?: any): void;
}
