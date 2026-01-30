import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useMemo, type AnchorHTMLAttributes, type HTMLAttributes } from "react";

interface MarkdownContentProps {
  content: string;
  /**
   * Variant controls spacing density:
   * - "default": Standard spacing for summary panels
   * - "compact": Tighter spacing for event card details
   */
  variant?: "default" | "compact";
}

export function MarkdownContent({ content, variant = "default" }: MarkdownContentProps) {
  const isCompact = variant === "compact";

  const components = useMemo(() => {
    return {
      h2: ({ children }: HTMLAttributes<HTMLHeadingElement>) => (
        <h3
          className={`font-semibold first:mt-0 flex items-center gap-2 text-foreground ${
            isCompact ? "text-lg mt-4 mb-2" : "text-lg mt-6 mb-3"
          }`}
        >
          {children}
        </h3>
      ),
      h3: ({ children }: HTMLAttributes<HTMLHeadingElement>) => (
        <h4
          className={`font-medium text-muted-foreground ${
            isCompact ? "text-base mt-3 mb-1.5" : "text-base mt-4 mb-2"
          }`}
        >
          {children}
        </h4>
      ),
      ul: ({ children }: HTMLAttributes<HTMLUListElement>) => (
        <ul className={`${isCompact ? "space-y-1 mb-3" : "space-y-1.5 mb-4"} last:mb-0`}>
          {children}
        </ul>
      ),
      li: ({ children }: HTMLAttributes<HTMLLIElement>) => {
        // Use a fixed height for the bullet container that matches the text's line-height (1.25rem for text-sm)
        // to ensure perfect vertical centering with the first line.
        return (
          <li className="text-base text-muted-foreground flex items-start gap-2 last:mb-0">
            <span className="text-primary shrink-0 select-none flex items-center justify-center w-1.5 h-5">
              •
            </span>
            <span className="flex-1 min-w-0 leading-relaxed">{children}</span>
          </li>
        );
      },
      p: ({ children }: HTMLAttributes<HTMLParagraphElement>) => (
        <p className={`text-base text-muted-foreground ${isCompact ? "my-1.5" : "my-2"} last:mb-0`}>
          {children}
        </p>
      ),
      a: ({ href, children }: AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <a
          href={href}
          className="text-primary hover:underline"
          target="_blank"
          rel="noopener noreferrer"
        >
          {children}
        </a>
      ),
      code: ({ className, children, ...props }: HTMLAttributes<HTMLElement>) => {
        const match = /language-(\w+)/.exec(className || "");
        const codeString = String(children).replace(/\n$/, "");

        // If there's a language class, it's a code block
        if (match) {
          const language = match[1];
          return (
            <SyntaxHighlighter
              style={oneDark}
              language={language}
              PreTag="div"
              className={`rounded-lg text-base ${isCompact ? "my-2!" : "my-3!"}`}
              customStyle={{
                margin: 0,
                padding: isCompact ? "0.75rem" : "1rem",
                fontSize: "1rem",
              }}
            >
              {codeString}
            </SyntaxHighlighter>
          );
        }

        // Inline code (no language class)
        return (
          <code
            className={`rounded bg-secondary text-base font-mono ${
              isCompact ? "px-1 py-0.5" : "px-1.5 py-0.5"
            }`}
            {...props}
          >
            {children}
          </code>
        );
      },
    };
  }, [isCompact]);

  return <ReactMarkdown components={components}>{content}</ReactMarkdown>;
}
