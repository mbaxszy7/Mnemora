import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";

const slogans = ["Remember everything.", "Memory, amplified.", "Pixels to memory"];

export default function SplashScreen() {
  const [currentSloganIndex, setCurrentSloganIndex] = useState(0);
  const navigate = useNavigate();

  // Detect prefers-reduced-motion
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(mediaQuery.matches);

    const handleChange = (e: MediaQueryListEvent) => {
      setPrefersReducedMotion(e.matches);
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  // Slogan rotation effect
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentSloganIndex((prev) => (prev + 1) % slogans.length);
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  // Auto-navigation after 15 seconds
  useEffect(() => {
    const timer = setTimeout(() => {
      navigate("/");
    }, 15000);

    return () => clearTimeout(timer);
  }, [navigate]);
  return (
    <motion.div
      initial={{ opacity: 1 }}
      exit={{ opacity: prefersReducedMotion ? 1 : 0 }}
      transition={{ duration: prefersReducedMotion ? 0 : 0.5 }}
      className="fixed inset-0 flex flex-col items-center justify-start bg-[#F8FAFC] pt-[120px]"
    >
      {/* Logo with animation */}
      <motion.div
        initial={prefersReducedMotion ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: prefersReducedMotion ? 0 : 1 }}
        className="mb-8"
        role="img"
        aria-label="Mnemora logo"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 512 260"
          fill="none"
          className="w-64 h-auto"
        >
          <defs>
            <linearGradient id="neural_gradient_splash" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#6366F1" />
              <stop offset="50%" stopColor="#8B5CF6" />
              <stop offset="100%" stopColor="#06B6D4" />
            </linearGradient>
          </defs>
          <path
            d="M 100 380 V 200 C 100 100, 220 100, 256 220 C 292 100, 412 100, 412 200 V 380"
            stroke="url(#neural_gradient_splash)"
            strokeWidth="56"
            strokeLinecap="round"
            strokeLinejoin="round"
            transform="translate(0, -100)"
          />
          <circle cx="256" cy="50" r="32" fill="#06B6D4" />
        </svg>
      </motion.div>

      {/* Brand Name */}
      <h1 className="text-[#0F172A] text-[64px] font-bold tracking-tight text-center font-sans">
        Mnemora
      </h1>

      {/* Slogan Carousel */}
      <div className="relative h-12 mt-8 flex items-center justify-center">
        <AnimatePresence mode="wait">
          <motion.p
            key={currentSloganIndex}
            initial={prefersReducedMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={prefersReducedMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: -20 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.6 }}
            className="absolute text-[#64748B] text-base  text-center whitespace-nowrap"
          >
            {slogans[currentSloganIndex]}
          </motion.p>
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
