import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { errorMessage, omni } from './api';
import { Composer } from './Composer';
import { Starter } from './Examples';
import { RunBlock } from './RunView';
import type { AIConnectionView, RunView, SessionView as Session, TeamConfig } from '../electron/shared';

export function SessionView({ session, connections, onNotify, onOpenConnections }: {
  session: Session;
  connections: AIConnectionView[];
  onNotify: (message: string, bad?: boolean) => void;
  onOpenConnections: () => void;
}) {
  const [runs, setRuns] = useState<RunView[]>([]);
  const [team, setTeam] = useState<TeamConfig>(session.team);
  const [pulses, setPulses] = useState<Record<string, string>>({});
  const [prefill, setPrefill] = useState('');
  const [workspaceMissing, setWorkspaceMissing] = useState(false);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const pendingTeam = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setRuns([]);
    void omni.runs(session.id).then((loaded) => { if (!cancelled) setRuns(loaded); }).catch(() => undefined);
    stickToBottom.current = true;
    return () => { cancelled = true; };
  }, [session.id]);

  useEffect(() => {
    if (pendingTeam.current) return;
    setTeam(session.team);
  }, [session.team]);

  useEffect(() => {
    void omni.pathExists(session.workspace).then((exists) => setWorkspaceMissing(!exists)).catch(() => undefined);
  }, [session.workspace]);

  useEffect(() => omni.onRun(({ sessionId, run }) => {
    if (sessionId !== session.id) return;
    setRuns((current) => {
      const index = current.findIndex((item) => item.id === run.id);
      if (index === -1) return [...current, run];
      const next = current.slice();
      next[index] = run;
      return next;
    });
  }), [session.id]);

  useEffect(() => omni.onPulse(({ sessionId, runId, pulseId }) => {
    if (sessionId !== session.id) return;
    setPulses((current) => ({ ...current, [runId]: pulseId }));
    window.setTimeout(() => setPulses((current) => (current[runId] === pulseId ? { ...current, [runId]: '' } : current)), 3_400);
  }), [session.id]);

  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (timeline && stickToBottom.current) timeline.scrollTop = timeline.scrollHeight;
  }, [runs]);

  const saveTeam = useCallback((next: TeamConfig) => {
    setTeam(next);
    window.clearTimeout(pendingTeam.current);
    pendingTeam.current = window.setTimeout(() => {
      pendingTeam.current = undefined;
      void omni.updateSession({ id: session.id, team: next }).catch((failure) => onNotify(errorMessage(failure), true));
    }, 150);
  }, [session.id, onNotify]);

  const changeFolder = async () => {
    const folder = await omni.chooseFolder(session.workspace);
    if (!folder) return;
    try {
      await omni.updateSession({ id: session.id, workspace: folder });
    } catch (failure) {
      onNotify(errorMessage(failure), true);
    }
  };

  const send = async (text: string, attachments: Array<{ path: string; name: string }>) => {
    if (workspaceMissing) throw new Error('This session’s workspace folder is missing. Use the folder button to choose it again.');
    if (pendingTeam.current) {
      window.clearTimeout(pendingTeam.current);
      pendingTeam.current = undefined;
      await omni.updateSession({ id: session.id, team });
    }
    stickToBottom.current = true;
    await omni.send(session.id, text, attachments);
  };

  const onPrefillUsed = useCallback(() => setPrefill(''), []);
  const latest = runs.at(-1);
  const workingAgents = session.running && latest
    ? latest.agents.filter((agent) => agent.status === 'working' || agent.status === 'queued').map(({ agentId, handle, provider }) => ({ agentId, handle, provider }))
    : [];

  return <section className="session">
    <div className="timeline" ref={timelineRef} onScroll={(event) => {
      const element = event.currentTarget;
      stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 140;
    }}>
      {runs.length ? <div className="timeline-inner">
        {runs.map((run) => <RunBlock run={run} workspace={session.workspace} pulseKey={pulses[run.id] ?? ''} connections={connections} key={run.id} />)}
      </div> : <Starter team={team} onPick={setPrefill} />}
    </div>
    <div className="session-dock">
      <Composer
        team={team}
        onTeamChange={saveTeam}
        connections={connections}
        running={session.running}
        workspace={session.workspace}
        workspaceMissing={workspaceMissing}
        workspaceLocked
        onPickWorkspace={changeFolder}
        onSend={send}
        onStop={() => omni.stop(session.id)}
        workingAgents={workingAgents}
        onStopAgent={(agentId) => omni.stopAgent(session.id, agentId)}
        onOpenConnections={onOpenConnections}
        loopLabel={session.loopLabel}
        prefill={prefill}
        onPrefillUsed={onPrefillUsed}
      />
    </div>
  </section>;
}
