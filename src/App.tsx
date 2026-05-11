import { useState } from 'react';
import { tauriTransport } from '@/transport/tauri';

interface ConnectionForm {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  pureRust: boolean;
}

interface ColumnDescription {
  name: string;
}

type ColumnValue =
  | { type: 'null' }
  | { type: 'text'; value: string }
  | { type: 'integer'; value: number }
  | { type: 'float'; value: number }
  | { type: 'bool'; value: boolean }
  | { type: 'blob'; value: string };

interface Row {
  cells: ColumnValue[];
}

type QueryResult =
  | { Rows: { columns: ColumnDescription[]; rows: Row[] } }
  | { Affected: { rows: number } };

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

interface ConnectionPanelProps {
  form: ConnectionForm;
  busy: boolean;
  onChange: <K extends keyof ConnectionForm>(key: K, value: ConnectionForm[K]) => void;
  onSubmit: () => void;
}

function ConnectionPanel({ form, busy, onChange, onSubmit }: ConnectionPanelProps) {
  return (
    <section className="grid grid-cols-2 gap-3 rounded border border-zinc-800 p-4">
      <Field label="Host">
        <input
          className="input"
          value={form.host}
          onChange={(e) => onChange('host', e.target.value)}
        />
      </Field>
      <Field label="Port">
        <input
          className="input"
          type="number"
          value={form.port}
          onChange={(e) => onChange('port', Number(e.target.value))}
        />
      </Field>
      <Field label="Database" className="col-span-2">
        <input
          className="input"
          value={form.database}
          onChange={(e) => onChange('database', e.target.value)}
        />
      </Field>
      <Field label="User">
        <input
          className="input"
          value={form.user}
          onChange={(e) => onChange('user', e.target.value)}
        />
      </Field>
      <Field label="Password">
        <input
          className="input"
          type="password"
          value={form.password}
          onChange={(e) => onChange('password', e.target.value)}
        />
      </Field>
      <label className="col-span-2 flex items-center gap-2 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={form.pureRust}
          onChange={(e) => onChange('pureRust', e.target.checked)}
        />
        Pure-Rust mode (no fbclient required)
      </label>
      <button
        className="col-span-2 rounded bg-amber-600 px-4 py-2 font-medium text-zinc-950 disabled:opacity-50"
        disabled={busy}
        onClick={onSubmit}
      >
        {busy ? 'Connecting…' : 'Connect'}
      </button>
    </section>
  );
}

interface QueryPanelProps {
  sessionId: string;
  sql: string;
  busy: boolean;
  onSqlChange: (value: string) => void;
  onExecute: () => void;
  onClose: () => void;
}

function QueryPanel({ sessionId, sql, busy, onSqlChange, onExecute, onClose }: QueryPanelProps) {
  return (
    <section className="flex flex-col gap-3 rounded border border-zinc-800 p-4">
      <div className="flex items-center justify-between text-xs text-zinc-400">
        <span>session: <code className="font-mono text-zinc-200">{sessionId}</code></span>
        <button
          className="rounded border border-zinc-700 px-3 py-1 text-zinc-300 hover:bg-zinc-800"
          onClick={onClose}
          disabled={busy}
        >
          Disconnect
        </button>
      </div>
      <textarea
        className="input min-h-[120px] font-mono text-sm"
        value={sql}
        onChange={(e) => onSqlChange(e.target.value)}
      />
      <button
        className="self-start rounded bg-amber-600 px-4 py-2 font-medium text-zinc-950 disabled:opacity-50"
        disabled={busy}
        onClick={onExecute}
      >
        {busy ? 'Executing…' : 'Execute'}
      </button>
    </section>
  );
}

function ResultTable({ result }: { result: QueryResult }) {
  if ('Affected' in result) {
    return (
      <div className="rounded border border-zinc-800 p-3 text-sm text-zinc-300">
        Affected rows: <span className="font-mono">{result.Affected.rows}</span>
      </div>
    );
  }

  const { columns, rows } = result.Rows;
  return (
    <div className="overflow-x-auto rounded border border-zinc-800">
      <table className="min-w-full text-sm">
        <thead className="bg-zinc-900 text-left text-xs uppercase text-zinc-400">
          <tr>
            {columns.map((col) => (
              <th key={col.name} className="px-3 py-2 font-medium">
                {col.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="odd:bg-zinc-950 even:bg-zinc-900/50">
              {row.cells.map((cell, j) => (
                <td key={j} className="px-3 py-2 font-mono text-xs text-zinc-200">
                  {renderCell(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderCell(cell: ColumnValue): string {
  switch (cell.type) {
    case 'null':
      return 'NULL';
    case 'text':
      return cell.value;
    case 'integer':
    case 'float':
      return String(cell.value);
    case 'bool':
      return cell.value ? 'true' : 'false';
    case 'blob':
      return `0x${cell.value.slice(0, 32)}${cell.value.length > 32 ? '…' : ''}`;
  }
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1 text-xs text-zinc-400 ${className ?? ''}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}
