import { useEffect, useState } from 'react';
import { tauriTransport } from '@/transport/tauri';

export function App() {
  const [pong, setPong] = useState<string | null>(null);

  useEffect(() => {
    tauriTransport
      .invoke<string>('ping')
      .then(setPong)
      .catch((err: unknown) => {
        setPong(`error: ${String(err)}`);
      });
  }, []);

  return (
    <main className="flex h-full items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">Plamenix</h1>
        <p className="mt-2 text-sm text-zinc-400">Firebird IDE — 1.0.0-beta scaffold</p>
        <p className="mt-6 font-mono text-xs text-zinc-500">{pong ?? 'pinging core…'}</p>
      </div>
    </main>
  );
}
