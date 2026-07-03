import { useEffect, useRef, useState } from "react";

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
  const [i, setI] = useState(0);
  const raf = useRef<number>(0);
  const last = useRef(0);

  useEffect(() => {
    const FPS = 14;
    function tick(t: number) {
      if (t - last.current >= 1000 / FPS) {
        last.current = t;
        setI((cur) => (cur + 1) % FRAMES.length);
      }
      raf.current = requestAnimationFrame(tick);
    }
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
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
        src={FRAMES[i]}
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
