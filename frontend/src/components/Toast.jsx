import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export default function Toast({ message, onClose, duration = 4000 }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onClose, duration);
    return () => clearTimeout(t);
  }, [message, duration, onClose]);

  return (
    <AnimatePresence>
      {message && (
        <motion.div
          initial={{ y: -24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -24, opacity: 0 }}
          className="fixed top-4 left-1/2 -translate-x-1/2 z-50 card !py-3 !px-4 flex items-center gap-3 max-w-md"
          role="status"
        >
          <span className="text-xl">✨</span>
          <span className="text-white">{message}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
