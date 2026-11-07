import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, omni } from './api';
import { Composer } from './Composer';
import { Starter } from './Examples';
import { DemoStage, DEMO_PROMPT } from './Demo';
import { tagPattern, type AppSnapshot, type TeamConfig } from '../electron/shared';

export type ProjectRequest = (options: { suggestion?: string; team?: TeamConfig }) => Promise<string | null>;

function suggestName(text: string) {
  const words = text.replace(tagPattern(), '$1').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 5).join(' ');
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

export function Home({ snapshot, requestProject, onStarted, onOpenConnections, onNotify }: {
  snapshot: AppSnapshot;
  requestProject: ProjectRequest;
  onStarted: (sessionId: string) => void;
  onOpenConnections: () => void;
  onNotify: (message: string, bad?: boolean) => void;
}) {
  const [team, setTeam] = useState<TeamConfig>(snapshot.defaultTeam);
  const [prefill, setPrefill] = useState('');
  const [demo, setDemo] = useState(false);
  const connected = snapshot.connections.some((item) => item.status === 'connected');
  const saveTimer = useRef<number | undefined>(undefined);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const followDemo = useCallback(() => {
    window.requestAnimationFrame(() => timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight, behavior: 'smooth' }));
  }, []);
  const dirty = useRef(false);

  useEffect(() => {
    if (!dirty.current) setTeam(snapshot.defaultTeam);
  }, [snapshot.defaultTeam]);

  const changeTeam = (next: TeamConfig) => {
    dirty.current = true;
    setTeam(next);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void omni.saveDefaultTeam(next).finally(() => { dirty.current = false; });
    }, 300);
  };

  const send = async (text: string, attachments: Array<{ path: string; name: string }>) => {
    window.clearTimeout(saveTimer.current);
    const sessionId = await requestProject({ suggestion: suggestName(text), team });
    if (!sessionId) return false;
    try {
      await omni.send(sessionId, text, attachments);
    } catch (failure) {
      onStarted(sessionId);
      onNotify(errorMessage(failure), true);
      return true;
    }
    dirty.current = false;
    onStarted(sessionId);
    return true;
  };

  const onPrefillUsed = useCallback(() => setPrefill(''), []);

  return <section className="session">
    <div className="timeline" ref={timelineRef}>
      {demo
        ? <div className="timeline-inner"><DemoStage connected={connected} onClose={() => setDemo(false)} onConnect={onOpenConnections} onTryForReal={() => { setDemo(false); setPrefill(DEMO_PROMPT); }} onAdvance={followDemo} /></div>
        : <Starter team={team} onPick={setPrefill} onDemo={() => setDemo(true)} />}
    </div>
    <div className="session-dock">
      <Composer
        team={team}
        onTeamChange={changeTeam}
        connections={snapshot.connections}
        running={false}
        workspace=""
        onPickWorkspace={async () => {
          const sessionId = await requestProject({ team });
          if (sessionId) onStarted(sessionId);
        }}
        onSend={send}
        onOpenConnections={onOpenConnections}
        loopLabel=""
        prefill={prefill}
        onPrefillUsed={onPrefillUsed}
        autoFocus
      />
    </div>
  </section>;
}
