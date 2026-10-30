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
      <p className="mb-1 uppercase text-ink-muted">{label}</p>
      <ul className="flex flex-col gap-0.5 text-ink">
        {items.map((item) => (
          <li key={item.key}>
            {item.key}: {item.value}
          </li>
        ))}
      </ul>
    </div>
  );
}
