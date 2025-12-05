import { LLMConfigPanel } from "@/components/core/llm-config";
import { useViewTransition } from "@/components/core/view-transition";

export default function LLMConfigPage() {
  const { navigate } = useViewTransition();

  const handleSaveSuccess = () => {
    navigate("/", { type: "fade", duration: 300 });
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-8">
      <LLMConfigPanel onSaveSuccess={handleSaveSuccess} />
    </div>
  );
}
