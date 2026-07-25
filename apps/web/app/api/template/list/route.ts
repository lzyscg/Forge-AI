import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export async function GET() {
  const projectRoot = resolve(process.cwd(), '../..');
  const cliBin = resolve(projectRoot, 'apps/cli/bin.js');

  const child = spawn('node', [cliBin, 'template', 'list'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    cwd: projectRoot,
  });

  return new Promise<NextResponse>((resolvePromise) => {
    let buf = '';
    let resolved = false;

    const done = (res: NextResponse) => {
      if (!resolved) {
        resolved = true;
        resolvePromise(res);
      }
    };

    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split('\n');
      if (lines.length > 0 && lines[0].trim()) {
        try {
          const parsed = JSON.parse(lines[0]);
          done(NextResponse.json({ templates: parsed }));
        } catch {
          done(NextResponse.json({ error: 'Invalid CLI output' }, { status: 500 }));
        }
        child.unref();
      }
    });

    child.on('error', (err) => {
      done(NextResponse.json({ error: err.message }, { status: 500 }));
    });

    child.on('close', (code) => {
      if (code !== 0 && !resolved) {
        done(NextResponse.json({ error: `CLI exited with code ${code}` }, { status: 500 }));
      }
    });

    setTimeout(() => {
      done(NextResponse.json({ error: 'Timeout waiting for CLI' }, { status: 500 }));
    }, 10000);
  });
}
