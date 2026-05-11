import { useCallback, useEffect, useState } from 'react';
import {
  ConnectionPanel,
  ProfilePicker,
  QueryPanel,
  ResultTable,
  SchemaBrowser,
  SettingsButton,
  TabStrip,
  useTabsStore,
  useThemeStore,
  type ConnectionForm,
  type CryptState,
  type Profile,
  type QueryResult,
  type Schema,
  type TabState,
  type TableAction,
  type TableInfo,
} from '@plamenix/ui';
import { tauriTransport } from '@/transport/tauri';

interface ConnectResponse {
  sessionId: string;
}

function deriveTitle(form: ConnectionForm): string {
  const last = form.database.split(/[\\/]/).pop() ?? form.database;
  return `${form.host}/${last}`;
}

/** Quotes a Firebird identifier only when the bare form would change
 *  meaning (lowercase letters, leading digit, special chars). All-upper
 *  ASCII identifiers stay bare to match Firebird's case-folding
 *  convention. */
function quoteIdent(name: string): string {
  if (/^[A-Z_][A-Z0-9_]*$/.test(name)) return name;
  return `"${name.replace(/"/g, '""')}"`;
}

function ddlTemplate(action: TableAction, table: TableInfo): string {
  const ident = quoteIdent(table.name);
  switch (action) {
    case 'drop':
      return `DROP ${table.kind === 'view' ? 'VIEW' : 'TABLE'} ${ident};`;
    case 'alter':
      return [
        `ALTER TABLE ${ident}`,
        `    ADD <column_name> <data_type>;`,
        ``,
        `-- Replace with the change you want. Firebird also supports:`,
        `--   DROP <column_name>`,
        `--   ALTER <column_name> TYPE <data_type>`,
        `--   ALTER <column_name> SET DEFAULT <expr> / DROP DEFAULT`,
        `--   ADD CONSTRAINT <name> ...`,
      ].join('\n');
    case 'create-index': {
      const firstCol = table.columns[0]?.name ?? 'column_name';
      const idxName = `IDX_${table.name}_${firstCol}`;
      return `CREATE INDEX ${quoteIdent(idxName)} ON ${ident} (${quoteIdent(firstCol)});`;
    }
  }
}

