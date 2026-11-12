import type {
  AcpAgentApi,
  AcpClientFactory,
  AcpProcessIo,
} from '@emdash/core/services/agent-plugins/api/plugins';
import { connectStdioAcp } from '../../helpers/acp-stdio';

/** 只有支持优先级扩展的 Claude adapter 才启用运行中补充。 */
export function connectClaudeAcp(io: AcpProcessIo, toClient: AcpClientFactory): AcpAgentApi {
  const connection = connectStdioAcp(io, toClient);
  const initialize = connection.initialize.bind(connection);
  const agent: AcpAgentApi = connection;
  agent.initialize = async (params) => {
    const response = await initialize({
      ...params,
      clientCapabilities: {
        ...params.clientCapabilities,
        _meta: {
          ...params.clientCapabilities?._meta,
          'emdash.dev/queued-steering': true,
          'emdash.dev/activities': 1,
        },
      },
    });
    agent.supportsActivities = response._meta?.['emdash.dev/activities'] === 1;
    const steering = response._meta?.steering;
    if (
      steering &&
      typeof steering === 'object' &&
      'priorities' in steering &&
      Array.isArray(steering.priorities) &&
      steering.priorities.includes('next')
    ) {
      agent.steerPrompt = async (request, priority) => {
        const result = await connection.extMethod('_session/steering', {
          ...request,
          _meta: { steering: { idleBehavior: 'promptRequired', priority } },
        });
        if (result.outcome === 'injected') return true;
        if (result.outcome === 'promptRequired') return false;
        throw new Error('Unexpected Claude steering response');
      };
    }
    return response;
  };
  return agent;
}
