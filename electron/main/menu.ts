import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import type { MenuCommand } from '../../shared/ipc';

export function buildMenu(getWin: () => BrowserWindow | null, recent: () => string[], openRecent: (p: string) => void) {
  const send = (cmd: MenuCommand) => () => {
    const w = getWin();
    if (w && !w.isDestroyed()) w.webContents.send('menu', cmd);
  };
  const recentItems: MenuItemConstructorOptions[] = recent().map((p) => ({ label: p.split('/').pop() ?? p, click: () => openRecent(p) }));
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: send('new') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { label: 'Open Recent', submenu: recentItems.length ? recentItems : [{ label: 'No Recent Projects', enabled: false }] },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: send('save-as') },
        { type: 'separator' },
        { label: 'Import Media…', accelerator: 'CmdOrCtrl+I', click: send('import') },
        { label: 'Record Screen…', accelerator: 'CmdOrCtrl+Shift+R', click: send('record') },
        { type: 'separator' },
        { label: 'Export Video…', accelerator: 'CmdOrCtrl+E', click: send('export') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: send('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: send('select-all') },
        { type: 'separator' },
        { label: 'Duplicate', accelerator: 'CmdOrCtrl+D', click: send('duplicate') },
        { label: 'Delete', accelerator: 'Backspace', registerAccelerator: false, click: send('delete') },
      ],
    },
    {
      label: 'Timeline',
      submenu: [
        { label: 'Play / Pause', accelerator: 'Space', registerAccelerator: false, click: send('play') },
        { label: 'Split at Playhead', accelerator: 'S', registerAccelerator: false, click: send('split') },
        { label: 'Insert Freeze Frame…', accelerator: 'F', registerAccelerator: false, click: send('freeze') },
        { type: 'separator' },
        { label: 'Cursor Mode', accelerator: 'K', registerAccelerator: false, click: send('cursor-mode') },
        { label: 'Add Click at Playhead', accelerator: 'C', registerAccelerator: false, click: send('add-click') },
        { label: 'Show Cursor Path', accelerator: 'P', registerAccelerator: false, click: send('toggle-path') },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: send('zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: send('zoom-out') },
        { label: 'Zoom to Fit', accelerator: 'Shift+Z', registerAccelerator: false, click: send('zoom-fit') },
      ],
    },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }, ...(app.isPackaged ? [] : ([{ role: 'toggleDevTools' }, { role: 'reload' }] as MenuItemConstructorOptions[]))] },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard Shortcuts', click: send('help') },
        { label: 'Screen Recording Permission…', click: () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
