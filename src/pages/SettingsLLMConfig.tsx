import { LLMConfigPanel } from "@/components/core/llm-config";
import { useViewTransition } from "@/components/core/view-transition";

export default function SettingsLLMConfigPage() {
  const { navigate } = useViewTransition();

  const handleSaveSuccess = () => {
    navigate("/settings", { type: "slide-right", duration: 300 });
  };

  return <LLMConfigPanel showBackButton onSaveSuccess={handleSaveSuccess} />;
}
