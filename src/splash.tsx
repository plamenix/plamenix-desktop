import { createRoot } from 'react-dom/client';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useState } from 'react';
import '@/styles/globals.css';

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
    <div className="flex h-screen w-screen flex-col justify-between rounded-xl bg-zinc-900/90 p-6 backdrop-blur">
      <img
        src="/favicon/favicon-192.png"
        alt=""
        aria-hidden="true"
        className="h-16 w-16 self-start"
      />
      <div>
        <div className="text-lg font-semibold">Plamenix</div>
        <div className="text-xs text-zinc-400">Firebird IDE — 1.0.0-beta</div>
        <div className="mt-6 text-xs text-zinc-300">{step.label}</div>
        {step.detail && <div className="text-[10px] text-zinc-500">{step.detail}</div>}
      </div>
    </div>
  );
}

const container = document.getElementById('splash-root');
if (!container) throw new Error('splash-root element missing');

createRoot(container).render(<Splash />);
