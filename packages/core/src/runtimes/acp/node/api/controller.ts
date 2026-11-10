import { createController } from '@emdash/wire/rpc';
import { acpApiContract } from '#runtimes/acp/api';
import type { AcpRuntime } from '#runtimes/acp/node/runtime/runtime';
import { createAcpProcedures } from './procedures';

export function createAcpController(runtime: AcpRuntime) {
  const procedures = createAcpProcedures(runtime);
  return createController(acpApiContract, {
    ...procedures,
    nativeHistory: {
      list: (input) => runtime.nativeHistory.list(input),
      resolve: (input) => runtime.nativeHistory.resolve(input.selectionId),
    },
    sessions: runtime.sessionsLiveHost(),
    session: runtime.sessionLiveHost(),
    terminalOutput: (key) => runtime.terminalOutputLog(key.terminalId),
  });
}
