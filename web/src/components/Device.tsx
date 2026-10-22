import { useEffect, useState, type ReactNode } from 'react';

/** The screen is laid out at Echo Show 10's native 1280×800 and scaled to fit. */
export const SCREEN_W = 1280;
export const SCREEN_H = 800;
const BEZEL = 26;
const BASE_H = 96;
const DEVICE_W = SCREEN_W + BEZEL * 2;
const DEVICE_H = SCREEN_H + BEZEL * 2 + BASE_H - 18;

function useFitScale(reserveBelow: number): number {
  const compute = () => Math.min((window.innerWidth - 48) / DEVICE_W, (window.innerHeight - reserveBelow - 40) / DEVICE_H, 1.15);
  const [scale, setScale] = useState(compute);
  useEffect(() => {
    const onResize = () => setScale(compute());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });
  return Math.max(scale, 0.2);
}

/** Echo Show 10: a screen with a deep black bezel, sitting on a fabric speaker base. */
export function Device({ children, reserveBelow }: { children: ReactNode; reserveBelow: number }) {
  const scale = useFitScale(reserveBelow);
  return (
    <div style={{ width: DEVICE_W * scale, height: DEVICE_H * scale }} className="relative">
      <div className="absolute left-0 top-0 origin-top-left" style={{ width: DEVICE_W, height: DEVICE_H, transform: `scale(${scale})` }}>
        {/* Speaker base, behind the screen */}
        <div
          className="fabric absolute rounded-b-[56px] rounded-t-[28px]"
          style={{ left: DEVICE_W * 0.17, right: DEVICE_W * 0.17, top: SCREEN_H + BEZEL * 2 - 60, height: BASE_H + 42 }}
        >
          <div className="absolute inset-x-10 bottom-3 h-px bg-white/5" />
        </div>
        {/* Contact shadow on the counter */}
        <div
          className="absolute rounded-[50%] bg-black/70 blur-2xl"
          style={{ left: DEVICE_W * 0.12, right: DEVICE_W * 0.12, top: DEVICE_H - 34, height: 40 }}
        />

        {/* Screen panel */}
        <div
          className="absolute left-0 top-0 rounded-[38px] bg-gradient-to-b from-[#1a1b1f] to-[#0c0c0e] shadow-[0_40px_90px_-30px_rgba(0,0,0,0.9),inset_0_1px_0_rgba(255,255,255,0.08),inset_0_-1px_0_rgba(0,0,0,0.6)]"
          style={{ width: DEVICE_W, height: SCREEN_H + BEZEL * 2, padding: BEZEL }}
        >
          {/* Camera and its privacy shutter */}
          <div className="absolute left-1/2 top-[9px] flex -translate-x-1/2 items-center gap-2">
            <span className="size-[9px] rounded-full bg-[#050506] ring-1 ring-white/10">
              <span className="m-[2.5px] block size-[4px] rounded-full bg-indigo-950" />
            </span>
          </div>
          <div className="relative h-full w-full overflow-hidden rounded-[14px] bg-black ring-1 ring-black">{children}</div>
        </div>
      </div>
    </div>
  );
}
