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
    <div
      className="relative flex h-screen w-screen flex-col justify-end overflow-hidden rounded-xl text-white"
      style={{
        backgroundImage: 'url(/branding/splash.svg)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
    >
      <div className="relative px-12 pb-6">
        <div className="text-xs text-zinc-200">{step.label}</div>
        {step.detail && <div className="text-[10px] text-zinc-400">{step.detail}</div>}
      </div>
    </div>
  );
}

const container = document.getElementById('splash-root');
if (!container) throw new Error('splash-root element missing');

createRoot(container).render(<Splash />);
