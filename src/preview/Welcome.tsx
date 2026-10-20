import { useEffect, useState } from 'react';
import { Circle, FolderOpen, Upload } from 'lucide-react';
import { editor } from '../state/store';
import { importMedia, openProject } from '../state/actions';

export function Welcome() {
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    window.studio.project.recent().then(setRecent).catch(() => {});
  }, []);
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <h1>Create a product tutorial</h1>
        <p>
          Record your SaaS interface without the mouse pointer, add your ElevenLabs narration, then place a perfectly smooth synthetic cursor by
          clicking where it should go.
        </p>
        <div className="welcome-actions">
          <button className="welcome-action" onClick={() => editor().set({ dialog: 'record' })}>
            <Circle size={20} color="#ff6b6b" fill="#ff6b6b" />
            Record Screen
            <span>Window, display or region</span>
          </button>
          <button className="welcome-action" onClick={() => importMedia('any')}>
            <Upload size={20} />
            Import Video
            <span>MP4 / MOV — or drop files here</span>
          </button>
          <button className="welcome-action" onClick={() => openProject()}>
            <FolderOpen size={20} />
            Open Project
            <span>.tvproj package</span>
          </button>
        </div>
        <div className="welcome-steps">
          <span><b>1</b> Record</span>
          <span><b>2</b> Add narration</span>
          <span><b>3</b> Place cursor</span>
          <span><b>4</b> Style</span>
          <span><b>5</b> Export</span>
        </div>
        {recent.length > 0 && (
          <div className="recent-list">
            <div className="media-group-title" style={{ padding: '0 8px 4px' }}>Recent projects</div>
            {recent.slice(0, 5).map((p) => (
              <button key={p} onClick={() => openProject(p)} title={p}>
                {p.split('/').pop()}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
