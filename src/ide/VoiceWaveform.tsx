import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

// Fixed-width scrolling amplitude history (not a live spectrum snapshot) —
// matches the classic voice-input look: bars for older samples slide left
// as new ones arrive on the right, so the shape of what you already said is
// still visible while you keep talking.
const BAR_COUNT = 48;
const SAMPLE_INTERVAL_MS = 70;
const MAX_BAR_HEIGHT = 26;

export default function VoiceWaveform({ stream, active = false }: { stream: MediaStream | null; active?: boolean }) {
  const barRefs = useRef<(HTMLDivElement | null)[]>([]);
  const levelsRef = useRef<number[]>(new Array(BAR_COUNT).fill(0));

  useEffect(() => {
    if (!stream) {
      if (!active) return;
      let cancelled = false;
      let timer = 0;
      const sample = async () => {
        try {
          const meter = await invoke<{ level: number; peak: number }>("microphone_level");
          if (cancelled) return;
          const levels = levelsRef.current;
          levels.shift();
          levels.push(Math.min(1, Math.max(0, meter.level * 0.7 + meter.peak * 0.3)));
          for (let i = 0; i < BAR_COUNT; i++) {
            const bar = barRefs.current[i];
            if (bar) bar.style.height = `${Math.max(3, Math.round(levels[i] * MAX_BAR_HEIGHT))}px`;
          }
        } catch {
          // Recording can stop between the last scheduled sample and unmount.
        }
        if (!cancelled) timer = window.setTimeout(sample, SAMPLE_INTERVAL_MS);
      };
      void sample();
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
        levelsRef.current = new Array(BAR_COUNT).fill(0);
      };
    }
    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);

    let raf = 0;
    let lastSample = 0;

    function paint() {
      const levels = levelsRef.current;
      for (let i = 0; i < BAR_COUNT; i++) {
        const bar = barRefs.current[i];
        if (bar) bar.style.height = `${Math.max(3, Math.round(levels[i] * MAX_BAR_HEIGHT))}px`;
      }
    }

    function tick(now: number) {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i] - 128) / 128;
        if (v > peak) peak = v;
      }
      if (now - lastSample > SAMPLE_INTERVAL_MS) {
        lastSample = now;
        const levels = levelsRef.current;
        levels.shift();
        levels.push(Math.min(1, peak * 1.6));
        paint();
      }
      raf = requestAnimationFrame(tick);
    }

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      source.disconnect();
      audioCtx.close().catch(() => {});
      levelsRef.current = new Array(BAR_COUNT).fill(0);
      paint();
    };
  }, [stream, active]);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2, height: MAX_BAR_HEIGHT + 4, flex: 1, overflow: "hidden" }}>
      {Array.from({ length: BAR_COUNT }).map((_, i) => (
        <div
          key={i}
          ref={(el) => {
            barRefs.current[i] = el;
          }}
          style={{
            width: 2,
            height: 3,
            background: "var(--accent)",
            borderRadius: 1,
            flexShrink: 0,
            transition: "height 60ms linear",
          }}
        />
      ))}
    </div>
  );
}
