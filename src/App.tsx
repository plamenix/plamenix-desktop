import { useState } from 'react';
import {
  ConnectionPanel,
  QueryPanel,
  ResultTable,
  type ConnectionForm,
  type QueryResult,
} from '@plamenix/ui';
import { tauriTransport } from '@/transport/tauri';

interface ConnectResponse {
  sessionId: string;
}

const initialForm: ConnectionForm = {
  host: '127.0.0.1',
  port: 3050,
  database: '/var/lib/firebird/data/test.fdb',
  user: 'SYSDBA',
  password: 'masterkey',
  pureRust: true,
};

const initialSql = "SELECT 42 AS answer, 'plamenix' AS name FROM RDB$DATABASE";

export function App() {
  const [form, setForm] = useState<ConnectionForm>(initialForm);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sql, setSql] = useState<string>(initialSql);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  const updateField = <K extends keyof ConnectionForm>(key: K, value: ConnectionForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleConnect = async () => {
    setError(null);
    setBusy(true);
    try {
      const response = await tauriTransport.invoke<ConnectResponse>('db_connect', {
        request: {
          host: form.host,
          port: form.port,
          database: form.database,
          user: form.user,
          password: form.password,
          encryptionRequired: false,
          pureRust: form.pureRust,
        },
      });
      setSessionId(response.sessionId);
      setResult(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleExecute = async () => {
    if (!sessionId) return;
    setError(null);
    setBusy(true);
    try {
      const res = await tauriTransport.invoke<QueryResult>('db_execute', {
        request: { sessionId, sql },
      });
      setResult(res);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleClose = async () => {
    if (!sessionId) return;
    setError(null);
    setBusy(true);
    try {
      await tauriTransport.invoke<null>('db_close', { sessionId });
      setSessionId(null);
      setResult(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex h-full max-w-4xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Plamenix</h1>
        <p className="text-sm text-zinc-400">Firebird IDE — 1.0.0-beta scaffold</p>
      </header>

      {!sessionId ? (
        <ConnectionPanel
          form={form}
          busy={busy}
          onChange={updateField}
          onSubmit={handleConnect}
        />
      ) : (
        <QueryPanel
          sessionId={sessionId}
          sql={sql}
          busy={busy}
          onSqlChange={setSql}
          onExecute={handleExecute}
          onClose={handleClose}
        />
      )}

      {error && (
        <pre className="rounded bg-red-950/40 p-3 text-xs text-red-200 whitespace-pre-wrap">
          {error}
        </pre>
      )}

      {result && <ResultTable result={result} />}
    </main>
  );
}
