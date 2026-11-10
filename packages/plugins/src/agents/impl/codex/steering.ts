import type { ClientSideConnection } from '@agentclientprotocol/sdk';
import type { AcpAgentApi } from '@emdash/core/services/agent-plugins/api/plugins';

/** 仅在协商了“空闲时不另开 turn”的 Codex 扩展后启用。 */
export function enableCodexSteering(
  agent: AcpAgentApi,
  connection: Pick<ClientSideConnection, 'extMethod'>
): void {
  agent.steerOnPrompt = true;
  agent.steerPrompt = async (request) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Codex message delivery timed out')), 15_000);
    });
    try {
      // Codex 原生 steer 在当前运行中接收消息；立即发送也不调用 turn/interrupt。
      const result = await Promise.race([
        connection.extMethod('_session/steering', {
          ...request,
          _meta: { ...request._meta, steering: { idleBehavior: 'promptRequired' } },
        }),
        timeout,
      ]);
      if (result.outcome === 'injected') return true;
      if (result.outcome === 'promptRequired') return false;
      throw new Error('Codex message delivery could not be confirmed');
    } finally {
      clearTimeout(timer);
    }
  };
}
