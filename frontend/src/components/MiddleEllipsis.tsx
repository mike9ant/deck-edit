import clsx from 'clsx'
import { splitForMiddleEllipsis } from './fileOps'

/**
 * A file name shortened in the middle when space is short, keeping its end
 * and extension: "Acme — Board Rev…raft_3.pptx". Used by the file tree and the tabs.
 */
export function MiddleEllipsis({ name, className }: { name: string; className?: string }) {
  const [head, tail] = splitForMiddleEllipsis(name)
  return (
    <span className={clsx('flex min-w-0', className)}>
      <span className="truncate">{head}</span>
      {tail && <span className="shrink-0 whitespace-pre">{tail}</span>}
    </span>
  )
}
