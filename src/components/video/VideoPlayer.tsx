import React, { useState, useRef, useEffect } from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize2,
  Settings,
  Subtitles,
  ExternalLink,
  FastForward,
  RotateCcw,
} from 'lucide-react';
import { Video, Campaign } from '../../types';

interface VideoPlayerProps {
  video: Video;
  activeAdCampaign?: Campaign;
  onAdImpressionCompleted?: (campaign: Campaign) => void;
  autoPlay?: boolean;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  video,
  activeAdCampaign,
  onAdImpressionCompleted,
  autoPlay = true,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Playback state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(video.durationSeconds || 120);
  const [volume, setVolume] = useState(0.85);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [selectedQuality, setSelectedQuality] = useState<'Auto' | '1080p' | '720p' | '480p' | '360p'>('Auto');
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [captionsEnabled, setCaptionsEnabled] = useState(false);
  const [captionLanguage, setCaptionLanguage] = useState<'en' | 'rw'>('en');

  // Pre-roll ad state
  const [isPlayingAd, setIsPlayingAd] = useState(Boolean(video.monetizationEnabled && activeAdCampaign));
  const [adSecondsRemaining, setAdSecondsRemaining] = useState(12);
  const [canSkipAd, setCanSkipAd] = useState(false);
  const [adSkipCountdown, setAdSkipCountdown] = useState(5);

