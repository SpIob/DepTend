function SearchIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      className="text-ink-muted pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
    >
      <circle cx="6.5" cy="6.5" r="4.5" />
      <path d="M13 13L10 10" strokeLinecap="round" />
    </svg>
  );
}

export function MissionSearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <div className="relative">
      <SearchIcon />
      <input
        type="search"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        placeholder="Search package, repo, or advisory"
        aria-label="Search missions"
        className="border-border bg-surface text-ink placeholder:text-ink-muted focus-visible:outline-accent w-full rounded-md border py-1.5 pl-8 pr-8 font-mono text-sm"
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
