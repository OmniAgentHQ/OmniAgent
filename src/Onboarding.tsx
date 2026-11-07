import { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Moon, Sun } from 'lucide-react';
import { errorMessage, omni } from './api';
import { MacPermissions } from './MacPermissions';
import { EnginesSection } from './Settings';
import { IS_MAC } from './shortcuts';
import { Swarm } from './Swarm';
import type { AppSnapshot } from '../electron/shared';

const THEMES = [
  { id: 'light' as const, title: 'Light', detail: 'White and blue', icon: Sun },
  { id: 'dark' as const, title: 'Dark', detail: 'Black and blue', icon: Moon }
];

const STEPS = ['Your look', 'Your engines'];

function ThemePreview({ theme }: { theme: 'light' | 'dark' }) {
  return <span className={`theme-preview ${theme}`} aria-hidden="true">
    <span className="tp-side"><i className="tp-brand" /><i /><i /><i /></span>
    <span className="tp-main">
      <i className="tp-line wide" />
      <i className="tp-line" />
      <span className="tp-cards"><i /><i /><i /></span>
      <span className="tp-composer"><i className="tp-tag" /><i className="tp-tag" /><i className="tp-send" /></span>
    </span>
  </span>;
}

export function Onboarding({ snapshot }: { snapshot: AppSnapshot }) {
  const [step, setStep] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState('');
  const installed = Object.values(snapshot.runtimes).filter(Boolean).length;

  const finish = async () => {
    setFinishing(true);
    setError('');
    try {
      await omni.completeOnboarding();
    } catch (failure) {
      setError(errorMessage(failure));
      setFinishing(false);
    }
  };

  return <div className={`onboarding ${IS_MAC ? 'mac' : ''}`}>
    <div className="onboarding-drag drag" />
    <div className="onboarding-inner">
      <header className="onboarding-hero">
        <Swarm />
        <span className="onboarding-eyebrow">OmniAgent <b className="edition-name core">Core</b></span>
        <h1>Welcome to OmniAgent</h1>
        <p>ChatGPT and Claude on the same team. Tag them in one message and they build it together.</p>
      </header>

      <ol className="onboarding-steps">
        {STEPS.map((label, index) => <li key={label} className={index === step ? 'on' : index < step ? 'done' : ''}>
          <span>{index < step ? <Check size={12} strokeWidth={3} /> : index + 1}</span>{label}
        </li>)}
      </ol>

      {step === 0 ? <section className="onboarding-card">
        <h3>Choose your look</h3>
        <p>You can switch any time in Settings.</p>
        <div className="theme-choices">
          {THEMES.map((theme) => {
            const Icon = theme.icon;
            const on = snapshot.theme === theme.id;
            return <button type="button" key={theme.id} className={`theme-choice ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => void omni.setTheme(theme.id)}>
              <ThemePreview theme={theme.id} />
              <span className="theme-choice-label">
                <Icon size={16} />
                <span className="grow"><strong>{theme.title}</strong><small>{theme.detail}</small></span>
                <span className="theme-radio">{on ? <Check size={12} strokeWidth={3} /> : null}</span>
              </span>
            </button>;
          })}
        </div>
        {IS_MAC ? <MacPermissions /> : null}
      </section> : <section className="onboarding-card">
        <h3>Check your AI engines</h3>
        <p>{installed ? `${installed} ready on this computer.` : 'None installed yet.'} Each AI runs through its official engine. Download the ones you plan to use now, or later in Settings.</p>
        <EnginesSection snapshot={snapshot} />
      </section>}

      {error ? <div className="notice bad">{error}</div> : null}

      <footer className="onboarding-actions">
        {step > 0 ? <button type="button" className="btn" onClick={() => setStep(step - 1)}><ArrowLeft size={14} />Back</button> : <span />}
        {step < STEPS.length - 1
          ? <button type="button" className="btn-primary" onClick={() => setStep(step + 1)}>Continue<ArrowRight size={14} /></button>
          : <button type="button" className="btn-primary" disabled={finishing} onClick={() => void finish()}>{finishing ? <span className="spinner" /> : null}Start using OmniAgent<ArrowRight size={14} /></button>}
      </footer>
    </div>
  </div>;
}
