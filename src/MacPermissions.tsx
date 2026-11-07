import { useEffect, useState } from 'react';
import { Check, Monitor, MousePointerClick } from 'lucide-react';
import { omni, type MacPermission, type MacPermissionReport } from './api';
import { APP_NAME } from '../electron/shared';

const PERMISSIONS: Array<{ id: MacPermission; title: string; detail: string; icon: typeof Monitor }> = [
  { id: 'accessibility', title: 'Accessibility', detail: 'Lets agents click, type and press keys in your other apps.', icon: MousePointerClick },
  { id: 'screenRecording', title: 'Screen Recording', detail: 'Lets agents see your screen and take screenshots.', icon: Monitor }
];

export function MacPermissions() {
  const [report, setReport] = useState<MacPermissionReport | null>(null);
  const [asking, setAsking] = useState<MacPermission | ''>('');

  useEffect(() => {
    // These are switched on in System Settings, and nothing tells the app when that happens.
    const refresh = () => void omni.macPermissions().then(setReport, () => undefined);
    refresh();
    const timer = window.setInterval(refresh, 2_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!report) return null;

  const ask = async (which: MacPermission) => {
    setAsking(which);
    try {
      setReport(await omni.requestMacPermission(which));
    } catch {
    } finally {
      setAsking('');
    }
  };
  const allOn = PERMISSIONS.every((item) => report[item.id] === 'granted');

  return <div className="mac-permissions">
    <div className="mac-permissions-head">
      <strong>Let agents use this Mac</strong>
      <span className="mac-permissions-tag">Optional</span>
    </div>
    <p>{allOn
      ? 'All set. Agents can work across your Mac.'
      : 'Without these, agents can’t click, type or see your screen in other apps, so some tasks may stop partway. They can still use their own browser, work with files and write code.'}</p>
    <div className="mac-permission-list">
      {PERMISSIONS.map((item) => {
        const Icon = item.icon;
        const on = report[item.id] === 'granted';
        return <div className={`mac-permission ${on ? 'on' : ''}`} key={item.id}>
          <span className="mac-permission-icon"><Icon size={16} /></span>
          <span className="grow">
            <strong>{item.title}</strong>
            <small>{item.detail}</small>
            {on ? null : <span className="mac-permissions-tag">Optional</span>}
          </span>
          {on
            ? <span className="mac-permission-state"><Check size={13} strokeWidth={3} />On</span>
            : <button type="button" className="btn small" disabled={asking === item.id} onClick={() => void ask(item.id)}>{asking === item.id ? 'Opening…' : 'Allow'}</button>}
        </div>;
      })}
    </div>
    {allOn ? null : <small className="mac-permissions-note">Click Allow, then switch on {APP_NAME} in System Settings. macOS may ask to reopen the app after Screen Recording.</small>}
  </div>;
}