  // Control visibility
  const [showControls, setShowControls] = useState(true);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize or handle video prop switch
  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    if (video.monetizationEnabled && activeAdCampaign) {
      setIsPlayingAd(true);
      setAdSecondsRemaining(12);
      setCanSkipAd(false);
      setAdSkipCountdown(5);
    } else {
      setIsPlayingAd(false);
    }
  }, [video.id, activeAdCampaign]);

  // Handle ad countdown timer
  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (isPlayingAd) {
      timer = setInterval(() => {
        setAdSecondsRemaining((prev) => {
          if (prev <= 1) {
            handleEndAd();
            return 0;
          }
          return prev - 1;
        });

        setAdSkipCountdown((prev) => {
          if (prev <= 1) {
            setCanSkipAd(true);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [isPlayingAd]);

  const handleEndAd = () => {
    setIsPlayingAd(false);
    if (activeAdCampaign && onAdImpressionCompleted) {
      onAdImpressionCompleted(activeAdCampaign);
    }
    // Start main video
    setTimeout(() => {
      if (videoRef.current) {
        videoRef.current.currentTime = 0;
        videoRef.current.play().catch(() => {});
        setIsPlaying(true);
      }
    }, 100);
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play();
      setIsPlaying(true);
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
      if (videoRef.current.duration && !isNaN(videoRef.current.duration)) {
        setDuration(videoRef.current.duration);
      }
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    setCurrentTime(time);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
  };

  const toggleMute = () => {
    if (!videoRef.current) return;
    const newMuted = !isMuted;
    setIsMuted(newMuted);
    videoRef.current.muted = newMuted;
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVol = parseFloat(e.target.value);
    setVolume(newVol);
    if (videoRef.current) {
      videoRef.current.volume = newVol;
      setIsMuted(newVol === 0);
    }
  };

  const handleSpeedChange = (speed: number) => {
    setPlaybackSpeed(speed);
    if (videoRef.current) {
      videoRef.current.playbackRate = speed;
    }
    setShowSettingsMenu(false);
  };

  const handleQualityChange = (quality: 'Auto' | '1080p' | '720p' | '480p' | '360p') => {
    setSelectedQuality(quality);
    setShowSettingsMenu(false);
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  const handleMouseMove = () => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying) {
        setShowControls(false);
        setShowSettingsMenu(false);
      }
    }, 3000);
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const source = isPlayingAd && activeAdCampaign ? activeAdCampaign.adCreativeUrl : video.videoUrl;
  const [playbackError, setPlaybackError] = useState(false);
  useEffect(() => {
    const element = videoRef.current;
    setPlaybackError(false);
    if (!element || !source.endsWith('.m3u8')) return;
    if (element.canPlayType('application/vnd.apple.mpegurl')) {
      element.src = source;
      return;
    }
    let disposed = false;
    let destroy = () => {};
    void import('hls.js').then(({ default: Hls }) => {
      if (disposed) return;
      if (!Hls.isSupported()) {
        setPlaybackError(true);
        return;
      }
      const hls = new Hls();
      destroy = () => hls.destroy();
      hls.on(Hls.Events.ERROR, (_event, detail) => {
        if (detail.fatal) setPlaybackError(true);
      });
      hls.loadSource(source);
      hls.attachMedia(element);
    }).catch(() => {
      if (!disposed) setPlaybackError(true);
    });
    return () => {
      disposed = true;
      destroy();
    };
  }, [source]);

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => isPlaying && setShowControls(false)}
      className="relative w-full aspect-video bg-black rounded-2xl overflow-hidden shadow-2xl select-none group"
    >
      {/* Video Element */}
      <video
        ref={videoRef}
        src={source.endsWith('.m3u8') ? undefined : source}
        onLoadedMetadata={(event) => {
          if (Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration);
        }}
        onError={() => setPlaybackError(true)}
        poster={video.thumbnailUrl}
        onTimeUpdate={handleTimeUpdate}
        onEnded={() => {
          if (isPlayingAd) handleEndAd();
          else setIsPlaying(false);
        }}
        onClick={togglePlay}
        autoPlay={autoPlay}
        playsInline
        className="w-full h-full object-cover"
      />

      {playbackError && <p role="alert" className="absolute inset-x-4 top-4 z-30 rounded-lg bg-black/85 p-3 text-sm text-white">This video could not be played. Check that the media service is running.</p>}

      {/* AD OVERLAY (When local Rwandan ad is actively running) */}
      {isPlayingAd && activeAdCampaign && (
        <div className="absolute inset-x-0 top-0 bottom-0 pointer-events-none flex flex-col justify-between p-4 z-20 bg-gradient-to-t from-black/80 via-transparent to-black/60">
          {/* Top Ad Info Banner */}
          <div className="flex items-center justify-between pointer-events-auto">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-black/75 backdrop-blur-md border border-white/10 text-white">
              <span className="font-mono text-xs font-bold text-amber-400 uppercase tracking-wider">
                Ad · {activeAdCampaign.businessName}
              </span>
              <span className="text-white/40">·</span>
              <span className="text-xs text-white/90 truncate max-w-sm">
                {activeAdCampaign.headline}
              </span>
            </div>

            <a
              href={activeAdCampaign.destinationUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium transition-colors shadow-lg"
            >
              <span>{activeAdCampaign.callToAction || 'Visit Website'}</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>

          {/* Bottom Ad Countdown & Skip Button */}
          <div className="flex items-center justify-between pointer-events-auto">
            <div className="text-xs text-white/80 font-mono bg-black/60 px-2.5 py-1 rounded backdrop-blur-sm">
              Ad ends in {adSecondsRemaining}s · 60% supports {video.channelName}
            </div>

            {canSkipAd ? (
              <button
                onClick={handleEndAd}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white/90 hover:bg-white text-slate-900 font-semibold text-xs transition-colors shadow-lg"
              >
                <span>Skip Ad</span>
                <FastForward className="w-3.5 h-3.5" />
              </button>
            ) : (
              <div className="px-3 py-2 rounded-lg bg-black/70 text-white/70 font-mono text-xs border border-white/10 backdrop-blur-sm">
                Skip in {adSkipCountdown}s
              </div>
            )}
          </div>
        </div>
      )}

      {/* SUBTITLES / CAPTIONS OVERLAY */}
      {captionsEnabled && !isPlayingAd && (
        <div className="absolute bottom-16 inset-x-0 flex justify-center pointer-events-none z-10 px-6">
          <div className="bg-black/85 text-white font-medium text-sm md:text-base px-4 py-1.5 rounded-lg text-center max-w-2xl shadow-lg backdrop-blur-sm">
            {captionLanguage === 'rw'
              ? 'Tugiye kureba uburyo abahanzi n’abayobozi b’ubucuruzi bishakira umutekano mu iterambere rya Kigali.'
              : 'Let us explore how young African creators and local businesses are shaping contemporary culture.'}
          </div>
        </div>
      )}

      {/* CONTROLS OVERLAY (MAIN VIDEO) */}
      {!isPlayingAd && (
        <div
          className={`absolute inset-0 flex flex-col justify-between p-4 bg-gradient-to-t from-black/80 via-transparent to-black/40 transition-opacity duration-200 z-10 ${
            showControls ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
          }`}
        >
          {/* Top Bar inside player */}
          <div className="flex items-center justify-between text-white">
            <h4 className="font-display font-medium text-sm drop-shadow-md truncate max-w-lg">
              {video.title}
            </h4>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono font-medium text-amber-400 bg-black/60 px-2 py-0.5 rounded border border-amber-400/30">
                HLS {selectedQuality}
              </span>
            </div>
          </div>

          {/* Center Play/Pause button on screen click */}
          <div
            onClick={togglePlay}
            className="self-center flex items-center justify-center w-14 h-14 rounded-full bg-black/60 hover:bg-amber-600/90 text-white transition-all cursor-pointer backdrop-blur-sm"
          >
            {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6 ml-0.5" />}
          </div>

          {/* Bottom Bar: Progress & Player Buttons */}
          <div className="space-y-2">
            {/* Scrubber Range */}
            <div className="relative flex items-center">
              <input
                type="range"
                min={0}
                max={duration || 100}
                value={currentTime}
                onChange={handleSeek}
                className="w-full h-1.5 bg-white/30 rounded-lg appearance-none cursor-pointer accent-amber-500 hover:h-2 transition-all"
              />
            </div>

            <div className="flex items-center justify-between text-white text-xs">
              <div className="flex items-center gap-3">
                {/* Play/Pause */}
                <button onClick={togglePlay} className="hover:text-amber-400 transition-colors">
                  {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                </button>

                {/* Volume & Mute */}
                <div className="flex items-center gap-1.5 group/vol">
                  <button onClick={toggleMute} className="hover:text-amber-400 transition-colors">
                    {isMuted || volume === 0 ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={isMuted ? 0 : volume}
                    onChange={handleVolumeChange}
                    className="w-16 h-1 bg-white/30 rounded accent-amber-500 cursor-pointer hidden group-hover/vol:block transition-all"
                  />
                </div>

                {/* Time Display */}
                <div className="font-mono text-[11px] text-white/80 tabular-nums">
                  {formatTime(currentTime)} / {formatTime(duration)}
                </div>
              </div>

              <div className="flex items-center gap-3 relative">
                {/* Captions Toggle */}
                <button
                  onClick={() => setCaptionsEnabled(!captionsEnabled)}
                  title={captionsEnabled ? 'Disable subtitles' : 'Enable subtitles (EN/RW)'}
                  className={`p-1 rounded transition-colors ${
                    captionsEnabled ? 'text-amber-400' : 'text-white/70 hover:text-white'
                  }`}
                >
                  <Subtitles className="w-4 h-4" />
                </button>

                {/* Settings & Quality Selector */}
                <div className="relative">
                  <button
                    onClick={() => setShowSettingsMenu(!showSettingsMenu)}
                    className="p-1 rounded text-white/70 hover:text-white transition-colors"
                  >
                    <Settings className="w-4 h-4" />
                  </button>

                  {/* Settings Popover */}
                  {showSettingsMenu && (
                    <div className="absolute right-0 bottom-full mb-2 w-52 bg-slate-900/95 border border-slate-700/80 rounded-xl p-3 shadow-2xl backdrop-blur-md text-slate-200 z-50 text-xs space-y-3">
                      <div>
                        <div className="text-[10px] font-mono uppercase text-slate-400 mb-1.5 font-semibold">
                          Adaptive Bitrate (HLS)
                        </div>
                        <div className="grid grid-cols-2 gap-1 font-mono text-[11px]">
                          {(['Auto', '1080p', '720p', '480p', '360p'] as const).map((q) => (
                            <button
                              key={q}
                              onClick={() => handleQualityChange(q)}
                              className={`px-2 py-1 rounded text-left transition-colors ${
                                selectedQuality === q
                                  ? 'bg-amber-600 text-white font-bold'
                                  : 'hover:bg-slate-800 text-slate-300'
                              }`}
                            >
                              {q}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="border-t border-slate-800 pt-2">
                        <div className="text-[10px] font-mono uppercase text-slate-400 mb-1 font-semibold">
                          Playback Speed
                        </div>
                        <div className="flex items-center justify-between text-[11px] font-mono">
                          {[0.75, 1, 1.25, 1.5].map((spd) => (
                            <button
                              key={spd}
                              onClick={() => handleSpeedChange(spd)}
                              className={`px-1.5 py-0.5 rounded transition-colors ${
                                playbackSpeed === spd
                                  ? 'bg-amber-600 text-white font-bold'
                                  : 'hover:bg-slate-800 text-slate-300'
                              }`}
                            >
                              {spd}x
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="border-t border-slate-800 pt-2">
                        <div className="text-[10px] font-mono uppercase text-slate-400 mb-1 font-semibold">
                          Subtitles
                        </div>
                        <div className="flex items-center gap-1 font-mono text-[11px]">
                          <button
                            onClick={() => {
                              setCaptionLanguage('en');
                              setCaptionsEnabled(true);
                            }}
                            className={`px-2 py-0.5 rounded ${
                              captionLanguage === 'en' && captionsEnabled
                                ? 'bg-amber-600 text-white'
                                : 'hover:bg-slate-800'
                            }`}
                          >
                            English
                          </button>
                          <button
                            onClick={() => {
                              setCaptionLanguage('rw');
                              setCaptionsEnabled(true);
                            }}
                            className={`px-2 py-0.5 rounded ${
                              captionLanguage === 'rw' && captionsEnabled
                                ? 'bg-amber-600 text-white'
                                : 'hover:bg-slate-800'
                            }`}
                          >
                            Kinyarwanda
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Fullscreen */}
                <button onClick={toggleFullscreen} className="hover:text-amber-400 transition-colors">
                  <Maximize2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
