#!/usr/bin/env bash
set -euo pipefail

# Free Me — Production FFmpeg HLS Transcoding Engine
# Usage: transcode.sh <input_file> <output_dir> <video_id>

INPUT="$1"
OUT_DIR="$2"
VIDEO_ID="$3"

mkdir -p "${OUT_DIR}/1080p" "${OUT_DIR}/720p" "${OUT_DIR}/480p" "${OUT_DIR}/360p" "${OUT_DIR}/thumbs"

echo "[INFO] Starting video probe for ${VIDEO_ID}..."
ffprobe -v quiet -print_format json -show_format -show_streams "${INPUT}" > "${OUT_DIR}/probe.json"

DURATION=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${INPUT}")
echo "[INFO] Duration: ${DURATION} seconds"

# Generate 3 representative thumbnails
T1=$(awk "BEGIN {print ${DURATION} * 0.25}")
T2=$(awk "BEGIN {print ${DURATION} * 0.50}")
T3=$(awk "BEGIN {print ${DURATION} * 0.75}")

ffmpeg -ss "${T1}" -i "${INPUT}" -vframes 1 -q:v 2 "${OUT_DIR}/thumbs/thumb_1.jpg" -y
ffmpeg -ss "${T2}" -i "${INPUT}" -vframes 1 -q:v 2 "${OUT_DIR}/thumbs/thumb_2.jpg" -y
ffmpeg -ss "${T3}" -i "${INPUT}" -vframes 1 -q:v 2 "${OUT_DIR}/thumbs/thumb_3.jpg" -y

echo "[INFO] Transcoding multi-bitrate HLS ladder (1080p, 720p, 480p, 360p)..."

ffmpeg -i "${INPUT}" \
  -filter_complex \
  "[0:v]split=4[v1080][v720][v480][v360]; \
   [v1080]scale=w=1920:h=1080:force_original_aspect_ratio=decrease[v1080out]; \
   [v720]scale=w=1280:h=720:force_original_aspect_ratio=decrease[v720out]; \
   [v480]scale=w=854:h=480:force_original_aspect_ratio=decrease[v480out]; \
   [v360]scale=w=640:h=360:force_original_aspect_ratio=decrease[v360out]" \
  -map "[v1080out]" -c:v:0 libx264 -b:v:0 4500k -maxrate:v:0 4800k -bufsize:v:0 9000k \
  -map "[v720out]"  -c:v:1 libx264 -b:v:1 2200k -maxrate:v:1 2400k -bufsize:v:1 4400k \
  -map "[v480out]"  -c:v:2 libx264 -b:v:2 900k  -maxrate:v:2 1000k -bufsize:v:2 1800k \
  -map "[v360out]"  -c:v:3 libx264 -b:v:3 450k  -maxrate:v:3 500k  -bufsize:v:3 900k \
  -map 0:a? -c:a aac -b:a 128k \
  -f hls \
  -hls_time 6 \
  -hls_playlist_type vod \
  -hls_flags independent_segments \
  -hls_segment_type mpegts \
  -hls_segment_filename "${OUT_DIR}/%v/segment_%03d.ts" \
  -master_pl_name master.m3u8 \
  -var_stream_map "v:0,a:0,name:1080p v:1,a:0,name:720p v:2,a:0,name:480p v:3,a:0,name:360p" \
  "${OUT_DIR}/%v/index.m3u8"

echo "[SUCCESS] Transcoding complete. Master playlist created at ${OUT_DIR}/master.m3u8"
