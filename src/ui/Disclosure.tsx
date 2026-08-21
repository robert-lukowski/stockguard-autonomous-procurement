import { ChevronRight } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId, useState, type ReactNode } from "react";

type Props = {
  label: string;
  children: ReactNode;
  /** Short hint about what is inside, shown next to the label. */
  hint?: string;
};

/**
 * Progressive disclosure for technical detail. The main narrative stays
 * readable; the architecture stays one keystroke away.
 */
export function Disclosure({ label, hint, children }: Props) {
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const panelId = useId();

  return (
    <div className="overflow-hidden rounded-xl border border-ground-700/45 bg-ground-950/40">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-ground-200 transition-colors hover:bg-ground-800/50"
      >
        <motion.span
          aria-hidden="true"
          animate={{ rotate: open ? 90 : 0 }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.18 }}
          className="text-ground-400"
        >
          <ChevronRight className="size-4" />
        </motion.span>
        {label}
        {hint && (
          <span className="ml-auto hidden text-xs font-normal text-ground-600 sm:inline">
            {hint}
          </span>
        )}
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={panelId}
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={
              reduceMotion
                ? { duration: 0 }
                : { duration: 0.24, ease: [0.2, 0.7, 0.25, 1] }
            }
            className="overflow-hidden"
          >
            <div className="border-t border-ground-700/40 px-4 py-4 text-sm leading-relaxed text-ground-400">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Monospace block for payloads, hashes and rule traces. */
export function CodeBlock({ children }: { children: ReactNode }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-lg border border-ground-700/40 bg-ground-950/70 p-3 font-mono text-[11.5px] leading-relaxed text-ground-300">
      {children}
    </pre>
  );
}
