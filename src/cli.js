#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 4747;
const DASHBOARD_URL = `http://localhost:${PORT}`;

function readVersion() {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printHelp() {
  console.log(`
AgentPipe v${readVersion()}

Usage:
  agentpipe start        Start the AgentPipe server and open the dashboard
  agentpipe help         Show this help message
  agentpipe --version    Show the version

Dashboard: ${DASHBOARD_URL}
`);
}

function openBrowser(url) {
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

async function start() {
  await import('./server.js');
  setTimeout(() => openBrowser(DASHBOARD_URL), 400);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === '--version' || command === '-v') {
    console.log(readVersion());
    return;
  }

  if (command === 'start') {
    await start();
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('[AgentPipe] CLI error:', err);
  process.exitCode = 1;
});