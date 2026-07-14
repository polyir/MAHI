import { useEffect, useRef } from "react";

// 60 pre-scaled frames of the MAHI medallion animation, bundled by Vite.
const frameModules = import.meta.glob("../assets/fish-frames/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const FRAMES = Object.keys(frameModules)
  .sort()
  .map((k) => frameModules[k]);

export default function FishLoader({ size = 72 }: { size?: number }) {
  const imgRef = useRef<HTMLImageElement>(null);
  const raf = useRef<number>(0);
  const last = useRef(0);
  const frame = useRef(0);

  useEffect(() => {
    const FPS = 14;
    function tick(t: number) {
      if (t - last.current >= 1000 / FPS) {
        last.current = t;
        frame.current = (frame.current + 1) % FRAMES.length;
        if (imgRef.current) imgRef.current.src = FRAMES[frame.current];
      }
      raf.current = requestAnimationFrame(tick);
    }

    function syncAnimation() {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
      if (!document.hidden && !document.documentElement.classList.contains("low-power")) {
        raf.current = requestAnimationFrame(tick);
      }
    }

    document.addEventListener("visibilitychange", syncAnimation);
    window.addEventListener("mahi-low-power-change", syncAnimation);
    syncAnimation();
    return () => {
      cancelAnimationFrame(raf.current);
      document.removeEventListener("visibilitychange", syncAnimation);
      window.removeEventListener("mahi-low-power-change", syncAnimation);
    };
  }, []);

  if (FRAMES.length === 0) return null;

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        overflow: "hidden",
        flexShrink: 0,
        boxShadow: "0 0 0 1px var(--gold-soft), 0 4px 18px rgba(31, 182, 201, 0.3)",
      }}
    >
      <img
        ref={imgRef}
        src={FRAMES[0]}
        alt=""
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          // Frames have a black square background; a slight zoom inside the
          // circular crop hides the corners.
          transform: "scale(1.07)",
        }}
      />
    </div>
  );
}
