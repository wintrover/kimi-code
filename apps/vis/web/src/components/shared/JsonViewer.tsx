import { useState, memo } from 'react';

interface JsonViewerProps {
  value: unknown;
  /** Default-open nesting depth */
  defaultOpenDepth?: number;
}

export function JsonViewer({ value, defaultOpenDepth = 2 }: JsonViewerProps) {
  return (
    <div className="font-mono text-[12px] leading-[1.5]">
      <Node value={value} depth={0} defaultOpenDepth={defaultOpenDepth} keyPath="" />
    </div>
  );
}

interface NodeProps {
  value: unknown;
  depth: number;
  defaultOpenDepth: number;
  keyPath: string;
  keyLabel?: string | number;
  isLast?: boolean;
}

const Node = memo(function Node({
  value,
  depth,
  defaultOpenDepth,
  keyPath,
  keyLabel,
  isLast,
}: NodeProps) {
  const [open, setOpen] = useState(depth < defaultOpenDepth);

  if (value === null)
    return <Leaf keyLabel={keyLabel} repr="null" color="text-fg-3" isLast={isLast} />;
  if (value === undefined)
    return <Leaf keyLabel={keyLabel} repr="undefined" color="text-fg-3" isLast={isLast} />;
  if (typeof value === 'boolean')
    return <Leaf keyLabel={keyLabel} repr={String(value)} color="text-[var(--color-cat-config)]" isLast={isLast} />;
  if (typeof value === 'number')
    return <Leaf keyLabel={keyLabel} repr={String(value)} color="text-[var(--color-sev-info)]" isLast={isLast} />;
  if (typeof value === 'string') {
    const short = value.length <= 200;
    return (
      <Leaf
        keyLabel={keyLabel}
        repr={short ? JSON.stringify(value) : `"${value.slice(0, 200)}…" (${value.length} chars)`}
        color="text-[var(--color-cat-ephemeral)]"
        isLast={isLast}
      />
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0)
      return <Leaf keyLabel={keyLabel} repr="[]" color="text-fg-3" isLast={isLast} />;
    return (
      <div>
        <button
          onClick={() =>{  setOpen((v) => !v); }}
          className="flex items-baseline gap-1 text-left hover:text-fg-0"
        >
          <span className="text-fg-3 w-3 shrink-0 inline-block">{open ? '▾' : '▸'}</span>
          {keyLabel !== undefined ? (
            <span className="text-fg-1">{keyLabel}</span>
          ) : null}
          {keyLabel !== undefined ? <span className="text-fg-3">:</span> : null}
          <span className="text-fg-3">
            [{value.length}]
          </span>
        </button>
        {open ? (
          <div className="border-l border-border ml-[5px] pl-3">
            {value.map((v, i) => (
              <Node
                key={i}
                value={v}
                depth={depth + 1}
                defaultOpenDepth={defaultOpenDepth}
                keyPath={`${keyPath}[${i}]`}
                keyLabel={i}
                isLast={i === value.length - 1}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0)
      return <Leaf keyLabel={keyLabel} repr="{}" color="text-fg-3" isLast={isLast} />;
    return (
      <div>
        <button
          onClick={() =>{  setOpen((v) => !v); }}
          className="flex items-baseline gap-1 text-left hover:text-fg-0"
        >
          <span className="text-fg-3 w-3 shrink-0 inline-block">{open ? '▾' : '▸'}</span>
          {keyLabel !== undefined ? (
            <span className="text-fg-1">{keyLabel}</span>
          ) : null}
          {keyLabel !== undefined ? <span className="text-fg-3">:</span> : null}
          <span className="text-fg-3">
            {'{'}
            {entries.length}
            {'}'}
          </span>
        </button>
        {open ? (
          <div className="border-l border-border ml-[5px] pl-3">
            {entries.map(([k, v], i) => (
              <Node
                key={k}
                value={v}
                depth={depth + 1}
                defaultOpenDepth={defaultOpenDepth}
                keyPath={`${keyPath}.${k}`}
                keyLabel={k}
                isLast={i === entries.length - 1}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  return <Leaf keyLabel={keyLabel} repr={typeof value} color="text-fg-3" isLast={isLast} />;
});

function Leaf({
  keyLabel,
  repr,
  color,
}: {
  keyLabel?: string | number;
  repr: string;
  color: string;
  isLast?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="w-3 shrink-0" />
      {keyLabel !== undefined ? (
        <>
          <span className="text-fg-1">{keyLabel}</span>
          <span className="text-fg-3">:</span>
        </>
      ) : null}
      <span className={color}>{repr}</span>
    </div>
  );
}
