import { Info } from "lucide-react";

export type SelectionHintType = "screens" | "apps";

export interface SelectionHintProps {
  type: SelectionHintType;
  isVisible: boolean;
}

/**
 * SelectionHint component displays a hint message when no items are selected,
 * indicating that all screens/apps will be captured.
 *
 * Requirements: 6.1, 6.2
 */
export function SelectionHint({ type, isVisible }: SelectionHintProps) {
  if (!isVisible) {
    return null;
  }

  const message =
    type === "screens" ? "All screens will be captured" : "All applications will be captured";

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-md p-3">
      <Info className="h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
