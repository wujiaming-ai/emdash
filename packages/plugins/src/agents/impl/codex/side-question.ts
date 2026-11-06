import type {
  AcpAgentApi,
  AcpClientFactory,
  AcpProcessIo,
} from '@emdash/core/services/agent-plugins/api/plugins';
import { z } from 'zod';
import { connectStdioAcp } from '../../helpers/acp-stdio';

/** 扩展只由 Codex 插件协商，其他 Agent 保留原有行为。 */
export function connectCodexAcp(io: AcpProcessIo, toClient: AcpClientFactory): AcpAgentApi {
  const connection = connectStdioAcp(io, toClient);
  const initialize = connection.initialize.bind(connection);
  const agent: AcpAgentApi = connection;
  agent.initialize = async (params) => {
    const response = await initialize(params);
    if (response._meta?.['emdash.dev/side-question'] === 1) {
      agent.sideQuestion = async (request) =>
        z
          .object({ text: z.string() })
          .parse(await connection.extMethod('_emdash/sideQuestion', request));
    }
    if (response._meta?.['emdash.dev/side-session'] === 1) {
      agent.forkSideSession = (request) =>
        connection.unstable_forkSession({
          ...request,
          _meta: { ...request._meta, 'emdash.dev/side-session': 1 },
        });
    }
    return response;
  };
  return agent;
}