export function App() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const newTab = useTabsStore((s) => s.newTab);
  const closeTab = useTabsStore((s) => s.closeTab);
  const setActive = useTabsStore((s) => s.setActive);
  const patchTab = useTabsStore((s) => s.patchTab);
  const renameTab = useTabsStore((s) => s.renameTab);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0]!;

  const [profiles, setProfiles] = useState<Profile[]>([]);

  const refreshProfiles = useCallback(async () => {
    try {
      const list = await tauriTransport.invoke<Profile[]>('profile_list');
      setProfiles(list);
    } catch (err) {
      patchTab(activeTabId, { error: String(err) });
    }
  }, [activeTabId, patchTab]);

  useEffect(() => {
    void refreshProfiles();
  }, [refreshProfiles]);

  const updateField = <K extends keyof ConnectionForm>(key: K, value: ConnectionForm[K]) => {
    patchTab(activeTabId, { form: { ...activeTab.form, [key]: value } });
  };

  const handleSelectProfile = (id: string | null) => {
    if (id === null) {
      patchTab(activeTabId, { selectedProfileId: null, profileName: '' });
      return;
    }
    const profile = profiles.find((p) => p.id === id);
    if (!profile) return;
    patchTab(activeTabId, {
      selectedProfileId: id,
      profileName: profile.name,
      form: {
        host: profile.host,
        port: profile.port,
        database: profile.database,
        user: profile.user,
        password: '',
        pureRust: profile.pureRust,
        encryptionKey: '',
        encryptionRequired: profile.encryptionRequired,
      },
    });
  };

  const handleSaveProfile = async () => {
    const tabId = activeTabId;
    const tab = activeTab;
    patchTab(tabId, { error: null, busy: true });
    try {
      const draft = {
        id: tab.selectedProfileId,
        name: tab.profileName.trim(),
        host: tab.form.host,
        port: tab.form.port,
        database: tab.form.database,
        user: tab.form.user,
        encryptionRequired: tab.form.encryptionRequired,
        pureRust: tab.form.pureRust,
        password: tab.form.password === '' ? null : tab.form.password,
        encryptionKey: tab.form.encryptionKey === '' ? null : tab.form.encryptionKey,
      };
      const saved = await tauriTransport.invoke<Profile>('profile_save', { draft });
      await refreshProfiles();
      patchTab(tabId, { selectedProfileId: saved.id, profileName: saved.name });
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  const handleDeleteProfile = async () => {
    const tabId = activeTabId;
    const id = activeTab.selectedProfileId;
    if (id === null) return;
    const existing = profiles.find((p) => p.id === id);
    const label = existing?.name ?? 'this profile';
    if (!window.confirm(`Delete "${label}"? This also removes its keyring entries.`)) {
      return;
    }
    patchTab(tabId, { error: null, busy: true });
    try {
      await tauriTransport.invoke<null>('profile_delete', { id });
      await refreshProfiles();
      patchTab(tabId, { selectedProfileId: null, profileName: '' });
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  const handleRenameProfile = async () => {
    const tabId = activeTabId;
    const tab = activeTab;
    const id = tab.selectedProfileId;
    if (id === null) return;
    const existing = profiles.find((p) => p.id === id);
    if (!existing) return;
    const newName = tab.profileName.trim();
    if (newName === '' || newName === existing.name) return;
    patchTab(tabId, { error: null, busy: true });
    try {
      // profile_save preserves untouched keyring refs and ignores the
      // `password` / `encryptionKey` fields when null, so we can rename
      // without overwriting any other field of the saved record.
      const draft = {
        id: existing.id,
        name: newName,
        host: existing.host,
        port: existing.port,
        database: existing.database,
        user: existing.user,
        encryptionRequired: existing.encryptionRequired,
        pureRust: existing.pureRust,
        password: null,
        encryptionKey: null,
      };
      const saved = await tauriTransport.invoke<Profile>('profile_save', { draft });
      await refreshProfiles();
      patchTab(tabId, { selectedProfileId: saved.id, profileName: saved.name });
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  const handleConnect = async () => {
    const tabId = activeTabId;
    const tab = activeTab;
    patchTab(tabId, { error: null, busy: true, cryptState: null });
    try {
      let response: ConnectResponse;
      if (tab.selectedProfileId !== null) {
        response = await tauriTransport.invoke<ConnectResponse>('profile_connect', {
          request: {
            profileId: tab.selectedProfileId,
            password: tab.form.password === '' ? null : tab.form.password,
            encryptionKey: tab.form.encryptionKey === '' ? null : tab.form.encryptionKey,
            pureRust: tab.form.pureRust,
            encryptionRequired: tab.form.encryptionRequired,
            fbclientPath: null,
          },
        });
      } else {
        response = await tauriTransport.invoke<ConnectResponse>('db_connect', {
          request: {
            host: tab.form.host,
            port: tab.form.port,
            database: tab.form.database,
            user: tab.form.user,
            password: tab.form.password,
            encryptionKey: tab.form.encryptionKey === '' ? null : tab.form.encryptionKey,
            encryptionRequired: tab.form.encryptionRequired,
            pureRust: tab.form.pureRust,
          },
        });
      }
      patchTab(tabId, { sessionId: response.sessionId, result: null });
      renameTab(tabId, tab.profileName.trim() || deriveTitle(tab.form));
      void refreshCryptState(tabId, response.sessionId);
      void refreshSchema(tabId, response.sessionId);
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  const refreshCryptState = async (tabId: string, sessionId: string) => {
    try {
      const state = await tauriTransport.invoke<CryptState>('db_crypt_state', { sessionId });
      patchTab(tabId, { cryptState: state });
    } catch {
      patchTab(tabId, { cryptState: null });
    }
  };

  const refreshSchema = async (tabId: string, sessionId: string) => {
    try {
      const schema = await tauriTransport.invoke<Schema>('db_describe_schema', { sessionId });
      patchTab(tabId, { schema });
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    }
  };

  const handleExecute = async () => {
    const tabId = activeTabId;
    const tab = activeTab;
    if (!tab.sessionId) return;
    patchTab(tabId, { error: null, busy: true });
    try {
      const res = await tauriTransport.invoke<QueryResult>('db_execute', {
        request: { sessionId: tab.sessionId, sql: tab.sql },
      });
      patchTab(tabId, { result: res });
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  const handleTableAction = async (action: TableAction, table: TableInfo) => {
    const tabId = activeTabId;
    const tab = activeTab;
    const sql = ddlTemplate(action, table);
    if (action !== 'drop') {
      patchTab(tabId, { sql });
      return;
    }
    if (
      !window.confirm(
        `Drop ${table.kind === 'view' ? 'view' : 'table'} ${table.name}? This cannot be undone.`,
      )
    ) {
      return;
    }
    if (!tab.sessionId) return;
    patchTab(tabId, { error: null, busy: true, sql });
    try {
      const res = await tauriTransport.invoke<QueryResult>('db_execute', {
        request: { sessionId: tab.sessionId, sql },
      });
      patchTab(tabId, { result: res });
      void refreshSchema(tabId, tab.sessionId);
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  const handleDisconnect = async () => {
    const tabId = activeTabId;
    const tab = activeTab;
    if (!tab.sessionId) return;
    patchTab(tabId, { error: null, busy: true });
    try {
      await tauriTransport.invoke<null>('db_close', { sessionId: tab.sessionId });
      patchTab(tabId, {
        sessionId: null,
        result: null,
        cryptState: null,
        schema: null,
      });
    } catch (err) {
      patchTab(tabId, { error: String(err) });
    } finally {
      patchTab(tabId, { busy: false });
    }
  };

  const handleTabClose = (id: string) => {
    const tab = tabs.find((t) => t.id === id);
    if (tab?.sessionId) {
      void tauriTransport
        .invoke<null>('db_close', { sessionId: tab.sessionId })
        .catch(() => {});
    }
    closeTab(id);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-stretch">
        <div className="flex-1 overflow-hidden">
          <TabStrip
            tabs={tabs}
            activeTabId={activeTabId}
            onSelect={setActive}
            onClose={handleTabClose}
            onNew={() => newTab()}
          />
        </div>
        <div className="flex shrink-0 items-end gap-1 border-b border-edge bg-canvas px-2 pb-1">
          <SettingsButton />
        </div>
      </div>
      {activeTab.sessionId === null ? (
        <ConnectView
          tab={activeTab}
          profiles={profiles}
          onFieldChange={updateField}
          onSelectProfile={handleSelectProfile}
          onProfileNameChange={(v) => patchTab(activeTabId, { profileName: v })}
          onSaveProfile={handleSaveProfile}
          onDeleteProfile={handleDeleteProfile}
          onRenameProfile={handleRenameProfile}
          onConnect={handleConnect}
        />
      ) : (
        <SessionView
          tab={activeTab}
          onSqlChange={(v) => patchTab(activeTabId, { sql: v })}
          onExecute={handleExecute}
          onDisconnect={handleDisconnect}
          onRefreshSchema={() => {
            if (activeTab.sessionId) {
              void refreshSchema(activeTabId, activeTab.sessionId);
            }
          }}
          onTableAction={handleTableAction}
        />
      )}
    </div>
  );
}

interface ConnectViewProps {
  tab: TabState;
  profiles: Profile[];
  onFieldChange: <K extends keyof ConnectionForm>(key: K, value: ConnectionForm[K]) => void;
  onSelectProfile: (id: string | null) => void;
  onProfileNameChange: (value: string) => void;
  onSaveProfile: () => void;
  onDeleteProfile: () => void;
  onRenameProfile: () => void;
  onConnect: () => void;
}

function ConnectView({
  tab,
  profiles,
  onFieldChange,
  onSelectProfile,
  onProfileNameChange,
  onSaveProfile,
  onDeleteProfile,
  onRenameProfile,
  onConnect,
}: ConnectViewProps) {
  const selected = tab.selectedProfileId
    ? profiles.find((p) => p.id === tab.selectedProfileId)
    : undefined;
  const passwordHint =
    selected?.passwordKeyringRef !== undefined
      ? 'Leave empty to use the password stored in your keyring for this profile.'
      : undefined;
  return (
    <main className="mx-auto flex flex-1 w-full max-w-4xl flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold">Plamenix</h1>
        <p className="text-sm text-zinc-400">Firebird IDE — 1.0.0-beta scaffold</p>
      </header>

      <ProfilePicker
        profiles={profiles}
        selectedId={tab.selectedProfileId}
        name={tab.profileName}
        busy={tab.busy}
        onSelect={onSelectProfile}
        onNameChange={onProfileNameChange}
        onSave={onSaveProfile}
        onDelete={onDeleteProfile}
        onRename={onRenameProfile}
      />

      <ConnectionPanel
        form={tab.form}
        busy={tab.busy}
        onChange={onFieldChange}
        onSubmit={onConnect}
        {...(passwordHint !== undefined && { passwordHint })}
      />

      {tab.error && (
        <pre className="rounded bg-red-950/40 p-3 text-xs text-red-200 whitespace-pre-wrap">
          {tab.error}
        </pre>
      )}
    </main>
  );
}

interface SessionViewProps {
  tab: TabState;
  onSqlChange: (value: string) => void;
  onExecute: () => void;
  onDisconnect: () => void;
  onRefreshSchema: () => void;
  onTableAction: (action: TableAction, table: TableInfo) => void;
}

function SessionView({
  tab,
  onSqlChange,
  onExecute,
  onDisconnect,
  onRefreshSchema,
  onTableAction,
}: SessionViewProps) {
  const sidebarCollapsed = useThemeStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useThemeStore((s) => s.toggleSidebar);
  if (!tab.sessionId) return null;
  return (
    <div className="flex flex-1 overflow-hidden">
      {sidebarCollapsed ? (
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label="Expand schema sidebar"
          className="flex shrink-0 items-start border-r border-edge bg-canvas px-2 pt-3 text-fg-subtle hover:text-fg"
        >
          »
        </button>
      ) : (
        <div className="flex w-64 shrink-0 flex-col">
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label="Collapse schema sidebar"
            className="self-end px-2 text-fg-subtle hover:text-fg"
            title="Collapse sidebar"
          >
            «
          </button>
          <SchemaBrowser
          schema={tab.schema}
          busy={tab.busy}
          onRefresh={onRefreshSchema}
          onSelect={(id) =>
            onSqlChange(
              tab.sql.length > 0 && !tab.sql.endsWith(' ') ? `${tab.sql} ${id}` : `${tab.sql}${id}`,
            )
          }
          onAction={onTableAction}
        />
        </div>
      )}
      <main className="flex flex-1 flex-col gap-6 overflow-y-auto p-6">
        <QueryPanel
          sessionId={tab.sessionId}
          sql={tab.sql}
          busy={tab.busy}
          cryptState={tab.cryptState}
          onSqlChange={onSqlChange}
          onExecute={onExecute}
          onClose={onDisconnect}
        />

        {tab.error && (
          <pre className="rounded bg-danger-subtle p-3 text-xs text-danger whitespace-pre-wrap">
            {tab.error}
          </pre>
        )}

        {tab.result && <ResultTable result={tab.result} />}
      </main>
    </div>
  );
}
