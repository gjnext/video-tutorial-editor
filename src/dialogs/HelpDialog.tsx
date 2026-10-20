import { editor } from '../state/store';
import { Modal } from '../components/ui';

const SHORTCUTS: [string, string][] = [
  ['Play / pause', 'Space'],
  ['Previous / next frame', '← →'],
  ['Jump 1 second', '⇧← ⇧→'],
  ['Previous / next edit point', '↑ ↓'],
  ['Go to start / end', 'Home End'],
  ['Cursor mode (place cursor)', 'K'],
  ['Arrange mode', 'V'],
  ['Crop mode', 'R'],
  ['Add click at playhead', 'C'],
  ['Show / hide cursor path', 'P'],
  ['Split at playhead', 'S'],
  ['Insert freeze frame', 'F'],
  ['Delete selection', '⌫'],
  ['Duplicate', '⌘D'],
  ['Undo / redo', '⌘Z ⇧⌘Z'],
  ['Toggle snapping', 'N'],
  ['Zoom timeline', '⌘= ⌘− / pinch'],
  ['Fit timeline', '⇧Z'],
  ['Import media', '⌘I'],
  ['Record screen', '⇧⌘R'],
  ['Export', '⌘E'],
  ['Save / Save As', '⌘S ⇧⌘S'],
];

export function HelpDialog() {
  return (
    <Modal title="Keyboard shortcuts & workflow" onClose={() => editor().set({ dialog: null })} wide>
      <div className="shortcuts">
        {SHORTCUTS.map(([a, b]) => (
          <div key={a}>
            <span>{a}</span>
            <span className="kbd">{b}</span>
          </div>
        ))}
      </div>
      <div className="hint" style={{ lineHeight: 1.7 }}>
        <b>Synthetic cursor:</b> press K, move the playhead to when the cursor should arrive, and click the target in the preview. Repeat for each target — motion between points is generated
        automatically. Press C where the recorded UI reacts to add a click. Option-click places a point and a click together.
        <br />
        <b>Longer narration:</b> put the playhead where the scene should hold and press F to insert a freeze. The cursor and audio keep running.
      </div>
    </Modal>
  );
}
