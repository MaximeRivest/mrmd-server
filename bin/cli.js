#!/usr/bin/env node

/**
 * mrmd-server CLI
 *
 * Usage:
 *   mrmd-server [options] [project-dir]
 *
 * Options:
 *   -p, --port <port>     HTTP port (default: 8080)
 *   -h, --host <host>     Bind host (default: 0.0.0.0)
 *   -t, --token <token>   Auth token (auto-generated if not provided)
 *   --no-auth             Disable authentication (dangerous!)
 *   --help                Show help
 */

import { createServer } from '../src/server.js';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';

function parseArgs(args) {
  const options = {
    port: 8080,
    host: '0.0.0.0',
    token: null,
    noAuth: false,
    projectDir: '.',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-p' || arg === '--port') {
      options.port = parseInt(args[++i], 10);
    } else if (arg === '-h' || arg === '--host') {
      options.host = args[++i];
    } else if (arg === '-t' || arg === '--token') {
      options.token = args[++i];
    } else if (arg === '--no-auth') {
      options.noAuth = true;
    } else if (arg === '--help') {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      options.projectDir = arg;
    }
  }

  return options;
}

function printHelp() {
  console.log(`
mrmd-server - Run mrmd in any browser

Usage:
  mrmd-server [options] [project-dir]

Options:
  -p, --port <port>     HTTP port (default: 8080)
  -h, --host <host>     Bind host (default: 0.0.0.0)
  -t, --token <token>   Auth token (auto-generated if not provided)
  --no-auth             Disable authentication (DANGEROUS - local dev only)
  --help                Show this help

Examples:
  mrmd-server                         Start in current directory
  mrmd-server ./my-project            Start in specific directory
  mrmd-server -p 3000 ./notebooks     Custom port
  mrmd-server --no-auth               No auth (local dev only)

Access:
  Once started, access via the URL shown (includes token).
  Share the URL with collaborators for real-time editing.
`);
}

async function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  // Resolve project directory
  options.projectDir = path.resolve(options.projectDir);

  // Verify directory exists
  try {
    await fs.access(options.projectDir);
  } catch {
    console.error(`Error: Directory not found: ${options.projectDir}`);
    process.exit(1);
  }

  // Find mrmd-electron for the UI
  const packageDir = path.dirname(path.dirname(import.meta.url.replace('file://', '')));
  const possibleElectronPaths = [
    path.join(packageDir, '..', 'mrmd-electron'),
    path.join(process.cwd(), '..', 'mrmd-electron'),
    path.join(process.cwd(), 'mrmd-electron'),
  ];

  let electronDir = null;
  for (const p of possibleElectronPaths) {
    try {
      await fs.access(path.join(p, 'index.html'));
      electronDir = p;
      break;
    } catch {}
  }

  // Create and start server
  const server = createServer({
    ...options,
    electronDir,
  });

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await server.stop();
    process.exit(0);
  });

  await server.start();

  // Start mrmd-sync if available
  try {
    const syncPath = path.join(packageDir, '..', 'mrmd-sync', 'bin', 'cli.js');
    await fs.access(syncPath);

    console.log('  Starting mrmd-sync...');
    const syncProc = spawn('node', [syncPath, '--port', '4444', options.projectDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    syncProc.stdout.on('data', (data) => {
      if (data.toString().includes('Server started')) {
        console.log(`  Sync:       ws://localhost:4444`);
      }
    });

    server.context.syncProcess = syncProc;
  } catch {
    console.log('  Sync:       (mrmd-sync not found, start manually)');
  }

  // Keep running
  console.log('');
  console.log('  Press Ctrl+C to stop');
  console.log('');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
