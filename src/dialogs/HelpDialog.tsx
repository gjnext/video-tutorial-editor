import { editor } from '../state/store';
import { Modal } from '../components/ui';

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'Playback & navigation',
    items: [
      ['Play / pause', 'Space'],
      ['Previous / next frame', '← →'],
      ['Back / forward 1 second', '⇧← ⇧→'],
      ['Previous / next edit point', '↑ ↓'],
      ['Go to start / end', 'Home  End'],
      ['Theater view (bigger preview)', 'T'],
      ['Play full screen (closes at the end)', '⇧F'],
      ['Close theater / full screen', 'Esc'],
    ],
  },
  {
    title: 'Cursor',
    items: [
      ['Cursor mode — click the video to place points', 'K'],
      ['Place a point and a click together', '⌥ + click'],
      ['Add click at playhead', 'C'],
      ['Add double click at playhead', '⇧C'],
      ['Show cursor here (starts a segment)', '['],
      ['Hide cursor here (ends the segment)', ']'],
      ['Show / hide cursor path', 'P'],
    ],
  },
  {
    title: 'Highlights & layout',
    items: [
      ['Highlight mode — drag on the video', 'H'],
      ['Arrange mode (move the recording)', 'V'],
      ['Crop mode', 'R'],
      ['Leave current mode / deselect', 'Esc'],
    ],
  },
  {
    title: 'Timeline editing',
    items: [
      ['Split at playhead', 'S'],
      ['Insert freeze frame', 'F'],
      ['Delete selection', '⌫'],
      ['Duplicate', '⌘D'],
      ['Select all of the same kind', '⌘A'],
      ['Undo / redo', '⌘Z  ⇧⌘Z'],
      ['Toggle snapping', 'N'],
      ['Zoom timeline', '⌘=  ⌘−  or pinch'],
      ['Fit timeline', '⇧Z'],
      ['Reorder clips / swap audio', 'drag'],
    ],
  },
  {
    title: 'Project',
    items: [
      ['Record screen', '⇧⌘R'],
      ['Import media', '⌘I'],
      ['Export video', '⌘E'],
      ['Save / Save As', '⌘S  ⇧⌘S'],
      ['Open project', '⌘O'],
      ['This sheet', '?'],
    ],
  },
];

export function HelpDialog() {
  return (
    <Modal title="Keyboard shortcuts" onClose={() => editor().set({ dialog: null })} wide>
      <div className="shortcut-groups">
        {GROUPS.map((g) => (
          <div key={g.title} className="shortcut-group">
            <div className="section-title">{g.title}</div>
            {g.items.map(([a, b]) => (
              <div key={a} className="shortcut-row">
                <span>{a}</span>
                <span className="kbd">{b}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="hint" style={{ lineHeight: 1.7 }}>
        <b>Cursor:</b> press K, put the playhead where the cursor should arrive and click the target. Each Show → Hide stretch is its own segment: the cursor appears at
        the segment's first point and never travels across hidden time. Press C where the recorded UI reacts to add a click.
        <br />
        <b>Highlights:</b> press H, pick a shape and style above the preview, and drag over the element. Several spotlights merge into one bright area.
        <br />
        <b>Longer narration:</b> put the playhead where the scene should hold and press F.
      </div>
    </Modal>
  );
}
