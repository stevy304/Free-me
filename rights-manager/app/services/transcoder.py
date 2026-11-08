"""FFmpeg command lines used by live streaming: forwarding the program to other services, and making the VOD."""

from app.config import get_settings


def destination_url(rtmp_url: str, stream_key: str) -> str:
    """YouTube/Facebook/Twitch give a server URL and a key; the full URL is server/key."""
    return f"{rtmp_url.rstrip('/')}/{stream_key.lstrip('/')}" if stream_key else rtmp_url


def restream_command(stream_key: str, target_url: str) -> list[str]:
    """The same program, copied (no re-encode) to one destination. One process each, so one failing never stops the others."""
    src = f"{get_settings().rtmp_internal_url.rstrip('/')}/{stream_key}-program"
    return ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-rw_timeout", "10000000", "-i", src,
            "-c", "copy", "-f", "flv", "-flvflags", "no_duration_filesize", target_url]


def preview_hls_command(stream_key: str, out_dir: str) -> list[str]:
    """The plain RTMP -> HLS preview (no control room); used when the mixer is turned off (LIVE_MIXER=false)."""
    src = f"{get_settings().rtmp_internal_url.rstrip('/')}/{stream_key}"
    return ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", src, "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac",
            "-f", "hls", "-hls_time", "2", "-hls_list_size", "10", "-hls_flags", "delete_segments", f"{out_dir}/index.m3u8"]
