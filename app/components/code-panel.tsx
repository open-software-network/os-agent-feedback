import { cn } from "../lib/utils";

export interface CodePanelProps {
  filename: string;
  code: string;
  className?: string;
}

/**
 * Dark code surface with a small title bar. Comment tails are dimmed with a
 * one-pass split so the panel reads like an editor without shipping a
 * syntax-highlighting runtime to the client.
 */
export function CodePanel({ filename, code, className }: CodePanelProps) {
  const lines = code.split("\n");

  return (
    <div
      className={cn(
        "code-surface overflow-hidden rounded-xl shadow-lg shadow-zinc-950/10",
        className,
      )}
    >
      <div className="code-rule flex items-center gap-3 border-b px-4 py-3">
        <span className="flex items-center gap-1.5" aria-hidden="true">
          <span className="size-2 rounded-full bg-white/15" />
          <span className="size-2 rounded-full bg-white/15" />
          <span className="size-2 rounded-full bg-white/15" />
        </span>
        <span className="font-mono text-xs text-zinc-400">{filename}</span>
      </div>
      <pre className="overflow-x-auto px-5 py-4 font-mono text-[13px] leading-[1.6]">
        <code>
          {lines.map((line, index) => {
            const commentAt = line.indexOf("//");
            const head = commentAt === -1 ? line : line.slice(0, commentAt);
            const comment = commentAt === -1 ? "" : line.slice(commentAt);

            return (
              <span className="block" key={`${index}:${line}`}>
                {line === "" ? " " : head}
                {comment ? (
                  <span className="text-zinc-500">{comment}</span>
                ) : null}
              </span>
            );
          })}
        </code>
      </pre>
    </div>
  );
}
