import { invoke } from '@tauri-apps/api/core';
import type { Transport } from '@plamenix/ui';
import { TransportError } from '@plamenix/ui';

export const tauriTransport: Transport = {
  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    try {
      return (await invoke(command, args)) as T;
    } catch (cause) {
      throw new TransportError(`Tauri command '${command}' failed`, cause);
    }
  },
};
