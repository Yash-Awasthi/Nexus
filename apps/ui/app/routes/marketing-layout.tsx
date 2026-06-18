import { Outlet, useLocation } from "react-router";
import { Navbar } from "~/components/navbar";
import { Footer } from "~/components/footer";
import { CursorGlow } from "~/components/animations";
import { motion, AnimatePresence } from "framer-motion";

const pageVariants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.23, 1, 0.32, 1] } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.2, ease: "easeIn" } },
};

export default function MarketingLayout() {
  const location = useLocation();
  return (
    <div className="min-h-screen flex flex-col">
      <CursorGlow />
      <Navbar />
      <main className="flex-1">
        <AnimatePresence mode="wait">
          <motion.div key={location.pathname} variants={pageVariants} initial="initial" animate="animate" exit="exit">
            <Outlet />
          </motion.div>
        </AnimatePresence>
      </main>
      <Footer />
    </div>
  );
}
