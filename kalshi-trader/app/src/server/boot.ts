import { pino } from 'pino';
import { ConfigError, loadConfig, type LoadedConfig } from '../config.js';

/**
 * Loads the configuration or terminates the process with exit code 1 and a single
 * JSON log line naming the offending key(s). Used by `main.ts` and `scripts/dev.ts`.
 */
export function loadConfigOrExit(): LoadedConfig {
  try {
    return loadConfig();
  } catch (err) {
    const log = pino({ base: { app: 'kalshi-trader' }, timestamp: pino.stdTimeFunctions.isoTime });
    if (err instanceof ConfigError) {
      log.fatal({ keys: err.keys }, err.message);
    } else {
      log.fatal({ err }, 'Failed to load configuration');
    }
    process.exit(1);
  }
}
