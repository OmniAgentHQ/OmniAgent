import { useEffect, useRef, useState } from 'react';
import { CircleAlert, X } from 'lucide-react';
import { errorMessage, omni } from './api';
import { Glyph } from './Glyph';

const SEP = window.omni?.platform === 'win32' ? '\\' : '/';

function lastPicked() {
  try {
    return localStorage.getItem('omniagent.projectRoot') || '';
  } catch {
    return '';
  }
}

export function NewProjectDialog({ suggestion, onCancel, onCreate }: {
  suggestion: string;
  onCancel: () => void;
  onCreate: (input: { name: string; folder: string }) => Promise<void>;
}) {
  const [name, setName] = useState(suggestion);
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    window.setTimeout(() => { nameRef.current?.focus(); nameRef.current?.select(); }, 30);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const ready = Boolean(name.trim()) && Boolean(folder);
  const parts = folder.split(/[\\/]/).filter(Boolean);

  const choose = async () => {
    const picked = await omni.chooseFolder(folder || lastPicked() || undefined);
    if (!picked) return;
    setFolder(picked);
    setError('');
    try { localStorage.setItem('omniagent.projectRoot', picked.split(/[\\/]/).slice(0, -1).join(SEP) || picked); } catch { }
    if (!name.trim()) setName(picked.split(/[\\/]/).filter(Boolean).pop() ?? '');
  };

  const create = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      await onCreate({ name: name.trim(), folder });
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };

  return <div className="modal-backdrop no-drag" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <form className="new-project" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <header className="new-project-head">
        <h2>New project</h2>
        <span className="spacer" />
        <button type="button" className="icon-btn" title="Cancel" onClick={onCancel}><X size={18} /></button>
      </header>
      <div className="field">
        <label>Name</label>
        <input ref={nameRef} className="input big" value={name} maxLength={120} placeholder="My Project" onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="field">
        <label>Folder</label>
        <div className={`folder-pick ${folder ? '' : 'empty'}`}>
          <Glyph name="openFolder" size={26} />
          <span className="folder-pick-path">{folder ? <><small>{parts.slice(0, -1).join(SEP)}{SEP}</small><strong>{parts[parts.length - 1]}</strong></> : <strong className="placeholder">Pick the folder your agents work in</strong>}</span>
          <button type="button" className={folder ? 'btn small' : 'btn-primary small'} onClick={() => void choose()}>{folder ? 'Change' : 'Choose folder'}</button>
        </div>
      </div>
      <p className="new-project-note">Your agents read and save everything inside this folder.</p>
      {error ? <div className="notice bad"><CircleAlert size={15} />{error}</div> : null}
      <div className="new-project-actions">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={!ready || busy}>{busy ? <span className="spinner" /> : null}Create project</button>
      </div>
    </form>
  </div>;
}
