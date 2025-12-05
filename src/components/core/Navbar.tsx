import { Brain, Home, Settings, Info, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { TransitionNavLink } from "@/components/core/view-transition";

const navItems = [
  { to: "/", label: "Home", icon: Home },
  { to: "/vlm-demo", label: "VLM Demo", icon: Sparkles },
  { to: "/settings", label: "Settings", icon: Settings },
  { to: "/about", label: "About", icon: Info },
];

export function Navbar() {
  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60">
      <div className="container flex h-14 items-center">
        <div className="flex items-center gap-2 mr-8">
          <Brain className="h-6 w-6 text-primary" />
          <span className="font-bold">Mnemora</span>
        </div>
        <nav className="flex items-center gap-1">
          {navItems.map(({ to, label, icon: Icon }) => (
            <TransitionNavLink
              key={to}
              to={to}
              end={to === "/"}
              type="fade"
              duration={160}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent"
                )
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </TransitionNavLink>
          ))}
        </nav>
      </div>
    </header>
  );
}
