"use client";

// The homepage demo video. Click-to-load: until the visitor presses play, only a local thumbnail is shown, so
// nothing is requested from YouTube and no third-party cookies are set. The player is YouTube's privacy-enhanced
// embed (youtube-nocookie.com, allowed by frame-src in next.config.ts). The iframe sends its origin as the referrer:
// the site's own policy (same-origin) sends none, and YouTube refuses to play embeds without one.
import { useState } from "react";
import { DEMO } from "./copy";

export function DemoVideo() {
  const [playing, setPlaying] = useState(false);
  return (
    <div className="lp-window relative aspect-video w-full overflow-hidden rounded-2xl border border-line bg-[#0b1020]">
      {playing ? (
        <iframe
          className="absolute inset-0 h-full w-full"
          src={`https://www.youtube-nocookie.com/embed/${DEMO.videoId}?autoplay=1&rel=0&modestbranding=1`}
          title={DEMO.iframeTitle}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      ) : (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          aria-label={DEMO.playLabel}
          className="group absolute inset-0 h-full w-full cursor-pointer focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/50"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- a fixed local poster, no optimisation needed */}
          <img src="/demo-thumbnail.jpg" alt="" width={1280} height={720} className="h-full w-full object-cover opacity-90 transition-opacity group-hover:opacity-100" />
          <span aria-hidden className="absolute inset-0 grid place-items-center">
            <span className="grid h-20 w-20 place-items-center rounded-full bg-white/95 shadow-3 transition-transform group-hover:scale-105">
              <svg viewBox="0 0 24 24" width="34" height="34" className="ml-1 fill-brand"><path d="M8 5.5v13l11-6.5z" /></svg>
            </span>
          </span>
          <span aria-hidden className="absolute right-3 bottom-3 rounded-md bg-black/70 px-2 py-0.5 text-xs font-medium text-white">{DEMO.length}</span>
        </button>
      )}
    </div>
  );
}
