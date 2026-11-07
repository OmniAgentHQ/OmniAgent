import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Download, Eye, FileImage, FolderOpen, X } from 'lucide-react';
import { errorMessage, omni } from './api';

export type ImageSource = { name: string; path: string };

const previewImageExtensions = new Set(['jpg', 'jpeg', 'png', 'svg', 'webp', 'gif']);

export function isPreviewImage(name: string) {
  return previewImageExtensions.has(name.split('.').pop()?.toLowerCase() ?? '');
}

export function imageSource(filePath: string, name?: string): ImageSource {
  return { path: filePath, name: name || filePath.split(/[\\/]/).filter(Boolean).pop() || filePath };
}

let viewing: ImageSource | null = null;
const viewers = new Set<() => void>();

export function openImage(source: ImageSource | null) {
  viewing = source;
  viewers.forEach((listener) => listener());
}

function useViewing() {
  return useSyncExternalStore((listener) => { viewers.add(listener); return () => { viewers.delete(listener); }; }, () => viewing);
}

function useImageUrl(source: ImageSource | null) {
  const [url, setUrl] = useState('');
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    setUrl('');
    setUnavailable(false);
    if (!source?.path) {
      setUnavailable(true);
      return () => undefined;
    }
    void Promise.resolve().then(() => omni.imagePreview(source.path)).then((result) => {
      if (!active) return;
      if (result.previewable && result.dataUrl) setUrl(result.dataUrl);
      else setUnavailable(true);
    }).catch(() => {
      if (active) setUnavailable(true);
    });
    return () => { active = false; };
  }, [source?.path]);

  return { url, unavailable };
}

function ImageTile({ source, compact, onRemove }: { source: ImageSource; compact: boolean; onRemove?: (source: ImageSource) => void }) {
  const { url, unavailable } = useImageUrl(source);
  return <div className={`image-tile ${compact ? 'compact' : ''} ${unavailable ? 'unavailable' : ''}`}>
    <button type="button" className="image-open" disabled={!url} aria-label={url ? `Preview ${source.name}` : `${source.name} cannot be previewed`} onClick={() => openImage(source)}>
      {url ? <img src={url} alt={source.name} draggable={false} /> : <span>{unavailable ? <FileImage size={20} /> : <span className="spinner" />}</span>}
      {url ? <i><Eye size={15} /></i> : null}
    </button>
    {onRemove ? <button type="button" className="image-remove" aria-label={`Remove ${source.name}`} onClick={() => onRemove(source)}><X size={12} /></button> : null}
  </div>;
}

export function ImageGallery({ images, onRemove, size = 'normal', className = '' }: { images: ImageSource[]; onRemove?: (source: ImageSource) => void; size?: 'normal' | 'medium' | 'small'; className?: string }) {
  if (!images.length) return null;
  const compact = images.length > 1 || size !== 'normal';
  return <div className={`image-gallery ${compact ? 'multiple' : 'single'} ${size} ${className}`}>
    {images.map((image) => <ImageTile source={image} compact={compact} onRemove={onRemove} key={image.path} />)}
  </div>;
}

export function ImageViewer() {
  const source = useViewing();
  const { url, unavailable } = useImageUrl(source);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  useEffect(() => { setSize(null); setNote(null); }, [source?.path]);
  useEffect(() => {
    if (!source) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); openImage(null); }
    };
    window.addEventListener('keydown', closeOnEscape, true);
    return () => window.removeEventListener('keydown', closeOnEscape, true);
  }, [source]);
  if (!source) return null;
  const act = (action: () => Promise<unknown>, success: (result: unknown) => string) => {
    setNote(null);
    void action()
      .then((result) => { const text = success(result); if (text) setNote({ text, bad: false }); })
      .catch((failure) => setNote({ text: errorMessage(failure) || 'That file is no longer there.', bad: true }));
  };
  return createPortal(
    <div className="viewer no-drag" data-floating-layer="" role="dialog" aria-modal="true" aria-label={`Preview ${source.name}`} onMouseDown={(event) => {
      const target = event.target as HTMLElement;
      if (target === event.currentTarget || target.classList.contains('viewer-stage')) openImage(null);
    }}>
      <div className="viewer-stage">
        {url
          ? <img src={url} alt={source.name} draggable={false} onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
          : unavailable
            ? <div className="viewer-missing"><FileImage size={30} /><strong>This image can’t be shown</strong><small>It may have been moved or deleted.</small></div>
            : <span className="spinner big" />}
      </div>
      <div className="viewer-dock">
        {note ? <span className={`viewer-note ${note.bad ? 'bad' : ''}`}>{note.text}</span> : null}
        <span className="viewer-file">
          <span className="viewer-thumb"><FileImage size={15} /></span>
          <span className="viewer-name">{source.name}</span>
          {size ? <small>{size.width} × {size.height}</small> : null}
        </span>
        <span className="viewer-actions">
          <button type="button" aria-label="Show in folder" onClick={() => act(() => omni.revealPath(source.path), () => '')}><FolderOpen size={15} /><span>Show in folder</span></button>
          <button type="button" aria-label="Save a copy" onClick={() => act(() => omni.saveCopy(source.path), (result) => (result as { canceled?: boolean })?.canceled ? '' : 'Saved')}><Download size={15} /><span>Save a copy</span></button>
          <button type="button" className="viewer-close" aria-label="Close preview" onClick={() => openImage(null)}><X size={16} /></button>
        </span>
      </div>
    </div>,
    document.body
  );
}
