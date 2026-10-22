export type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

/** The blue Alexa light along the bottom edge of the screen. */
export function LightBar({ phase }: { phase: Phase }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 h-[10px]" aria-hidden>
      <div className="lightbar absolute inset-x-0 bottom-0 h-[7px] rounded-t-full" data-state={phase} />
    </div>
  );
}
