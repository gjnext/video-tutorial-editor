import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { useEditor } from '../state/store';

// ------------------------------------------------------------ tooltip

let tipTimer: ReturnType<typeof setTimeout> | null = null;
const tipListeners = new Set<(t: TipState | null) => void>();
interface TipState {
  text: string;
  shortcut?: string;
  x: number;
  y: number;
}
function showTip(t: TipState | null) {
  for (const l of tipListeners) l(t);
}

export function TooltipLayer() {
  const [tip, setTip] = useState<TipState | null>(null);
  useEffect(() => {
    tipListeners.add(setTip);
    return () => void tipListeners.delete(setTip);
  }, []);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!tip || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    let left = tip.x - r.width / 2;
    left = Math.max(6, Math.min(window.innerWidth - r.width - 6, left));
    let top = tip.y + 8;
    if (top + r.height > window.innerHeight - 6) top = tip.y - r.height - 36;
    setPos({ left, top });
  }, [tip]);
  if (!tip) return null;
  return createPortal(
    <div ref={ref} className="tooltip" style={pos}>
      {tip.text}
      {tip.shortcut && <span className="kbd">{tip.shortcut}</span>}
    </div>,
    document.body,
  );
}

export function useTooltip(text?: string, shortcut?: string) {
  return {
    onMouseEnter: (e: React.MouseEvent) => {
      if (!text) return;
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      if (tipTimer) clearTimeout(tipTimer);
      tipTimer = setTimeout(() => showTip({ text, shortcut, x: r.left + r.width / 2, y: r.bottom }), 450);
    },
    onMouseLeave: () => {
      if (tipTimer) clearTimeout(tipTimer);
      showTip(null);
    },
    onMouseDown: () => {
      if (tipTimer) clearTimeout(tipTimer);
      showTip(null);
    },
  };
}

// ------------------------------------------------------------ buttons

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tip?: string;
  shortcut?: string;
  variant?: 'primary' | 'ghost' | 'danger' | 'record';
  size?: 'small';
  icon?: boolean;
  active?: boolean;
};

export function Button({ tip, shortcut, variant, size, icon, active, className, children, ...rest }: BtnProps) {
  const t = useTooltip(tip, shortcut);
  const cls = ['btn', variant, size, icon ? 'icon' : '', active ? 'active' : '', className].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} {...t} {...rest} aria-pressed={active ?? undefined}>
      {children}
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, small }: { value: T; options: { value: T; label: ReactNode; tip?: string }[]; onChange: (v: T) => void; small?: boolean }) {
  return (
    <div className={`segmented ${small ? 'small' : ''}`} role="group">
      {options.map((o) => (
        <SegButton key={o.value} pressed={o.value === value} tip={o.tip} onClick={() => onChange(o.value)}>
          {o.label}
        </SegButton>
      ))}
    </div>
  );
}
function SegButton({ pressed, tip, onClick, children }: { pressed: boolean; tip?: string; onClick: () => void; children: ReactNode }) {
  const t = useTooltip(tip);
  return (
    <button type="button" aria-pressed={pressed} onClick={onClick} {...t}>
      {children}
    </button>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button type="button" role="switch" aria-label={label} aria-checked={checked} className="toggle" onClick={() => onChange(!checked)} />;
}

// ------------------------------------------------------------ number field (type or drag-scrub)

export function NumberField({
  value,
  onChange,
  onCommit,
  onBegin,
  step = 1,
  min = -Infinity,
  max = Infinity,
  precision = 2,
  unit,
  display,
  parse,
  width,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  onCommit?: () => void;
  onBegin?: () => void;
  step?: number;
  min?: number;
  max?: number;
  precision?: number;
  unit?: string;
  display?: (v: number) => string;
  parse?: (s: string) => number | null;
  width?: number;
  disabled?: boolean;
}) {
  const [text, setText] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const shown = display ? display(value) : Number.isFinite(value) ? value.toFixed(precision) : '';
  const drag = useRef<{ x: number; v: number; moved: boolean } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLInputElement>) => {
    if (disabled || document.activeElement === ref.current) return;
    e.preventDefault();
    drag.current = { x: e.clientX, v: value, moved: false };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 3) return;
    if (!d.moved) {
      d.moved = true;
      onBegin?.();
    }
    const mul = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    onChange(clamp(d.v + Math.round(dx / 2) * step * mul));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) onCommit?.();
    else {
      ref.current?.focus();
      ref.current?.select();
    }
  };
  const commitText = () => {
    if (text == null) return;
    const v = parse ? parse(text) : parseFloat(text);
    setText(null);
    if (v != null && Number.isFinite(v)) {
      onBegin?.();
      onChange(clamp(v));
      onCommit?.();
    }
  };
  return (
    <div className="numfield" style={width ? { width, flex: 'none' } : undefined}>
      <input
        ref={ref}
        className="input num"
        disabled={disabled}
        value={text ?? shown}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setText(shown)}
        onBlur={commitText}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setText(null);
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            onBegin?.();
            onChange(clamp(value + d));
            onCommit?.();
            setText(null);
          }
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      {unit && <span className="unit">{unit}</span>}
    </div>
  );
}

