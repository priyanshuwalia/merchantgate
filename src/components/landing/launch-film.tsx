"use client";

import { Play } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

const SRC = "/media/merchantgate-launch.mp4";
const POSTER = "/media/merchantgate-launch.jpg";
const TRACK = "/media/merchantgate-launch.vtt";

/**
 * The launch film carries no spoken narration — its whole argument is on-screen
 * text — so the poster holds until the visitor asks for playback. That keeps
 * the soundtrack intact, respects autoplay policy, and stops 2.8 MB from
 * landing on every page view.
 */
export function LaunchFilm({ className }: { className?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  // If the browser refuses programmatic playback, stop covering the player so
  // the native controls underneath stay reachable.
  const [dismissed, setDismissed] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border border-border bg-card shadow-sm",
        className,
      )}
    >
      <video
        ref={videoRef}
        className="block aspect-video w-full bg-secondary object-cover"
        poster={POSTER}
        controls
        preload="none"
        playsInline
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => setFailed(true)}
      >
        <source src={SRC} type="video/mp4" />
        <track kind="captions" src={TRACK} srcLang="en" label="English" />
        Your browser does not support embedded video. The MerchantGate launch
        film is also available at /media/merchantgate-launch.mp4.
      </video>

      {failed && (
        <p className="absolute inset-0 flex items-center justify-center bg-card px-6 text-center text-sm text-text-secondary">
          The launch film could not be loaded. It is also available at{" "}
          <a
            href={SRC}
            className="font-medium text-primary underline underline-offset-2"
          >
            /media/merchantgate-launch.mp4
          </a>
          .
        </p>
      )}

      {!playing && !dismissed && !failed && (
        <button
          type="button"
          onClick={() => {
            const el = videoRef.current;
            if (!el) return;
            // Safari/iOS only honours playback from a direct user gesture.
            el.play().catch(() => setDismissed(true));
          }}
          className="absolute inset-0 flex items-center justify-center bg-foreground/0 transition-colors duration-200 hover:bg-foreground/10 focus-visible:bg-foreground/10"
        >
          <span className="sr-only">
            Play the MerchantGate launch film (20 seconds, with sound)
          </span>
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-foreground/85 text-background shadow-lg backdrop-blur-sm transition-transform duration-200 group-hover:scale-105">
            <Play className="ml-1 h-6 w-6 fill-current" aria-hidden="true" />
          </span>
        </button>
      )}
    </div>
  );
}
