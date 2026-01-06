import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

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

  return (
    <ReactMarkdown
      components={{
        h2: ({ children }) => (
          <h3
            className={`font-semibold first:mt-0 flex items-center gap-2 text-foreground ${
              isCompact ? "text-base mt-4 mb-2" : "text-base mt-6 mb-3"
            }`}
          >
            {children}
          </h3>
        ),
        h3: ({ children }) => (
          <h4
            className={`font-medium text-muted-foreground ${
              isCompact ? "text-sm mt-3 mb-1.5" : "text-sm mt-4 mb-2"
            }`}
          >
            {children}
          </h4>
        ),
        ul: ({ children }) => (
          <ul className={`${isCompact ? "space-y-1 mb-3" : "space-y-1.5 mb-4"} last:mb-0`}>
            {children}
          </ul>
        ),
        li: ({ children }) => (
          <li className="text-sm text-muted-foreground flex items-start gap-2 last:mb-0">
            <span className="text-primary leading-relaxed shrink-0 select-none mt-0.5">•</span>
            <span className="flex-1 min-w-0">{children}</span>
          </li>
        ),
        p: ({ children }) => (
          <p className={`text-sm text-muted-foreground ${isCompact ? "my-1.5" : "my-2"} last:mb-0`}>
            {children}
          </p>
        ),
        a: ({ href, children }) => (
          <a
            href={href}
            className="text-primary hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            {children}
          </a>
        ),
        code: ({ className, children, ...props }) => {
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
                className={`rounded-lg text-xs ${isCompact ? "my-2!" : "my-3!"}`}
                customStyle={{
                  margin: 0,
                  padding: isCompact ? "0.75rem" : "1rem",
                  fontSize: isCompact ? "0.7rem" : "0.75rem",
                }}
              >
                {codeString}
              </SyntaxHighlighter>
            );
          }

          // Inline code (no language class)
          return (
            <code
              className={`rounded bg-secondary text-xs font-mono ${
                isCompact ? "px-1 py-0.5" : "px-1.5 py-0.5"
              }`}
              {...props}
            >
              {children}
            </code>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
