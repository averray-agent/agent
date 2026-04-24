"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * Renders a GitHub issue body as markdown. Tailored to the noise we see
 * in real issue bodies:
 *   - shields.io / img.shields.io badges are dropped entirely (they're
 *     decorative and render as 90px pills that blow out the layout)
 *   - other inline images are replaced with a compact `[image: alt]`
 *     token so we don't pull remote assets into the control room
 *   - links open in a new tab with rel=noopener
 *   - headings, blockquotes, lists, code fences and task lists are
 *     typographically tamed so a 4-paragraph body doesn't overwhelm
 *     the 420px-wide tab
 *
 * Kept small and dependency-surface-minimal: react-markdown + remark-gfm
 * cover GitHub-flavoured markdown (tables, task lists, strikethrough,
 * autolinks) without adding a full rehype/sanitize pipeline. We don't
 * render raw HTML, so the default sanitisation is sufficient.
 */
export function IssueMarkdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={cn("avy-md", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Drop shields.io / img.shields.io badges — they're pure
          // decoration and their fixed pixel widths blow out narrow
          // columns. Surface other images as a compact placeholder so
          // we don't fetch remote assets from inside the control room.
          img: ({ src, alt }) => {
            const href = typeof src === "string" ? src : "";
            if (/(?:img\.)?shields\.io/i.test(href)) return null;
            return (
              <span
                className="inline-block rounded border border-[var(--avy-line)] bg-[color:rgba(17,19,21,0.04)] px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]"
                style={{ letterSpacing: 0 }}
              >
                [image{alt ? `: ${alt}` : ""}]
              </span>
            );
          },
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[var(--avy-accent)] underline decoration-[color:rgba(30,102,66,0.35)] underline-offset-2 hover:decoration-[var(--avy-accent)]"
            >
              {children}
            </a>
          ),
          p: ({ children }) => (
            <p className="mb-2.5 last:mb-0">{children}</p>
          ),
          h1: ({ children }) => (
            <h3 className="mt-4 mb-1.5 font-[family-name:var(--font-display)] text-[13.5px] font-bold leading-[1.3] text-[var(--avy-ink)]">
              {children}
            </h3>
          ),
          h2: ({ children }) => (
            <h4 className="mt-3.5 mb-1 font-[family-name:var(--font-display)] text-[12.5px] font-bold leading-[1.3] text-[var(--avy-ink)]">
              {children}
            </h4>
          ),
          h3: ({ children }) => (
            <h5 className="mt-3 mb-1 font-[family-name:var(--font-display)] text-[12px] font-bold uppercase leading-[1.3] text-[var(--avy-muted)]"
              style={{ letterSpacing: "0.08em" }}
            >
              {children}
            </h5>
          ),
          ul: ({ children }) => (
            <ul className="mb-2.5 ml-4 list-disc space-y-0.5 marker:text-[var(--avy-accent)]">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-2.5 ml-4 list-decimal space-y-0.5">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-[1.5]">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="mb-2.5 border-l-[3px] border-[color:rgba(30,102,66,0.25)] bg-[color:rgba(30,102,66,0.04)] py-1 pl-3 pr-2 text-[var(--avy-muted)]">
              {children}
            </blockquote>
          ),
          code: ({ className, children }) => {
            const inline = !className;
            if (inline) {
              return (
                <code
                  className="rounded bg-[color:rgba(17,19,21,0.06)] px-1 py-px font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)]"
                  style={{ letterSpacing: 0 }}
                >
                  {children}
                </code>
              );
            }
            return (
              <code
                className={cn(
                  className,
                  "font-[family-name:var(--font-mono)] text-[11.5px] leading-[1.55]"
                )}
                style={{ letterSpacing: 0 }}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre
              className="mb-2.5 overflow-x-auto rounded-[6px] border border-[var(--avy-line)] bg-[#131715] px-3 py-2 text-[#e7ebe5]"
              style={{ letterSpacing: 0 }}
            >
              {children}
            </pre>
          ),
          hr: () => (
            <hr className="my-3 border-0 border-t border-[var(--avy-line-soft)]" />
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-[var(--avy-ink)]">
              {children}
            </strong>
          ),
          em: ({ children }) => (
            <em className="italic text-[var(--avy-ink)]">{children}</em>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

// Typed re-export so consumers don't need to know about the wrapper shape.
export type IssueMarkdownProps = {
  children: string;
  className?: string;
};

// Utility for tests / debugging — strips the markdown of known-noisy
// image refs without rendering. Not exported right now but useful for
// future server-side summarisation.
export function stripShieldsIoImages(markdown: string): string {
  return markdown.replace(
    /!\[[^\]]*\]\(https?:\/\/(?:img\.)?shields\.io[^)]*\)\s*/gi,
    ""
  );
}

// Back-compat helper for callers that want a plain ReactNode fallback
// when the markdown is empty.
export function renderIssueBody(body: string | undefined): ReactNode {
  if (!body || !body.trim()) return null;
  return <IssueMarkdown>{body}</IssueMarkdown>;
}
