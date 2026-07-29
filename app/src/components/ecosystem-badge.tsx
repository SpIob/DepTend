import type { Ecosystem } from "@deptend/core/db/schema.js";
import { Tag } from "./tag";

const ECOSYSTEM_STYLES: Record<Ecosystem, { className: string; label: string }> = {
  npm: { className: "bg-ecosystem-npm/10 text-ecosystem-npm", label: "npm" },
  pypi: { className: "bg-ecosystem-pypi/10 text-ecosystem-pypi", label: "PyPI" },
  go: { className: "bg-ecosystem-go/10 text-ecosystem-go", label: "Go" },
};

export function EcosystemBadge({ ecosystem }: { ecosystem: Ecosystem }): React.JSX.Element {
  const style = ECOSYSTEM_STYLES[ecosystem];
  return <Tag className={style.className}>{style.label}</Tag>;
}
