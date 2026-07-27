export function MissionSearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <div className="relative">
      <input
        type="search"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        placeholder="Search by package, repo, or advisory id"
        aria-label="Search missions"
        className="border-border bg-surface text-ink placeholder:text-ink-muted focus-visible:outline-accent w-full rounded-sm border px-3 py-1.5 pr-8 font-mono text-sm"
      />
      {value !== "" && (
        <button
          type="button"
          onClick={() => {
            onChange("");
          }}
          aria-label="Clear search"
          className="text-ink-muted hover:text-ink absolute inset-y-0 right-2 font-mono text-sm"
        >
          ×
        </button>
      )}
    </div>
  );
}
