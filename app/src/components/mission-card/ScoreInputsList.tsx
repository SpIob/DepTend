"use client";

export function ScoreInputsList({
  label,
  items,
}: {
  label: string;
  items: { key: string; value: string }[];
}): React.JSX.Element {
  return (
    <div>
      <p className="text-ink-muted mb-1 uppercase">{label}</p>
      <ul className="text-ink flex flex-col gap-0.5">
        {items.map((item) => (
          <li key={item.key}>
            {item.key}: {item.value}
          </li>
        ))}
      </ul>
    </div>
  );
}
