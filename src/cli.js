#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createAgentPipeServer, PORT as DEFAULT_SERVER_PORT } from './server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_PORT = DEFAULT_SERVER_PORT || 4747;

/**
 * Resolves the port from CLI arguments, environment variable, or fallback default.
 *
 * Priority:
 * 1. CLI flag: --port <value>, --port=<value>, -p <value>, -p=<value>
 * 2. Environment variable: PORT
 * 3. Default: 4747
 *
 * @param {string[]} [args]
 * @param {object} [env]
 * @returns {number} Resolved port number
 */
export function resolvePort(args = process.argv.slice(2), env = process.env) {
  let portArg = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' || arg === '-p') {
      portArg = args[i + 1];
      i++;
    } else if (arg.startsWith('--port=')) {
      portArg = arg.slice('--port='.length);
    } else if (arg.startsWith('-p=')) {
      portArg = arg.slice('-p='.length);
    }
  }

  if (portArg !== null && portArg !== undefined) {
    const parsed = Number.parseInt(portArg, 10);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 65535) {
      return parsed;
    }
  }

  if (env && env.PORT) {
    const parsed = Number.parseInt(env.PORT, 10);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 65535) {
      return parsed;
    }
  }

  return DEFAULT_PORT;
}

export function readVersion() {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function printHelp(port = DEFAULT_PORT) {
  console.log(`
AgentPipe v${readVersion()}

Usage:
  agentpipe start [--port <number>]    Start the AgentPipe server and open the dashboard
  agentpipe help                       Show this help message
  agentpipe --version                  Show the version

Options:
  -p, --port <number>                  Port to bind (default: 4747 or PORT env var)

Dashboard: http://localhost:${port}
`);
}

export function openBrowser(url) {
  const platform = process.platform;
  let cmd;
  let cmdArgs;

  if (platform === 'win32') {
    cmd = 'cmd';
    cmdArgs = ['/c', 'start', '', url];
  } else if (platform === 'darwin') {
    cmd = 'open';
    cmdArgs = [url];
  } else {
    cmd = 'xdg-open';
    cmdArgs = [url];
  }

  try {
    spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    console.log(`[AgentPipe] Open your browser at ${url}`);
  }
}

/**
 * Starts the AgentPipe server and optionally opens the dashboard in the default browser.
 *
 * @param {object} [options]
 * @param {string[]} [options.args]
 * @param {object} [options.env]
 * @param {number} [options.port]
 * @param {string} [options.host]
 * @param {boolean} [options.open]
 * @param {import('./store.js').RequestStore} [options.store]
 * @param {string} [options.publicDir]
 * @returns {Promise<import('node:http').Server>}
 */
export async function start(options = {}) {
  const args = options.args || process.argv.slice(2);
  const env = options.env || process.env;
  const port = options.port !== undefined ? options.port : resolvePort(args, env);
  const host = options.host || 'localhost';
  const open = options.open !== false;

  const server = createAgentPipeServer({
    store: options.store,
    publicDir: options.publicDir,
    port,
    host
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const boundAddress = server.address();
  const activePort = (boundAddress && typeof boundAddress === 'object') ? boundAddress.port : port;
  const dashboardUrl = `http://${host}:${activePort}`;

  console.log(`AgentPipe server listening on ${dashboardUrl}`);

  if (open) {
    setTimeout(() => openBrowser(dashboardUrl), 400);
  }

  return server;
}

export async function main() {
  const args = process.argv.slice(2);
  const command = args.find((a) => !a.startsWith('-')) || args[0];

  if (!command || command === 'help' || args.includes('help') || args.includes('--help') || args.includes('-h')) {
    const port = resolvePort(args);
    printHelp(port);
    return;
  }

  if (command === '--version' || command === '-v' || args.includes('--version') || args.includes('-v')) {
    console.log(readVersion());
    return;
  }

  if (command === 'start') {
    const server = await start({ args });

    const shutdown = () => {
      server.close(() => {
        process.exit(0);
      });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return server;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(__filename);
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main().catch((err) => {
    console.error('[AgentPipe] CLI error:', err);
    process.exitCode = 1;
  });
}
