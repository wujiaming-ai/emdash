import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'claude-history-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// 使用隔离 CLI 历史验证真实 SDK，不读取个人会话，也不向模型发送请求。
it('paginates real SDK records without loading all history into the response', async () => {
  const project = join(root, 'projects', '-fixture-repo');
  await mkdir(project, { recursive: true });
  for (let i = 0; i < 45; i++) {
    const sessionId = randomUUID();
    await writeFile(
      join(project, `${sessionId}.jsonl`),
      JSON.stringify({
        type: 'user',
        sessionId,
        cwd: '/fixture/repo',
        timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        message: { role: 'user', content: `Fixture task ${i}` },
        uuid: randomUUID(),
        parentUuid: null,
      }) + '\n'
    );
  }
  const script = `
    import { ClaudeAcpAgent } from '@agentclientprotocol/claude-agent-acp/dist/acp-agent.js';
    const request = (cursor) => ClaudeAcpAgent.prototype.listSessions.call({}, { cursor, _meta: { 'emdash.dev/history-page-size': 20 } });
    const a = await request(); const b = await request(a.nextCursor); const c = await request(b.nextCursor);
    let invalid = false; try { await request('-1'); } catch { invalid = true; }
    console.log(JSON.stringify({ counts: [a,b,c].map(x => x.sessions.length), cursors: [a,b,c].map(x => x.nextCursor), unique: new Set([a,b,c].flatMap(x => x.sessions.map(s => s.sessionId))).size, invalid }));
  `;
  const result = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: root },
      timeout: 15000,
    })
  );
  expect(result).toEqual({
    counts: [20, 20, 5],
    cursors: ['20', '40', null],
    unique: 45,
    invalid: true,
  });
});
