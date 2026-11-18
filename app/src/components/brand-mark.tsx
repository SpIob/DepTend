import Link from "next/link";

/**
 * Project wordmark. A small accent-color square plus the project name in
 * mono. Used in the page header on every route; keeping it as one
 * component is the only way a designer changing its size or weight
 * actually changes it everywhere at once (previously hand-copied in
 * four page files, with the usual drift risk).
 *
 * `href` opts into a Link wrapper (default: bare wordmark, used on the
 * landing page where the header already lives inside the home route).
 */
export function BrandMark({ href }: { href?: string }): React.JSX.Element {
  const content = (
    <>
      <span className="bg-accent inline-block h-2.5 w-2.5" aria-hidden="true" />
      <span className="text-ink font-mono text-xl font-bold tracking-tight">DepTend</span>
    </>
  );
  if (href === undefined) {
    return <span className="flex items-center gap-2">{content}</span>;
  }
  return (
    <Link href={href} className="flex items-center gap-2">
      {content}
    </Link>
  );
}
