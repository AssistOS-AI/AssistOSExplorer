const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, critical: 4 };
const currentLevel = LEVELS[process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;

function fmt(level, component, msg, data) {
  const ts = new Date().toISOString();
  const base = `${ts} [${level.toUpperCase()}] [${component}] ${msg}`;
  if (data !== undefined) {
    return `${base} ${JSON.stringify(data)}`;
  }
  return base;
}

export function createLogger(component) {
  return {
    debug: (msg, data) => { if (currentLevel <= LEVELS.debug) console.log(fmt('debug', component, msg, data)); },
    info:  (msg, data) => { if (currentLevel <= LEVELS.info)  console.log(fmt('info', component, msg, data)); },
    warn:  (msg, data) => { if (currentLevel <= LEVELS.warn)  console.warn(fmt('warn', component, msg, data)); },
    error: (msg, data) => { if (currentLevel <= LEVELS.error) console.error(fmt('error', component, msg, data)); },
    critical: (msg, data) => { console.error(fmt('critical', component, msg, data)); },
  };
}
