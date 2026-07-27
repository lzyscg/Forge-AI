import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export async function POST(req: NextRequest) {
  const { caseId, dbPath, env } = await req.json();

  if (!caseId) {
    return NextResponse.json({ error: 'caseId is required' }, { status: 400 });
  }

  // 项目根目录（apps/web 的上两级）
  const projectRoot = resolve(process.cwd(), '../..');
  const cliBin = resolve(projectRoot, 'apps/cli/bin.js');

  const args = [cliBin, 'case', 'run', caseId, '--wait'];
  // 写操作：--db 优先级最高（精确库），否则透传 --env（必须单库 production|test）。
  if (dbPath) args.push('--db', dbPath);
  else if (env) args.push('--env', env);

  // detached spawn，stderr 必须 ignore 否则缓冲满会阻塞
  const child = spawn('node', args, {
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
          const firstLine = JSON.parse(lines[0]);
          // 检查是否是错误行（含 error 字段）
          if (firstLine.error) {
            done(NextResponse.json(firstLine, { status: 409 }));
          } else {
            done(NextResponse.json(firstLine));
          }
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

    // 超时保护
    setTimeout(() => {
      done(NextResponse.json({ error: 'Timeout waiting for CLI' }, { status: 500 }));
    }, 10000);
  });
}
