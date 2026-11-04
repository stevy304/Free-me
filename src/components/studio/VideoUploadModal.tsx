import React, { useState } from 'react';
import {
  Upload,
  X,
  CheckCircle2,
  Cpu,
  Layers,
  Sparkles,
  FileVideo,
  AlertCircle,
} from 'lucide-react';
import { Video } from '../../types';

interface VideoUploadModalProps {
  onClose: () => void;
  onUploadComplete: (newVideo: Partial<Video>) => void;
}

export const VideoUploadModal: React.FC<VideoUploadModalProps> = ({
  onClose,
  onUploadComplete,
}) => {
  const [step, setStep] = useState<'DETAILS' | 'PROCESSING' | 'DONE'>('DETAILS');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('Kigali Life');
  const [isShort, setIsShort] = useState(false);
  const [monetizationEnabled, setMonetizationEnabled] = useState(true);

  // Transcoding progress states
  const [uploadPercent, setUploadPercent] = useState(0);
  const [currentStage, setCurrentStage] = useState('Initiating S3 multipart upload...');

  const categories = [
    'Kigali Life',
    'Tech & Innovation',
    'Wildlife & Safari',
    'Music & Performance',
    'Culinary & Coffee',
    'Comedy & Entertainment',
  ];

  const handleStartUpload = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setStep('PROCESSING');

    // Simulate multi-stage background transcoding pipeline on Server 4 (Media Node)
    let p = 0;
    const interval = setInterval(() => {
      p += 10;
      setUploadPercent(p);

      if (p === 20) {
        setCurrentStage('S3 Direct Upload: Received chunk 2/5 (10MB)...');
      } else if (p === 40) {
        setCurrentStage('Triggering Media Worker (Server 4): Executing ffprobe metadata extraction...');
      } else if (p === 60) {
        setCurrentStage('FFmpeg Transcoding: Generating HLS adaptive ladder (1080p, 720p, 480p, 360p)...');
      } else if (p === 80) {
        setCurrentStage('Generating WebVTT storyboards & 3 high-res poster thumbnails...');
      } else if (p === 100) {
        clearInterval(interval);
        setCurrentStage('Transcoding complete! Master playlist verified.');
        setStep('DONE');

        setTimeout(() => {
          onUploadComplete({
            title: title.trim(),
            description: description.trim() || 'Published via Free Me African Creator Studio.',
            category,
            isShort,
            monetizationEnabled,
            durationSeconds: isShort ? 35 : 480,
            status: 'READY',
            visibility: 'PUBLIC',
            videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
            thumbnailUrl: isShort
              ? '/src/assets/images/hero_african_creator_1793734955093.jpg'
              : '/src/assets/images/thumbnail_kigali_tech_1793734955621.jpg',
            viewCount: 0,
            likeCount: 0,
            commentCount: 0,
            renditions: [
              { resolution: '1080p', width: 1920, height: 1080, bitrateKbps: 4500, label: '1080p HD' },
              { resolution: '720p', width: 1280, height: 720, bitrateKbps: 2200, label: '720p' },
              { resolution: '480p', width: 854, height: 480, bitrateKbps: 900, label: '480p (Data Saver)' },
            ],
          });
          onClose();
        }, 1200);
      }
    }, 400);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-xl bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl p-6 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-amber-50 dark:bg-amber-950/50 flex items-center justify-center text-amber-600">
              <Upload className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-display font-bold text-base text-slate-900 dark:text-white">
                Upload to Free Me
              </h3>
              <p className="text-[11px] text-slate-500">
                Automated HLS Transcoding & Creator Revenue Registration
              </p>
            </div>
          </div>
          {step !== 'PROCESSING' && (
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {step === 'DETAILS' && (
          <form onSubmit={handleStartUpload} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Video Title *
              </label>
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Exploring Kigali's Tech Ecosystem at Norrsken House"
                className="w-full px-3.5 py-2 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-500 text-slate-900 dark:text-white"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Description
              </label>
              <textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Share context, story highlights, guest credits, and links..."
                className="w-full px-3.5 py-2 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-500 text-slate-900 dark:text-white"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Category
                </label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:outline-none"
                >
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Format
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setIsShort(false)}
                    className={`flex-1 py-2 text-xs rounded-lg border font-medium transition-colors ${
                      !isShort
                        ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-500 text-amber-700 dark:text-amber-300'
                        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    Standard (16:9)
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsShort(true)}
                    className={`flex-1 py-2 text-xs rounded-lg border font-medium transition-colors ${
                      isShort
                        ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-500 text-amber-700 dark:text-amber-300'
                        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    Shorts (9:16)
                  </button>
                </div>
              </div>
            </div>

            {/* Monetization Toggle */}
            <div className="p-3 rounded-xl bg-amber-50/60 dark:bg-amber-950/30 border border-amber-200/60 dark:border-amber-800/40 flex items-center justify-between">
              <div>
                <span className="font-semibold text-xs text-slate-900 dark:text-white">
                  Enable 60% Creator Monetization
                </span>
                <p className="text-[11px] text-slate-500">
                  Allow compliant local Rwandan advertisements to run and credit your balance.
                </p>
              </div>
              <input
                type="checkbox"
                checked={monetizationEnabled}
                onChange={(e) => setMonetizationEnabled(e.target.checked)}
                className="w-4 h-4 accent-amber-600 cursor-pointer"
              />
            </div>

            <div className="flex justify-end gap-3 pt-3 border-t border-slate-100 dark:border-slate-800">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 font-medium"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-5 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg shadow-sm transition-colors"
              >
                Publish Video
              </button>
            </div>
          </form>
        )}

        {step === 'PROCESSING' && (
          <div className="py-8 space-y-6 text-center">
            <div className="relative w-20 h-20 mx-auto">
              <div className="absolute inset-0 rounded-full border-4 border-slate-200 dark:border-slate-700" />
              <div
                className="absolute inset-0 rounded-full border-4 border-amber-600 border-t-transparent animate-spin"
                style={{ animationDuration: '1.2s' }}
              />
              <div className="absolute inset-0 flex items-center justify-center font-mono font-bold text-sm text-slate-900 dark:text-white">
                {uploadPercent}%
              </div>
            </div>

            <div className="space-y-2">
              <h4 className="font-display font-semibold text-sm text-slate-900 dark:text-white">
                Processing on Media Node (Server 4)
              </h4>
              <p className="text-xs font-mono text-amber-600 dark:text-amber-400 bg-slate-50 dark:bg-slate-800/80 py-2 px-3 rounded-lg border border-slate-200 dark:border-slate-700/60 max-w-md mx-auto truncate">
                {currentStage}
              </p>
            </div>

            <div className="text-[11px] text-slate-400">
              Generating HLS adaptive bitrate chunks: 1080p, 720p, 480p, 360p.
            </div>
          </div>
        )}

        {step === 'DONE' && (
          <div className="py-8 text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400 mx-auto flex items-center justify-center">
              <CheckCircle2 className="w-6 h-6" />
            </div>
            <h4 className="font-display font-bold text-base text-slate-900 dark:text-white">
              Video Successfully Published!
            </h4>
            <p className="text-xs text-slate-500">
              Your video is now live on the Free Me feed and available for African audiences.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