export function Slider({ value, min, max, step = 0.01, onChange, onBegin, onCommit }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; onBegin?: () => void; onCommit?: () => void }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      style={{ ['--fill' as string]: `${Math.max(0, Math.min(100, pct))}%` }}
      onPointerDown={() => onBegin?.()}
      onPointerUp={() => onCommit?.()}
      onKeyDown={(e) => e.stopPropagation()}
      onChange={(e) => onChange(parseFloat(e.target.value))}
    />
  );
}

/** Slider + number box sharing one gesture → one undo step. */
export function SliderField(props: { label: string; value: number; min: number; max: number; step?: number; precision?: number; unit?: string; scale?: number; onChange: (v: number) => void }) {
  const { beginGesture, endGesture } = useEditor.getState();
  const scale = props.scale ?? 1;
  return (
    <div className="field">
      <label>{props.label}</label>
      <div className="slider-row">
        <Slider value={props.value} min={props.min} max={props.max} step={props.step} onBegin={beginGesture} onCommit={endGesture} onChange={props.onChange} />
        <NumberField
          width={64}
          value={props.value * scale}
          step={(props.step ?? 0.01) * scale}
          min={props.min * scale}
          max={props.max * scale}
          precision={props.precision ?? 0}
          unit={props.unit}
          onBegin={beginGesture}
          onCommit={endGesture}
          onChange={(v) => props.onChange(v / scale)}
        />
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      <div className="field-row">{children}</div>
    </div>
  );
}

export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="section">
      <div className="section-title">
        <span>{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

export function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <span className="color-swatch" style={{ background: value }}>
      <input type="color" value={value.length === 7 ? value : '#000000'} onChange={(e) => onChange(e.target.value)} />
    </span>
  );
}

export function Warning({ children }: { children: ReactNode }) {
  return (
    <div className="warning">
      <AlertTriangle size={13} />
      <span>{children}</span>
    </div>
  );
}

// ------------------------------------------------------------ context menu

export interface MenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  run?: () => void;
  separator?: boolean;
}

const MenuCtx = createContext<(e: { clientX: number; clientY: number }, items: MenuItem[]) => void>(() => {});
export const useContextMenu = () => useContext(MenuCtx);

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const open = useCallback((e: { clientX: number; clientY: number }, items: MenuItem[]) => setMenu({ x: e.clientX, y: e.clientY, items }), []);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ left: Math.min(menu.x, window.innerWidth - r.width - 6), top: Math.min(menu.y, window.innerHeight - r.height - 6) });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menu]);
  return (
    <MenuCtx.Provider value={open}>
      {children}
      {menu &&
        createPortal(
          <div ref={ref} className="context-menu" style={pos} onPointerDown={(e) => e.stopPropagation()}>
            {menu.items.map((it, i) =>
              it.separator ? (
                <hr key={i} />
              ) : (
                <button
                  key={i}
                  disabled={it.disabled}
                  style={it.danger ? { color: 'var(--danger)' } : undefined}
                  onClick={() => {
                    setMenu(null);
                    it.run?.();
                  }}
                >
                  <span>{it.label}</span>
                  {it.shortcut && <span className="shortcut">{it.shortcut}</span>}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </MenuCtx.Provider>
  );
}

// ------------------------------------------------------------ toasts

export function Toasts() {
  const toasts = useEditor((s) => s.toasts);
  const dismiss = useEditor((s) => s.dismissToast);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'error' ? <AlertTriangle size={15} color="var(--danger)" /> : t.kind === 'success' ? <CheckCircle2 size={15} color="var(--success)" /> : <Info size={15} color="var(--accent-text)" />}
          <span className="msg">{t.message}</span>
          {t.action && (
            <Button size="small" onClick={() => { t.action!.run(); dismiss(t.id); }}>
              {t.action.label}
            </Button>
          )}
          <Button variant="ghost" icon size="small" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X size={12} />
          </Button>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------ modal

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose?: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onClose) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" onKeyDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{title}</span>
          {onClose && (
            <Button variant="ghost" icon size="small" onClick={onClose} aria-label="Close">
              <X size={14} />
            </Button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
