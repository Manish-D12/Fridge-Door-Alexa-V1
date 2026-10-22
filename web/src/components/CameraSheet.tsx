import { useEffect, useRef, useState } from 'react';
import type { ImageMimeType } from '@fridge-door/shared';
import { Camera, ImageUp, X } from 'lucide-react';

export interface Photo {
  base64: string;
  mimeType: ImageMimeType;
  /** For showing while it's read. */
  previewUrl: string;
}

const MAX_EDGE = 1600;

/** Draws the source onto a canvas no larger than MAX_EDGE and returns it as JPEG. */
function toJpeg(source: CanvasImageSource, width: number, height: number): Photo {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const previewUrl = canvas.toDataURL('image/jpeg', 0.88);
  return { base64: previewUrl.slice(previewUrl.indexOf(',') + 1), mimeType: 'image/jpeg', previewUrl };
}

async function fromFile(file: File): Promise<Photo> {
  try {
    const bitmap = await createImageBitmap(file);
    return toJpeg(bitmap, bitmap.width, bitmap.height);
  } catch {
    // The browser can't decode it (e.g. HEIC outside Safari): send it as-is.
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: (file.type || 'image/jpeg') as ImageMimeType, previewUrl: dataUrl };
  }
}

export function CameraSheet({ onPhoto, onClose }: { onPhoto(photo: Photo): void; onClose(): void }) {
  const video = useRef<HTMLVideoElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<'starting' | 'live' | 'unavailable'>('starting');
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        if (video.current) {
          video.current.srcObject = stream;
          await video.current.play().catch(() => undefined);
        }
        setStatus('live');
      } catch {
        if (!cancelled) setStatus('unavailable');
      }
    })();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const snap = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    setFlash(true);
    window.setTimeout(() => onPhoto(toJpeg(v, v.videoWidth, v.videoHeight)), 180);
  };

  const pick = async (f: File | undefined) => {
    if (f) onPhoto(await fromFile(f));
  };

  return (
    <div className="fade-in absolute inset-0 z-30 flex flex-col bg-black/85 backdrop-blur-xl">
      <div className="flex items-center justify-between px-10 pt-8">
        <div>
          <div className="text-[30px] font-semibold">Show me a document</div>
          <div className="mt-1 text-[19px] text-white/60">A school slip, a bill or an appointment card. I'll add anything with a date.</div>
        </div>
        <button onClick={onClose} aria-label="Close camera" className="rounded-full bg-white/10 p-3 transition hover:bg-white/20">
          <X size={28} />
        </button>
      </div>

      <div className="relative mx-10 mt-6 flex-1 overflow-hidden rounded-[26px] bg-white/[0.04] ring-1 ring-white/10">
        <video ref={video} playsInline muted className={`h-full w-full object-cover transition-opacity duration-500 ${status === 'live' ? 'opacity-100' : 'opacity-0'}`} />
        {status !== 'live' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-center text-white/60">
            <Camera size={56} className="text-white/40" />
            <div className="text-[22px]">{status === 'starting' ? 'Starting the camera…' : 'No camera available. Upload a photo instead.'}</div>
          </div>
        )}
        {status === 'live' && (
          <div className="pointer-events-none absolute inset-[8%] rounded-3xl border-2 border-dashed border-white/40" />
        )}
        <div className={`pointer-events-none absolute inset-0 bg-white transition-opacity duration-200 ${flash ? 'opacity-80' : 'opacity-0'}`} />
      </div>

      <div className="flex items-center justify-center gap-8 py-7">
        <button
          onClick={() => file.current?.click()}
          className="flex items-center gap-3 rounded-full bg-white/10 px-7 py-4 text-[21px] font-medium transition hover:bg-white/20"
        >
          <ImageUp size={24} /> Upload photo
        </button>
        <button
          onClick={snap}
          disabled={status !== 'live'}
          aria-label="Take photo"
          className="flex size-[84px] items-center justify-center rounded-full bg-white ring-[6px] ring-white/25 transition hover:scale-105 active:scale-95 disabled:opacity-30"
        >
          <Camera size={34} className="text-slate-900" />
        </button>
        <div className="w-[190px]" />
        <input ref={file} type="file" accept="image/*" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
      </div>
    </div>
  );
}
