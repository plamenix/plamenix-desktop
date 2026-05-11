import { createRoot } from 'react-dom/client';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useState } from 'react';
import { applyThemeToDocument, useThemeStore } from '@plamenix/ui';
import '@/styles/globals.css';

// Splash entry doesn't render <App>, so the theme store's auto-apply
// (which runs the first time the store module is touched) needs to be
// kicked manually before the splash mounts so the rehydrated mode
// lands on <html>.
applyThemeToDocument(useThemeStore.getState());

interface BootStep {
  label: string;
  detail?: string | undefined;
}

function Splash() {
  const [step, setStep] = useState<BootStep>({ label: 'Starting Plamenix' });

  useEffect(() => {
    const unlisten = listen<BootStep>('boot:step', (event) => {
      setStep(event.payload);
    });
    return () => {
      void unlisten.then((fn) => {
        fn();
      });
    };
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col justify-between rounded-xl bg-panel/90 p-6 text-fg backdrop-blur">
      <img
        src="/favicon/favicon-192.png"
        alt=""
        aria-hidden="true"
        className="h-16 w-16 self-start"
      />
      <div>
        <div className="text-lg font-semibold">Plamenix</div>
        <div className="text-xs text-fg-muted">Firebird IDE — 1.0.0-beta</div>
        <div className="mt-6 text-xs text-fg">{step.label}</div>
        {step.detail && <div className="text-[10px] text-fg-subtle">{step.detail}</div>}
      </div>
    </div>
  );
}

const container = document.getElementById('splash-root');
if (!container) throw new Error('splash-root element missing');

createRoot(container).render(<Splash />);
